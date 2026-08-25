// cosmic-editor.js
// Cosmic Web Sandbox: create/delete/merge/collide/rename/retype/rescale
// and undo for cosmic-layer galaxy records - mirrors system-editor.js's
// conventions exactly (pure(ish) functions operating on a passed-in
// `cosmicState`, a 10-entry undo stack, the same momentum-conserving merge
// rule system-editor.js's checkCollisions already uses one level down).
//
// Runs inside the physics worker (importScripts, loaded after
// cosmic-web.js so GALAXY_MORPHOLOGIES/UNDO_STACK_LIMIT are already in
// scope as globals).

/* global GALAXY_MORPHOLOGIES, UNDO_STACK_LIMIT, GALAXY_MASS_MIN, GALAXY_MASS_MAX */
if (typeof module !== 'undefined' && typeof GALAXY_MORPHOLOGIES === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (importScripts shared-scope
  // gotcha - a redeclaration here would be a SyntaxError in the worker).
  Object.assign(globalThis, require('./star-types.js'));
  Object.assign(globalThis, require('./galaxy.js'));
  Object.assign(globalThis, require('./galaxy-morphology.js'));
  Object.assign(globalThis, require('./cosmic-web.js'));
}

function findGalaxyIndex(cosmicState, galaxyId) {
  return cosmicState.galaxies.findIndex((g) => g.id === galaxyId);
}
function findGalaxy(cosmicState, galaxyId) {
  const i = findGalaxyIndex(cosmicState, galaxyId);
  return i === -1 ? null : cosmicState.galaxies[i];
}

// --- Undo stack (same 10-entry design as system-editor.js's) ---

function pushCosmicUndoSnapshot(cosmicState) {
  cosmicState.undoStack.push({
    nextCustomId: cosmicState.nextCustomId,
    galaxies: cosmicState.galaxies.map((g) => ({ ...g })), // shallow clones - every field is a primitive
  });
  if (cosmicState.undoStack.length > UNDO_STACK_LIMIT) cosmicState.undoStack.shift();
}

function undoCosmic(cosmicState) {
  if (!cosmicState.undoStack.length) return false;
  const entry = cosmicState.undoStack.pop();
  cosmicState.nextCustomId = entry.nextCustomId;
  cosmicState.galaxies = entry.galaxies.map((g) => ({ ...g }));
  return true;
}

// --- Create / delete ---

function createGalaxy(cosmicState, x, y, morphology) {
  const validMorphology = GALAXY_MORPHOLOGIES.includes(morphology) ? morphology : 'spiral';
  const id = cosmicState.nextCustomId++;
  const galaxy = {
    id,
    name: `Custom-${id}`,
    x, y, vx: 0, vy: 0,
    mass: (GALAXY_MASS_MIN + GALAXY_MASS_MAX) / 2,
    morphology: validMorphology,
    starCount: 500,
    clusterIndex: -1, // user-placed - not gravitationally anchored to any cosmic-web cluster
  };
  cosmicState.galaxies.push(galaxy);
  return { ...galaxy };
}

// Returns the removed galaxy's summary (id/name/x/y/mass) for the caller's
// visual feedback (delete-fade, same pattern deleteBody() already uses one
// level down), or null if not found. Caller is responsible for evicting
// this galaxy's star-level `state` FIRST if it's the currently-loaded one
// (see physics-worker.js's message handlers) - a stale loaded `state` for
// a galaxy that no longer exists in cosmicState would silently leak.
function deleteGalaxy(cosmicState, galaxyId) {
  const idx = findGalaxyIndex(cosmicState, galaxyId);
  if (idx === -1) return null;
  const [removed] = cosmicState.galaxies.splice(idx, 1);
  return { id: removed.id, name: removed.name, x: removed.x, y: removed.y, mass: removed.mass };
}

// --- Editing ---

function renameGalaxy(cosmicState, galaxyId, name) {
  const g = findGalaxy(cosmicState, galaxyId);
  if (!g || !name) return null;
  g.name = String(name).slice(0, 40);
  return { ...g };
}

function changeGalaxyType(cosmicState, galaxyId, morphology) {
  const g = findGalaxy(cosmicState, galaxyId);
  if (!g || !GALAXY_MORPHOLOGIES.includes(morphology)) return null;
  g.morphology = morphology;
  return { ...g };
}

// "Increase Mass (more stars spawn)" per spec - scales both mass and
// starCount together so a heavier galaxy also reads as a bigger one once
// entered, not just a cosmic-view number change.
function adjustGalaxyMass(cosmicState, galaxyId, multiplier) {
  const g = findGalaxy(cosmicState, galaxyId);
  if (!g) return null;
  g.mass = Math.max(GALAXY_MASS_MIN * 0.1, Math.min(GALAXY_MASS_MAX * 5, g.mass * multiplier));
  g.starCount = Math.max(50, Math.min(3000, Math.round(g.starCount * multiplier)));
  return { ...g };
}

// --- Merge / collision ---
// Both operate on cosmic-layer point masses only - two galaxies' star-level
// data is never loaded/simulated together (an explicit scope decision, see
// the Cosmic Web Sandbox plan). Same mass-weighted-centroid, momentum-
// conserving rule system-editor.js's checkCollisions already uses for
// system bodies one level down. "Collision" and "Merge Galaxies" produce
// the SAME underlying result - the caller (physics-worker.js) fires an
// extra cosmetic event for "Collision" (particle burst/wobble) that "Merge
// Galaxies" skips, per the explicit scope decision made for this feature
// (no real dual-galaxy star-level collision physics).
//
// Merged result becomes 'irregular' morphology - astronomically motivated
// (real galaxy mergers famously produce irregular/starburst remnants), a
// deliberate default since the spec doesn't specify a resulting type.
function mergeGalaxies(cosmicState, idA, idB) {
  if (idA === idB) return null;
  const ia = findGalaxyIndex(cosmicState, idA), ib = findGalaxyIndex(cosmicState, idB);
  if (ia === -1 || ib === -1) return null;
  const a = cosmicState.galaxies[ia], b = cosmicState.galaxies[ib];
  const totalMass = a.mass + b.mass;
  const merged = {
    id: cosmicState.nextCustomId++,
    name: `${a.name}+${b.name}`.slice(0, 40),
    x: (a.x * a.mass + b.x * b.mass) / totalMass,
    y: (a.y * a.mass + b.y * b.mass) / totalMass,
    vx: (a.vx * a.mass + b.vx * b.mass) / totalMass,
    vy: (a.vy * a.mass + b.vy * b.mass) / totalMass,
    mass: totalMass,
    morphology: 'irregular',
    starCount: a.starCount + b.starCount,
    clusterIndex: a.clusterIndex >= 0 ? a.clusterIndex : b.clusterIndex,
  };
  // Remove the higher index first so the lower index's splice position
  // doesn't shift out from under it.
  const [hi, lo] = ia > ib ? [ia, ib] : [ib, ia];
  cosmicState.galaxies.splice(hi, 1);
  cosmicState.galaxies.splice(lo, 1);
  cosmicState.galaxies.push(merged);
  return { removedIds: [idA, idB], merged: { ...merged } };
}

if (typeof self !== 'undefined') {
  self.pushCosmicUndoSnapshot = pushCosmicUndoSnapshot;
  self.undoCosmic = undoCosmic;
  self.createGalaxy = createGalaxy;
  self.deleteGalaxy = deleteGalaxy;
  self.renameGalaxy = renameGalaxy;
  self.changeGalaxyType = changeGalaxyType;
  self.adjustGalaxyMass = adjustGalaxyMass;
  self.mergeGalaxies = mergeGalaxies;
}
if (typeof module !== 'undefined') {
  module.exports = {
    pushCosmicUndoSnapshot, undoCosmic, createGalaxy, deleteGalaxy,
    renameGalaxy, changeGalaxyType, adjustGalaxyMass, mergeGalaxies,
  };
}
