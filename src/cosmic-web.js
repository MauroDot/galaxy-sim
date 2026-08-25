// cosmic-web.js
// Cosmic Web Sandbox: generates a universe of 20-50 galaxies laid out in a
// cosmic-web-like pattern (cluster/filament/void), and steps their mutual
// gravity as a small, separate simulation layer alongside (not instead of)
// the existing per-galaxy star-level `state` in physics-worker.js.
//
// Coordinate frames are deliberately NOT unified with per-galaxy star data:
// a galaxy's own star-level simulation always stays in its own local frame
// (core pinned at that galaxy's own (0,0), exactly as today). "Cosmic
// position" here is a property only of this lightweight layer - used for
// the cosmic camera and inter-galaxy gravity, never merged into one flat
// coordinate space with star positions. See the Cosmic Web Sandbox plan's
// Context section for why (there's no continuous function between a
// galaxy's cosmic-plane position and its own pinned-at-origin star frame).
//
// Runs inside the physics worker (importScripts, loaded after
// galaxy-morphology.js so mulberry32/hashSeed/GALAXY_MORPHOLOGIES/
// GALAXY_MORPHOLOGY_COLORS are already in scope as globals).

/* global mulberry32, hashSeed, GALAXY_MORPHOLOGIES, DEFAULT_G */
if (typeof module !== 'undefined' && typeof mulberry32 === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (importScripts shared-scope
  // gotcha - a redeclaration here would be a SyntaxError in the worker).
  Object.assign(globalThis, require('./star-types.js'));
  Object.assign(globalThis, require('./galaxy.js'));
  Object.assign(globalThis, require('./galaxy-morphology.js'));
}

// --- Tunables ---
// Universe plane extent (spec: "100,000 x 100,000 unit 2D plane"). Only
// ever used by this cosmic layer's own layout/camera math - never by
// per-galaxy star generation, which stays in its own small local frame
// regardless of where its host galaxy sits on this plane.
const UNIVERSE_PLANE_SIZE = 100000;
const UNIVERSE_PLANE_HALF = UNIVERSE_PLANE_SIZE / 2;

// Target galaxy-to-galaxy spacing (spec: "1,000-10,000 units"). Enforced
// via a minimum-separation rejection/nudge pass in layoutUniverse() and
// verified empirically (scratchpad test_cosmic_web.js measures actual
// nearest-neighbor distances across many seeds), not just assumed from
// the scatter parameters alone - same discipline the galaxy-morphology
// tuning needed in practice, applied proactively here from the start.
const MIN_GALAXY_SEPARATION = 1200;
const CLUSTER_CENTER_COUNT_MIN = 3;
const CLUSTER_CENTER_COUNT_MAX = 6;
const CLUSTER_JITTER = 6000; // spread of galaxies around a cluster center
const FILAMENT_JITTER = 2500; // perpendicular spread of galaxies along a filament segment

// Galaxy point-mass scale. ~3-5x a single galaxy's own centralMass
// (n*60 -> ~30000-180000 for typical star counts) - large enough to read
// as "a whole galaxy" and dominate cosmic-layer dynamics, small enough
// that this layer's G/softening stay in the same numeric ballpark as the
// existing per-galaxy sim rather than needing an unrelated force law.
const GALAXY_MASS_MIN = 8e4;
const GALAXY_MASS_MAX = 4e5;

// Two to three orders of magnitude above the per-galaxy SOFTENING=12,
// matching the fact that typical galaxy-to-galaxy spacing (1,000-10,000)
// is two to three orders of magnitude above typical intra-galaxy spacing
// (tens to hundreds) - avoids close-encounter singularities between
// clustered galaxies without flattening the force at typical spacing.
const COSMIC_SOFTENING = 300;

// Worked check (see plan Context item 2): at r=3000, M=137500 (mid-range
// of GALAXY_MASS_MIN/MAX), G=DEFAULT_G=0.6: v=sqrt(0.6*137500/3000)~=5.24
// units/s, period T=2*pi*r/v~=3600s (~1hr at 1x) - "orbit each other
// slowly", verified empirically in test_cosmic_web.js by measuring actual
// angular displacement over many steps, not just asserted from this formula.
const COSMIC_SPEED_MIN = 0.85;
const COSMIC_SPEED_MAX = 1.0;

/**
 * Cluster centers scattered across the plane (kept away from the very
 * edges so filament segments and cluster jitter don't push galaxies off
 * the plane entirely).
 */
function generateClusterCenters(rand) {
  const count = CLUSTER_CENTER_COUNT_MIN + Math.floor(rand() * (CLUSTER_CENTER_COUNT_MAX - CLUSTER_CENTER_COUNT_MIN + 1));
  const centers = [];
  const margin = UNIVERSE_PLANE_HALF * 0.25;
  for (let i = 0; i < count; i++) {
    centers.push({
      x: (rand() * 2 - 1) * (UNIVERSE_PLANE_HALF - margin),
      y: (rand() * 2 - 1) * (UNIVERSE_PLANE_HALF - margin),
    });
  }
  return centers;
}

/**
 * Filament segments: pairs of cluster centers within a reasonable distance
 * of each other, connected by a line - galaxies placed "along a filament"
 * scatter linearly along one of these segments instead of clustering
 * tightly at either end.
 */
function generateFilaments(centers, rand) {
  const filaments = [];
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const dx = centers[j].x - centers[i].x, dy = centers[j].y - centers[i].y;
      const dist = Math.hypot(dx, dy);
      // Only connect reasonably-nearby cluster pairs, not every pair -
      // otherwise every cluster ends up linked to every other one and
      // "filaments" stop reading as a sparse web.
      if (dist < UNIVERSE_PLANE_SIZE * 0.6 && rand() < 0.55) {
        filaments.push({ a: centers[i], b: centers[j] });
      }
    }
  }
  return filaments;
}

function randnLocal(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One candidate position: near a cluster center (dense), along a filament
 * segment (linear scatter), or rarely isolated in a void (uniform across
 * the whole plane).
 */
function candidatePosition(rand, centers, filaments) {
  const roll = rand();
  if (roll < 0.55 && centers.length) {
    const c = centers[Math.floor(rand() * centers.length)];
    return {
      x: c.x + randnLocal(rand) * CLUSTER_JITTER,
      y: c.y + randnLocal(rand) * CLUSTER_JITTER,
      clusterIndex: centers.indexOf(c),
    };
  }
  if (roll < 0.9 && filaments.length) {
    const f = filaments[Math.floor(rand() * filaments.length)];
    const t = rand(); // position along the segment, 0..1
    const mx = f.a.x + (f.b.x - f.a.x) * t, my = f.a.y + (f.b.y - f.a.y) * t;
    // Perpendicular jitter, not radial - keeps the scatter reading as a
    // line/filament rather than a blob.
    const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const j = randnLocal(rand) * FILAMENT_JITTER;
    return { x: mx + px * j, y: my + py * j, clusterIndex: -1 };
  }
  // Void: rare, isolated, uniform across the whole plane.
  return {
    x: (rand() * 2 - 1) * UNIVERSE_PLANE_HALF,
    y: (rand() * 2 - 1) * UNIVERSE_PLANE_HALF,
    clusterIndex: -1,
  };
}

/**
 * Lays out `count` galaxies across the plane using the cluster/filament/void
 * pattern above, enforcing MIN_GALAXY_SEPARATION via rejection+resample
 * (cheap at this scale - at most a few dozen candidates ever get rejected).
 * Returns [{x, y, clusterIndex}] - clusterIndex is -1 for filament/void
 * galaxies, or the index into `centers` for cluster members (used below to
 * assign a per-cluster orbital velocity).
 */
function layoutGalaxyPositions(rand, count, centers, filaments) {
  const positions = [];
  const maxAttemptsPerGalaxy = 40;
  for (let i = 0; i < count; i++) {
    let placed = null;
    for (let attempt = 0; attempt < maxAttemptsPerGalaxy; attempt++) {
      const candidate = candidatePosition(rand, centers, filaments);
      let tooClose = false;
      for (const p of positions) {
        const d = Math.hypot(candidate.x - p.x, candidate.y - p.y);
        if (d < MIN_GALAXY_SEPARATION) { tooClose = true; break; }
      }
      if (!tooClose) { placed = candidate; break; }
    }
    // Pool exhausted (extremely unlikely at 20-50 galaxies across a
    // 100,000-unit plane) - place it anyway rather than silently dropping
    // a galaxy; a slightly-too-close pair is a cosmetic imperfection, not
    // a correctness bug (cosmic-layer gravity uses COSMIC_SOFTENING
    // specifically so a close pair doesn't blow up).
    positions.push(placed || candidatePosition(rand, centers, filaments));
  }
  return positions;
}

const GALAXY_NAME_SYLLABLES = [
  'And', 'Cen', 'Dra', 'Eri', 'Gal', 'Hydra', 'Leo', 'Lyra', 'Nova', 'Orion',
  'Perse', 'Sculp', 'Tri', 'Vel', 'Vira', 'Zeta',
];
function generateGalaxyName(rand, index) {
  const a = GALAXY_NAME_SYLLABLES[Math.floor(rand() * GALAXY_NAME_SYLLABLES.length)];
  const b = GALAXY_NAME_SYLLABLES[Math.floor(rand() * GALAXY_NAME_SYLLABLES.length)];
  return `${a}${b}-${index + 1}`;
}

/**
 * Generates a full universe: galaxy records (position/velocity/mass/
 * morphology/name/starCount), deterministic from `seed`. Does NOT generate
 * any galaxy's internal star-level state - that happens on demand when a
 * galaxy is actually entered (see physics-worker.js's enterGalaxy,
 * mirroring enterSystem's on-demand generate-or-restore pattern).
 *
 * @param {number|string} seed
 * @param {object} [opts]
 * @param {number} [opts.galaxyCount] - 20-50 per spec, default 32
 * @returns {{galaxies: Array<{id, name, x, y, vx, vy, mass, morphology, starCount, clusterIndex}>}}
 */
function generateUniverse(seed, opts = {}) {
  const rand = mulberry32(hashSeed(seed));
  const count = Math.max(1, Math.min(100, opts.galaxyCount ?? 32));
  const G = opts.G ?? DEFAULT_G;

  const centers = generateClusterCenters(rand);
  const filaments = generateFilaments(centers, rand);
  const positions = layoutGalaxyPositions(rand, count, centers, filaments);

  // Each cluster's total mass (for assigning member galaxies a circular
  // velocity around it) is computed AFTER every galaxy's mass is rolled,
  // so it reflects what was actually generated - but unlike the star-level
  // "empirically measured enclosed mass" approach that caused real
  // instability for irregular galaxies (see galaxy-morphology.js), this is
  // safe: galaxy-to-galaxy separation is explicitly bounded well above
  // MIN_GALAXY_SEPARATION by the layout pass above, so there's no dense
  // local crowding to destabilize - the failure mode that mattered at
  // star-cluster scale doesn't apply at this much sparser scale.
  const galaxies = [];
  for (let i = 0; i < count; i++) {
    const morphology = GALAXY_MORPHOLOGIES[Math.floor(rand() * GALAXY_MORPHOLOGIES.length)];
    const mass = GALAXY_MASS_MIN + rand() * (GALAXY_MASS_MAX - GALAXY_MASS_MIN);
    const starCount = 300 + Math.floor(rand() * 700); // 300-1000, per spec's galaxy-scale budget
    galaxies.push({
      id: i,
      name: generateGalaxyName(rand, i),
      x: positions[i].x, y: positions[i].y,
      vx: 0, vy: 0, // filled in below
      mass, morphology, starCount,
      clusterIndex: positions[i].clusterIndex,
    });
  }

  const clusterMass = new Array(centers.length).fill(0);
  const clusterCentroid = centers.map(() => ({ x: 0, y: 0, weight: 0 }));
  for (const g of galaxies) {
    if (g.clusterIndex >= 0) {
      clusterMass[g.clusterIndex] += g.mass;
      const c = clusterCentroid[g.clusterIndex];
      c.x += g.x * g.mass; c.y += g.y * g.mass; c.weight += g.mass;
    }
  }
  for (const c of clusterCentroid) {
    if (c.weight > 0) { c.x /= c.weight; c.y /= c.weight; }
  }

  for (const g of galaxies) {
    if (g.clusterIndex < 0) {
      // Filament/void galaxy: no strong single local anchor to orbit -
      // a slow, mostly-random drift rather than a fabricated orbit around
      // something that isn't really there gravitationally.
      g.vx = (rand() - 0.5) * 0.6;
      g.vy = (rand() - 0.5) * 0.6;
      continue;
    }
    const c = clusterCentroid[g.clusterIndex];
    const dx = g.x - c.x, dy = g.y - c.y;
    const r = Math.hypot(dx, dy);
    const theta = Math.atan2(dy, dx);
    const vCirc = Math.sqrt((G * clusterMass[g.clusterIndex]) / (r + COSMIC_SOFTENING));
    const speed = vCirc * (COSMIC_SPEED_MIN + rand() * (COSMIC_SPEED_MAX - COSMIC_SPEED_MIN));
    // Ordered rotation (single direction per cluster) - crossing orbits
    // within a cluster were the single biggest source of instability found
    // while tuning galaxy-morphology.js's irregular galaxies; no reason to
    // reintroduce that risk here when a real visual "orbiting" read doesn't
    // need mixed directions.
    g.vx = -Math.sin(theta) * speed;
    g.vy = Math.cos(theta) * speed;
  }

  return { galaxies, centers, filaments };
}

/**
 * Advances cosmic-layer gravity by one fixed step (same DT the rest of the
 * sim uses). O(g^2) pairwise - at up to ~100 galaxies that's <=10,000 pair
 * checks per step, immaterial next to the existing per-galaxy Barnes-Hut
 * cost. Mutates `galaxies` in place. `G` is passed in (not read from a
 * module-level default) so it can share the same mutable G "System
 * Experiments" (Crazy Physics/Low Gravity) already scales for the rest of
 * the simulation - one shared force-calc principle, not a special case.
 */
function cosmicStep(galaxies, G, DT) {
  const n = galaxies.length;
  const fx = new Float64Array(n), fy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gi = galaxies[i];
    for (let j = i + 1; j < n; j++) {
      const gj = galaxies[j];
      const dx = gj.x - gi.x, dy = gj.y - gi.y;
      const distSq = dx * dx + dy * dy + COSMIC_SOFTENING * COSMIC_SOFTENING;
      const dist = Math.sqrt(distSq);
      const f = (G * gi.mass * gj.mass) / distSq;
      const fxi = (f * dx) / dist, fyi = (f * dy) / dist;
      fx[i] += fxi; fy[i] += fyi;
      fx[j] -= fxi; fy[j] -= fyi;
    }
  }
  for (let i = 0; i < n; i++) {
    const g = galaxies[i];
    g.vx += (fx[i] / g.mass) * DT;
    g.vy += (fy[i] / g.mass) * DT;
    g.x += g.vx * DT;
    g.y += g.vy * DT;
  }
}

if (typeof self !== 'undefined') {
  self.UNIVERSE_PLANE_SIZE = UNIVERSE_PLANE_SIZE;
  self.MIN_GALAXY_SEPARATION = MIN_GALAXY_SEPARATION;
  self.COSMIC_SOFTENING = COSMIC_SOFTENING;
  self.GALAXY_MASS_MIN = GALAXY_MASS_MIN;
  self.GALAXY_MASS_MAX = GALAXY_MASS_MAX;
  self.generateUniverse = generateUniverse;
  self.cosmicStep = cosmicStep;
}
if (typeof module !== 'undefined') {
  module.exports = {
    UNIVERSE_PLANE_SIZE, MIN_GALAXY_SEPARATION, COSMIC_SOFTENING,
    GALAXY_MASS_MIN, GALAXY_MASS_MAX, generateUniverse, cosmicStep,
  };
}
