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

    this.mode = 'galaxy';    // 'galaxy' | 'system' - purely a render-time flag
    this.focusIndex = -1;    // index of the star being zoomed into, in system mode
    this.systemMeta = {};    // slot index -> planet metadata (orbitRadius, moons, ...)

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
      this.camera.zoom = Math.min(20, Math.max(0.02, this.camera.zoom * factor));
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
    this.camera.zoom = this.tween.fromZoom + (this.tween.targetZoom - this.tween.fromZoom) * eased;
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
    for (const s of slots) this.systemMeta[s.index] = s;
  }

  clearSystemMeta() {
    this.systemMeta = {};
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

  _moonWorldPos(planetX, planetY, moon, simStep) {
    const t = simStep * RENDER_DT;
    const angle = moon.phase0 + moon.angularSpeed * t;
    return { x: planetX + Math.cos(angle) * moon.orbitRadius, y: planetY + Math.sin(angle) * moon.orbitRadius };
  }

  // Moons have no physics-array index (they're pure render-time decoration -
  // see system-bodies.js), so they need their own hit-test path.
  findMoonAt(positions, sx, sy, simStep, thresholdPx = 10) {
    let best = null, bestDist = thresholdPx;
    for (const key in this.systemMeta) {
      const idx = Number(key);
      if (this.alive && !this.alive[idx]) continue;
      const meta = this.systemMeta[idx];
      if (!meta.moons || !meta.moons.length) continue;
      const px = positions[idx * 2], py = positions[idx * 2 + 1];
      for (let m = 0; m < meta.moons.length; m++) {
        const pos = this._moonWorldPos(px, py, meta.moons[m], simStep);
        const p = this.worldToScreen(pos.x, pos.y);
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bestDist) { bestDist = d; best = { planetIndex: idx, moonIndex: m }; }
      }
    }
    return best;
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

  // --- Main draw ---

  draw(positions, n, now, simStep) {
    now = now ?? performance.now();
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

    // System-mode extras: faint orbit rings + cosmetic moons.
    if (this.mode === 'system' && positions && this.focusIndex >= 0 && this.focusIndex < n) {
      const hx = positions[this.focusIndex * 2], hy = positions[this.focusIndex * 2 + 1];
      const hsx = cx + (hx - camera.x) * zoom, hsy = cy + (hy - camera.y) * zoom;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = Math.max(1, dpr);
      for (const key in this.systemMeta) {
        const idx = Number(key);
        if (this.alive && !this.alive[idx]) continue;
        const meta = this.systemMeta[idx];
        const ringR = meta.orbitRadius * zoom;
        ctx.beginPath();
        ctx.arc(hsx, hsy, ringR, 0, Math.PI * 2);
        ctx.stroke();

        if (meta.moons && meta.moons.length) {
          const px = positions[idx * 2], py = positions[idx * 2 + 1];
          ctx.fillStyle = 'rgba(220,225,255,0.85)';
          for (const moon of meta.moons) {
            const pos = this._moonWorldPos(px, py, moon, simStep || 0);
            const msx = cx + (pos.x - camera.x) * zoom, msy = cy + (pos.y - camera.y) * zoom;
            ctx.beginPath();
            ctx.arc(msx, msy, Math.max(1.1, 1.4 * dpr), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
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
      }
    }

    this._updateParticles(now, dtSec);
    this._drawParticles(now);
  }
}
