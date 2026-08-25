// share-codec.js
// Packed binary encoding for "Save This System" / shared-URL loading.
// Main-thread only (plain <script> tag - no importScripts), also
// Node-testable. Not JSON: with up to ~100 bodies, a compact per-body byte
// layout keeps the resulting URL a reasonable length. Velocity is never
// stored - it's recomputed at decode time from orbitRadius/angle0/G (the
// same formula physics-worker.js's enterSystem already uses for
// auto-generated systems), which halves the per-body payload.
//
// Per-body layout (9 bytes): kind(1) compositionIndex(1) massEarth(2,
// quantized 0-500 -> 0-65535) orbitRadius(2, quantized 0-2000 -> 0-65535)
// angle0(2, quantized 0-2pi -> 0-65535) cometSpeedMult(1, 0 for non-comets,
// else (mult-0.2)*100 clamped to a byte). Header (8 bytes): version(1)
// hostType(1) hostMassHi/Lo... actually hostMass needs more range than a
// byte, so it's a 4-byte float32; count(1) pads the header to 8 bytes.
//
// Uses base64url (RFC 4648 sec 5: '+'/'/' -> '-'/'_' , no '=' padding) so
// the result drops straight into a URL query string with no percent-
// encoding needed.

/* global SHARE_FORMAT_VERSION, PLANET_COMPOSITIONS */
if (typeof module !== 'undefined' && typeof SHARE_FORMAT_VERSION === 'undefined') {
  // Node/CommonJS test-harness path only - see galaxy.js for why this never
  // declares a top-level binding of its own (this file loads as a plain
  // <script> tag in the browser, sharing window's global scope with
  // star-types.js the same way importScripts'd files share one - a
  // redeclaration here would be a SyntaxError there).
  Object.assign(globalThis, require('./star-types.js'));
}

const BODY_KINDS = ['planet', 'asteroid', 'comet'];
const COMPOSITION_KEYS = ['water', 'rocky', 'iron', 'airless', 'comet'];

function clampQuantize(value, min, max, bits) {
  const steps = (1 << bits) - 1;
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return Math.round(t * steps);
}
function dequantize(q, min, max, bits) {
  const steps = (1 << bits) - 1;
  return min + (q / steps) * (max - min);
}

function base64UrlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64'));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = (typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * @param {{hostType:number, hostMass:number, creatorName?:string, bodies: Array<{kind, massEarth, orbitRadius, angle0, composition, speedMult?}>}} snapshot
 * @returns {string} base64url-encoded payload, safe to drop into a URL query param
 */
function encodeSystem(snapshot) {
  const bodies = snapshot.bodies || [];
  const buf = new ArrayBuffer(8 + bodies.length * 9);
  const view = new DataView(buf);
  view.setUint8(0, SHARE_FORMAT_VERSION);
  view.setUint8(1, snapshot.hostType);
  view.setFloat32(2, snapshot.hostMass, true);
  view.setUint8(6, Math.min(255, bodies.length));
  view.setUint8(7, 0); // reserved

  let off = 8;
  for (const b of bodies) {
    view.setUint8(off, Math.max(0, BODY_KINDS.indexOf(b.kind)));
    view.setUint8(off + 1, Math.max(0, COMPOSITION_KEYS.indexOf(b.composition)));
    view.setUint16(off + 2, clampQuantize(b.massEarth, 0, 500, 16), true);
    view.setUint16(off + 4, clampQuantize(b.orbitRadius, 0, 2000, 16), true);
    view.setUint16(off + 6, clampQuantize(((b.angle0 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), 0, Math.PI * 2, 16), true);
    const sm = b.kind === 'comet' ? Math.min(255, Math.max(0, Math.round((b.speedMult - 0.1) * 200))) : 0;
    view.setUint8(off + 8, sm);
    off += 9;
  }
  return base64UrlEncode(new Uint8Array(buf));
}

/**
 * @param {string} str
 * @returns {{hostType:number, hostMass:number, bodies: Array}|null} null on malformed input
 */
function decodeSystem(str) {
  try {
    const bytes = base64UrlDecode(str);
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    if (version !== SHARE_FORMAT_VERSION) return null; // forward-compat: refuse unknown versions rather than misreading
    const hostType = view.getUint8(1);
    const hostMass = view.getFloat32(2, true);
    const count = view.getUint8(6);
    if (bytes.length < 8 + count * 9) return null;

    const bodies = [];
    let off = 8;
    for (let i = 0; i < count; i++) {
      const kind = BODY_KINDS[view.getUint8(off)] || 'planet';
      const composition = COMPOSITION_KEYS[view.getUint8(off + 1)] || 'rocky';
      const massEarth = dequantize(view.getUint16(off + 2, true), 0, 500, 16);
      const orbitRadius = dequantize(view.getUint16(off + 4, true), 0, 2000, 16);
      const angle0 = dequantize(view.getUint16(off + 6, true), 0, Math.PI * 2, 16);
      const smByte = view.getUint8(off + 8);
      const speedMult = kind === 'comet' ? smByte / 200 + 0.1 : 1;
      const compTable = (typeof PLANET_COMPOSITIONS !== 'undefined') ? PLANET_COMPOSITIONS : null;
      const color = compTable ? (compTable.find((c) => c.key === composition) || compTable[1]).color
        : (kind === 'comet' ? '#ffffff' : '#a67a4d');
      bodies.push({
        kind, composition, massEarth, orbitRadius, angle0, speedMult,
        color: kind === 'comet' ? '#ffffff' : color,
        name: `Shared-${i + 1}`,
      });
      off += 9;
    }
    return { hostType, hostMass, bodies };
  } catch (err) {
    return null; // malformed/corrupt share link - caller falls back to a normal galaxy
  }
}

if (typeof window !== 'undefined') {
  window.encodeSystem = encodeSystem;
  window.decodeSystem = decodeSystem;
  // Exported too (not just used internally) so universe-codec.js's
  // `?universe=` packed-binary codec can reuse the exact same base64url
  // implementation instead of duplicating it - both are plain <script>
  // tags sharing one global `window` scope, same as every worker-side file
  // sharing one scope via importScripts.
  window.base64UrlEncode = base64UrlEncode;
  window.base64UrlDecode = base64UrlDecode;
}
if (typeof module !== 'undefined') {
  module.exports = {
    encodeSystem, decodeSystem, BODY_KINDS, COMPOSITION_KEYS,
    base64UrlEncode, base64UrlDecode,
  };
}
