// star-types.js
// Shared spectral-type table: the single source of truth for stellar
// diversity, used by both the physics worker (generation + lifetime/aging)
// and the main thread (colors, info panel labels). Loaded via a plain
// <script> tag on the page and via importScripts() inside the worker.

// Ordered hottest -> coolest. `weight` is the relative frequency used to
// sample a realistic population (roughly: overwhelmingly cool M dwarfs,
// vanishingly few hot O giants), and must sum to 100.
const STAR_TYPES = [
  { code: 0, label: 'O', colorName: 'Blue',        color: '#4d6dff', mass: 60,  radius: 10.0, lifetime: 1.0e7,  weight: 1 },
  { code: 1, label: 'B', colorName: 'Blue-white',  color: '#a6c0ff', mass: 17,  radius: 6.0,  lifetime: 1.0e8,  weight: 2 },
  { code: 2, label: 'A', colorName: 'White',       color: '#ffffff', mass: 3.2, radius: 4.0,  lifetime: 1.0e9,  weight: 4 },
  { code: 3, label: 'F', colorName: 'Yellow-white',color: '#fff5d1', mass: 1.6, radius: 2.8,  lifetime: 4.0e9,  weight: 7 },
  { code: 4, label: 'G', colorName: 'Yellow',      color: '#ffe066', mass: 1.0, radius: 2.2,  lifetime: 1.0e10, weight: 11 },
  { code: 5, label: 'K', colorName: 'Orange',      color: '#ffa347', mass: 0.7, radius: 1.6,  lifetime: 4.0e10, weight: 15 },
  { code: 6, label: 'M', colorName: 'Red',         color: '#ff4d4d', mass: 0.5, radius: 1.0,  lifetime: 1.0e11, weight: 60 },
];

// Sentinel type code for the central mass (not a spectral-type star: it
// doesn't age, doesn't go supernova, and isn't part of the distribution).
const CORE_TYPE_CODE = 255;

// Sentinel type code for a wandering black hole (also not a spectral-type
// star: immortal, point-mass, absorbs nearby stars instead of aging out).
const BLACKHOLE_TYPE_CODE = 254;

// Rare-event tuning for black holes: rolled per disk-star slot at
// generation time, so the expected count scales with galaxy size
// (0.3% * 500 =~ 1.5, i.e. "1-2 per 500-star galaxy").
const BLACKHOLE_SPAWN_CHANCE = 0.003;
// Spec calls for 1e7 solar masses, but this sim's G (0.6) and distances were
// already calibrated around a much smaller mass range: individual stars top
// out around ~80 and the galaxy's own central anchor is n*60 (30000 for a
// 500-star galaxy). Plugging a literal 1e7 into that SAME G, unmodified,
// makes the black hole ~300x the core - empirically (see scratchpad
// test_bh_calibrate*.js) that devoured 498/500 stars within 10 seconds,
// leaving nothing to "orbit naturally" and defeating the rest of the sim.
// Calibrated down to match the core's own mass instead: still ~400x any
// star (reads as clearly dominant/supermassive), captures a visible stream
// of nearby stars within the first 30s, but leaves most of the galaxy
// intact and orbiting for a multi-minute session. The info panel displays
// this same value, so what's shown always matches what's actually simulated.
const BLACKHOLE_MASS = 30000;
const BLACKHOLE_CAPTURE_RADIUS = 70; // sim units; a star this close is absorbed
// Stylized (not physically accurate) "event horizon" for the info panel -
// real Schwarzschild radii are tiny compared to these sim units, so this is
// an approximation chosen purely for in-panel flavor, as specified.
const BLACKHOLE_EVENT_HORIZON_FACTOR = 3;

// Sentinel type code for a quasar. Physically it's just another black hole -
// same mass, same capture-radius absorption - with different paint and a
// different (cosmetic-only) displayed mass. Rolled per disk-star slot,
// rarer than an ordinary black hole ("1 per 1000 stars").
const QUASAR_TYPE_CODE = 253;
const QUASAR_SPAWN_CHANCE = 0.001;
const QUASAR_MASS = BLACKHOLE_MASS; // same physics as any other black hole
const QUASAR_CAPTURE_RADIUS = BLACKHOLE_CAPTURE_RADIUS;
// "mass = 1e6 in visual scale" per spec - shown in the info panel, never fed
// to gravity (exact precedent: BLACKHOLE_MASS vs. the spec's literal 1e7).
const QUASAR_DISPLAY_MASS = 1e6;

// Sentinel type code for a neutron star: an ordinary, gravitationally
// unremarkable immortal point mass (a few solar masses) - no special
// physics needed, just a distinct, already-dead remnant.
const NEUTRONSTAR_TYPE_CODE = 252;
const NEUTRONSTAR_SPAWN_CHANCE = 0.005; // "2-3 per galaxy" at 500 stars
const NEUTRONSTAR_MASS_MIN = 2;
const NEUTRONSTAR_MASS_MAX = 3;

// Lookup table for the two galaxy-scale exotic types, mirroring STAR_TYPES'
// shape so main.js/renderer.js can look up label/color uniformly.
const EXOTIC_TYPES = [
  { code: QUASAR_TYPE_CODE, label: 'Quasar', color: '#fff7c2', ringColor: 'rgba(255,244,180,0.7)' },
  { code: NEUTRONSTAR_TYPE_CODE, label: 'Neutron Star', color: '#cfe8ff', ringColor: null },
];
function exoticTypeByCode(code) {
  return EXOTIC_TYPES.find((t) => t.code === code) || null;
}

// Sentinel type code for a planet (auto-generated on first zoom into a
// star's system) and for a reserved-but-unpopulated system-body slot.
const PLANET_TYPE_CODE = 251;
const SYSTEM_EMPTY_TYPE_CODE = 250;

// Up to 5 auto-generated planets per star (spec's own stated max) - moons
// are NOT physics bodies (see galaxy-sim README / code comments for why:
// at planet mass ~1e-6x the star, a stable moon orbit sits well inside
// SOFTENING=12, where the 1/r^2 force is nearly flat - moons are rendered
// as pure decoration instead, animated from stored orbital parameters).
const MAX_AUTO_PLANETS = 5;

// Total reserved "system body" pool size (planets + asteroids + comets,
// auto-generated AND user-created, all sharing one dynamic slot pool - see
// physics-worker.js's findFreeSlot()). Deliberately much larger than
// MAX_AUTO_PLANETS: creation tools let a user add asteroid fields/comets/
// custom planets freely during a session, up to the "100 bodies" perf
// target, with headroom. Bumping this costs at most 128 extra (skipped,
// dormant) !alive[i] iterations per physics step, for every galaxy whether
// it's ever zoomed into or not - immaterial next to a 500+ body buildTree().
const SYSTEM_POOL_CAPACITY = 128;

// World-unit collision radius for system-body collision detection - a
// distinct quantity from radiusPx (which is display pixels only).
//
// Tuned empirically (see scratchpad test_collision_tuning.js) against real
// auto-generated systems, not just the orbit-radius spacing formula alone:
// a first pass at 1.5 looked reasonable on paper (nominal adjacent-orbit
// spacing is ~26 units for a 5-planet system) but actually merged planets
// spuriously in ~38% of a 30-trial/5-sim-minute sweep - a rare pair of
// high-mass planets (log-uniform up to 300 M_earth; cbrt(300)~=6.7) drawn
// into adjacent orbit slots already sums to a collision radius (2x1.5x6.7
// ~= 20 units) close enough to that spacing that ordinary jitter+drift
// crossed it. 0.35 keeps that same worst case (2x0.35x6.7 ~= 4.7 units)
// comfortably below nominal spacing while still reliably merging a
// deliberately-overlapping user-placed pair (created a fraction of a
// world unit apart) within a few steps.
const COLLISION_RADIUS_BASE = 0.35;
function collisionRadiusFor(massEarth) {
  return COLLISION_RADIUS_BASE * Math.cbrt(Math.max(0.01, massEarth));
}

// Shared display-size formula (system-bodies.js's auto-generation and
// system-editor.js's creation/mass-adjustment both need it - factored out
// so the two never quietly drift apart).
function planetRadiusPxFor(massEarth) {
  return Math.min(4, Math.max(1.8, 0.9 + Math.cbrt(massEarth) * 0.4));
}

// Asteroid/comet/moon creation-tool tuning.
const ASTEROID_MASS_EARTH = 0.1;
const ASTEROID_BELT_RADIUS = 150;
const ASTEROID_BELT_JITTER = 12; // +/- sim units around the belt radius
const COMET_MASS_EARTH = 1.0;
// A comet is placed near the outer edge of the system with LESS than
// circular-orbit tangential speed at that radius (a fraction of it) - no
// special orbital-mechanics code needed, this alone produces a genuinely
// eccentric ellipse (outer aphelion, close perihelion, back out) under the
// exact same gravity everything else uses. Verified bounded/periodic/no-NaN
// empirically (test_comet_stability.js), not just assumed.
const COMET_SPEED_MULT_MIN = 0.3;
const COMET_SPEED_MULT_MAX = 0.5;
const MOON_MASS_FRACTION = 0.1; // spec: "1/10 of planet"

const UNDO_STACK_LIMIT = 10;

// Gravitational constant baseline + the two "System Experiments" presets.
// Both toggles change this SAME worker-global G that every body's gravity
// already goes through - there is one shared force-calc path in this
// project, on purpose, so "G but only for system-view bodies" would be
// actual special-cased gravity code, which nothing else here does. This is
// therefore a whole-simulation effect, called out explicitly in the UI
// rather than done silently. Low Gravity divides by 4, not literally by
// the same 10x Crazy Physics multiplies by: an abrupt G change on already-
// moving bodies (whose velocity was tuned for the old G) causes real
// re-adjustment regardless of direction, and /4 settles into a visibly
// "weaker, slower, more spread out" regime without reading as pure chaos -
// which would undercut the contrast with Crazy Physics.
const DEFAULT_G = 0.6;
const CRAZY_PHYSICS_G_MULT = 10;
const LOW_GRAVITY_G_DIV = 4;

const SHARE_FORMAT_VERSION = 1;

// 1 Earth mass in this sim's solar-mass-scaled units. A real, principled
// conversion (not an empirical fudge like BLACKHOLE_MASS) - it's what keeps
// a "300 Earth mass" giant planet from ever perturbing its star: even the
// heaviest generated planet is < 0.1% of the lightest star's mass.
const EARTH_MASS_IN_SOLAR = 3.003e-6;

// Planet composition/color categories (spec: "blue=water, brown=rocky,
// red=iron, gray=airless"), each biased toward a temperature band so hot,
// close-in planets read as iron/rocky and cold, distant ones read as
// icy/airless - a bit more narratively coherent than a pure coin-flip.
// 'airless' is the most common composition by far (~60% of generated
// planets, since its temp band [0,260] covers most typical orbit
// distances) - its color got brightened from a muted #9a9a9a to this
// lighter silver specifically because that combination (majority
// composition + tiny dot + dim color) was the main reason planets read as
// "invisible" against the near-black background, even though they were
// rendering at the mathematically correct position all along.
const PLANET_COMPOSITIONS = [
  { key: 'water', color: '#4d8dff', tempBias: [180, 320] },
  { key: 'rocky', color: '#a67a4d', tempBias: [280, 600] },
  { key: 'iron', color: '#c0392b', tempBias: [400, 900] },
  { key: 'airless', color: '#c9ced6', tempBias: [0, 260] },
];

// "Change Color" (right-click menu / C key) cycles through the same 4
// composition presets already used for auto-generation - no new palette.
function cyclePlanetColor(currentKey) {
  const i = PLANET_COMPOSITIONS.findIndex((c) => c.key === currentKey);
  return PLANET_COMPOSITIONS[(i + 1 + PLANET_COMPOSITIONS.length) % PLANET_COMPOSITIONS.length];
}

// Cumulative weights for O(types) weighted sampling, e.g. [1,3,7,14,25,40,100].
const STAR_TYPE_CUMULATIVE = (() => {
  let sum = 0;
  return STAR_TYPES.map((t) => (sum += t.weight));
})();

// Generic weighted-index sampler, factored out of pickStarTypeIndex so
// galaxy-morphology.js can supply a per-morphology weight table (ellipticals
// skew old/red, spirals keep the default incl. O/B, etc.) without
// duplicating the cumulative-sum-and-pick algorithm itself. `cumulative`
// need not sum to 100 - only relative magnitude matters.
function pickWeightedIndex(rand, cumulative) {
  const r = rand() * cumulative[cumulative.length - 1];
  for (let i = 0; i < cumulative.length; i++) {
    if (r <= cumulative[i]) return i;
  }
  return cumulative.length - 1;
}

// Pick a spectral type index using the supplied rand() source (0..1).
function pickStarTypeIndex(rand) {
  return pickWeightedIndex(rand, STAR_TYPE_CUMULATIVE);
}

// --- Galaxy morphology (Cosmic Web Sandbox) ---
// Per-morphology spectral-type weight overrides, same [O,B,A,F,G,K,M] order
// as STAR_TYPES. `null` means "use the default STAR_TYPE_CUMULATIVE as-is"
// (spiral - unchanged from the original single-galaxy behavior). These are
// narrative/visual biases, not physically load-bearing the way gravity
// tuning is - ellipticals skew heavily toward old K/M stars (real ellipticals
// are dominated by an old, red population with little ongoing star
// formation), irregulars are flatter/more chaotic, lenticular sits between
// spiral and elliptical.
const GALAXY_MORPHOLOGIES = ['spiral', 'elliptical', 'irregular', 'lenticular'];
const MORPHOLOGY_STAR_WEIGHTS = {
  spiral: null,
  elliptical: [0.1, 0.2, 0.5, 2, 6, 26, 65.2],
  irregular: [8, 10, 12, 14, 16, 18, 22],
  lenticular: [0.5, 1, 2, 5, 12, 28, 51.5],
};
const MORPHOLOGY_STAR_CUMULATIVE = (() => {
  const out = {};
  for (const key of GALAXY_MORPHOLOGIES) {
    const weights = MORPHOLOGY_STAR_WEIGHTS[key];
    if (!weights) { out[key] = STAR_TYPE_CUMULATIVE; continue; }
    let sum = 0;
    out[key] = weights.map((w) => (sum += w));
  }
  return out;
})();
function pickStarTypeIndexForMorphology(rand, morphology) {
  return pickWeightedIndex(rand, MORPHOLOGY_STAR_CUMULATIVE[morphology] || STAR_TYPE_CUMULATIVE);
}

// Cosmic-view galaxy-dot colors, keyed by morphology (spec: blue=spiral,
// red=elliptical, yellow=irregular; lenticular isn't specified in the spec -
// pale/white chosen as a fourth visually-distinct color, reading as "between"
// spiral-blue and elliptical-red).
const GALAXY_MORPHOLOGY_COLORS = {
  spiral: '#5d8dff',
  elliptical: '#ff6b4d',
  irregular: '#ffd24d',
  lenticular: '#e8e8f0',
};

function starTypeByCode(code) {
  return code === CORE_TYPE_CODE ? null : STAR_TYPES[code];
}

if (typeof self !== 'undefined') {
  self.STAR_TYPES = STAR_TYPES;
  self.CORE_TYPE_CODE = CORE_TYPE_CODE;
  self.BLACKHOLE_TYPE_CODE = BLACKHOLE_TYPE_CODE;
  self.BLACKHOLE_SPAWN_CHANCE = BLACKHOLE_SPAWN_CHANCE;
  self.BLACKHOLE_MASS = BLACKHOLE_MASS;
  self.BLACKHOLE_CAPTURE_RADIUS = BLACKHOLE_CAPTURE_RADIUS;
  self.BLACKHOLE_EVENT_HORIZON_FACTOR = BLACKHOLE_EVENT_HORIZON_FACTOR;
  self.pickStarTypeIndex = pickStarTypeIndex;
  self.starTypeByCode = starTypeByCode;
  self.QUASAR_TYPE_CODE = QUASAR_TYPE_CODE;
  self.QUASAR_SPAWN_CHANCE = QUASAR_SPAWN_CHANCE;
  self.QUASAR_MASS = QUASAR_MASS;
  self.QUASAR_CAPTURE_RADIUS = QUASAR_CAPTURE_RADIUS;
  self.QUASAR_DISPLAY_MASS = QUASAR_DISPLAY_MASS;
  self.NEUTRONSTAR_TYPE_CODE = NEUTRONSTAR_TYPE_CODE;
  self.NEUTRONSTAR_SPAWN_CHANCE = NEUTRONSTAR_SPAWN_CHANCE;
  self.NEUTRONSTAR_MASS_MIN = NEUTRONSTAR_MASS_MIN;
  self.NEUTRONSTAR_MASS_MAX = NEUTRONSTAR_MASS_MAX;
  self.EXOTIC_TYPES = EXOTIC_TYPES;
  self.exoticTypeByCode = exoticTypeByCode;
  self.PLANET_TYPE_CODE = PLANET_TYPE_CODE;
  self.SYSTEM_EMPTY_TYPE_CODE = SYSTEM_EMPTY_TYPE_CODE;
  self.MAX_AUTO_PLANETS = MAX_AUTO_PLANETS;
  self.SYSTEM_POOL_CAPACITY = SYSTEM_POOL_CAPACITY;
  self.COLLISION_RADIUS_BASE = COLLISION_RADIUS_BASE;
  self.collisionRadiusFor = collisionRadiusFor;
  self.planetRadiusPxFor = planetRadiusPxFor;
  self.ASTEROID_MASS_EARTH = ASTEROID_MASS_EARTH;
  self.ASTEROID_BELT_RADIUS = ASTEROID_BELT_RADIUS;
  self.ASTEROID_BELT_JITTER = ASTEROID_BELT_JITTER;
  self.COMET_MASS_EARTH = COMET_MASS_EARTH;
  self.COMET_SPEED_MULT_MIN = COMET_SPEED_MULT_MIN;
  self.COMET_SPEED_MULT_MAX = COMET_SPEED_MULT_MAX;
  self.MOON_MASS_FRACTION = MOON_MASS_FRACTION;
  self.UNDO_STACK_LIMIT = UNDO_STACK_LIMIT;
  self.DEFAULT_G = DEFAULT_G;
  self.CRAZY_PHYSICS_G_MULT = CRAZY_PHYSICS_G_MULT;
  self.LOW_GRAVITY_G_DIV = LOW_GRAVITY_G_DIV;
  self.SHARE_FORMAT_VERSION = SHARE_FORMAT_VERSION;
  self.EARTH_MASS_IN_SOLAR = EARTH_MASS_IN_SOLAR;
  self.PLANET_COMPOSITIONS = PLANET_COMPOSITIONS;
  self.cyclePlanetColor = cyclePlanetColor;
  self.pickWeightedIndex = pickWeightedIndex;
  self.GALAXY_MORPHOLOGIES = GALAXY_MORPHOLOGIES;
  self.MORPHOLOGY_STAR_WEIGHTS = MORPHOLOGY_STAR_WEIGHTS;
  self.pickStarTypeIndexForMorphology = pickStarTypeIndexForMorphology;
  self.GALAXY_MORPHOLOGY_COLORS = GALAXY_MORPHOLOGY_COLORS;
}
if (typeof module !== 'undefined') {
  module.exports = {
    STAR_TYPES, CORE_TYPE_CODE, pickStarTypeIndex, starTypeByCode,
    BLACKHOLE_TYPE_CODE, BLACKHOLE_SPAWN_CHANCE, BLACKHOLE_MASS,
    BLACKHOLE_CAPTURE_RADIUS, BLACKHOLE_EVENT_HORIZON_FACTOR,
    QUASAR_TYPE_CODE, QUASAR_SPAWN_CHANCE, QUASAR_MASS, QUASAR_CAPTURE_RADIUS,
    QUASAR_DISPLAY_MASS, NEUTRONSTAR_TYPE_CODE, NEUTRONSTAR_SPAWN_CHANCE,
    NEUTRONSTAR_MASS_MIN, NEUTRONSTAR_MASS_MAX, EXOTIC_TYPES, exoticTypeByCode,
    PLANET_TYPE_CODE, SYSTEM_EMPTY_TYPE_CODE, MAX_AUTO_PLANETS,
    SYSTEM_POOL_CAPACITY, COLLISION_RADIUS_BASE, collisionRadiusFor, planetRadiusPxFor,
    ASTEROID_MASS_EARTH, ASTEROID_BELT_RADIUS, ASTEROID_BELT_JITTER,
    COMET_MASS_EARTH, COMET_SPEED_MULT_MIN, COMET_SPEED_MULT_MAX,
    MOON_MASS_FRACTION, UNDO_STACK_LIMIT, DEFAULT_G, CRAZY_PHYSICS_G_MULT,
    LOW_GRAVITY_G_DIV, SHARE_FORMAT_VERSION,
    EARTH_MASS_IN_SOLAR, PLANET_COMPOSITIONS, cyclePlanetColor,
    pickWeightedIndex, GALAXY_MORPHOLOGIES, MORPHOLOGY_STAR_WEIGHTS,
    pickStarTypeIndexForMorphology, GALAXY_MORPHOLOGY_COLORS,
  };
}
