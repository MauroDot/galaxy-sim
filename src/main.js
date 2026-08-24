// main.js
// Wires UI controls to the physics worker and drives the render loop.

(function () {
  const canvas = document.getElementById('sim-canvas');
  const renderer = new Renderer(canvas);
  const worker = new Worker('src/physics-worker.js');

  const els = {
    playPause: document.getElementById('playPauseBtn'),
    reset: document.getElementById('resetBtn'),
    regen: document.getElementById('regenBtn'),
    speed: document.getElementById('speedSlider'),
    speedLabel: document.getElementById('speedLabel'),
    seed: document.getElementById('seedInput'),
    starCount: document.getElementById('starCountInput'),
    fps: document.getElementById('fpsStat'),
    starStat: document.getElementById('starStat'),
    physStat: document.getElementById('physStat'),
    supernovaStat: document.getElementById('supernovaStat'),
    infoPanel: document.getElementById('info-panel'),
    infoType: document.getElementById('infoType'),
    infoMass: document.getElementById('infoMass'),
    infoAge: document.getElementById('infoAge'),
    infoLifetime: document.getElementById('infoLifetime'),
    infoFlash: document.getElementById('infoFlash'),
  };

  let playing = true;
  let latestPositions = null;
  let latestN = 0;
  let lastStepSeen = -1;
  let physStepsAtLastFpsCheck = 0;
  let supernovaCount = 0;
  let selectedIndex = -1;
  let infoPollTimer = null;
  let flashTimer = null;

  // --- Audio: a short 440Hz beep on each supernova ---
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      audioCtx = null;
    }
    return audioCtx;
  }
  function playBeep() {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch (err) {
      /* audio best-effort only */
    }
  }
  // Unlock audio on first real user gesture (autoplay policies).
  window.addEventListener('pointerdown', () => ensureAudio(), { once: true });
  window.addEventListener('keydown', () => ensureAudio(), { once: true });

  function randomSeed() {
    return Math.floor(Math.random() * 1e9).toString(36);
  }

  function currentSeed() {
    return els.seed.value.trim() || randomSeed();
  }

  function currentStarCount() {
    const v = parseInt(els.starCount.value, 10);
    return Number.isFinite(v) ? Math.min(3000, Math.max(10, v)) : 500;
  }

  function setPlaying(next) {
    playing = next;
    els.playPause.textContent = playing ? '⏸ Pause' : '▶ Play';
    worker.postMessage({ type: playing ? 'play' : 'pause' });
  }

  function init(seed, numStars) {
    els.seed.value = seed;
    supernovaCount = 0;
    els.supernovaStat.textContent = '0';
    selectedIndex = -1;
    hideInfoPanel();
    worker.postMessage({ type: 'init', seed, numStars });
  }

  // --- Info panel ---

  function formatYears(y) {
    if (!Number.isFinite(y)) return '∞';
    if (y >= 1e9) return (y / 1e9).toFixed(2) + 'B yr';
    if (y >= 1e6) return (y / 1e6).toFixed(2) + 'M yr';
    if (y >= 1e3) return (y / 1e3).toFixed(1) + 'k yr';
    return Math.round(y) + ' yr';
  }

  function hideInfoPanel() {
    els.infoPanel.classList.add('hidden');
    if (infoPollTimer) {
      clearInterval(infoPollTimer);
      infoPollTimer = null;
    }
  }

  function showStarInfo(info) {
    const st = (window.STAR_TYPES || []).find((t) => t.code === info.starType);
    els.infoPanel.classList.remove('hidden');
    els.infoType.textContent = st ? `${st.label} - ${st.colorName}` : 'Core';
    els.infoType.style.color = st ? st.color : '#fff6d6';
    els.infoMass.textContent = info.mass.toFixed(2) + ' M☉';
    els.infoAge.textContent = formatYears(info.age);
    els.infoLifetime.textContent = formatYears(info.lifetime);
    if (!info.alive) {
      els.infoFlash.textContent = '\u{1F4A5} Supernova!';
      els.infoFlash.classList.remove('hidden');
    } else {
      els.infoFlash.classList.add('hidden');
    }
  }

  function selectStar(index) {
    selectedIndex = index;
    if (infoPollTimer) clearInterval(infoPollTimer);
    worker.postMessage({ type: 'getStarInfo', index });
    // Keep the panel live-ish while a star is selected.
    infoPollTimer = setInterval(() => {
      if (selectedIndex >= 0) worker.postMessage({ type: 'getStarInfo', index: selectedIndex });
    }, 500);
  }

  renderer.onClick = (sx, sy) => {
    if (!latestPositions) return;
    let best = -1;
    let bestDist = 16; // px hit-radius, generous enough for small dots
    for (let i = 0; i < latestN; i++) {
      if (renderer.alive && !renderer.alive[i]) continue;
      const wx = latestPositions[i * 2];
      const wy = latestPositions[i * 2 + 1];
      const p = renderer.worldToScreen(wx, wy);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) selectStar(best);
  };

  function flashSupernovaBanner() {
    els.infoFlash.textContent = '\u{1F4A5} Supernova!';
    els.infoFlash.classList.remove('hidden');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (selectedIndex === -1) els.infoFlash.classList.add('hidden');
    }, 2000);
  }

  // --- UI wiring ---

  els.playPause.addEventListener('click', () => setPlaying(!playing));

  els.reset.addEventListener('click', () => {
    worker.postMessage({ type: 'reset', seed: currentSeed(), numStars: currentStarCount() });
    renderer.resetCamera();
    supernovaCount = 0;
    els.supernovaStat.textContent = '0';
    selectedIndex = -1;
    hideInfoPanel();
    setPlaying(true);
  });

  els.regen.addEventListener('click', () => {
    const seed = randomSeed();
    init(seed, currentStarCount());
    renderer.resetCamera();
    setPlaying(true);
  });

  els.speed.addEventListener('input', () => {
    const speed = parseFloat(els.speed.value);
    els.speedLabel.textContent = speed.toFixed(2) + 'x';
    worker.postMessage({ type: 'setSpeed', speed });
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      setPlaying(!playing);
    }
  });

  // --- Worker messages ---

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      renderer.setStarMeta(msg.starType, msg.radius, msg.n);
      els.starStat.textContent = String(msg.n);
    } else if (msg.type === 'positions') {
      latestPositions = msg.buf;
      latestN = msg.n;
      lastStepSeen = msg.step;
    } else if (msg.type === 'supernova') {
      renderer.markDead(msg.index);
      const st = (window.STAR_TYPES || []).find((t) => t.code === msg.starType);
      renderer.spawnBurst(msg.x, msg.y, st ? st.color : '#ffcf7a');
      playBeep();
      supernovaCount++;
      els.supernovaStat.textContent = String(supernovaCount);
      if (msg.index === selectedIndex) {
        flashSupernovaBanner();
      }
    } else if (msg.type === 'starInfo') {
      if (msg.index === selectedIndex) showStarInfo(msg);
    }
  };

  // --- Render loop (decoupled from physics tick rate) ---

  let frames = 0;
  let lastFpsTime = performance.now();

  function frame(now) {
    renderer.draw(latestPositions, latestN, now);

    frames++;
    if (now - lastFpsTime >= 500) {
      const fps = (frames * 1000) / (now - lastFpsTime);
      els.fps.textContent = fps.toFixed(0);
      const physSteps = lastStepSeen - physStepsAtLastFpsCheck;
      physStepsAtLastFpsCheck = lastStepSeen;
      const physHz = physSteps / ((now - lastFpsTime) / 1000);
      els.physStat.textContent = physHz.toFixed(0);
      frames = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(frame);
  }

  // --- Boot ---

  els.speedLabel.textContent = parseFloat(els.speed.value).toFixed(2) + 'x';
  init(currentSeed() || randomSeed(), currentStarCount());
  worker.postMessage({ type: 'setSpeed', speed: parseFloat(els.speed.value) });
  setPlaying(true);
  requestAnimationFrame(frame);
})();
