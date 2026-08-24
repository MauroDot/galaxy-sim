// galaxy.js
// Seeded procedural generation of a spiral-galaxy initial condition.
// Runs inside the physics worker (loaded via importScripts, after
// star-types.js so STAR_TYPES/CORE_TYPE_CODE/pickStarTypeIndex are already
// in scope as globals).

/* global STAR_TYPES, CORE_TYPE_CODE, pickStarTypeIndex, BLACKHOLE_TYPE_CODE,
   BLACKHOLE_SPAWN_CHANCE, BLACKHOLE_MASS, QUASAR_TYPE_CODE,
   QUASAR_SPAWN_CHANCE, QUASAR_MASS, NEUTRONSTAR_TYPE_CODE,
   NEUTRONSTAR_SPAWN_CHANCE, NEUTRONSTAR_MASS_MIN, NEUTRONSTAR_MASS_MAX */
// Node/CommonJS test-harness path only (browsers/workers get these as
// globals via importScripts, since star-types.js is loaded first there).
// This intentionally avoids any top-level var/let/const of its own: in a
// Worker, importScripts shares one global scope across files - like sibling
// <script> tags - so a lexical redeclaration here would collide with
// star-types.js's top-level `const STAR_TYPES` and throw a SyntaxError.
if (typeof module !== 'undefined' && typeof STAR_TYPES === 'undefined') {
  Object.assign(globalThis, require('./star-types.js'));
}

// Deterministic 32-bit PRNG (mulberry32). Same seed -> same galaxy, always.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turn any seed (number or string) into a 32-bit integer for mulberry32.
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0) || 1;
}

// Gaussian-ish random via Box-Muller, using the supplied rand() source so it
// stays deterministic for a given seed.
function randn(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate a spiral galaxy's initial state: a dominant central mass plus a
 * disk of stars laid out along logarithmic spiral arms, given near-circular
 * orbital velocities so the disk starts close to dynamical equilibrium.
 * Each disk star is assigned a spectral type (O/B/A/F/G/K/M) sampled from a
 * realistic population weighting, which drives its mass, radius and
 * main-sequence lifetime (see star-types.js). Stars are also given a
 * randomized starting age (a fraction of their lifetime) so a freshly
 * generated galaxy isn't perfectly coeval - some stars are already close to
 * the end of their lives, which staggers supernovae naturally once the sim
 * is running instead of producing a single synchronized burst.
 * A small fraction of disk slots become exotic bodies instead of ordinary
 * stars, rolled in order of rarity - black hole, then quasar, then neutron
 * star: black holes and quasars are supermassive point bodies (radius 0, no
 * lifetime) placed the same way as any other disk body but given a near-zero
 * drift velocity instead of an orbital one, so they sit and pull the disk
 * around them rather than orbiting the core themselves (a quasar is
 * physically identical to a black hole - same mass, same capture radius -
 * just a different type code for rendering/info-panel purposes and a much
 * larger *displayed* mass). A neutron star is an ordinary, gravitationally
 * unremarkable immortal point mass (a few solar masses) that orbits the
 * core like any star, just already-dead and never going supernova again.
 *
 * @param {number|string} seed
 * @param {number} numStars total bodies, including the central mass (index 0)
 * @param {object} [opts]
 * @returns {{x:Float64Array,y:Float64Array,vx:Float64Array,vy:Float64Array,
 *            mass:Float64Array,type:Uint8Array,radius:Float64Array,
 *            age:Float64Array,lifetime:Float64Array,n:number}}
 */
function generateGalaxy(seed, numStars, opts = {}) {
  const rand = mulberry32(hashSeed(seed));
  const n = Math.max(2, numStars | 0);

  const arms = opts.arms ?? (2 + Math.floor(rand() * 3)); // 2-4 arms
  const armSpread = opts.armSpread ?? 0.35;
  const spiralTightness = opts.spiralTightness ?? 0.7;
  const maxRadius = opts.maxRadius ?? 650;
  const G = opts.G ?? 0.6;
  const centralMass = opts.centralMass ?? n * 60;
  const diskMassTotal = opts.diskMassTotal ?? n * 1.2;

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const mass = new Float64Array(n);
  const type = new Uint8Array(n);
  const radius = new Float64Array(n);
  const age = new Float64Array(n);
  const lifetime = new Float64Array(n);

  // Body 0: the central mass (a "black hole" anchoring the disk). It is not
  // a spectral-type star: it never ages and never goes supernova.
  x[0] = 0; y[0] = 0; vx[0] = 0; vy[0] = 0; mass[0] = centralMass;
  type[0] = CORE_TYPE_CODE;
  radius[0] = 0;
  age[0] = 0;
  lifetime[0] = Infinity;

  for (let i = 1; i < n; i++) {
    // Radius distribution: denser toward the core, thinning out to maxRadius.
    const u = rand();
    const r = maxRadius * Math.pow(u, 0.55);

    const arm = Math.floor(rand() * arms);
    const armAngle = (arm / arms) * Math.PI * 2;
    const spiralAngle = Math.log(r + 1) * spiralTightness;
    const scatter = randn(rand) * armSpread * (1 - (r / maxRadius) * 0.4);
    const theta = armAngle + spiralAngle + scatter;

    const px = r * Math.cos(theta);
    const py = r * Math.sin(theta);
    x[i] = px;
    y[i] = py;

    if (rand() < BLACKHOLE_SPAWN_CHANCE) {
      // A rare wandering black hole: supermassive point mass, immortal,
      // essentially stationary (a small drift instead of an orbital
      // velocity - it perturbs the disk rather than following it).
      type[i] = BLACKHOLE_TYPE_CODE;
      mass[i] = BLACKHOLE_MASS;
      radius[i] = 0;
      lifetime[i] = Infinity;
      age[i] = 0;
      vx[i] = (rand() - 0.5) * 4;
      vy[i] = (rand() - 0.5) * 4;
      continue;
    }

    if (rand() < QUASAR_SPAWN_CHANCE) {
      // Rarer still, and physically just a black hole with different paint
      // (see star-types.js: QUASAR_MASS === BLACKHOLE_MASS).
      type[i] = QUASAR_TYPE_CODE;
      mass[i] = QUASAR_MASS;
      radius[i] = 0;
      lifetime[i] = Infinity;
      age[i] = 0;
      vx[i] = (rand() - 0.5) * 4;
      vy[i] = (rand() - 0.5) * 4;
      continue;
    }

    if (rand() < NEUTRONSTAR_SPAWN_CHANCE) {
      // An already-dead stellar remnant: compact, immortal, gravitationally
      // ordinary - it orbits the core like any star, just never again ages
      // toward a supernova.
      type[i] = NEUTRONSTAR_TYPE_CODE;
      mass[i] = NEUTRONSTAR_MASS_MIN + rand() * (NEUTRONSTAR_MASS_MAX - NEUTRONSTAR_MASS_MIN);
      radius[i] = 0.4; // "very small (1px on screen)"
      lifetime[i] = Infinity;
      age[i] = 0;

      const enclosedNS = centralMass + diskMassTotal * (r / maxRadius);
      let vNS = Math.sqrt((G * enclosedNS) / (r + 25));
      vNS *= 0.92 + rand() * 0.16;
      vx[i] = -Math.sin(theta) * vNS;
      vy[i] = Math.cos(theta) * vNS;
      continue;
    }

    // Spectral type -> base mass/radius/lifetime, each with independent
    // jitter so stars of the same type aren't identical.
    const typeIdx = pickStarTypeIndex(rand);
    const st = STAR_TYPES[typeIdx];
    type[i] = st.code;
    mass[i] = st.mass * (0.8 + rand() * 0.4);       // +/-20%
    radius[i] = st.radius * (0.85 + rand() * 0.3);   // +/-15%
    const lt = st.lifetime * (0.8 + rand() * 0.4);   // +/-20%
    lifetime[i] = lt;
    age[i] = rand() * lt * 0.9; // staggered starting age, never born pre-dead

    // Enclosed-mass approximation (central mass + a roughly linear disk
    // contribution) gives a rotation curve that stays fairly flat with
    // radius, which reads visually as a stable rotating disk.
    const enclosed = centralMass + diskMassTotal * (r / maxRadius);
    let v = Math.sqrt((G * enclosed) / (r + 25));
    v *= 0.92 + rand() * 0.16; // small velocity dispersion

    // Velocity perpendicular to the radius vector (counter-clockwise orbit).
    vx[i] = -Math.sin(theta) * v;
    vy[i] = Math.cos(theta) * v;
  }

  return { x, y, vx, vy, mass, type, radius, age, lifetime, n };
}

if (typeof self !== 'undefined') {
  self.generateGalaxy = generateGalaxy;
  self.hashSeed = hashSeed;
  self.mulberry32 = mulberry32; // also needed by system-bodies.js
}
if (typeof module !== 'undefined') {
  module.exports = { generateGalaxy, hashSeed, mulberry32 };
}
