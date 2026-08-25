// physics-worker.js
// Owns the simulation state and advances it with Barnes-Hut gravity,
// off the main thread so rendering stays smooth. Also ages stars and
// triggers supernovae when a star's age reaches its main-sequence lifetime,
// absorbs any star that strays within an absorber's (black hole/quasar)
// capture radius, generates/hosts a zoomed-in star's planetary system on
// request, and now hosts a full interactive system editor (create/delete/
// edit bodies, asteroid fields, comets, collisions, undo - see
// system-editor.js) plus "System Experiments" (a mutable G) and a pinned-
// body mechanic (the core, and a shared-system's synthetic host, never
// move regardless of gravity acting on them - they still exert gravity on
// everything else normally). Black holes/quasars/planets/asteroids/comets
// all need no special gravity code - they're just point bodies of varying
// mass in the same quadtree/integration loop as everything else.
//
// Also independently Node-harness-testable (unlike every other worker-side
// file, this one didn't used to be - see scratchpad tests for this
// feature): postMessage calls go through a local emit() that falls back to
// a test-visible sink when postMessage isn't a global, importScripts is
// guarded the same way every other file already guards its own
// environment-specific bits, and self.onmessage's switch body is a plain
// function a test harness can call directly.

if (typeof importScripts !== 'undefined') {
  importScripts('quadtree.js', 'star-types.js', 'galaxy.js', 'system-bodies.js', 'system-editor.js');
} else {
  // Node/CommonJS test-harness path only.
  Object.assign(globalThis, require('./quadtree.js'));
  Object.assign(globalThis, require('./star-types.js'));
  Object.assign(globalThis, require('./galaxy.js'));
  Object.assign(globalThis, require('./system-bodies.js'));
  Object.assign(globalThis, require('./system-editor.js'));
}

const _testSink = []; // Node-harness-only: emit() falls back to this
function emit(msg, transfer) {
  if (typeof postMessage !== 'undefined') {
    postMessage(msg, transfer);
  } else {
    _testSink.push(msg);
  }
}

const DT = 1 / 60;       // fixed physics timestep (seconds) - unchanged
let G = DEFAULT_G;        // mutable now - "System Experiments" (Crazy Physics/Low Gravity)
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

// Advance physics by one fixed step. Handles (in order): gravity kick+drift
// (skipping pinned/locked-orbit bodies), locked-orbit kinematic repositioning,
// core-eats-absorber, absorber-eats-body, system-body collisions, and
// stellar aging/supernova. Returns every kind of removal/merge event for
// this step so the caller can broadcast them.
function step(s) {
  const tree = buildTree(s);
  const n = s.n;

  // Kick: apply accelerations from the tree built at the current positions
  // (symplectic/semi-implicit Euler - stable and cheap for a real-time viz).
  // Pinned bodies (the core, a shared-system's synthetic host) and
  // locked-orbit bodies are skipped here - they still exert gravity on
  // everyone else (they're still in the tree above), they just don't
  // accelerate from it.
  for (let i = 0; i < n; i++) {
    if (!s.alive[i] || s.pinned[i] || s.lockedOrbit[i]) continue;
    const body = { x: s.x[i], y: s.y[i], mass: s.mass[i] };
    const f = tree.calculateForce(body, G);
    const invM = 1 / s.mass[i];
    s.vx[i] += f.fx * invM * DT;
    s.vy[i] += f.fy * invM * DT;
  }
  // Drift. Pinned bodies never accelerate so their velocity stays at
  // whatever it was initialized to (0) - this naturally leaves them
  // motionless without needing to also skip them here. Locked-orbit bodies
  // ARE skipped here too (their position is set kinematically below instead).
  for (let i = 0; i < n; i++) {
    if (!s.alive[i] || s.lockedOrbit[i]) continue;
    s.x[i] += s.vx[i] * DT;
    s.y[i] += s.vy[i] * DT;
  }

  // Locked-orbit kinematic override: position/velocity recomputed directly
  // from stored orbital parameters (same formula moons already use, applied
  // here to a REAL body) rather than integrated - "Lock Orbit" freezes a
  // body into a circular path even if its mass later changes.
  for (const idxStr in s.lockedOrbit) {
    const idx = Number(idxStr);
    if (!s.alive[idx]) { delete s.lockedOrbit[idx]; continue; }
    const lock = s.lockedOrbit[idx];
    const hostIdx = lock.hostIndex;
    const t = stepCount * DT;
    const angle = lock.phase0 + lock.angularSpeed * t;
    s.x[idx] = s.x[hostIdx] + Math.cos(angle) * lock.radius;
    s.y[idx] = s.y[hostIdx] + Math.sin(angle) * lock.radius;
    const v = lock.radius * lock.angularSpeed;
    s.vx[idx] = s.vx[hostIdx] - Math.sin(angle) * v;
    s.vy[idx] = s.vy[hostIdx] + Math.cos(angle) * v;
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
  let absorbedSystemBody = false;
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
          // A system body (one of the zoomed-in star's planets/asteroids/
          // comets) can be swept up here too - unlike an ordinary galaxy
          // star it also occupies a reserved pool slot tracked in
          // systemBodyIndices. Free it the same way deleteBody() does, or
          // it leaks permanently: findFreeSlot never reclaims a slot whose
          // `type` is still PLANET_TYPE_CODE, and the stale index lingers
          // in systemBodyIndices forever, silently disagreeing with
          // anything that filters by `alive` (an undo snapshot) versus
          // anything that doesn't (currentSlots(), used for every
          // systemBodyDelta broadcast and the status-line body count).
          if (s.systemMeta[i]) {
            s.type[i] = SYSTEM_EMPTY_TYPE_CODE;
            s.mass[i] = 1;
            delete s.systemMeta[i];
            delete s.lockedOrbit[i];
            absorbedSystemBody = true;
          }
          break;
        }
      }
    }
    if (absorbedSystemBody) {
      s.systemBodyIndices = s.systemBodyIndices.filter((idx) => s.alive[idx]);
    }
  }

  // System-body collisions: O(k^2) over state.systemBodyIndices only (never
  // the core/host/galaxy stars), dormant (near-zero cost) whenever fewer
  // than 2 system bodies exist. See system-editor.js for the merge rule.
  const { events: collisions } = checkCollisions(s);

  // Age stars (skip index 0, the immortal central mass) and collect any
  // that just died so the caller can broadcast supernova events. Absorbers,
  // neutron stars, and planets/asteroids/comets all carry lifetime=Infinity
  // so this never fires for them.
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
  return { died, absorbed, coreAbsorptions, collisions, absorbedSystemBody };
}

function initSim(newSeed, newNumStars, newParams) {
  seed = newSeed;
  numStars = newNumStars;
  params = newParams || {};
  G = DEFAULT_G; // "System Experiments" toggles reset on reload/regen
  const g = generateGalaxy(seed, numStars, params);

  // Capacity model: allocate room for SYSTEM_POOL_CAPACITY reserved,
  // dormant "system body" slots after the real galaxy bodies. buildTree()/
  // step() above need zero changes for this - they already skip !alive[i],
  // so these slots cost nothing until populated. state.n is the full
  // capacity (loop bound / positions-buffer size); state.realStarCount is
  // what the UI reports as "Stars" - keeping these separate is what stops
  // the stat from reading inflated.
  const capacity = g.n + SYSTEM_POOL_CAPACITY;
  const x = new Float64Array(capacity), y = new Float64Array(capacity);
  const vx = new Float64Array(capacity), vy = new Float64Array(capacity);
  const mass = new Float64Array(capacity), radius = new Float64Array(capacity);
  const age = new Float64Array(capacity), lifetime = new Float64Array(capacity);
  const type = new Uint8Array(capacity);
  const alive = new Uint8Array(capacity);
  const pinned = new Uint8Array(capacity);

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
  pinned[0] = 1; // the core is anchored at the origin forever (Part 1)

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
    x, y, vx, vy, mass, radius, age, lifetime, type, alive, pinned,
    n: capacity,
    realStarCount: g.n,
    absorberIndices,
    absorbedCount,
    coreConsumedCount: 0,
    focusIndex: -1,
    systemBodyIndices: [],
    systemMeta: {},
    lockedOrbit: {},
    undoStack: [],
    nextCustomIndex: 1,
    nextMoonId: 1,
  };
  acc = 0;
  stepCount = 0;
  emit({
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
  emit({ type: 'positions', n, step: stepCount, buf }, [buf.buffer]);
}

function tick() {
  if (!playing || !state) return;
  acc += speed;
  let stepped = false;
  const allDied = [];
  const allAbsorbed = [];
  const allCoreAbsorptions = [];
  const allCollisions = [];
  let anySystemBodyAbsorbed = false;
  // Cap substeps per tick so a runaway speed value can't stall the worker.
  let guard = 0;
  while (acc >= 1 && guard < 240) {
    const { died, absorbed, coreAbsorptions, collisions, absorbedSystemBody } = step(state);
    if (died.length) allDied.push(...died);
    if (absorbed.length) allAbsorbed.push(...absorbed);
    if (coreAbsorptions.length) allCoreAbsorptions.push(...coreAbsorptions);
    if (collisions.length) allCollisions.push(...collisions);
    if (absorbedSystemBody) anySystemBodyAbsorbed = true;
    acc -= 1;
    stepped = true;
    guard++;
  }
  if (stepped) postPositions();
  for (const i of allDied) {
    emit({
      type: 'supernova',
      index: i,
      x: state.x[i],
      y: state.y[i],
      starType: state.type[i],
    });
  }
  for (const { starIndex, blackHoleIndex } of allAbsorbed) {
    emit({
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
    emit({
      type: 'coreAbsorption',
      blackHoleIndex,
      x: state.x[0],
      y: state.y[0],
      newCoreMass,
      coreConsumedCount: state.coreConsumedCount,
    });
  }
  for (const ev of allCollisions) {
    emit({ type: 'collision', ...ev });
  }
  // A wandering absorber eating one of the zoomed-in system's own bodies
  // (see the absorber-capture comment in step()) changes systemBodyIndices
  // just like a collision merge does - resync the same way, or the status
  // line / info panel keep showing a body that's already gone until the
  // next unrelated user action happens to trigger a resync.
  if (allCollisions.length || anySystemBodyAbsorbed) {
    broadcastSystemDelta(allCollisions.length ? 'collision' : 'absorbed', null);
  }
}

function play() {
  playing = true;
  if (!timer && typeof setInterval !== 'undefined') timer = setInterval(tick, TICK_MS);
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
  clearSystemBodies(state);
  state.focusIndex = -1;
}

// Persisted-save shape: {starIndex, genSignature, hostType, hostMass,
// nextCustomIndex, nextMoonId, bodies}. `bodies` generalizes the old
// planets-only shape (now tags each with `kind`); a save from before this
// feature (which used `planets`, not `bodies`) is simply treated as
// invalid and regenerated fresh - graceful degradation, no migration code.
function buildSnapshot() {
  if (!state || state.focusIndex === -1) return null;
  const starIndex = state.focusIndex;
  return {
    starIndex,
    genSignature: `${seed}:${numStars}:${starIndex}`,
    hostType: state.type[starIndex],
    hostMass: state.mass[starIndex],
    nextCustomIndex: state.nextCustomIndex,
    nextMoonId: state.nextMoonId,
    bodies: buildBodiesSnapshot(state),
  };
}

function currentSlots() {
  return state.systemBodyIndices.map((i) => ({ index: i, ...state.systemMeta[i] }));
}

function broadcastSystemDelta(action, result) {
  postPositions();
  emit({
    type: 'systemBodyDelta',
    action, result,
    slots: currentSlots(),
    snapshot: buildSnapshot(),
  });
}

function enterSystem(starIndex, saved) {
  if (!state || starIndex < 0 || starIndex >= state.realStarCount) return;

  if (state.focusIndex === starIndex) {
    // Already live - just re-report the current slots.
    emit({
      type: 'systemReady', starIndex, wasGenerated: false, slots: currentSlots(),
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

  state.focusIndex = starIndex;
  state.undoStack = [];
  state.nextCustomIndex = 1;
  state.nextMoonId = 1;

  let wasGenerated;
  if (saved && saved.genSignature === genSignature && saved.hostType === hostType &&
      Math.abs(saved.hostMass - hostMass) < 1e-6 && Array.isArray(saved.bodies)) {
    state.nextCustomIndex = saved.nextCustomIndex || 1;
    state.nextMoonId = saved.nextMoonId || 1;
    restoreBodiesFromSnapshot(state, saved.bodies);
    wasGenerated = false;
  } else {
    const generated = generateSystem(seed, starIndex, hostMass, hostType).planets;
    for (const p of generated) {
      const idx = findFreeSlot(state);
      if (idx === -1) break;
      const { vx, vy } = circularOrbitVelocity(G, hostMass, hostVX, hostVY, p.orbitRadius, p.angle0);
      placeBody(
        state, idx, starIndex,
        hostX + Math.cos(p.angle0) * p.orbitRadius, hostY + Math.sin(p.angle0) * p.orbitRadius, vx, vy,
        p.massEarth,
        {
          kind: 'planet', name: p.name, radiusPx: p.radiusPx, color: p.color,
          composition: p.composition, tempK: p.tempK, orbitRadius: p.orbitRadius,
          moons: p.moons, collisionRadius: collisionRadiusFor(p.massEarth),
        }
      );
    }
    wasGenerated = true;
  }

  // The new bodies' positions only exist in worker state so far - tick()
  // is what normally broadcasts a fresh 'positions' buffer, but that only
  // fires while playing. Without this, entering a system while paused would
  // leave the main thread rendering/hit-testing stale (zero-initialized)
  // data for these slots. Sent before 'systemReady' so the camera-tween
  // target (read from the positions buffer) is already correct by the time
  // that message is handled.
  postPositions();

  emit({
    type: 'systemReady',
    starIndex,
    wasGenerated,
    slots: currentSlots(),
    starMeta: { type: hostType, mass: hostMass },
  });
}

// Loads a shared system from a decoded URL payload (see share-codec.js,
// main-thread-only). The shared system gets its own synthetic host - not
// any real galaxy star - placed far outside the visible galaxy (so it's
// gravitationally inert relative to it) and pinned (Part 1's mechanism
// generalizes to this too, not just the core).
function loadSharedSystem(payload) {
  if (!state) return;
  if (state.focusIndex !== -1) evictSystem();

  const hostIdx = findFreeSlot(state);
  if (hostIdx === -1) return; // pool exhausted (shouldn't happen on a fresh galaxy)

  const hostX = 5000, hostY = 5000;
  state.x[hostIdx] = hostX; state.y[hostIdx] = hostY;
  state.vx[hostIdx] = 0; state.vy[hostIdx] = 0;
  state.mass[hostIdx] = payload.hostMass;
  state.type[hostIdx] = payload.hostType;
  state.radius[hostIdx] = 0;
  state.alive[hostIdx] = 1;
  state.age[hostIdx] = 0;
  state.lifetime[hostIdx] = Infinity;
  state.pinned[hostIdx] = 1;

  state.focusIndex = hostIdx;
  state.undoStack = [];
  state.nextCustomIndex = 1;
  state.nextMoonId = 1;

  const bodies = (payload.bodies || []).map((b) => {
    const { vx, vy } = circularOrbitVelocity(G, payload.hostMass, 0, 0, b.orbitRadius, b.angle0, b.speedMult);
    return {
      kind: b.kind, name: b.name, massEarth: b.massEarth, radiusPx: planetRadiusPxFor(b.massEarth),
      color: b.color, composition: b.composition, tempK: null, orbitRadius: b.orbitRadius,
      moons: [], locked: false,
      relX: Math.cos(b.angle0) * b.orbitRadius, relY: Math.sin(b.angle0) * b.orbitRadius,
      relVX: vx, relVY: vy,
    };
  });
  restoreBodiesFromSnapshot(state, bodies);

  postPositions();
  emit({
    type: 'systemReady',
    starIndex: hostIdx,
    wasGenerated: true,
    fromShare: true,
    creatorName: payload.creatorName || null,
    slots: currentSlots(),
    starMeta: { type: payload.hostType, mass: payload.hostMass },
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
    const dx = state.x[index] - state.x[meta.hostIndex], dy = state.y[index] - state.y[meta.hostIndex];
    const currentRadius = Math.hypot(dx, dy);
    const orbitalSpeed = Math.hypot(state.vx[index] - hostVX, state.vy[index] - hostVY);
    const periodSeconds = orbitalSpeed > 0 ? (2 * Math.PI * currentRadius) / orbitalSpeed : Infinity;
    Object.assign(payload, {
      isPlanet: true,
      kind: meta.kind,
      name: meta.name,
      massEarth: meta.massEarth,
      orbitRadius: meta.orbitRadius,
      currentRadius,
      tempK: meta.tempK,
      composition: meta.composition,
      hostIndex: meta.hostIndex,
      orbitalSpeed,
      periodYears: periodSeconds * ORBIT_PERIOD_YEAR_SCALE,
      moons: meta.moons,
      locked: !!meta.locked,
      stability: stabilityFor(currentRadius, meta.orbitRadius),
    });
  }
  emit(payload);
}

function handleMessage(msg) {
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
      if (snapshot) emit({ type: 'systemSnapshot', ...snapshot });
      break;
    }
    case 'peekSystemSnapshot': {
      const snapshot = buildSnapshot();
      if (snapshot) emit({ type: 'systemSnapshot', ...snapshot, peek: true });
      break;
    }
    case 'setPhysicsParams':
      if (typeof msg.G === 'number' && msg.G > 0) G = msg.G;
      break;
    case 'createPlanet': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = createPlanet(state, G, msg.x, msg.y);
      broadcastSystemDelta('createPlanet', result);
      break;
    }
    case 'deleteBody': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = deleteBody(state, msg.index);
      broadcastSystemDelta('deleteBody', result);
      break;
    }
    case 'deleteMoon': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = deleteMoon(state, msg.planetIndex, msg.moonId);
      broadcastSystemDelta('deleteMoon', { planetIndex: msg.planetIndex, moon: result });
      break;
    }
    case 'adjustMass': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = adjustMass(state, msg.index, msg.massEarth);
      broadcastSystemDelta('adjustMass', result);
      break;
    }
    case 'cycleColor': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = cycleColor(state, msg.index);
      broadcastSystemDelta('cycleColor', result);
      break;
    }
    case 'recalcOrbit': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = recalcOrbit(state, G, msg.index);
      broadcastSystemDelta('recalcOrbit', result);
      break;
    }
    case 'lockOrbit': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = msg.locked ? lockOrbit(state, G, msg.index) : unlockOrbit(state, msg.index);
      broadcastSystemDelta('lockOrbit', result);
      break;
    }
    case 'addAsteroidField': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = addAsteroidField(state, G);
      broadcastSystemDelta('addAsteroidField', result);
      break;
    }
    case 'addComet': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = addComet(state, G);
      broadcastSystemDelta('addComet', result);
      break;
    }
    case 'addMoon': {
      if (state.focusIndex === -1) break;
      pushUndoSnapshot(state);
      const result = addMoon(state, msg.planetIndex);
      broadcastSystemDelta('addMoon', result);
      break;
    }
    case 'undo': {
      if (state.focusIndex === -1) break;
      const ok = undo(state);
      if (ok) broadcastSystemDelta('undo', null);
      break;
    }
    case 'loadSharedSystem':
      loadSharedSystem(msg.payload);
      break;
    default:
      break;
  }
}

if (typeof self !== 'undefined' && typeof importScripts !== 'undefined') {
  self.onmessage = (e) => handleMessage(e.data);
}

if (typeof module !== 'undefined') {
  module.exports = {
    handleMessage,
    _testSink,
    _getState: () => state,
    _getG: () => G,
    _step: () => step(state),
  };
}
