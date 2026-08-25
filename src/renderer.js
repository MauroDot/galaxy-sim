// renderer.js
// Canvas 2D rendering: world-space stars -> screen space, with pan/zoom,
// a soft motion-trail effect, ephemeral particle bursts, a galaxy<->system
// camera tween, and (in system mode) planet orbit rings + cosmetic moons.
// Runs on the main thread. Domain-agnostic where it can be: it knows how to
// draw a body given its precomputed color/size/kind, and how to tween the
// camera toward a target, but main.js decides *when* to do those things.

// Matches physics-worker.js's fixed timestep - needed here only to turn a
// step count into "simulation seconds" for animating cosmetic moon orbits.
const RENDER_DT = 1 / 60;

// Body "kind" classification for draw()'s per-body branch, cached per index
// alongside color/pixelRadius so draw() never has to re-derive it.
const KIND_STAR = 0;
const KIND_BLACKHOLE = 1;
const KIND_QUASAR = 2;
const KIND_NEUTRONSTAR = 3;
const KIND_PLANET = 4;
const KIND_EMPTY = 5;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // Camera: world point at screen center + zoom (pixels per world unit).
    this.camera = { x: 0, y: 0, zoom: 0.6 };
    this.tween = null; // active panZoomTo() animation, if any

    this.colors = null;      // per-index color string, computed at 'ready' / applySlotMeta
    this.pixelRadius = null; // per-index on-screen radius (device px)
    this.kind = null;        // per-index KIND_* classification
    this.starType = null;    // per-index raw type code (for hit-test/info lookups)
    this.alive = null;       // Uint8Array mirror of worker's alive flags, for skipping dead bodies

    this.mode = 'galaxy';    // 'cosmic' | 'galaxy' | 'system' - purely a render-time flag
    this.focusIndex = -1;    // index of the star being zoomed into, in system mode
    this.systemMeta = {};    // slot index -> planet metadata (orbitRadius, moons, ...)

    // Cosmic mode: index in the cosmic-layer positions buffer -> galaxy
    // metadata (name/mass/morphology/starCount), parallel to systemMeta one
    // level down. selectedGalaxyId is a stable galaxy id (not a buffer
    // index - those shift as galaxies are created/deleted), matching how
    // system bodies are addressed by worker-assigned index but this cosmic
    // layer's own records carry a separate persistent `id`.
    this.cosmicMeta = [];        // [{id, name, mass, morphology, starCount}], buffer-index-aligned
    this.selectedGalaxyId = -1;
    this._cosmicTrails = new Map(); // galaxyId -> [{x,y}, ...] ring buffer of recent positions

    // System-mode orbit trail: a short per-planet position history, drawn
    // as a fading polyline in system view. A DISTINCT mechanism from both
    // _cosmicTrails above and the global soft-fade fillRect in draw()'s
    // main loop - that fade is imperceptible at real orbital speeds (a
    // full period can take tens of minutes to hours at this sim's
    // calibrated scale, confirmed empirically), so a planet's circularity
    // needs its own, longer-lived trail to be visible without literally
    // waiting out a full orbit. Keyed by slot index, not id, matching how
    // every other system-body lookup in this file already works.
    this._systemTrails = new Map(); // slot index -> [{x,y}, ...] ring buffer

    this.selectedIndex = -1; // currently-selected body (set by main.js) - drawn with a selection ring
    this._newFlashes = [];   // [{index, born, duration}] - new-body glow fade, reads live position
    this._deleteFades = [];  // [{x,y,color,pixelRadius,born,duration}] - VALUE-snapshotted, not live:
                              // a freed slot is often immediately reused by the next creation, and a
                              // live read would visually snap the fade onto the new occupant.

    // The core (index 0) is a supermassive black hole that grows by eating
    // wandering black holes/quasars - main.js updates coreMass live as that
    // happens; initialCoreMass (set once, at 'ready') is the baseline its
    // glow size/brightness are scaled relative to, so the existing tuned
    // look at a fresh galaxy's starting mass is unchanged (ratio 1).
    this.coreMass = null;
    this.initialCoreMass = null;

    // Debug overlay (off by default): draws a labeled bounding box around
    // every live, on-screen body so it's obvious where the renderer thinks
    // each one is, even if the actual dot is too small/dim to spot easily.
    // Toggle with the 'D' key. Temporary debugging aid - safe to remove
    // once planet visibility is confirmed fixed.
    this.debugMode = false;

    this.particles = []; // ephemeral burst particles: {x,y,vx,vy,born,life,color} in world space
    this._lastFrameTime = null;
    this._lastHoverX = -9999;
    this._lastHoverY = -9999;

    // Set by main.js: onClick/onHover(cssX, cssY) fire on a genuine click
    // (not a drag-pan) / a throttled hover move, respectively.
    this.onClick = null;
    this.onHover = null;

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this._wireInput();
  }

  _resize() {
    const { canvas, dpr } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  _wireInput() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let moved = 0;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      const before = this.screenToWorld(e.offsetX, e.offsetY);
      const [zMin, zMax] = this._zoomRange();
      this.camera.zoom = Math.min(zMax, Math.max(zMin, this.camera.zoom * factor));
      const after = this.screenToWorld(e.offsetX, e.offsetY);
      // Keep the point under the cursor stationary while zooming.
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
    }, { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      moved = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        return;
      }
      if (!this.onHover) return;
      const dx = e.offsetX - this._lastHoverX;
      const dy = e.offsetY - this._lastHoverY;
      if (Math.abs(dx) + Math.abs(dy) < 3) return; // throttle
      this._lastHoverX = e.offsetX;
      this._lastHoverY = e.offsetY;
      this.onHover(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      // A near-stationary press+release is a click, not a pan.
      if (moved < 5 && this.onClick) this.onClick(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
    canvas.addEventListener('pointerleave', () => {
      if (this.onHover) this.onHover(-1, -1); // hide tooltip
    });
  }

  // Mode-aware zoom bounds. Framing the 100,000-unit cosmic plane in a
  // ~1000px viewport needs zoom~=0.008-0.01, below the galaxy/system range's
  // 0.02 floor - and a max well below where individual galaxy stars would
  // need to render (a galaxy dot should never grow large enough to look
  // like it should show internal structure; entering a galaxy is always an
  // explicit "Enter Galaxy ->" action, never an implicit scroll-zoom-in).
  // Checked in BOTH the wheel handler and after every tween/direct camera
  // write (_updateTween, resetCamera) - panZoomTo itself sets camera.zoom
  // with no bound at all, so a tween landing outside this mode's range
  // would otherwise pop back the instant the user first scrolled.
  _zoomRange() {
    return this.mode === 'cosmic' ? [0.005, 1.5] : [0.02, 20];
  }

  screenToWorld(sx, sy) {
    const { camera, canvas, dpr } = this;
    const cx = (canvas.width / dpr) / 2;
    const cy = (canvas.height / dpr) / 2;
    return {
      x: camera.x + (sx - cx) / camera.zoom,
      y: camera.y + (sy - cy) / camera.zoom,
    };
  }

  // Inverse of screenToWorld: world -> CSS-pixel screen coordinates, for
  // hit-testing against pointer events (which report CSS pixels).
  worldToScreen(wx, wy) {
    const { camera, canvas, dpr } = this;
    const cx = (canvas.width / dpr) / 2;
    const cy = (canvas.height / dpr) / 2;
    return {
      x: cx + (wx - camera.x) * camera.zoom,
      y: cy + (wy - camera.y) * camera.zoom,
    };
  }

  resetCamera() {
    this.tween = null;
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.zoom = 0.6;
  }

  // --- Camera tween (galaxy <-> system transitions) ---

  panZoomTo(targetX, targetY, targetZoom, durationMs, onDone) {
    const cam = this.camera;
    this.tween = {
      fromX: cam.x, fromY: cam.y, fromZoom: cam.zoom,
      targetX, targetY, targetZoom,
      start: performance.now(), duration: Math.max(1, durationMs),
      onDone: onDone || null,
    };
  }

  // Called by main.js each frame while a tween is active and the focus body
  // keeps moving (e.g. a star drifting through the galaxy during the 1s
  // transition into its system).
  retarget(x, y) {
    if (this.tween) { this.tween.targetX = x; this.tween.targetY = y; }
  }

  _updateTween(now) {
    if (!this.tween) return;
    const t = Math.min(1, (now - this.tween.start) / this.tween.duration);
    const eased = t * t * (3 - 2 * t); // smoothstep
    this.camera.x = this.tween.fromX + (this.tween.targetX - this.tween.fromX) * eased;
    this.camera.y = this.tween.fromY + (this.tween.targetY - this.tween.fromY) * eased;
    const [zMin, zMax] = this._zoomRange();
    this.camera.zoom = Math.min(zMax, Math.max(zMin,
      this.tween.fromZoom + (this.tween.targetZoom - this.tween.fromZoom) * eased));
    if (t >= 1) {
      const done = this.tween.onDone;
      this.tween = null;
      if (done) done();
    }
  }

  // --- Per-index visual metadata ---

  _visualFor(typeCode, radiusVal) {
    if (typeCode === BLACKHOLE_TYPE_CODE) {
      return { kind: KIND_BLACKHOLE, color: '#160821', pixelRadius: 6 * this.dpr };
    }
    if (typeCode === QUASAR_TYPE_CODE) {
      return { kind: KIND_QUASAR, color: '#fff7c2', pixelRadius: 5 * this.dpr };
    }
    if (typeCode === NEUTRONSTAR_TYPE_CODE) {
      return { kind: KIND_NEUTRONSTAR, color: '#cfe8ff', pixelRadius: 1 * this.dpr };
    }
    if (typeCode === PLANET_TYPE_CODE) {
      // radiusVal is already a display px value (system-bodies.js), not a
      // world-unit star radius, so no sqrt curve. The 1.8 floor here (not
      // just at generation time) also covers planets loaded from
      // localStorage that were saved before that floor was raised.
      return { kind: KIND_PLANET, color: '#c9ced6', pixelRadius: Math.max(1.8, radiusVal) * this.dpr };
    }
    if (typeCode === SYSTEM_EMPTY_TYPE_CODE) {
      return { kind: KIND_EMPTY, color: 'transparent', pixelRadius: 0 };
    }
    const st = starTypeByCode(typeCode);
    return {
      kind: KIND_STAR,
      color: st ? st.color : '#ffffff',
      // Map world-unit radius (1..10) to a small on-screen dot size, with a
      // sqrt curve so the O/M contrast reads clearly without huge dots.
      pixelRadius: Math.max(0.9, Math.sqrt(radiusVal) * 0.85) * this.dpr,
    };
  }

  // Precompute per-body color/size/kind and reset the alive mask. Called
  // once per 'ready' message from the worker (n is the full capacity,
  // including dormant reserved system-body slots).
  setStarMeta(starType, radius, n) {
    const colors = new Array(n);
    const pixelRadius = new Float32Array(n);
    const kind = new Uint8Array(n);
    colors[0] = 'rgba(255,246,214,1)'; // central mass
    pixelRadius[0] = 0; // drawn specially (glow), see draw()
    for (let i = 1; i < n; i++) {
      const v = this._visualFor(starType[i], radius[i]);
      colors[i] = v.color;
      pixelRadius[i] = v.pixelRadius;
      kind[i] = v.kind;
    }
    this.colors = colors;
    this.pixelRadius = pixelRadius;
    this.kind = kind;
    this.starType = Uint8Array.from(starType);
    this.alive = new Uint8Array(n).fill(1);
  }

  // Additive-only update for a handful of indices (e.g. newly populated
  // system-body slots). Deliberately does NOT touch any other index -
  // setStarMeta's full alive-array reset would otherwise silently
  // resurrect every star that already died earlier this session.
  applySlotMeta(entries) {
    for (const e of entries) {
      const v = this._visualFor(e.starType, e.radius);
      this.colors[e.index] = e.color || v.color;
      this.pixelRadius[e.index] = v.pixelRadius;
      this.kind[e.index] = v.kind;
      this.starType[e.index] = e.starType;
      this.alive[e.index] = 1;
    }
  }

  markDead(index) {
    if (this.alive) this.alive[index] = 0;
  }

  markSlotsEmpty(indices) {
    if (!this.alive) return;
    for (const idx of indices) {
      this.alive[idx] = 0;
      if (this.kind) this.kind[idx] = KIND_EMPTY;
    }
  }

  setSystemMeta(slots) {
    this.systemMeta = {};
    const stillTracked = new Set();
    for (const s of slots) { this.systemMeta[s.index] = s; stillTracked.add(s.index); }
    // Prune trail history for any slot that's no longer present (deleted,
    // collided, absorbed) - same "drop what's no longer tracked" pattern
    // _cosmicTrails already uses in updateCosmicTrails-adjacent code.
    for (const idx of this._systemTrails.keys()) {
      if (!stillTracked.has(idx)) this._systemTrails.delete(idx);
    }
  }

  clearSystemMeta() {
    this.systemMeta = {};
    this._systemTrails.clear();
  }

  // Cosmic mode's equivalent of setStarMeta/setSystemMeta - `galaxies` is
  // buffer-index-aligned with the cosmicPositions message (same order
  // main.js already keeps a copy in, since cosmicBodyDelta/cosmicReady both
  // send the full current list). Also records a trail sample per galaxy
  // (see _drawCosmic) - the existing global canvas-fade trail effect is
  // imperceptible at cosmic-orbit speeds, so this per-galaxy history is a
  // distinct, necessary mechanism, not a duplicate of that one.
  setCosmicMeta(galaxies) {
    this.cosmicMeta = galaxies;
    const stillTracked = new Set(galaxies.map((g) => g.id));
    for (const id of this._cosmicTrails.keys()) {
      if (!stillTracked.has(id)) this._cosmicTrails.delete(id);
    }
  }

  // --- Hit-testing (shared by click and hover) ---

  findBodyAt(positions, n, sx, sy, thresholdPx = 16) {
    if (!positions) return -1;
    let best = -1, bestDist = thresholdPx;
    for (let i = 0; i < n; i++) {
      if (this.alive && !this.alive[i]) continue;
      if (this.kind && this.kind[i] === KIND_EMPTY) continue;
      const p = this.worldToScreen(positions[i * 2], positions[i * 2 + 1]);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  // Cosmic mode's hit-test - returns a galaxy id (not a buffer index, which
  // shifts across create/delete), or -1. A slightly larger default
  // threshold than findBodyAt's: galaxy dots are meant to be easy targets
  // at a zoomed-way-out scale, not precision click targets.
  findGalaxyAt(cosmicPositions, n, sx, sy, thresholdPx = 20) {
    if (!cosmicPositions) return -1;
    let best = -1, bestDist = thresholdPx;
    for (let i = 0; i < n; i++) {
      const p = this.worldToScreen(cosmicPositions[i * 2], cosmicPositions[i * 2 + 1]);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best === -1 ? -1 : (this.cosmicMeta[best] ? this.cosmicMeta[best].id : -1);
  }

  _moonWorldPos(planetX, planetY, moon, simStep) {
    const t = simStep * RENDER_DT;
    const angle = moon.phase0 + moon.angularSpeed * t;
    return { x: planetX + Math.cos(angle) * moon.orbitRadius, y: planetY + Math.sin(angle) * moon.orbitRadius };
  }

  // Moons have no physics-array index (they're pure render-time decoration -
  // see system-bodies.js), so they need their own hit-test path. Reports the
  // moon's stable `id` (not its position in the .moons array) - deleting
  // moon 0 of 2 shifts moon 1 into slot 0, which would silently invalidate
  // any held reference resolved by array position instead.
  findMoonAt(positions, sx, sy, simStep, thresholdPx = 10) {
    let best = null, bestDist = thresholdPx;
    for (const key in this.systemMeta) {
      const idx = Number(key);
      if (this.alive && !this.alive[idx]) continue;
      const meta = this.systemMeta[idx];
      if (!meta.moons || !meta.moons.length) continue;
      const px = positions[idx * 2], py = positions[idx * 2 + 1];
      for (const moon of meta.moons) {
        const pos = this._moonWorldPos(px, py, moon, simStep);
        const p = this.worldToScreen(pos.x, pos.y);
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bestDist) { bestDist = d; best = { planetIndex: idx, moonId: moon.id }; }
      }
    }
    return best;
  }

  // --- Selection / creation / deletion visual feedback ---

  flashNew(index, durationMs = 2000) {
    this._newFlashes.push({ index, born: performance.now(), duration: durationMs });
  }

  // Snapshotted by value (x, y, color, pixelRadius) rather than read live
  // per-frame from the index each draw - see the field comment above.
  startDeleteFade(x, y, color, pixelRadius, durationMs = 500) {
    this._deleteFades.push({ x, y, color, pixelRadius, born: performance.now(), duration: durationMs });
  }

  // --- Particles (supernova bursts, absorption flashes) ---

  // Spawn a burst of ephemeral, gravity-free particles at a world position.
  // opts: { countMin, countMax, life (seconds), speedMin, speedMax }
  // Defaults match the supernova burst (100-200 particles, 0.5s); pass
  // smaller/quicker values for e.g. a black-hole absorption flash.
  spawnBurst(wx, wy, color, opts = {}) {
    const countMin = opts.countMin ?? 100;
    const countMax = opts.countMax ?? 200;
    const life = opts.life ?? 0.5;
    const speedMin = opts.speedMin ?? 40;
    const speedMax = opts.speedMax ?? 260;
    const count = countMin + Math.floor(Math.random() * (countMax - countMin + 1));
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = speedMin + Math.random() * (speedMax - speedMin);
      this.particles.push({
        x: wx, y: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: now,
        life,
        color,
      });
    }
  }

  _updateParticles(now, dtSec) {
    if (!this.particles.length) return;
    const alive = [];
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      if (age >= p.life) continue;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      alive.push(p);
    }
    this.particles = alive;
  }

  _drawParticles(now) {
    const { ctx, canvas, camera, dpr } = this;
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const zoom = camera.zoom * dpr;
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      const alpha = Math.max(0, 1 - age / p.life);
      const sx = cx + (p.x - camera.x) * zoom;
      const sy = cy + (p.y - camera.y) * zoom;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- Cosmic-scale draw (galaxies as glowing dots + fading trails) ---
  // Entirely separate from the star-level draw() below: different buffer
  // (cosmicPositions, not positions), different visual language (dots
  // colored/sized by galaxy morphology/mass, not spectral type), and no
  // shared per-body metadata with the star-level arrays at all.
  _drawCosmic(cosmicPositions, n, now) {
    const { ctx, canvas, camera, dpr } = this;
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const zoom = camera.zoom * dpr;

    ctx.fillStyle = 'rgba(4, 5, 14, 0.4)';
    ctx.fillRect(0, 0, w, h);
    if (!cosmicPositions) return;

    const morphColors = (typeof GALAXY_MORPHOLOGY_COLORS !== 'undefined') ? GALAXY_MORPHOLOGY_COLORS : {};
    const TRAIL_LENGTH = 30;

    for (let i = 0; i < n; i++) {
      const meta = this.cosmicMeta[i];
      if (!meta) continue;
      const wx = cosmicPositions[i * 2], wy = cosmicPositions[i * 2 + 1];

      // Trail: a short ring buffer of recent positions per galaxy id,
      // drawn as a fading polyline before the dot itself.
      let trail = this._cosmicTrails.get(meta.id);
      if (!trail) { trail = []; this._cosmicTrails.set(meta.id, trail); }
      if (trail.length === 0 || trail[trail.length - 1].x !== wx || trail[trail.length - 1].y !== wy) {
        trail.push({ x: wx, y: wy });
        if (trail.length > TRAIL_LENGTH) trail.shift();
      }

      const sx = cx + (wx - camera.x) * zoom, sy = cy + (wy - camera.y) * zoom;
      if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;

      if (trail.length > 1) {
        ctx.beginPath();
        for (let t = 0; t < trail.length; t++) {
          const p = trail[t];
          const tsx = cx + (p.x - camera.x) * zoom, tsy = cy + (p.y - camera.y) * zoom;
          if (t === 0) ctx.moveTo(tsx, tsy); else ctx.lineTo(tsx, tsy);
        }
        const color = morphColors[meta.morphology] || '#a6c0ff';
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = Math.max(1, 1.2 * dpr);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      const color = morphColors[meta.morphology] || '#a6c0ff';
      // Mass -> dot size, sqrt curve so the range (8e4-4e5, plus merged
      // galaxies well above that) doesn't produce wildly mismatched sizes.
      const r = Math.max(3, Math.sqrt(meta.mass) * 0.02) * dpr;

      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3.2);
      grad.addColorStop(0, color);
      grad.addColorStop(0.4, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      if (meta.id === this.selectedGalaxyId) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1, 1.5 * dpr);
        ctx.beginPath();
        ctx.arc(sx, sy, r + 5 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Name label - only once zoomed in enough that labels wouldn't
      // completely overlap at typical galaxy spacing.
      if (camera.zoom > 0.02) {
        ctx.font = `${11 * dpr}px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(220,225,255,0.85)';
        ctx.fillText(meta.name, sx + r + 4 * dpr, sy - 5 * dpr);
      }
    }
  }

  // --- Main draw ---

  draw(positions, n, now, simStep) {
    now = now ?? performance.now();
    if (this.mode === 'cosmic') {
      const dtSecCosmic = this._lastFrameTime == null ? 0 : Math.min(0.05, (now - this._lastFrameTime) / 1000);
      this._updateTween(now);
      this._drawCosmic(positions, n, now);
      this._updateParticles(now, dtSecCosmic); // e.g. the "Collision" flourish burst
      this._drawParticles(now);
      this._lastFrameTime = now;
      return;
    }
    const dtSec = this._lastFrameTime == null ? 0 : Math.min(0.05, (now - this._lastFrameTime) / 1000);
    this._lastFrameTime = now;
    this._updateTween(now);

    const { ctx, canvas, camera, dpr } = this;
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const zoom = camera.zoom * dpr;

    // Soft trail effect instead of a hard clear.
    ctx.fillStyle = 'rgba(6, 8, 20, 0.35)';
    ctx.fillRect(0, 0, w, h);

    if (positions && this.colors) {
      for (let i = 0; i < n; i++) {
        if (this.alive && !this.alive[i]) continue;
        const wx = positions[i * 2];
        const wy = positions[i * 2 + 1];
        const sx = cx + (wx - camera.x) * zoom;
        const sy = cy + (wy - camera.y) * zoom;
        if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) continue;

        const k = this.kind ? this.kind[i] : KIND_STAR;
        ctx.fillStyle = this.colors[i] || 'rgba(220,220,255,0.9)';

        if (i === 0) {
          // The core is itself a supermassive black hole: dark center, with
          // an outer glow whose size (sqrt(mass)) and brightness grow as it
          // consumes wandering black holes/quasars. growthRatio is 1 at the
          // galaxy's starting core mass, so a fresh galaxy looks exactly as
          // before - it only visibly swells once it's eaten something.
          const growthRatio = this.initialCoreMass
            ? Math.max(1, (this.coreMass ?? this.initialCoreMass) / this.initialCoreMass)
            : 1;
          const glowScale = Math.sqrt(growthRatio);
          const r = Math.max(3.5, 4.5 * dpr); // dark center stays a fixed size
          const glowR = r * 6 * glowScale;
          const brightness = Math.min(1, 0.6 + 0.4 * Math.min(1, glowScale - 1));

          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
          grad.addColorStop(0, `rgba(190,145,255,${brightness})`);
          grad.addColorStop(0.55, `rgba(150,95,255,${brightness * 0.35})`);
          grad.addColorStop(1, 'rgba(150,95,255,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = `rgba(205,170,255,${Math.min(1, brightness + 0.15)})`;
          ctx.lineWidth = Math.max(1.2, 1.6 * dpr);
          ctx.beginPath();
          ctx.arc(sx, sy, glowR * 0.5, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#0d0616';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (k === KIND_BLACKHOLE) {
          const r = this.pixelRadius[i];
          // Subtle glowing ring first (lighter purple, semi-transparent, 1.5x radius)...
          ctx.strokeStyle = 'rgba(176,120,255,0.55)';
          ctx.lineWidth = Math.max(1, 1.1 * dpr);
          ctx.beginPath();
          ctx.arc(sx, sy, r * 1.5, 0, Math.PI * 2);
          ctx.stroke();
          // ...then a solid, non-sparkly dark-purple/black disc on top.
          ctx.fillStyle = this.colors[i];
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (k === KIND_QUASAR) {
          const r = this.pixelRadius[i];
          // Big soft outer glow - "very distinctive, looks like a tiny star with a big ring".
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 5);
          grad.addColorStop(0, 'rgba(255,247,194,0.55)');
          grad.addColorStop(1, 'rgba(255,247,194,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 5, 0, Math.PI * 2);
          ctx.fill();
          // Bright yellow/white ring.
          ctx.strokeStyle = 'rgba(255,244,180,0.9)';
          ctx.lineWidth = Math.max(1.2, 1.6 * dpr);
          ctx.beginPath();
          ctx.arc(sx, sy, r * 2, 0, Math.PI * 2);
          ctx.stroke();
          // Bright core.
          ctx.fillStyle = '#fffdf0';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (k === KIND_NEUTRONSTAR) {
          const r = Math.max(1, this.pixelRadius[i]);
          // Tiny but brighter-than-a-star sparkle.
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
          grad.addColorStop(0, 'rgba(207,232,255,0.9)');
          grad.addColorStop(1, 'rgba(207,232,255,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (k === KIND_PLANET) {
          // A small soft halo so a 2-4px dot doesn't get lost against the
          // dark background - most planets are the muted "airless" gray,
          // which needs the extra help to read as a distinct body rather
          // than background noise.
          const r = this.pixelRadius[i];
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.4);
          grad.addColorStop(0, this.colors[i]);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = this.colors[i];
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Ordinary star - a plain dot at its precomputed color/size.
          ctx.beginPath();
          ctx.arc(sx, sy, this.pixelRadius ? this.pixelRadius[i] : 1.2 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // System-mode extras: faint nominal-orbit rings, per-planet orbit
    // trails, + cosmetic moons.
    const SYSTEM_TRAIL_LENGTH = 240; // ~4s of samples at 60Hz - enough to read curvature without a full orbit
    if (this.mode === 'system' && positions && this.focusIndex >= 0 && this.focusIndex < n) {
      const hx = positions[this.focusIndex * 2], hy = positions[this.focusIndex * 2 + 1];
      const hsx = cx + (hx - camera.x) * zoom, hsy = cy + (hy - camera.y) * zoom;
      for (const key in this.systemMeta) {
        const idx = Number(key);
        if (this.alive && !this.alive[idx]) continue;
        const meta = this.systemMeta[idx];

        // Nominal orbit ring: plain faint white for pure-physics bodies,
        // a soft cyan tint for anything the Orbit Stability slider/"Lock
        // Orbit" is actively assisting - a quick "this one's protected"
        // visual cue with zero extra state (meta.lockStrength already
        // travels with every systemBodyDelta/starInfo broadcast).
        const assisted = meta.locked && (meta.lockStrength || 0) > 0;
        ctx.strokeStyle = assisted ? 'rgba(130,220,255,0.28)' : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = Math.max(1, dpr);
        const ringR = meta.orbitRadius * zoom;
        ctx.beginPath();
        ctx.arc(hsx, hsy, ringR, 0, Math.PI * 2);
        ctx.stroke();

        // Orbit trail: append the current position (world space, sampled
        // once per rendered frame - fine-grained enough at 60fps to read
        // as smooth curvature over a few seconds).
        const wx = positions[idx * 2], wy = positions[idx * 2 + 1];
        let trail = this._systemTrails.get(idx);
        if (!trail) { trail = []; this._systemTrails.set(idx, trail); }
        if (trail.length === 0 || trail[trail.length - 1].x !== wx || trail[trail.length - 1].y !== wy) {
          trail.push({ x: wx, y: wy });
          if (trail.length > SYSTEM_TRAIL_LENGTH) trail.shift();
        }
        if (trail.length > 1) {
          ctx.beginPath();
          for (let t = 0; t < trail.length; t++) {
            const p = trail[t];
            const tsx = cx + (p.x - camera.x) * zoom, tsy = cy + (p.y - camera.y) * zoom;
            if (t === 0) ctx.moveTo(tsx, tsy); else ctx.lineTo(tsx, tsy);
          }
          ctx.strokeStyle = this.colors && this.colors[idx] ? this.colors[idx] : 'rgba(220,225,255,0.5)';
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = Math.max(1, 1.1 * dpr);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        if (meta.moons && meta.moons.length) {
          ctx.fillStyle = 'rgba(220,225,255,0.85)';
          for (const moon of meta.moons) {
            const pos = this._moonWorldPos(wx, wy, moon, simStep || 0);
            const msx = cx + (pos.x - camera.x) * zoom, msy = cy + (pos.y - camera.y) * zoom;
            ctx.beginPath();
            ctx.arc(msx, msy, Math.max(1.1, 1.4 * dpr), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // Selection ring: a pulsing outline around the currently-selected body,
    // read live (it's a real, still-occupied index while selected).
    if (this.selectedIndex >= 0 && this.selectedIndex < n && positions &&
        (!this.alive || this.alive[this.selectedIndex])) {
      const idx = this.selectedIndex;
      const wx = positions[idx * 2], wy = positions[idx * 2 + 1];
      const sx = cx + (wx - camera.x) * zoom, sy = cy + (wy - camera.y) * zoom;
      const baseR = (this.pixelRadius ? this.pixelRadius[idx] : 3 * dpr) || 3 * dpr;
      const pulse = 1 + 0.15 * Math.sin(now / 220);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1.2, 1.5 * dpr);
      ctx.beginPath();
      ctx.arc(sx, sy, (baseR + 5 * dpr) * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    // New-body flash: an expanding, fading ring at a just-created body's
    // (live) position - a soft "welcome" pulse, not tied to selection.
    if (this._newFlashes.length && positions) {
      const stillActive = [];
      for (const f of this._newFlashes) {
        const t = (now - f.born) / f.duration;
        if (t >= 1 || f.index >= n || (this.alive && !this.alive[f.index])) continue;
        stillActive.push(f);
        const wx = positions[f.index * 2], wy = positions[f.index * 2 + 1];
        const sx = cx + (wx - camera.x) * zoom, sy = cy + (wy - camera.y) * zoom;
        const baseR = (this.pixelRadius ? this.pixelRadius[f.index] : 3 * dpr) || 3 * dpr;
        const growR = baseR + t * 14 * dpr;
        ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.9})`;
        ctx.lineWidth = Math.max(1, 1.4 * dpr);
        ctx.beginPath();
        ctx.arc(sx, sy, growR, 0, Math.PI * 2);
        ctx.stroke();
      }
      this._newFlashes = stillActive;
    }

    // Delete fade: a shrinking, fading ghost at a just-deleted body's
    // CAPTURED position/color (not live - see the field comment above).
    if (this._deleteFades.length) {
      const stillActive = [];
      for (const f of this._deleteFades) {
        const t = (now - f.born) / f.duration;
        if (t >= 1) continue;
        stillActive.push(f);
        const sx = cx + (f.x - camera.x) * zoom, sy = cy + (f.y - camera.y) * zoom;
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.5, f.pixelRadius * (1 - t * 0.5)), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      this._deleteFades = stillActive;
    }

    // Debug overlay: a labeled box around every live body's computed screen
    // position (green = on-screen, red = clipped/off-screen) - makes it
    // trivial to see whether a "missing" body is actually just tiny/dim vs.
    // genuinely mispositioned. Toggle with 'D'. Cheap enough to leave in
    // (only runs at all when this.debugMode is explicitly turned on).
    if (this.debugMode && positions) {
      ctx.font = `${10 * dpr}px monospace`;
      ctx.textBaseline = 'top';
      for (let i = 0; i < n; i++) {
        if (this.alive && !this.alive[i]) continue;
        if (this.kind && this.kind[i] === KIND_EMPTY) continue;
        const wx = positions[i * 2], wy = positions[i * 2 + 1];
        const sx = cx + (wx - camera.x) * zoom, sy = cy + (wy - camera.y) * zoom;
        const onScreen = sx >= -10 && sx <= w + 10 && sy >= -10 && sy <= h + 10;
        const boxR = Math.max(6 * dpr, (this.pixelRadius ? this.pixelRadius[i] : 4 * dpr) + 4 * dpr);
        ctx.strokeStyle = onScreen ? 'rgba(80,255,120,0.9)' : 'rgba(255,80,80,0.9)';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.strokeRect(sx - boxR, sy - boxR, boxR * 2, boxR * 2);
        const label = this.systemMeta[i] ? this.systemMeta[i].name : `#${i}`;
        ctx.fillStyle = onScreen ? '#8fffb0' : '#ff9a9a';
        ctx.fillText(`${label} (${sx.toFixed(0)},${sy.toFixed(0)})`, sx + boxR + 2, sy - boxR);

        // System-mode extra: a velocity-direction arrow (from the orbit
        // trail's last two samples - no extra worker message needed, the
        // trail already has what's needed) and live distance-from-host
        // text, directly under the existing box label.
        if (this.mode === 'system' && this.systemMeta[i] && onScreen) {
          const dist = this.focusIndex >= 0
            ? Math.hypot(wx - positions[this.focusIndex * 2], wy - positions[this.focusIndex * 2 + 1])
            : null;
          if (dist != null) {
            ctx.fillText(`dist=${dist.toFixed(1)}`, sx + boxR + 2, sy - boxR + 11 * dpr);
          }
          const trail = this._systemTrails.get(i);
          if (trail && trail.length >= 2) {
            const a = trail[trail.length - 2], b = trail[trail.length - 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const mag = Math.hypot(dx, dy);
            if (mag > 1e-6) {
              const arrowLen = 18 * dpr;
              const ex = sx + (dx / mag) * arrowLen, ey = sy + (dy / mag) * arrowLen;
              ctx.strokeStyle = 'rgba(255,220,120,0.9)';
              ctx.lineWidth = Math.max(1, 1.2 * dpr);
              ctx.beginPath();
              ctx.moveTo(sx, sy);
              ctx.lineTo(ex, ey);
              ctx.stroke();
              const ang = Math.atan2(ey - sy, ex - sx);
              ctx.beginPath();
              ctx.moveTo(ex, ey);
              ctx.lineTo(ex - 5 * dpr * Math.cos(ang - 0.4), ey - 5 * dpr * Math.sin(ang - 0.4));
              ctx.lineTo(ex - 5 * dpr * Math.cos(ang + 0.4), ey - 5 * dpr * Math.sin(ang + 0.4));
              ctx.closePath();
              ctx.fillStyle = 'rgba(255,220,120,0.9)';
              ctx.fill();
            }
          }
        }
      }
    }

    this._updateParticles(now, dtSec);
    this._drawParticles(now);
  }
}
