// galaxy-morphology.js
// Cosmic Web Sandbox: generates a galaxy's initial state for one of four
// morphologies (spiral/elliptical/irregular/lenticular), all producing the
// exact same typed-array shape galaxy.js's generateGalaxy() already does -
// buildTree()/step()/aging/absorbers/enterSystem in physics-worker.js need
// zero changes regardless of which morphology generated a given galaxy.
//
// galaxy.js itself is untouched: the spiral path is generateGalaxy() called
// as-is (the existing, already-tuned single-galaxy behavior, unchanged when
// morphology is unspecified or 'spiral'). Elliptical and irregular share
// one generator (generateWithPlacement, below) parameterized by a
// per-morphology position generator, an analytic enclosed-mass-fraction
// formula, and a velocity style; lenticular gets its own small function
// (generateLenticular) that reuses spiral's exact enclosed-mass formula,
// since its radial profile is identical to spiral's - see that function's
// comment for why routing it through the shared generator instead measurably
// hurt stability.
//
// Runs inside the physics worker (importScripts, loaded after galaxy.js so
// generateGalaxy/mulberry32/hashSeed are already in scope as globals).

/* global STAR_TYPES, CORE_TYPE_CODE, BLACKHOLE_TYPE_CODE, BLACKHOLE_SPAWN_CHANCE,
   BLACKHOLE_MASS, QUASAR_TYPE_CODE, QUASAR_SPAWN_CHANCE, QUASAR_MASS,
   NEUTRONSTAR_TYPE_CODE, NEUTRONSTAR_SPAWN_CHANCE, NEUTRONSTAR_MASS_MIN,
   NEUTRONSTAR_MASS_MAX, pickStarTypeIndexForMorphology, DEFAULT_G,
   GALAXY_MORPHOLOGIES, generateGalaxy, mulberry32, hashSeed */
if (typeof module !== 'undefined' && typeof STAR_TYPES === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (importScripts shared-scope
  // gotcha - a redeclaration here would be a SyntaxError in the worker).
  Object.assign(globalThis, require('./star-types.js'));
  Object.assign(globalThis, require('./galaxy.js'));
}

// Small local Gaussian sampler (Box-Muller) - galaxy.js has its own private
// `randn`, not exported (it's a spiral-only implementation detail), so this
// is a deliberate small duplication rather than modifying galaxy.js at all.
function randnLocal(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Shared two-pass generator for the three non-spiral morphologies.
//
// Places every disk body (position, type/mass, and velocity) in one pass,
// using an ANALYTIC enclosed-mass-fraction formula (`enclosedFractionFn(r,
// maxRadius) -> 0..1`) rather than measuring it from the actual discrete
// population. An empirically-measured version (sorted-by-radius cumulative
// sum of the real generated masses) was tried first and is, in principle,
// exactly self-consistent with whatever placeFn() actually produced - but
// tested empirically (scratchpad test_morphology.js) it was LESS stable
// than a smooth analytic approximation even for profiles it should have
// been more accurate for (lenticular's radial profile, identical to
// spiral's own proven-stable one, dispersed measurably worse with the
// empirical measurement than with spiral's plain analytic formula).
// Discrete sampling noise in a population of only a few hundred stars
// apparently matters more than getting the profile shape exactly right;
// every morphology here now uses a smooth per-shape analytic formula
// instead, mirroring spiral's own approach.
//
// `velocityStyle`: { directionMode: 'ordered'|'random', speedMin, speedMax,
// directionBias? } - speed is a multiple of the true local circular
// velocity; escape velocity is sqrt(2)~=1.414x circular, so speedMax must
// stay safely under that or bodies drift outward on wide unbound-ish orbits
// (verified empirically, not just asserted - see test_morphology.js).
function generateWithPlacement(seed, numStars, opts, morphology, maxRadiusDefault, placeFn, enclosedFractionFn, velocityStyle) {
  const rand = mulberry32(hashSeed(seed));
  const n = Math.max(2, numStars | 0);
  const G = opts.G ?? DEFAULT_G;
  const maxRadius = opts.maxRadius ?? maxRadiusDefault;
  const centralMass = opts.centralMass ?? n * 60;
  const diskMassTotal = opts.diskMassTotal ?? n * 1.2;

  const x = new Float64Array(n), y = new Float64Array(n);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  const mass = new Float64Array(n), type = new Uint8Array(n);
  const radius = new Float64Array(n), age = new Float64Array(n), lifetime = new Float64Array(n);

  x[0] = 0; y[0] = 0; vx[0] = 0; vy[0] = 0; mass[0] = centralMass;
  type[0] = CORE_TYPE_CODE; radius[0] = 0; age[0] = 0; lifetime[0] = Infinity;

  // Minimum effective radius for the vCirc formula below - vCirc ~
  // 1/sqrt(r) diverges as r->0, and a clustered scatter (irregular's
  // sub-clusters, which can themselves land near the origin) can genuinely
  // put an ordinary star within a handful of units of it (found
  // empirically: r=13 against centralMass~=24000 assigned v~=21, several
  // times faster than anything else in the galaxy - not a meaningful
  // "close orbit," just the formula blowing up). Flooring r itself
  // (proportional to maxRadius, so it scales with the galaxy) is what
  // actually keeps every assigned velocity within a sane range.
  const minEffectiveR = maxRadius * 0.15;
  const { directionMode, speedMin, speedMax, directionBias } = velocityStyle;
  const bias = directionBias ?? 0.5;

  for (let i = 1; i < n; i++) {
    const p = placeFn(rand, maxRadius);
    x[i] = p.x; y[i] = p.y;
    const r = Math.hypot(p.x, p.y);
    const theta = Math.atan2(p.y, p.x);

    if (rand() < BLACKHOLE_SPAWN_CHANCE) {
      // Near-zero drift, not an orbital velocity - matches spiral's own
      // treatment exactly (a wandering perturber, not something that
      // orbits). A version of this function that assigned every body an
      // orbital velocity unconditionally (including exotics) put a
      // 30000-mass body moving at ~17 units/s straight through a cluster of
      // ordinary stars - a wrecking ball that alone accounted for most of a
      // whole galaxy's observed instability (see test_morphology.js history).
      type[i] = BLACKHOLE_TYPE_CODE; mass[i] = BLACKHOLE_MASS; radius[i] = 0;
      lifetime[i] = Infinity; age[i] = 0;
      vx[i] = (rand() - 0.5) * 4; vy[i] = (rand() - 0.5) * 4;
      continue;
    }
    if (rand() < QUASAR_SPAWN_CHANCE) {
      type[i] = QUASAR_TYPE_CODE; mass[i] = QUASAR_MASS; radius[i] = 0;
      lifetime[i] = Infinity; age[i] = 0;
      vx[i] = (rand() - 0.5) * 4; vy[i] = (rand() - 0.5) * 4;
      continue;
    }

    const enclosed = centralMass + diskMassTotal * enclosedFractionFn(r, maxRadius);
    const vCirc = Math.sqrt((G * enclosed) / (Math.max(r, minEffectiveR) + 25));
    const direction = directionMode === 'random' ? (rand() < bias ? 1 : -1) : 1;
    const assignVelocity = () => {
      const v = vCirc * (speedMin + rand() * (speedMax - speedMin)) * direction;
      vx[i] = -Math.sin(theta) * v;
      vy[i] = Math.cos(theta) * v;
    };

    if (rand() < NEUTRONSTAR_SPAWN_CHANCE) {
      type[i] = NEUTRONSTAR_TYPE_CODE;
      mass[i] = NEUTRONSTAR_MASS_MIN + rand() * (NEUTRONSTAR_MASS_MAX - NEUTRONSTAR_MASS_MIN);
      radius[i] = 0.4; lifetime[i] = Infinity; age[i] = 0;
      assignVelocity();
      continue;
    }

    const typeIdx = pickStarTypeIndexForMorphology(rand, morphology);
    const st = STAR_TYPES[typeIdx];
    type[i] = st.code;
    mass[i] = st.mass * (0.8 + rand() * 0.4);
    radius[i] = st.radius * (0.85 + rand() * 0.3);
    const lt = st.lifetime * (0.8 + rand() * 0.4);
    lifetime[i] = lt;
    age[i] = rand() * lt * 0.9;
    assignVelocity();
  }

  return { x, y, vx, vy, mass, type, radius, age, lifetime, n };
}

// --- Elliptical: 2D-Gaussian position (concentrated toward center, a
// simplified stand-in for a real de Vaucouleurs profile). Random orbital
// sense (no single ordered rotation - real ellipticals are dispersion-,
// not rotation-, supported) at 0.75-1.1x the true local circular speed. ---
function ellipticalPosition(rand, maxRadius) {
  const aspect = 1.3 + rand() * 0.5; // mild ellipticity, varies per galaxy
  const orientation = rand() * Math.PI * 2;
  const gx = randnLocal(rand) * maxRadius * 0.32;
  const gy = (randnLocal(rand) * maxRadius * 0.32) / aspect;
  const cos = Math.cos(orientation), sin = Math.sin(orientation);
  return { x: gx * cos - gy * sin, y: gx * sin + gy * cos };
}
// For a 2D isotropic Gaussian with std sigma, the radius follows a Rayleigh
// distribution, whose CDF (fraction of mass enclosed within radius r) has a
// clean closed form: 1 - exp(-r^2/(2*sigma^2)). Used instead of measuring
// enclosed mass empirically from the actual discrete population (tried
// first - see lenticularPosition/generateLenticular's comment for why that
// measurably destabilized a several-hundred-star population via discrete
// sampling noise, even for a profile it should in principle be MORE
// accurate for). The mild aspect-ratio elongation is ignored here (treated
// as circular) purely for this velocity approximation - good enough given
// the aspect ratio is mild (1.3-1.8x).
// Calibrated empirically against the actual generated radial distribution
// (median of real positions vs a Rayleigh distribution's closed-form
// median=1.1774*sigma), same as IRREGULAR_SIGMA_FRACTION below: the
// position generator's own std-dev parameter (0.32) isn't quite the same
// number as the resulting RADIAL distribution's effective sigma once the
// aspect-ratio elongation is folded in - measured implied sigma was ~0.26.
const ELLIPTICAL_SIGMA_FRACTION = 0.27;
function ellipticalEnclosedFraction(r, maxRadius) {
  const sigma = maxRadius * ELLIPTICAL_SIGMA_FRACTION;
  return 1 - Math.exp(-(r * r) / (2 * sigma * sigma));
}
const ELLIPTICAL_VELOCITY_STYLE = { directionMode: 'random', directionBias: 0.75, speedMin: 0.75, speedMax: 1.1 };

// --- Irregular: a handful of scattered sub-clusters (Voronoi-ish without a
// real Voronoi computation - each star just picks a random cluster center
// and scatters around it) for POSITION only. Smaller default radius -
// "dwarf galaxies" per spec.
//
// Velocity still comes from generateWithPlacement's origin-centric
// empirical enclosed mass, same as elliptical/lenticular, NOT a per-cluster
// local orbit. A per-cluster model was tried first and measured (scratchpad
// test_morphology.js) to disperse far worse than an origin-centric one: a
// cluster's *assumed* local mass share doesn't account for the very real,
// very strong pull every star also feels from the actual central mass at
// its true distance from the origin (dominant whenever a cluster happens to
// sit close to the origin) - the mismatch between assumed and actual force
// produces close-encounter-style slingshots, not a gentle drift. Anchoring
// velocity to the real origin-based enclosed mass (like every other
// morphology) avoids fighting the dominant physics; the cluster-based
// POSITION scatter alone already produces the desired chaotic, non-disk
// visual character once stars are moving under real gravity. ---
function irregularClusterCenters(rand, maxRadius) {
  const count = 3 + Math.floor(rand() * 4); // 3-6 sub-clusters
  const centers = [];
  for (let i = 0; i < count; i++) {
    const r = maxRadius * 0.5 * Math.sqrt(rand());
    const theta = rand() * Math.PI * 2;
    centers.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return centers;
}
function makeIrregularPosition(clusterCenters, maxRadius) {
  // A tighter jitter (0.22, first tried) packs each sub-cluster ~19x denser
  // than spiral's own overall average stellar density - measured
  // empirically (scratchpad test_morphology.js, an 8-seed sweep), that
  // local crowding alone drove real instability (worst-case ~8x radius
  // growth over 3600 steps/60 sim-seconds) regardless of the assigned
  // orbital velocity, since dense local self-gravity dominates over
  // whatever origin-centric velocity a star was given - reducing speed
  // alone didn't help. Widening the jitter (spreading each cluster's
  // members out more, so local density approaches the sim's overall
  // tolerance) was the actual lever: swept 0.22->0.45->0.6->0.75, worst-case
  // dropped from ~8x to 2.84x across the same 8 seeds at 0.75 - comparable
  // to the existing, already-shipped spiral generator's own worst case
  // (2.53x across a 12-seed sweep of the untouched code). Real N-body
  // seed-to-seed variance exists even there (already documented elsewhere
  // in this codebase); this isn't chasing zero variance, just parity with
  // spiral's own established tolerance.
  const jitter = maxRadius * 0.75;
  return (rand) => {
    const c = clusterCenters[Math.floor(rand() * clusterCenters.length)];
    return { x: c.x + randnLocal(rand) * jitter, y: c.y + randnLocal(rand) * jitter };
  };
}
// Same analytic Gaussian-CDF enclosed-mass approximation as elliptical
// (see that comment for why analytic beats empirically-measured here) -
// wider effective sigma to account for the extra spread cluster centers
// themselves add (each cluster center lands up to maxRadius*0.5 from the
// origin, on top of each star's own jitter around its cluster).
// Calibrated empirically against the actual generated radial distribution
// (median/p75 of real positions, matched against a Rayleigh distribution's
// closed-form median=1.1774*sigma / p75=1.665*sigma) rather than guessed:
// an initial guess of 0.38 overestimated the true spread by ~20% (predicted
// median 134 vs actual 111), systematically underestimating enclosed mass
// at typical radii and contributing to instability on top of the general
// analytic-vs-empirical lesson documented above.
const IRREGULAR_SIGMA_FRACTION = 0.31;
function irregularEnclosedFraction(r, maxRadius) {
  const sigma = maxRadius * IRREGULAR_SIGMA_FRACTION;
  return 1 - Math.exp(-(r * r) / (2 * sigma * sigma));
}
// Ordered rotation (single direction, like lenticular/spiral), not a
// random-direction mix. Tested empirically first with a random/mixed
// direction (see scratchpad test_morphology.js history): within a densely-
// scattered cluster, mixed-direction orbits cross paths far more often than
// a single-direction disk ever does, and those crossings occasionally
// produced a genuine slingshot close encounter that flung a meaningful
// fraction of the population outward within under a minute - real N-body
// behavior, but too dramatic for a "same session" viewing experience (even
// an 80/20 direction split still crossed the stability threshold). The
// wider-than-lenticular speed jitter (0.8-1.15x vs 0.92-1.08x) still gives
// irregular a rougher, less pristine orbit than lenticular's disk - what
// makes it read as "irregular" is the clumpy, non-disk position layout
// (irregularClusterCenters) and the flatter/more chaotic stellar population
// mix, not orbital chaos. ---
const IRREGULAR_VELOCITY_STYLE = { directionMode: 'ordered', speedMin: 0.8, speedMax: 1.15 };

// --- Lenticular: disk + bulge, no arms - same radial profile shape as
// spiral, with theta uniform at random instead of following log-spiral
// arms. Ordered rotation (like spiral/a real disk), near-circular speed.
//
// A first version used a higher exponent (0.62 vs spiral's 0.55) for a
// modest "bulge" emphasis - tested empirically (scratchpad
// test_morphology.js), this pulled the innermost few stars measurably
// closer to the origin than spiral's own proven-stable exponent (a higher
// power-law exponent shrinks the extreme low tail faster, even though the
// aggregate distribution is actually less concentrated - the exponent
// governs near-zero tail behavior directly), which combined with the large
// centralMass to produce fast, close-encounter-prone inner orbits and real
// measured instability. Reusing spiral's own exponent removes the "extra"
// concentration risk entirely rather than re-deriving a new safe value.
//
// Uses spiral's own ANALYTIC linear enclosed-mass approximation
// (`centralMass + diskMassTotal*(r/maxRadius)`), not generateWithPlacement's
// empirically-measured cumulative sum - tested empirically (scratchpad
// test_morphology.js), the empirical measurement (exactly matching the real
// discrete population rather than a smoothed average) was measurably less
// stable for this identical radial profile: bulk radius contracted by
// nearly half while a few close encounters near the ever-densifying center
// flung individual stars out several times farther, within 60 sim-seconds.
// Since lenticular's radial profile is now IDENTICAL to spiral's (same
// exponent), there's no reason to use anything but spiral's own
// already-proven-stable formula - implemented as its own small function
// (mirroring generateGalaxy's structure) rather than routed through
// generateWithPlacement, specifically to reuse that exact formula. ---
function generateLenticular(seed, numStars, opts) {
  const rand = mulberry32(hashSeed(seed));
  const n = Math.max(2, numStars | 0);
  const G = opts.G ?? DEFAULT_G;
  const maxRadius = opts.maxRadius ?? 600;
  const centralMass = opts.centralMass ?? n * 60;
  const diskMassTotal = opts.diskMassTotal ?? n * 1.2;

  const x = new Float64Array(n), y = new Float64Array(n);
  const vx = new Float64Array(n), vy = new Float64Array(n);
  const mass = new Float64Array(n), type = new Uint8Array(n);
  const radius = new Float64Array(n), age = new Float64Array(n), lifetime = new Float64Array(n);

  x[0] = 0; y[0] = 0; vx[0] = 0; vy[0] = 0; mass[0] = centralMass;
  type[0] = CORE_TYPE_CODE; radius[0] = 0; age[0] = 0; lifetime[0] = Infinity;

  for (let i = 1; i < n; i++) {
    const r = maxRadius * Math.pow(rand(), 0.55);
    const theta = rand() * Math.PI * 2;
    x[i] = r * Math.cos(theta); y[i] = r * Math.sin(theta);

    if (rand() < BLACKHOLE_SPAWN_CHANCE) {
      type[i] = BLACKHOLE_TYPE_CODE; mass[i] = BLACKHOLE_MASS; radius[i] = 0;
      lifetime[i] = Infinity; age[i] = 0;
      vx[i] = (rand() - 0.5) * 4; vy[i] = (rand() - 0.5) * 4;
      continue;
    }
    if (rand() < QUASAR_SPAWN_CHANCE) {
      type[i] = QUASAR_TYPE_CODE; mass[i] = QUASAR_MASS; radius[i] = 0;
      lifetime[i] = Infinity; age[i] = 0;
      vx[i] = (rand() - 0.5) * 4; vy[i] = (rand() - 0.5) * 4;
      continue;
    }
    if (rand() < NEUTRONSTAR_SPAWN_CHANCE) {
      type[i] = NEUTRONSTAR_TYPE_CODE;
      mass[i] = NEUTRONSTAR_MASS_MIN + rand() * (NEUTRONSTAR_MASS_MAX - NEUTRONSTAR_MASS_MIN);
      radius[i] = 0.4; lifetime[i] = Infinity; age[i] = 0;
      const enclosed = centralMass + diskMassTotal * (r / maxRadius);
      const v = Math.sqrt((G * enclosed) / (r + 25)) * (0.92 + rand() * 0.16);
      vx[i] = -Math.sin(theta) * v; vy[i] = Math.cos(theta) * v;
      continue;
    }

    const typeIdx = pickStarTypeIndexForMorphology(rand, 'lenticular');
    const st = STAR_TYPES[typeIdx];
    type[i] = st.code;
    mass[i] = st.mass * (0.8 + rand() * 0.4);
    radius[i] = st.radius * (0.85 + rand() * 0.3);
    const lt = st.lifetime * (0.8 + rand() * 0.4);
    lifetime[i] = lt;
    age[i] = rand() * lt * 0.9;

    const enclosed = centralMass + diskMassTotal * (r / maxRadius);
    const v = Math.sqrt((G * enclosed) / (r + 25)) * (0.92 + rand() * 0.16);
    vx[i] = -Math.sin(theta) * v; vy[i] = Math.cos(theta) * v;
  }

  return { x, y, vx, vy, mass, type, radius, age, lifetime, n };
}

/**
 * Generate a galaxy's initial state for a given morphology. Spiral falls
 * straight through to the existing, untouched generateGalaxy(); the other
 * three morphologies use generateWithPlacement() above. Returns the exact
 * same shape as generateGalaxy() in every case.
 * @param {number|string} seed
 * @param {number} numStars
 * @param {object} [opts] - same opts generateGalaxy() accepts, plus
 *   `opts.morphology` (default 'spiral').
 */
function generateGalaxyByMorphology(seed, numStars, opts = {}) {
  const morphology = GALAXY_MORPHOLOGIES.includes(opts.morphology) ? opts.morphology : 'spiral';
  if (morphology === 'spiral') return generateGalaxy(seed, numStars, opts);

  if (morphology === 'elliptical') {
    return generateWithPlacement(
      seed, numStars, opts, 'elliptical', 500,
      ellipticalPosition, ellipticalEnclosedFraction, ELLIPTICAL_VELOCITY_STYLE
    );
  }
  if (morphology === 'irregular') {
    // 150, not 300: the stability-driven jitter widening above (0.75x
    // maxRadius per cluster) means the actual star spread now reaches
    // ~2-3x maxRadius in practice (measured avgR~=307 at maxRadius=300,
    // vs spiral's own ~250-ish average) - too big to still read as the
    // spec's "dwarf galaxies". Halving the default radius keeps the
    // relative dynamics (same jitter fraction, same stability behavior,
    // scale-invariant) while bringing the absolute spread back down to
    // smaller than every other morphology's default, as a dwarf should be.
    const maxRadius = opts.maxRadius ?? 150;
    const clusterRand = mulberry32(hashSeed(seed + ':irregular-clusters'));
    const centers = irregularClusterCenters(clusterRand, maxRadius);
    return generateWithPlacement(
      seed, numStars, opts, 'irregular', maxRadius,
      makeIrregularPosition(centers, maxRadius), irregularEnclosedFraction, IRREGULAR_VELOCITY_STYLE
    );
  }
  if (morphology === 'lenticular') {
    return generateLenticular(seed, numStars, opts);
  }
  return generateGalaxy(seed, numStars, opts); // unreachable given the guard above; fall back to spiral
}

if (typeof self !== 'undefined') {
  self.generateGalaxyByMorphology = generateGalaxyByMorphology;
}
if (typeof module !== 'undefined') {
  module.exports = { generateGalaxyByMorphology };
}
