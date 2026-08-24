// physics-worker.js
// Owns the simulation state and advances it with Barnes-Hut gravity,
// off the main thread so rendering stays smooth. Also ages stars and
// triggers supernovae when a star's age reaches its main-sequence lifetime.

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

let state = null;        // { x, y, vx, vy, mass, type, radius, age, lifetime, alive } (typed-array-backed)
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

// Advance physics by one fixed step, age every living star, and report any
// stars that cross their lifetime this step (supernova).
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

  // Age stars (skip index 0, the immortal central mass) and collect any
  // that just died so the caller can broadcast supernova events.
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
  return died;
}

function initSim(newSeed, newNumStars, newParams) {
  seed = newSeed;
  numStars = newNumStars;
  params = newParams || {};
  const g = generateGalaxy(seed, numStars, params);
  state = { ...g, alive: new Uint8Array(g.n).fill(1) };
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
  // Cap substeps per tick so a runaway speed value can't stall the worker.
  let guard = 0;
  while (acc >= 1 && guard < 240) {
    const died = step(state);
    if (died.length) allDied.push(...died);
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
  postMessage({
    type: 'starInfo',
    index,
    starType: state.type[index],
    mass: state.mass[index],
    radius: state.radius[index],
    age: state.age[index],
    lifetime: state.lifetime[index],
    alive: !!state.alive[index],
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
