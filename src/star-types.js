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
  self.pickStarTypeIndex = pickStarTypeIndex;
  self.starTypeByCode = starTypeByCode;
}
if (typeof module !== 'undefined') {
  module.exports = { STAR_TYPES, CORE_TYPE_CODE, pickStarTypeIndex, starTypeByCode };
}
