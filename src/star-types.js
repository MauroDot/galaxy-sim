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

// Cumulative weights for O(types) weighted sampling, e.g. [1,3,7,14,25,40,100].
const STAR_TYPE_CUMULATIVE = (() => {
  let sum = 0;
  return STAR_TYPES.map((t) => (sum += t.weight));
})();

// Pick a spectral type index using the supplied rand() source (0..1).
function pickStarTypeIndex(rand) {
  const r = rand() * STAR_TYPE_CUMULATIVE[STAR_TYPE_CUMULATIVE.length - 1];
  for (let i = 0; i < STAR_TYPE_CUMULATIVE.length; i++) {
    if (r <= STAR_TYPE_CUMULATIVE[i]) return i;
  }
  return STAR_TYPES.length - 1;
}

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
}
if (typeof module !== 'undefined') {
  module.exports = {
    STAR_TYPES, CORE_TYPE_CODE, pickStarTypeIndex, starTypeByCode,
    BLACKHOLE_TYPE_CODE, BLACKHOLE_SPAWN_CHANCE, BLACKHOLE_MASS,
    BLACKHOLE_CAPTURE_RADIUS, BLACKHOLE_EVENT_HORIZON_FACTOR,
  };
}
