// system-editor.js
// Worker-side "system editor" operations: create/delete/edit individual
// system bodies (planets/asteroids/comets, plus kinematic moons),
// collision detection, and the undo stack. Split out from
// physics-worker.js to keep that file from doubling in size - same
// one-concern-per-file convention as galaxy.js/system-bodies.js. These are
// pure(ish) functions operating on a passed-in `state` object (and, where
// gravity matters, a passed-in current G, since G is now mutable) - no
// module-level physics state of its own, so it's independently
// Node-harness-testable without spinning up a worker.
//
// Body model: planets/asteroids/comets are all REAL physics bodies (one
// reserved-pool slot each, PLANET_TYPE_CODE, full gravity in and out) -
// "kind" (planet/asteroid/comet) is purely a systemMeta cosmetic tag, not a
// different type code, since mechanically they're identical. Moons stay
// KINEMATIC (position = host-planet-position + orbit(t), never a slot,
// never gravity-integrated) because the Hill-sphere radius for a genuinely
// bound moon at this sim's scale works out to well under 1 sim unit -
// deep inside SOFTENING=12, where no orbit-radius choice fixes the
// resulting numerical mush (verified in scratchpad test_moon_hillsphere.js).
// Moons still get full bookkeeping (a stable `id`, mass, color) so they're
// selectable/editable/deletable/persistable like anything else.

/* global CORE_TYPE_CODE, PLANET_TYPE_CODE, SYSTEM_EMPTY_TYPE_CODE,
   EARTH_MASS_IN_SOLAR, UNDO_STACK_LIMIT, ASTEROID_MASS_EARTH,
   ASTEROID_BELT_RADIUS, ASTEROID_BELT_JITTER, COMET_MASS_EARTH,
   COMET_SPEED_MULT_MIN, COMET_SPEED_MULT_MAX, MOON_MASS_FRACTION,
   collisionRadiusFor, planetRadiusPxFor, cyclePlanetColor,
   PLANET_COMPOSITIONS */
if (typeof module !== 'undefined' && typeof CORE_TYPE_CODE === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (importScripts shared-scope gotcha).
  Object.assign(globalThis, require('./star-types.js'));
}

const MIN_PLACEMENT_RADIUS = 8; // sim units - avoids a near-zero-radius divide in the orbit-velocity formula
const PROXIMITY_WARNING_RADIUS_MULT = 8; // "nearby" = within 8x the system's own outermost orbit

// --- Slot management ---

// Linear scan is fine here: SYSTEM_POOL_CAPACITY is small (128) and this
// only runs on creation, never once per physics step.
function findFreeSlot(state) {
  for (let i = state.realStarCount; i < state.n; i++) {
    if (state.type[i] === SYSTEM_EMPTY_TYPE_CODE) return i;
  }
  return -1;
}

function circularOrbitVelocity(G, hostMass, hostVX, hostVY, orbitRadius, angle0, speedMult) {
  const v = Math.sqrt((G * hostMass) / orbitRadius) * (speedMult ?? 1);
  return {
    vx: hostVX - Math.sin(angle0) * v,
    vy: hostVY + Math.cos(angle0) * v,
  };
}

function placeBody(state, idx, hostIdx, x, y, vx, vy, massEarth, meta) {
  state.x[idx] = x; state.y[idx] = y;
  state.vx[idx] = vx; state.vy[idx] = vy;
  state.mass[idx] = massEarth * EARTH_MASS_IN_SOLAR;
  state.radius[idx] = meta.radiusPx;
  state.type[idx] = PLANET_TYPE_CODE;
  state.alive[idx] = 1;
  state.age[idx] = 0;
  state.lifetime[idx] = Infinity;
  state.systemMeta[idx] = { hostIndex: hostIdx, moons: [], locked: false, ...meta, massEarth };
  state.systemBodyIndices.push(idx);
  return idx;
}

// --- Snapshot / restore (shared by enterSystem's "load saved", undo, and
// shared-system loading) ---

// Non-destructive: every live system body's state relative to the current
// host star, in the generalized {kind, ...} shape (superset of the old
// planets-only shape).
function buildBodiesSnapshot(state) {
  const hostIdx = state.focusIndex;
  if (hostIdx === -1) return [];
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  const bodies = [];
  for (const idx of state.systemBodyIndices) {
    if (!state.alive[idx]) continue;
    const meta = state.systemMeta[idx];
    bodies.push({
      kind: meta.kind, name: meta.name, massEarth: meta.massEarth,
      orbitRadius: meta.orbitRadius, radiusPx: meta.radiusPx,
      color: meta.color, composition: meta.composition, tempK: meta.tempK,
      locked: !!meta.locked, lockStrength: meta.lockStrength, moons: meta.moons,
      relX: state.x[idx] - hostX, relY: state.y[idx] - hostY,
      relVX: state.vx[idx] - hostVX, relVY: state.vy[idx] - hostVY,
    });
  }
  return bodies;
}

// Clears every current system-body slot (does NOT touch state.focusIndex -
// callers decide whether they're switching hosts or just clearing bodies).
function clearSystemBodies(state) {
  for (const idx of state.systemBodyIndices) {
    state.alive[idx] = 0;
    state.type[idx] = SYSTEM_EMPTY_TYPE_CODE;
    state.mass[idx] = 1;
    delete state.systemMeta[idx];
    delete state.lockedOrbit[idx];
  }
  state.systemBodyIndices = [];
}

// Places a list of {kind, massEarth, radiusPx, color, composition, tempK,
// moons, relX, relY, relVX, relVY, locked} bodies relative to the CURRENT
// host (state.focusIndex must already be set). Used by enterSystem's
// "load from saved", undo(), and loadSharedSystem(). `G`/`currentStep` are
// only needed for the locked-body branch - see lockOrbit()'s comment for why.
function restoreBodiesFromSnapshot(state, bodies, G, currentStep) {
  const hostIdx = state.focusIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  for (const b of bodies) {
    const idx = findFreeSlot(state);
    if (idx === -1) break; // pool full - drop the rest rather than crash
    placeBody(
      state, idx, hostIdx,
      hostX + b.relX, hostY + b.relY, hostVX + b.relVX, hostVY + b.relVY,
      b.massEarth,
      {
        kind: b.kind, name: b.name, radiusPx: b.radiusPx, color: b.color,
        composition: b.composition, tempK: b.tempK,
        orbitRadius: b.orbitRadius, moons: b.moons || [], locked: !!b.locked,
        collisionRadius: collisionRadiusFor(b.massEarth),
      }
    );
    if (b.locked) lockOrbit(state, G, idx, currentStep, b.lockStrength);
  }
}

// --- Undo stack ---

function pushUndoSnapshot(state) {
  if (state.focusIndex === -1) return; // nothing to undo outside a system
  state.undoStack.push({
    focusIndex: state.focusIndex,
    nextCustomIndex: state.nextCustomIndex,
    nextMoonId: state.nextMoonId,
    bodies: buildBodiesSnapshot(state),
  });
  if (state.undoStack.length > UNDO_STACK_LIMIT) state.undoStack.shift();
}

// Pops the last undo entry and restores it. Returns true if something was
// restored, false if the stack was empty. Deliberately does NOT push a new
// undo entry for the undo itself (no redo stack in this feature).
function undo(state, G, currentStep) {
  if (!state.undoStack.length || state.focusIndex === -1) return false;
  const entry = state.undoStack.pop();
  clearSystemBodies(state);
  state.nextCustomIndex = entry.nextCustomIndex;
  state.nextMoonId = entry.nextMoonId;
  restoreBodiesFromSnapshot(state, entry.bodies, G, currentStep);
  return true;
}

// --- Creation tools ---

function createPlanet(state, G, worldX, worldY) {
  if (state.focusIndex === -1) return null;
  const idx = findFreeSlot(state);
  if (idx === -1) return { poolFull: true };

  const hostIdx = state.focusIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  const dx = worldX - hostX, dy = worldY - hostY;
  const orbitRadius = Math.max(MIN_PLACEMENT_RADIUS, Math.hypot(dx, dy));
  const angle0 = Math.atan2(dy, dx);
  const { vx, vy } = circularOrbitVelocity(G, state.mass[hostIdx], hostVX, hostVY, orbitRadius, angle0);
  const massEarth = 1; // spec default

  const name = `Custom-${state.nextCustomIndex++}`;
  placeBody(
    state, idx, hostIdx,
    hostX + Math.cos(angle0) * orbitRadius, hostY + Math.sin(angle0) * orbitRadius, vx, vy,
    massEarth,
    {
      kind: 'planet', name, radiusPx: planetRadiusPxFor(massEarth),
      color: PLANET_COMPOSITIONS[1].color, composition: PLANET_COMPOSITIONS[1].key, // 'rocky' default
      tempK: null, orbitRadius, collisionRadius: collisionRadiusFor(massEarth),
    }
  );
  return { index: idx, ...state.systemMeta[idx] };
}

function deleteBody(state, index) {
  if (!state.systemMeta[index]) return null;
  const removed = {
    index, x: state.x[index], y: state.y[index],
    color: state.systemMeta[index].color, radiusPx: state.systemMeta[index].radiusPx,
  };
  state.alive[index] = 0;
  state.type[index] = SYSTEM_EMPTY_TYPE_CODE;
  state.mass[index] = 1;
  delete state.systemMeta[index];
  delete state.lockedOrbit[index];
  state.systemBodyIndices = state.systemBodyIndices.filter((i) => i !== index);
  return removed;
}

function deleteMoon(state, planetIndex, moonId) {
  const meta = state.systemMeta[planetIndex];
  if (!meta || !meta.moons) return null;
  const i = meta.moons.findIndex((m) => m.id === moonId);
  if (i === -1) return null;
  return meta.moons.splice(i, 1)[0];
}

function adjustMass(state, index, massEarth) {
  const meta = state.systemMeta[index];
  if (!meta) return null;
  const clamped = Math.min(500, Math.max(0.1, massEarth));
  meta.massEarth = clamped;
  meta.radiusPx = planetRadiusPxFor(clamped);
  meta.collisionRadius = collisionRadiusFor(clamped);
  state.mass[index] = clamped * EARTH_MASS_IN_SOLAR;
  state.radius[index] = meta.radiusPx;
  return { index, ...meta };
}

function cycleColor(state, index) {
  const meta = state.systemMeta[index];
  if (!meta) return null;
  const next = cyclePlanetColor(meta.composition);
  meta.composition = next.key;
  meta.color = next.color;
  return { index, ...meta };
}

// "R key": reset velocity to a fresh circular orbit at the body's CURRENT
// position (re-baselines orbitRadius too, so stability reads as "just
// fixed" going forward).
function recalcOrbit(state, G, index, currentStep) {
  const meta = state.systemMeta[index];
  if (!meta) return null;
  const hostIdx = meta.hostIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  const dx = state.x[index] - hostX, dy = state.y[index] - hostY;
  const orbitRadius = Math.max(MIN_PLACEMENT_RADIUS, Math.hypot(dx, dy));
  const angle0 = Math.atan2(dy, dx);
  const { vx, vy } = circularOrbitVelocity(G, state.mass[hostIdx], hostVX, hostVY, orbitRadius, angle0);
  state.vx[index] = vx; state.vy[index] = vy;
  meta.orbitRadius = orbitRadius;
  if (meta.locked) lockOrbit(state, G, index, currentStep, meta.lockStrength); // re-derive the kinematic params too
  return { index, ...meta };
}

// Locks a body into a circular orbit at its CURRENT radius, exerting
// gravity as always but never integrated - same kinematic mechanism the
// pinned core/moons already use (see step()'s locked-orbit block).
//
// Two things this deliberately does NOT do, both found by testing against
// the actual running sim rather than assumed correct on paper:
//
// 1. It does NOT freeze the body's current (possibly non-circular)
//    velocity as the locked speed. A body can easily be off a clean
//    circular path the moment it's locked - ordinary N-body drift (already
//    documented elsewhere in this file), or it was just created/mass-
//    edited - so "whatever speed it has right now" isn't reliably a
//    circular orbit. `angularSpeed` is instead derived straight from
//    G/hostMass/radius (the same formula circularOrbitVelocity() uses),
//    guaranteeing a true circle regardless of how it was moving before.
//
// 2. It does NOT let step()'s kinematic formula use `stepCount` directly
//    as elapsed time. `phase0` is the body's real angle *right now*, but
//    stepCount keeps counting from simulation start, not from this lock -
//    using it unadjusted made the body SNAP to a essentially arbitrary
//    angle the instant it locked (a jump of `angularSpeed * stepCount *
//    DT` radians, worse the longer the session had already been running,
//    and repeating on every re-lock e.g. after recalcOrbit) - which is
//    exactly what read as "not orbiting" even though the geometry/math was
//    otherwise correct. Stashing `lockedAtStep` here lets step() compute
//    elapsed time as `(stepCount - lockedAtStep) * DT` instead, so `angle
//    === phase0` at the exact moment of locking - zero discontinuity.
// `strength` (0-1, default 1 = today's full lock) is the "Orbit Stability"
// blend factor: at 1, step()'s locked-orbit block skips force/drift for
// this body entirely and sets its position kinematically, exactly as
// before. Below 1, step() instead lets the body accumulate REAL gravity
// from the shared force calc like every other body, then nudges it toward
// this same kinematic ideal by `strength` each tick - see step()'s
// locked-orbit block in physics-worker.js for the actual blend. This
// keeps "one shared force-calc path for every body" true even for
// partially-stabilized bodies; only the post-hoc position/velocity value
// differs, never how gravity itself is computed.
function lockOrbit(state, G, index, currentStep, strength) {
  const meta = state.systemMeta[index];
  if (!meta) return null;
  const hostIdx = meta.hostIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostMass = state.mass[hostIdx];
  const dx = state.x[index] - hostX, dy = state.y[index] - hostY;
  const radius = Math.max(MIN_PLACEMENT_RADIUS, Math.hypot(dx, dy));
  const angularSpeed = Math.sqrt((G * hostMass) / radius) / radius;
  const clampedStrength = Math.min(1, Math.max(0, strength ?? 1));
  if (clampedStrength <= 0) return unlockOrbit(state, index); // 0% stability = no lock at all
  meta.locked = true;
  meta.lockStrength = clampedStrength;
  state.lockedOrbit[index] = {
    radius, angularSpeed, phase0: Math.atan2(dy, dx), hostIndex: hostIdx,
    lockedAtStep: currentStep || 0, strength: clampedStrength,
  };
  return { index, ...meta };
}

function unlockOrbit(state, index) {
  const meta = state.systemMeta[index];
  if (!meta) return null;
  meta.locked = false;
  meta.lockStrength = 0;
  delete state.lockedOrbit[index];
  return { index, ...meta };
}

// --- Quick-spawn tools ---

function addAsteroidField(state, G) {
  if (state.focusIndex === -1) return [];
  const hostIdx = state.focusIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  const hostMass = state.mass[hostIdx];
  const count = 5 + Math.floor(Math.random() * 6); // 5-10
  const created = [];
  for (let i = 0; i < count; i++) {
    const idx = findFreeSlot(state);
    if (idx === -1) break;
    const orbitRadius = Math.max(
      MIN_PLACEMENT_RADIUS,
      ASTEROID_BELT_RADIUS + (Math.random() - 0.5) * 2 * ASTEROID_BELT_JITTER
    );
    const angle0 = Math.random() * Math.PI * 2;
    // Each asteroid gets its OWN circular speed at its OWN radius - they
    // don't move in lockstep, giving natural desync as the belt evolves.
    const { vx, vy } = circularOrbitVelocity(G, hostMass, hostVX, hostVY, orbitRadius, angle0);
    const name = `Asteroid-${state.nextCustomIndex++}`;
    placeBody(
      state, idx, hostIdx,
      hostX + Math.cos(angle0) * orbitRadius, hostY + Math.sin(angle0) * orbitRadius, vx, vy,
      ASTEROID_MASS_EARTH,
      {
        kind: 'asteroid', name, radiusPx: planetRadiusPxFor(ASTEROID_MASS_EARTH),
        color: '#9a9a9a', composition: 'airless', tempK: null,
        orbitRadius, collisionRadius: collisionRadiusFor(ASTEROID_MASS_EARTH),
      }
    );
    created.push({ index: idx, ...state.systemMeta[idx] });
  }
  return created;
}

function addComet(state, G) {
  if (state.focusIndex === -1) return null;
  const idx = findFreeSlot(state);
  if (idx === -1) return { poolFull: true };

  const hostIdx = state.focusIndex;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  const hostVX = state.vx[hostIdx], hostVY = state.vy[hostIdx];
  const hostMass = state.mass[hostIdx];
  const orbitRadius = ASTEROID_BELT_RADIUS - Math.random() * 20; // near the outer edge
  const angle0 = Math.random() * Math.PI * 2;
  const speedMult = COMET_SPEED_MULT_MIN + Math.random() * (COMET_SPEED_MULT_MAX - COMET_SPEED_MULT_MIN);
  // Less than circular speed at this radius -> the SAME gravity everything
  // else uses turns this into a genuinely eccentric ellipse (this radius as
  // aphelion, a much closer perihelion, back out) with no special orbital-
  // mechanics code - verified bounded/periodic/no-NaN in
  // scratchpad test_comet_stability.js.
  const { vx, vy } = circularOrbitVelocity(G, hostMass, hostVX, hostVY, orbitRadius, angle0, speedMult);
  const name = `Comet-${state.nextCustomIndex++}`;
  placeBody(
    state, idx, hostIdx,
    hostX + Math.cos(angle0) * orbitRadius, hostY + Math.sin(angle0) * orbitRadius, vx, vy,
    COMET_MASS_EARTH,
    {
      kind: 'comet', name, radiusPx: planetRadiusPxFor(COMET_MASS_EARTH) + 0.5,
      color: '#ffffff', composition: 'comet', tempK: null,
      orbitRadius, collisionRadius: collisionRadiusFor(COMET_MASS_EARTH),
    }
  );
  return { index: idx, ...state.systemMeta[idx] };
}

function addMoon(state, planetIndex) {
  const meta = state.systemMeta[planetIndex];
  if (!meta) return null;
  const moon = {
    id: state.nextMoonId++,
    name: `${meta.name}-moon${meta.moons.length + 1}`,
    massEarth: meta.massEarth * MOON_MASS_FRACTION,
    color: '#9a9a9a',
    orbitRadius: 2 + Math.random() * 6, // matches the existing auto-generated-moon range
    angularSpeed: (Math.PI * 2) / (3 + Math.random() * 10),
    phase0: Math.random() * Math.PI * 2,
  };
  meta.moons.push(moon);
  return { planetIndex, moon };
}

// --- Collision detection ---

// Single O(k^2) pass over state.systemBodyIndices (never the core/host/
// galaxy stars - those aren't in this array). Every pair uses the SAME
// mass-weighted momentum-conserving merge rule regardless of kind; the
// planet/asteroid/comet distinction only drives cosmetics (burst/sound) on
// the caller side via the returned `loserKind`. At most one merge per body
// per step (chained merges just defer to next step - imperceptible at
// DT=1/60, avoids a fussier algorithm). Also returns minPairDistance as a
// free byproduct, for the "closest approach" system stat.
function checkCollisions(state) {
  const idxs = state.systemBodyIndices;
  const events = [];
  let minPairDistance = Infinity;
  if (idxs.length < 2) return { events, minPairDistance };

  const consumed = new Set();
  for (let a = 0; a < idxs.length; a++) {
    const i = idxs[a];
    if (consumed.has(i)) continue;
    const mi = state.systemMeta[i];
    for (let b = a + 1; b < idxs.length; b++) {
      const j = idxs[b];
      if (consumed.has(j)) continue;
      const mj = state.systemMeta[j];
      const dx = state.x[i] - state.x[j], dy = state.y[i] - state.y[j];
      const distSq = dx * dx + dy * dy;
      if (distSq < minPairDistance * minPairDistance) minPairDistance = Math.sqrt(distSq);

      const rr = mi.collisionRadius + mj.collisionRadius;
      if (distSq >= rr * rr) continue;

      const iMass = state.mass[i], jMass = state.mass[j];
      const winner = iMass >= jMass ? i : j;
      const loser = winner === i ? j : i;
      const wm = state.mass[winner], lm = state.mass[loser];
      const total = wm + lm;
      state.vx[winner] = (state.vx[winner] * wm + state.vx[loser] * lm) / total;
      state.vy[winner] = (state.vy[winner] * wm + state.vy[loser] * lm) / total;
      state.mass[winner] = total;
      const wMeta = state.systemMeta[winner], lMeta = state.systemMeta[loser];
      wMeta.massEarth += lMeta.massEarth;
      wMeta.collisionRadius = collisionRadiusFor(wMeta.massEarth);
      wMeta.radiusPx = planetRadiusPxFor(wMeta.massEarth);
      state.radius[winner] = wMeta.radiusPx;

      events.push({
        winner, loser, loserKind: lMeta.kind, winnerKind: wMeta.kind,
        x: (state.x[i] + state.x[j]) / 2, y: (state.y[i] + state.y[j]) / 2,
      });

      state.alive[loser] = 0;
      state.type[loser] = SYSTEM_EMPTY_TYPE_CODE;
      state.mass[loser] = 1;
      delete state.systemMeta[loser];
      delete state.lockedOrbit[loser];

      consumed.add(i); consumed.add(j);
      break;
    }
  }
  if (consumed.size) {
    const removed = new Set(events.map((e) => e.loser));
    state.systemBodyIndices = idxs.filter((idx) => !removed.has(idx));
  }
  return { events, minPairDistance };
}

// --- Stability classification (shared by getStarInfo's per-body estimate
// and the aggregate system-stats indicator) ---
// Reuses the thresholds already empirically documented in system-bodies.js
// (orbit radius drift stays within ~15% at 15s, ~20-60% at 30s under this
// galaxy's ordinary N-body perturbation) rather than inventing new ones.
function stabilityFor(currentRadius, nominalRadius) {
  if (!nominalRadius || nominalRadius <= 0) return 'unknown';
  const drift = Math.abs(currentRadius / nominalRadius - 1);
  if (drift <= 0.15) return 'stable';
  if (drift <= 0.40) return 'marginal';
  return 'unstable';
}

// The largest nominal orbitRadius among this system's live bodies, or null
// if none - used to scale the proximity-warning threshold to this
// system's own size rather than a fixed sim-unit constant.
function outermostOrbitRadius(state) {
  let max = null;
  for (const idx of state.systemBodyIndices) {
    if (!state.alive[idx]) continue;
    const r = state.systemMeta[idx] && state.systemMeta[idx].orbitRadius;
    if (r && (max === null || r > max)) max = r;
  }
  return max;
}

// --- Proximity warning (surfaces a rare-but-real wandering absorber sweep
// as a diagnosable event instead of planets silently disappearing - see
// physics-worker.js's step() for where this is called each tick a system
// is loaded). Pure distance check: never alters gravity, never repels or
// protects anything, just reports whether one is currently close enough
// to explain instability the user is about to see.
function absorberProximityWarning(state, absorberIndices, hostIdx) {
  if (hostIdx === -1 || !absorberIndices.length) return null;
  const outermost = outermostOrbitRadius(state);
  if (!outermost) return null;
  const threshold = outermost * PROXIMITY_WARNING_RADIUS_MULT;
  const hostX = state.x[hostIdx], hostY = state.y[hostIdx];
  let closest = null;
  for (const idx of absorberIndices) {
    if (!state.alive[idx] || idx === hostIdx) continue;
    const dist = Math.hypot(state.x[idx] - hostX, state.y[idx] - hostY);
    if (dist <= threshold && (!closest || dist < closest.distance)) {
      closest = { index: idx, distance: dist, mass: state.mass[idx] };
    }
  }
  return closest;
}

if (typeof self !== 'undefined') {
  self.findFreeSlot = findFreeSlot;
  self.circularOrbitVelocity = circularOrbitVelocity;
  self.placeBody = placeBody;
  self.buildBodiesSnapshot = buildBodiesSnapshot;
  self.clearSystemBodies = clearSystemBodies;
  self.restoreBodiesFromSnapshot = restoreBodiesFromSnapshot;
  self.pushUndoSnapshot = pushUndoSnapshot;
  self.undo = undo;
  self.createPlanet = createPlanet;
  self.deleteBody = deleteBody;
  self.deleteMoon = deleteMoon;
  self.adjustMass = adjustMass;
  self.cycleColor = cycleColor;
  self.recalcOrbit = recalcOrbit;
  self.lockOrbit = lockOrbit;
  self.unlockOrbit = unlockOrbit;
  self.addAsteroidField = addAsteroidField;
  self.addComet = addComet;
  self.addMoon = addMoon;
  self.checkCollisions = checkCollisions;
  self.stabilityFor = stabilityFor;
  self.outermostOrbitRadius = outermostOrbitRadius;
  self.absorberProximityWarning = absorberProximityWarning;
}
if (typeof module !== 'undefined') {
  module.exports = {
    findFreeSlot, circularOrbitVelocity, placeBody, buildBodiesSnapshot,
    clearSystemBodies, restoreBodiesFromSnapshot, pushUndoSnapshot, undo,
    createPlanet, deleteBody, deleteMoon, adjustMass, cycleColor,
    recalcOrbit, lockOrbit, unlockOrbit, addAsteroidField, addComet,
    addMoon, checkCollisions, stabilityFor, outermostOrbitRadius,
    absorberProximityWarning, MIN_PLACEMENT_RADIUS,
    PROXIMITY_WARNING_RADIUS_MULT,
  };
}
