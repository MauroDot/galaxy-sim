// universe-codec.js
// Cosmic Web Sandbox: packed-binary encode/decode for the "Save Universe"
// `?universe=` share URL - same design as share-codec.js's `?system=` codec
// (a full snapshot, not seed+diff; quantized fixed-width fields; base64url
// so it drops straight into a URL query string), reusing share-codec.js's
// own exported base64UrlEncode/base64UrlDecode rather than duplicating that
// part. Main-thread `<script>` tag (not importScripts), like share-codec.js.
//
// Per-galaxy layout (15 bytes): x(2) y(2) mass(4, float32) morphology(1,
// index into GALAXY_MORPHOLOGIES) starCount(2) vx(2) vy(2). Header (2
// bytes): version(1) count(1). Names and per-galaxy ids are never stored -
// regenerated deterministically at decode time (`Shared-N`, sequential ids
// 0..count-1), the same way share-codec.js never round-trips a planet's
// name either. At 50 galaxies that's 2 + 50*15 = 752 bytes -> ~1003
// base64url chars, comfortably inside the ~2000-char budget already used
// for the system codec (verified in scratchpad test_universe_codec.js, not
// just computed on paper).

/* global SHARE_FORMAT_VERSION, GALAXY_MORPHOLOGIES, UNIVERSE_PLANE_SIZE,
   base64UrlEncode, base64UrlDecode */
if (typeof module !== 'undefined' && typeof SHARE_FORMAT_VERSION === 'undefined') {
  // Node/CommonJS test-harness path only - see share-codec.js for why this
  // never declares a top-level binding of its own (both are plain <script>
  // tags sharing one global `window` scope in the browser).
  Object.assign(globalThis, require('./star-types.js'));
  Object.assign(globalThis, require('./cosmic-web.js'));
  Object.assign(globalThis, require('./share-codec.js'));
}

const UNIVERSE_PLANE_HALF_FALLBACK = 50000; // matches cosmic-web.js's UNIVERSE_PLANE_SIZE/2, used if that constant isn't in scope for some reason
function planeHalf() {
  return (typeof UNIVERSE_PLANE_SIZE !== 'undefined' ? UNIVERSE_PLANE_SIZE : UNIVERSE_PLANE_HALF_FALLBACK * 2) / 2;
}
const UNIVERSE_VELOCITY_RANGE = 60; // generous headroom above observed cosmic-layer speeds (worst measured ~37 after a full sim-hour, see test_cosmic_web.js)
const UNIVERSE_STAR_COUNT_MAX = 4000; // above adjustGalaxyMass's own cap (3000), headroom for future tuning

function clampQuantize(value, min, max, bits) {
  const steps = (1 << bits) - 1;
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return Math.round(t * steps);
}
function dequantize(q, min, max, bits) {
  const steps = (1 << bits) - 1;
  return min + (q / steps) * (max - min);
}

/**
 * @param {{galaxies: Array<{x, y, mass, morphology, starCount, vx, vy}>}} universe
 * @returns {string} base64url-encoded payload
 */
function encodeUniverse(universe) {
  const galaxies = universe.galaxies || [];
  const half = planeHalf();
  const buf = new ArrayBuffer(2 + galaxies.length * 15);
  const view = new DataView(buf);
  view.setUint8(0, SHARE_FORMAT_VERSION);
  view.setUint8(1, Math.min(255, galaxies.length));

  let off = 2;
  for (const g of galaxies) {
    view.setUint16(off, clampQuantize(g.x, -half, half, 16), true);
    view.setUint16(off + 2, clampQuantize(g.y, -half, half, 16), true);
    view.setFloat32(off + 4, g.mass, true);
    view.setUint8(off + 8, Math.max(0, GALAXY_MORPHOLOGIES.indexOf(g.morphology)));
    view.setUint16(off + 9, Math.min(UNIVERSE_STAR_COUNT_MAX, Math.max(0, Math.round(g.starCount))), true);
    view.setUint16(off + 11, clampQuantize(g.vx, -UNIVERSE_VELOCITY_RANGE, UNIVERSE_VELOCITY_RANGE, 16), true);
    view.setUint16(off + 13, clampQuantize(g.vy, -UNIVERSE_VELOCITY_RANGE, UNIVERSE_VELOCITY_RANGE, 16), true);
    off += 15;
  }
  return base64UrlEncode(new Uint8Array(buf));
}

/**
 * @param {string} str
 * @returns {{galaxies: Array}|null} null on malformed input
 */
function decodeUniverse(str) {
  try {
    const bytes = base64UrlDecode(str);
    if (bytes.length < 2) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    if (version !== SHARE_FORMAT_VERSION) return null; // forward-compat: refuse unknown versions rather than misreading
    const count = view.getUint8(1);
    if (bytes.length < 2 + count * 15) return null;

    const half = planeHalf();
    const galaxies = [];
    let off = 2;
    for (let i = 0; i < count; i++) {
      const x = dequantize(view.getUint16(off, true), -half, half, 16);
      const y = dequantize(view.getUint16(off + 2, true), -half, half, 16);
      const mass = view.getFloat32(off + 4, true);
      const morphology = GALAXY_MORPHOLOGIES[view.getUint8(off + 8)] || 'spiral';
      const starCount = view.getUint16(off + 9, true);
      const vx = dequantize(view.getUint16(off + 11, true), -UNIVERSE_VELOCITY_RANGE, UNIVERSE_VELOCITY_RANGE, 16);
      const vy = dequantize(view.getUint16(off + 13, true), -UNIVERSE_VELOCITY_RANGE, UNIVERSE_VELOCITY_RANGE, 16);
      galaxies.push({
        id: i, name: `Shared-${i + 1}`,
        x, y, vx, vy, mass, morphology, starCount, clusterIndex: -1,
      });
      off += 15;
    }
    return { galaxies };
  } catch (err) {
    return null; // malformed/corrupt share link - caller falls back to a normal universe
  }
}

if (typeof window !== 'undefined') {
  window.encodeUniverse = encodeUniverse;
  window.decodeUniverse = decodeUniverse;
}
if (typeof module !== 'undefined') {
  module.exports = { encodeUniverse, decodeUniverse };
}
