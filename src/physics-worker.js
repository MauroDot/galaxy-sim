// physics-worker.js
// Owns the simulation state and advances it with Barnes-Hut gravity,
// off the main thread so rendering stays smooth. Also ages stars and
// triggers supernovae when a star's age reaches its main-sequence lifetime,
// and absorbs any star that strays within a black hole's capture radius.
// Black holes need no special gravity code - they're just very massive
// point bodies in the same quadtree/integration loop as everything else.

importScripts('quadtree.js', 'star-types.js', 'galaxy.js');

const DT = 1 / 60;       // fixed physics timestep (seconds) - unchanged
const G = 0.6;
const SOFTENING = 12;    // avoids blow-ups on close encounters
const THETA = 0.6;       // Barnes-Hut accuracy/speed tradeoff
const TICK_MS = 1000 / 60;

// Stellar-age compression: how many simulated "years" a star ages per
// physics step. Calibrated so an O-star (lifetime ~10M years, the shortest
// lived) burns through a full lifetime in ~200s of sim-time at 1x speed
// (60 steps/s) - i.e. roughly a couple of minutes of play at normal speed,
// or ~15-20s once you push the speed slider to 10x+.
const YEARS_PER_TICK = 833;

const CAPTURE_RADIUS_SQ = BLACKHOLE_CAPTURE_RADIUS * BLACKHOLE_CAPTURE_RADIUS;

let state = null;        // { x, y, vx, vy, mass, type, radius, age, lifetime, alive,
                          //   blackHoleIndices, absorbedCount } (typed-array-backed)
let seed = 1;
let numStars = 500;
let params = {};
let playing = false;
let speed = 1;
let acc = 0;
let timer = null;
let stepCount = 0;

function buildTree(s) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    const x = s.x[i], y = s.y[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const size = Math.max(maxX - minX, maxY - minY) / 2 * 1.05 + 1;
  const tree = new Quadtree(cx, cy, size, THETA, SOFTENING);
  for (let i = 0; i < s.n; i++) {
    if (!s.alive[i]) continue;
    tree.insert({ x: s.x[i], y: s.y[i], mass: s.mass[i] });
  }
  return tree;
}

// Advance physics by one fixed step, age every living star, absorb any star
// that has strayed within a black hole's capture radius, and report both
// kinds of removal events (supernova, absorption) for this step.
function step(s) {
  const tree = buildTree(s);
  const n = s.n;

  // Kick: apply accelerations from the tree built at the current positions
  // (symplectic/semi-implicit Euler - stable and cheap for a real-time viz).
  for (let i = 0; i < n; i++) {
    if (!s.alive[i]) continue;
    const body = { x: s.x[i], y: s.y[i], mass: s.mass[i] };
    const f = tree.calculateForce(body, G);
    const invM = 1 / s.mass[i];
    s.vx[i] += f.fx * invM * DT;
    s.vy[i] += f.fy * invM * DT;
  }
  // Drift.
  for (let i = 0; i < n; i++) {
    if (!s.alive[i]) continue;
    s.x[i] += s.vx[i] * DT;
    s.y[i] += s.vy[i] * DT;
  }

  // Black hole capture: any ordinary star that has drifted within
  // CAPTURE_RADIUS of a black hole is absorbed and removed from the sim.
  // Cheap (n * numBlackHoles distance checks, and there are only ever 0-2),
  // so it runs every step with no measurable cost.
  const absorbed = [];
  if (s.blackHoleIndices.length) {
    for (let i = 1; i < n; i++) {
      if (!s.alive[i] || s.type[i] === BLACKHOLE_TYPE_CODE) continue;
      for (const bhIdx of s.blackHoleIndices) {
        const dx = s.x[i] - s.x[bhIdx];
        const dy = s.y[i] - s.y[bhIdx];
        if (dx * dx + dy * dy < CAPTURE_RADIUS_SQ) {
          s.alive[i] = 0;
          s.absorbedCount[bhIdx] = (s.absorbedCount[bhIdx] || 0) + 1;
          absorbed.push({ starIndex: i, blackHoleIndex: bhIdx });
          break;
        }
      }
    }
  }

  // Age stars (skip index 0, the immortal central mass) and collect any
  // that just died so the caller can broadcast supernova events. Black
  // holes carry lifetime=Infinity so this never fires for them.
  const died = [];
  for (let i = 1; i < n; i++) {
    if (!s.alive[i]) continue;
    s.age[i] += YEARS_PER_TICK;
    if (s.age[i] >= s.lifetime[i]) {
      s.alive[i] = 0;
      died.push(i);
    }
  }

  stepCount++;
  return { died, absorbed };
}

function initSim(newSeed, newNumStars, newParams) {
  seed = newSeed;
  numStars = newNumStars;
  params = newParams || {};
  const g = generateGalaxy(seed, numStars, params);

  const blackHoleIndices = [];
  const absorbedCount = {};
  for (let i = 0; i < g.n; i++) {
    if (g.type[i] === BLACKHOLE_TYPE_CODE) {
      blackHoleIndices.push(i);
      absorbedCount[i] = 0;
    }
  }

  state = { ...g, alive: new Uint8Array(g.n).fill(1), blackHoleIndices, absorbedCount };
  acc = 0;
  stepCount = 0;
  postMessage({
    type: 'ready',
    n: state.n,
    seed,
    mass: Array.from(state.mass),
    starType: Array.from(state.type),
    radius: Array.from(state.radius),
    lifetime: Array.from(state.lifetime),
    blackHoleCount: blackHoleIndices.length,
  });
  postPositions();
}

function postPositions() {
  const n = state.n;
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    buf[i * 2] = state.x[i];
    buf[i * 2 + 1] = state.y[i];
  }
  postMessage({ type: 'positions', n, step: stepCount, buf }, [buf.buffer]);
}

function tick() {
  if (!playing || !state) return;
  acc += speed;
  let stepped = false;
  const allDied = [];
  const allAbsorbed = [];
  // Cap substeps per tick so a runaway speed value can't stall the worker.
  let guard = 0;
  while (acc >= 1 && guard < 240) {
    const { died, absorbed } = step(state);
    if (died.length) allDied.push(...died);
    if (absorbed.length) allAbsorbed.push(...absorbed);
    acc -= 1;
    stepped = true;
    guard++;
  }
  if (stepped) postPositions();
  for (const i of allDied) {
    postMessage({
      type: 'supernova',
      index: i,
      x: state.x[i],
      y: state.y[i],
      starType: state.type[i],
    });
  }
  for (const { starIndex, blackHoleIndex } of allAbsorbed) {
    postMessage({
      type: 'absorption',
      starIndex,
      blackHoleIndex,
      // Flash at the black hole's position, not the star's - that's where
      // the visual event reads as happening.
      x: state.x[blackHoleIndex],
      y: state.y[blackHoleIndex],
      absorbedCount: state.absorbedCount[blackHoleIndex],
    });
  }
}

function play() {
  playing = true;
  if (!timer) timer = setInterval(tick, TICK_MS);
}

function pause() {
  playing = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function sendStarInfo(index) {
  if (!state || index < 0 || index >= state.n) return;
  const isBlackHole = state.type[index] === BLACKHOLE_TYPE_CODE;
  postMessage({
    type: 'starInfo',
    index,
    starType: state.type[index],
    mass: state.mass[index],
    radius: state.radius[index],
    age: state.age[index],
    lifetime: state.lifetime[index],
    alive: !!state.alive[index],
    isBlackHole,
    absorbed: isBlackHole ? (state.absorbedCount[index] || 0) : 0,
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      initSim(msg.seed, msg.numStars, msg.params);
      break;
    case 'play':
      play();
      break;
    case 'pause':
      pause();
      break;
    case 'setSpeed':
      speed = Math.max(0, msg.speed);
      break;
    case 'reset':
      pause();
      initSim(msg.seed ?? seed, msg.numStars ?? numStars, msg.params ?? params);
      break;
    case 'getStarInfo':
      sendStarInfo(msg.index);
      break;
    default:
      break;
  }
};
