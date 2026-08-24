// renderer.js
// Canvas 2D rendering: world-space stars -> screen space, with pan/zoom,
// a soft motion-trail effect, and ephemeral supernova particle bursts.
// Runs on the main thread.

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // Camera: world point at screen center + zoom (pixels per world unit).
    this.camera = { x: 0, y: 0, zoom: 0.6 };

    this.colors = null;      // per-star color string, computed once at 'ready'
    this.pixelRadius = null; // per-star on-screen radius (device px), computed once at 'ready'
    this.alive = null;       // Uint8Array mirror of worker's alive flags, for skipping dead stars

    this.particles = []; // supernova burst particles: {x,y,vx,vy,born,color} in world space
    this._lastFrameTime = null;

    // Set by main.js: onClick(cssX, cssY) fires on a genuine click (not a drag-pan).
    this.onClick = null;

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
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      this.camera.x -= dx / this.camera.zoom;
      this.camera.y -= dy / this.camera.zoom;
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      // A near-stationary press+release is a click, not a pan.
      if (moved < 5 && this.onClick) this.onClick(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
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
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.zoom = 0.6;
  }

  // Precompute per-star color (from spectral type) and on-screen radius,
  // and reset the alive mask. Called once per 'ready' message from the worker.
  setStarMeta(starType, radius, n) {
    const colors = new Array(n);
    const pixelRadius = new Float32Array(n);
    colors[0] = 'rgba(255,246,214,1)'; // central mass
    pixelRadius[0] = 0; // drawn specially (glow), see draw()
    for (let i = 1; i < n; i++) {
      const st = starTypeByCode(starType[i]);
      colors[i] = st ? st.color : '#ffffff';
      // Map world-unit radius (1..10) to a small on-screen dot size, with a
      // sqrt curve so the O/M contrast reads clearly without huge dots.
      pixelRadius[i] = Math.max(0.9, Math.sqrt(radius[i]) * 0.85) * this.dpr;
    }
    this.colors = colors;
    this.pixelRadius = pixelRadius;
    this.alive = new Uint8Array(n).fill(1);
  }

  markDead(index) {
    if (this.alive) this.alive[index] = 0;
  }

  // Spawn a burst of ephemeral, gravity-free particles at a world position.
  spawnBurst(wx, wy, color) {
    const count = 100 + Math.floor(Math.random() * 101); // 100-200
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 220; // world units / second
      this.particles.push({
        x: wx, y: wy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: now,
        color,
      });
    }
  }

  _updateParticles(now, dtSec) {
    if (!this.particles.length) return;
    const alive = [];
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      if (age >= 0.5) continue;
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
      const alpha = Math.max(0, 1 - age / 0.5);
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

  draw(positions, n, now) {
    now = now ?? performance.now();
    const dtSec = this._lastFrameTime == null ? 0 : Math.min(0.05, (now - this._lastFrameTime) / 1000);
    this._lastFrameTime = now;

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

        ctx.fillStyle = this.colors[i] || 'rgba(220,220,255,0.9)';
        if (i === 0) {
          const r = Math.max(3, 4 * dpr);
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 6);
          grad.addColorStop(0, 'rgba(255,246,214,0.9)');
          grad.addColorStop(1, 'rgba(255,246,214,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,252,235,1)';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(sx, sy, this.pixelRadius ? this.pixelRadius[i] : 1.2 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    this._updateParticles(now, dtSec);
    this._drawParticles(now);
  }
}
