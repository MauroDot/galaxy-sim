// physics-worker.js
// Owns the simulation state and advances it with Barnes-Hut gravity,
// off the main thread so rendering stays smooth. Also ages stars and
// triggers supernovae when a star's age reaches its main-sequence lifetime,
// absorbs any star that strays within an absorber's (black hole/quasar)
// capture radius, and generates/hosts a zoomed-in star's planetary system
// on request. Black holes/quasars need no special gravity code - they're
// just very massive point bodies in the same quadtree/integration loop as
// everything else; planets are the same, at Earth-mass-converted scale.
// The galactic core (index 0) is itself a supermassive black hole: it
// consumes any wandering black hole/quasar that strays within its own
// capture radius and grows its own mass by the absorbed body's mass - same
// principle, the increased mass just flows into the next tree build/force
// calc for free, no special gravity code needed there either.

importScripts('quadtree.js', 'star-types.js', 'galaxy.js', 'system-bodies.js');

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

// Separate, much smaller compression for orbital-period *display* only
// (getStarInfo on a planet). Reusing YEARS_PER_TICK here would be a units
// mismatch - it's calibrated for multi-million-year stellar lifetimes, not
// week-to-decade planetary orbits, and would show a ~1-year Earth-like
// orbit as ~140 million years. Calibrated instead so a reference orbit
// (Sol-mass host, orbitRadius=50, this sim's own G) reads as "~1 year" -
// stylized flavor, same spirit as BLACKHOLE_EVENT_HORIZON_FACTOR.
const ORBIT_PERIOD_YEAR_SCALE = 1 / 2868;

const CAPTURE_RADIUS_SQ = BLACKHOLE_CAPTURE_RADIUS * BLACKHOLE_CAPTURE_RADIUS;

function isAbsorber(typeCode) {
  return typeCode === BLACKHOLE_TYPE_CODE || typeCode === QUASAR_TYPE_CODE;
}

let state = null;        // typed-array-backed; see initSim for full shape
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

// Advance physics by one fixed step, age every living star, absorb any body
// that has strayed within an absorber's capture radius, and report both
// kinds of removal events (supernova, absorption) for this step. Reserved-
// but-unpopulated system-body slots (alive=0) and populated planet slots
// (ordinary alive bodies) both flow through these same loops for free.
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

  // Core consumption: the core (index 0) is itself a supermassive black
  // hole and eats any wandering black hole/quasar within its own capture
  // radius, growing its own mass by the absorbed body's mass. O(numAbsorbers)
  // - always a handful at most - so this is effectively O(1) per step, no
  // measurable cost. Runs before the star-absorption loop below so a body
  // consumed this step is already gone from s.absorberIndices and can't
  // also "capture" a star this same step via its now-frozen last position.
  const coreAbsorptions = [];
  if (s.absorberIndices.length) {
    const stillHere = [];
    for (const bhIdx of s.absorberIndices) {
      const dx = s.x[bhIdx] - s.x[0];
      const dy = s.y[bhIdx] - s.y[0];
      if (dx * dx + dy * dy < CAPTURE_RADIUS_SQ) {
        s.mass[0] += s.mass[bhIdx];
        s.alive[bhIdx] = 0;
        s.coreConsumedCount++;
        coreAbsorptions.push({ blackHoleIndex: bhIdx, newCoreMass: s.mass[0] });
      } else {
        stillHere.push(bhIdx);
      }
    }
    s.absorberIndices = stillHere;
  }

  // Absorber capture: any ordinary body that has drifted within
  // CAPTURE_RADIUS of a black hole or quasar is absorbed and removed from
  // the sim (this can include a zoomed-in star's own planets, if a
  // wandering absorber happens to pass through that system - a real
  // emergent hazard, not a bug). Cheap (n * numAbsorbers distance checks,
  // and there are only ever a handful), so it runs every step for free.
  const absorbed = [];
  if (s.absorberIndices.length) {
    for (let i = 1; i < n; i++) {
      if (!s.alive[i] || isAbsorber(s.type[i])) continue;
      for (const bhIdx of s.absorberIndices) {
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
  // that just died so the caller can broadcast supernova events. Absorbers,
  // neutron stars, and planets all carry lifetime=Infinity so this never
  // fires for them.
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
  return { died, absorbed, coreAbsorptions };
}

function initSim(newSeed, newNumStars, newParams) {
  seed = newSeed;
  numStars = newNumStars;
  params = newParams || {};
  const g = generateGalaxy(seed, numStars, params);

  // Capacity model: allocate room for MAX_SYSTEM_BODIES reserved, dormant
  // "system body" slots after the real galaxy bodies. buildTree()/step()
  // above need zero changes for this - they already skip !alive[i], so
  // these slots cost nothing until a system populates them. state.n is the
  // full capacity (loop bound / positions-buffer size); state.realStarCount
  // is what the UI reports as "Stars" - keeping these separate is what
  // stops the stat from reading inflated by up to MAX_SYSTEM_BODIES.
  const capacity = g.n + MAX_SYSTEM_BODIES;
  const x = new Float64Array(capacity), y = new Float64Array(capacity);
  const vx = new Float64Array(capacity), vy = new Float64Array(capacity);
  const mass = new Float64Array(capacity), radius = new Float64Array(capacity);
  const age = new Float64Array(capacity), lifetime = new Float64Array(capacity);
  const type = new Uint8Array(capacity);
  const alive = new Uint8Array(capacity);

  x.set(g.x); y.set(g.y); vx.set(g.vx); vy.set(g.vy);
  mass.set(g.mass); radius.set(g.radius); age.set(g.age); lifetime.set(g.lifetime);
  type.set(g.type);
  alive.fill(0);
  for (let i = 0; i < g.n; i++) alive[i] = 1;
  for (let i = g.n; i < capacity; i++) {
    type[i] = SYSTEM_EMPTY_TYPE_CODE;
    mass[i] = 1; // never 0 - a stray uninitialized slot can never NaN a force calc
    lifetime[i] = Infinity;
  }

  const absorberIndices = [];
  const absorbedCount = {};
  let quasarCount = 0, neutronStarCount = 0;
  for (let i = 0; i < g.n; i++) {
    if (g.type[i] === BLACKHOLE_TYPE_CODE || g.type[i] === QUASAR_TYPE_CODE) {
      absorberIndices.push(i);
      absorbedCount[i] = 0;
      if (g.type[i] === QUASAR_TYPE_CODE) quasarCount++;
    } else if (g.type[i] === NEUTRONSTAR_TYPE_CODE) {
      neutronStarCount++;
    }
  }

  state = {
    x, y, vx, vy, mass, radius, age, lifetime, type, alive,
    n: capacity,
    realStarCount: g.n,
    absorberIndices,
    absorbedCount,
    coreConsumedCount: 0,
    focusIndex: -1,
    focusSlotCount: 0,
    systemMeta: {},
  };
  acc = 0;
  stepCount = 0;
  postMessage({
    type: 'ready',
    n: state.n,
    realStarCount: state.realStarCount,
    seed,
    mass: Array.from(state.mass),
    starType: Array.from(state.type),
    radius: Array.from(state.radius),
    lifetime: Array.from(state.lifetime),
    blackHoleCount: absorberIndices.length - quasarCount,
    quasarCount,
    neutronStarCount,
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
  const allCoreAbsorptions = [];
  // Cap substeps per tick so a runaway speed value can't stall the worker.
  let guard = 0;
  while (acc >= 1 && guard < 240) {
    const { died, absorbed, coreAbsorptions } = step(state);
    if (died.length) allDied.push(...died);
    if (absorbed.length) allAbsorbed.push(...absorbed);
    if (coreAbsorptions.length) allCoreAbsorptions.push(...coreAbsorptions);
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
      // Flash at the absorber's position, not the star's - that's where
      // the visual event reads as happening.
      x: state.x[blackHoleIndex],
      y: state.y[blackHoleIndex],
      absorbedCount: state.absorbedCount[blackHoleIndex],
    });
  }
  for (const { blackHoleIndex, newCoreMass } of allCoreAbsorptions) {
    postMessage({
      type: 'coreAbsorption',
      blackHoleIndex,
      x: state.x[0],
      y: state.y[0],
      newCoreMass,
      coreConsumedCount: state.coreConsumedCount,
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

// --- Sol System zoom: enter/exit/snapshot a star's planetary system ---

function evictSystem() {
  if (!state || state.focusIndex === -1) return;
  const base = state.realStarCount;
  for (let i = 0; i < state.focusSlotCount; i++) {
    const idx = base + i;
    state.alive[idx] = 0;
    state.type[idx] = SYSTEM_EMPTY_TYPE_CODE;
    state.mass[idx] = 1;
    delete state.systemMeta[idx];
  }
  state.focusIndex = -1;
  state.focusSlotCount = 0;
}

// Non-destructive: current live planets' state relative to their host star,
// for persistence (used by both a real exit and a periodic autosave peek).
function buildSnapshot() {
  if (!state || state.focusIndex === -1) return null;
  const starIndex = state.focusIndex;
  const hostX = state.x[starIndex], hostY = state.y[starIndex];
  const hostVX = state.vx[starIndex], hostVY = state.vy[starIndex];
  const base = state.realStarCount;
  const planets = [];
  for (let i = 0; i < state.focusSlotCount; i++) {
    const idx = base + i;
    if (!state.alive[idx]) continue; // may have been absorbed since generation
    const meta = state.systemMeta[idx];
    planets.push({
      name: meta.name, massEarth: meta.massEarth, orbitRadius: meta.orbitRadius,
      color: meta.color, composition: meta.composition, tempK: meta.tempK, moons: meta.moons,
      relX: state.x[idx] - hostX, relY: state.y[idx] - hostY,
      relVX: state.vx[idx] - hostVX, relVY: state.vy[idx] - hostVY,
    });
  }
  return {
    starIndex,
    genSignature: `${seed}:${numStars}:${starIndex}`,
    hostType: state.type[starIndex],
    hostMass: state.mass[starIndex],
    planets,
  };
}

function enterSystem(starIndex, saved) {
  if (!state || starIndex < 0 || starIndex >= state.realStarCount) return;

  if (state.focusIndex === starIndex) {
    // Already live - just re-report the current slots.
    const base = state.realStarCount;
    const slots = [];
    for (let i = 0; i < state.focusSlotCount; i++) {
      const idx = base + i;
      if (state.alive[idx]) slots.push({ index: idx, ...state.systemMeta[idx] });
    }
    postMessage({
      type: 'systemReady', starIndex, wasGenerated: false, slots,
      starMeta: { type: state.type[starIndex], mass: state.mass[starIndex] },
    });
    return;
  }
  if (state.focusIndex !== -1) evictSystem();

  const hostMass = state.mass[starIndex];
  const hostType = state.type[starIndex];
  const hostX = state.x[starIndex], hostY = state.y[starIndex];
  const hostVX = state.vx[starIndex], hostVY = state.vy[starIndex];
  const genSignature = `${seed}:${numStars}:${starIndex}`;

  let planets, wasGenerated;
  if (saved && saved.genSignature === genSignature && saved.hostType === hostType &&
      Math.abs(saved.hostMass - hostMass) < 1e-6 && Array.isArray(saved.planets)) {
    planets = saved.planets;
    wasGenerated = false;
  } else {
    planets = generateSystem(seed, starIndex, hostMass, hostType).planets;
    wasGenerated = true;
  }

  const base = state.realStarCount;
  const count = Math.min(planets.length, MAX_SYSTEM_BODIES);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const idx = base + i;
    const p = planets[i];
    let px, py, pvx, pvy;
    if (!wasGenerated) {
      px = hostX + p.relX; py = hostY + p.relY;
      pvx = hostVX + p.relVX; pvy = hostVY + p.relVY;
    } else {
      px = hostX + Math.cos(p.angle0) * p.orbitRadius;
      py = hostY + Math.sin(p.angle0) * p.orbitRadius;
      const v = Math.sqrt((G * hostMass) / p.orbitRadius);
      pvx = hostVX - Math.sin(p.angle0) * v;
      pvy = hostVY + Math.cos(p.angle0) * v;
    }
    state.x[idx] = px; state.y[idx] = py;
    state.vx[idx] = pvx; state.vy[idx] = pvy;
    state.mass[idx] = p.massEarth * EARTH_MASS_IN_SOLAR;
    state.radius[idx] = p.radiusPx; // display px directly, not a world-unit star radius
    state.type[idx] = PLANET_TYPE_CODE;
    state.alive[idx] = 1;
    state.age[idx] = 0;
    state.lifetime[idx] = Infinity;

    state.systemMeta[idx] = {
      name: p.name, massEarth: p.massEarth, orbitRadius: p.orbitRadius,
      radiusPx: p.radiusPx, color: p.color, composition: p.composition,
      tempK: p.tempK, hostIndex: starIndex, moons: p.moons,
    };
    slots.push({ index: idx, ...state.systemMeta[idx] });
  }

  state.focusIndex = starIndex;
  state.focusSlotCount = count;

  // The new planets' positions only exist in worker state so far - tick()
  // is what normally broadcasts a fresh 'positions' buffer, but that only
  // fires while playing. Without this, entering a system while paused would
  // leave the main thread rendering/hit-testing stale (zero-initialized)
  // data for these slots. Sent before 'systemReady' so the camera-tween
  // target (read from the positions buffer) is already correct by the time
  // that message is handled.
  postPositions();

  postMessage({
    type: 'systemReady',
    starIndex,
    wasGenerated,
    slots,
    starMeta: { type: hostType, mass: hostMass },
  });
}

function sendStarInfo(index) {
  if (!state || index < 0 || index >= state.n) return;
  const typeCode = state.type[index];
  const absorberBody = isAbsorber(typeCode);
  const payload = {
    type: 'starInfo',
    index,
    starType: typeCode,
    mass: state.mass[index],
    radius: state.radius[index],
    age: state.age[index],
    lifetime: state.lifetime[index],
    alive: !!state.alive[index],
    isBlackHole: absorberBody, // true for both black holes and quasars
    absorbed: absorberBody ? (state.absorbedCount[index] || 0) : 0,
    coreConsumedCount: index === 0 ? state.coreConsumedCount : 0,
  };
  if (typeCode === PLANET_TYPE_CODE && state.systemMeta[index]) {
    const meta = state.systemMeta[index];
    const hostVX = state.vx[meta.hostIndex], hostVY = state.vy[meta.hostIndex];
    const orbitalSpeed = Math.hypot(state.vx[index] - hostVX, state.vy[index] - hostVY);
    const periodSeconds = orbitalSpeed > 0 ? (2 * Math.PI * meta.orbitRadius) / orbitalSpeed : Infinity;
    Object.assign(payload, {
      isPlanet: true,
      name: meta.name,
      massEarth: meta.massEarth,
      orbitRadius: meta.orbitRadius,
      tempK: meta.tempK,
      composition: meta.composition,
      hostIndex: meta.hostIndex,
      orbitalSpeed,
      periodYears: periodSeconds * ORBIT_PERIOD_YEAR_SCALE,
      moons: meta.moons,
    });
  }
  postMessage(payload);
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
    case 'enterSystem':
      enterSystem(msg.starIndex, msg.saved);
      break;
    case 'exitSystem': {
      const snapshot = buildSnapshot();
      evictSystem();
      postPositions(); // same reasoning as enterSystem: keep the buffer fresh even while paused
      if (snapshot) postMessage({ type: 'systemSnapshot', ...snapshot });
      break;
    }
    case 'peekSystemSnapshot': {
      const snapshot = buildSnapshot();
      if (snapshot) postMessage({ type: 'systemSnapshot', ...snapshot, peek: true });
      break;
    }
    default:
      break;
  }
};
