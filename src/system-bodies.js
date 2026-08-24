// system-bodies.js
// Deterministic, seeded generation of a star's planetary system, used the
// first time the user zooms into that star. Runs inside the physics worker
// (loaded via importScripts, after galaxy.js so mulberry32/hashSeed are
// already in scope as globals) - pure data generation only, no orbital
// velocity here (that needs G, a worker constant computed in
// physics-worker.js's enterSystem handler, right where the host star's
// current position/velocity are available to add onto).

/* global mulberry32, hashSeed, CORE_TYPE_CODE, PLANET_COMPOSITIONS */
if (typeof module !== 'undefined' && typeof mulberry32 === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (importScripts shared-scope gotcha).
  Object.assign(globalThis, require('./galaxy.js'));
  Object.assign(globalThis, require('./star-types.js'));
}

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

// Planet-count buckets by host spectral type, per spec's three examples
// (O-stars 2-3, G-stars/Sol 3-5, M-stars 1-2) extended to the rest of the
// spectral sequence: O/B (hot, massive) -> 2-3; A/F/G/K (Sol-like) -> 3-5;
// M (cool dwarf) -> 1-2. The core ("Sol") uses the Sol-like bucket.
function planetCountFor(starTypeCode, rand) {
  if (starTypeCode === CORE_TYPE_CODE) return 3 + Math.floor(rand() * 3); // 3-5
  if (starTypeCode === 0 || starTypeCode === 1) return 2 + Math.floor(rand() * 2); // O,B: 2-3
  if (starTypeCode === 6) return 1 + Math.floor(rand() * 2); // M: 1-2
  return 3 + Math.floor(rand() * 3); // A,F,G,K: 3-5
}

// Stylized (not physically accurate) equilibrium-temperature guess, in the
// same spirit as BLACKHOLE_EVENT_HORIZON_FACTOR: T ~ L^0.25 / sqrt(distance),
// with L approximated as mass^3.5 (rough main-sequence mass-luminosity
// relation). Calibrated so a Sol-mass host at orbitRadius=50 reads ~280K,
// close to Earth's real ~288K, purely as a nice touch.
function estimateTempK(hostMassSolar, orbitRadius) {
  const luminosity = Math.pow(hostMassSolar, 3.5);
  return Math.round((280 * Math.pow(luminosity, 0.25)) / Math.sqrt(orbitRadius / 50));
}

function pickComposition(tempK, rand) {
  const weights = PLANET_COMPOSITIONS.map((c) =>
    tempK >= c.tempBias[0] && tempK <= c.tempBias[1] ? 1 : 0.05
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < PLANET_COMPOSITIONS.length; i++) {
    r -= weights[i];
    if (r <= 0) return PLANET_COMPOSITIONS[i];
  }
  return PLANET_COMPOSITIONS[PLANET_COMPOSITIONS.length - 1];
}

/**
 * @param {number|string} seed base galaxy seed
 * @param {number} starIndex
 * @param {number} starMass solar masses (the host's real, physics mass)
 * @param {number} starTypeCode spectral code 0-6, or CORE_TYPE_CODE
 * @returns {{planets: Array}}
 */
function generateSystem(seed, starIndex, starMass, starTypeCode) {
  const rand = mulberry32(hashSeed(seed + ':system:' + starIndex));
  const count = planetCountFor(starTypeCode, rand);

  // Temperature is a stylized display value only - a "Sol" host uses a
  // nominal 1 solar mass for this formula regardless of its real (much
  // larger) anchor mass, since it isn't a literal star luminosity-wise.
  const tempHostMass = starTypeCode === CORE_TYPE_CODE ? 1.0 : starMass;

  // Orbit radii: 20-150 sim units. This range was tuned empirically, not
  // picked arbitrarily - see scratchpad test_orbit_*.js. This galaxy's own
  // stars already pass startlingly close to each other as ordinary N-body
  // behavior (closest-approach distances as low as ~1 unit were observed
  // across a sample of hosts, unrelated to and pre-existing this feature),
  // which tugs on any planet regardless of its orbit radius. A wider range
  // (e.g. 30-220, matching the ~500-unit system-view framing more literally)
  // looked fine for a few seconds but visibly degraded within 30-60s across
  // most tested host stars; this tighter range keeps orbits reading as
  // stable circles for the timeframe a user is actually watching (holds
  // within roughly +/-15% at 15s, +/-20-60% at 30s, across 7 sampled
  // hosts). Slow drift over a multi-minute session is still possible and
  // is left as-is deliberately: it's real N-body physics (a planet a
  // passing star perturbs), not a bug, exactly like a wandering black hole
  // "eating" the galaxy over time is real physics, not a bug.
  const minR = 20, maxR = 150;
  const step = (maxR - minR) / count;

  const planets = [];
  for (let i = 0; i < count; i++) {
    const orbitRadius = minR + step * (i + 0.5) + (rand() - 0.5) * step * 0.5;

    // Log-uniform in [0.3, 300] Earth masses - "realistic distribution":
    // far more small/mid planets than giants, same idea as a Kroupa-style
    // stellar IMF but simplified to a single log-uniform draw.
    const massEarth = Math.exp(rand() * (Math.log(300) - Math.log(0.3)) + Math.log(0.3));
    // Floor bumped from 1 to 1.8 (and max 3->4): a 1px-radius (2px diameter)
    // dot was confirmed, via pixel-position debugging, to be technically
    // rendering in the mathematically correct spot but was so small it read
    // as "invisible" - not a pipeline bug, a legibility one. See renderer.js
    // for the matching render-time floor (also covers systems saved to
    // localStorage before this change).
    const radiusPx = Math.min(4, Math.max(1.8, 0.9 + Math.cbrt(massEarth) * 0.4));

    const tempK = estimateTempK(tempHostMass, orbitRadius);
    const composition = pickComposition(tempK, rand);

    const name = `${GREEK[i % GREEK.length]}-${i + 1}`;
    const angle0 = rand() * Math.PI * 2;

    const moons = [];
    if (rand() < 0.3) {
      const moonCount = rand() < 0.5 ? 1 : 2;
      for (let m = 0; m < moonCount; m++) {
        moons.push({
          name: `${name}${m === 0 ? 'i' : 'ii'}`,
          orbitRadius: 2 + rand() * 6, // 2-8 units from the planet, purely cosmetic
          angularSpeed: (Math.PI * 2) / (3 + rand() * 10), // one lap every 3-13 sim-seconds
          phase0: rand() * Math.PI * 2,
        });
      }
    }

    planets.push({
      name, massEarth, radiusPx, orbitRadius, angle0,
      composition: composition.key, color: composition.color, tempK, moons,
    });
  }

  // Temporary debug logging (per debugging request) - shows up in the
  // browser's DevTools console since Chrome aggregates Worker console
  // output into the main Console panel by default. Safe to remove once
  // planet visibility is confirmed fixed; left in for now since it's cheap
  // and only fires once per zoom-in (not per frame).
  console.log(
    `[system-bodies] generated ${planets.length} planet(s) for star #${starIndex} ` +
    `(type=${starTypeCode}, mass=${starMass.toFixed(2)} M☉):`,
    planets.map((p) => ({
      name: p.name, massEarth: +p.massEarth.toFixed(2), orbitRadius: +p.orbitRadius.toFixed(1),
      angle0: +p.angle0.toFixed(2), radiusPx: +p.radiusPx.toFixed(2), composition: p.composition,
      moons: p.moons.length,
    }))
  );

  return { planets };
}

if (typeof self !== 'undefined') {
  self.generateSystem = generateSystem;
}
if (typeof module !== 'undefined') {
  module.exports = { generateSystem, planetCountFor, estimateTempK, pickComposition };
}
