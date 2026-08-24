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
    blackHoleStat: document.getElementById('blackHoleStat'),
    absorptionStat: document.getElementById('absorptionStat'),
    infoPanel: document.getElementById('info-panel'),
    infoTitle: document.getElementById('infoTitle'),
    infoLabel1: document.getElementById('infoLabel1'),
    infoValue1: document.getElementById('infoValue1'),
    infoLabel2: document.getElementById('infoLabel2'),
    infoValue2: document.getElementById('infoValue2'),
    infoLabel3: document.getElementById('infoLabel3'),
    infoValue3: document.getElementById('infoValue3'),
    infoLabel4: document.getElementById('infoLabel4'),
    infoValue4: document.getElementById('infoValue4'),
    infoFlash: document.getElementById('infoFlash'),
  };

  let playing = true;
  let latestPositions = null;
  let latestN = 0;
  let lastStepSeen = -1;
  let physStepsAtLastFpsCheck = 0;
  let supernovaCount = 0;
  let absorptionCount = 0;
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
    absorptionCount = 0;
    els.supernovaStat.textContent = '0';
    els.absorptionStat.textContent = '0';
    selectedIndex = -1;
    hideInfoPanel();
    // The worker's step counter restarts at 0 for the new galaxy; without
    // this the next FPS sample window diffs against the old (much larger)
    // step count and briefly shows a negative Physics Hz.
    lastStepSeen = -1;
    physStepsAtLastFpsCheck = -1;
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

  // Compact large-number formatting (k/M/B suffixes), used for masses and
  // the stylized black-hole event horizon - both can range from ~0.4 (a
  // small star) up into the tens of millions (a black hole).
  function formatCompact(n) {
    if (!Number.isFinite(n)) return '∞';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'k';
    return n.toFixed(2);
  }

  function hideInfoPanel() {
    els.infoPanel.classList.add('hidden');
    if (infoPollTimer) {
      clearInterval(infoPollTimer);
      infoPollTimer = null;
    }
  }

  function showBodyInfo(info) {
    els.infoPanel.classList.remove('hidden');

    if (info.isBlackHole) {
      els.infoTitle.textContent = 'Black Hole';
      els.infoLabel1.textContent = 'Type';
      els.infoValue1.textContent = 'Black Hole';
      els.infoValue1.style.color = '#c79bff';
      els.infoLabel2.textContent = 'Mass';
      els.infoValue2.textContent = formatCompact(info.mass) + ' M☉';
      els.infoLabel3.textContent = 'Event Horizon';
      els.infoValue3.textContent = formatCompact(info.mass * BLACKHOLE_EVENT_HORIZON_FACTOR) + ' units';
      els.infoLabel4.textContent = 'Stars absorbed';
      els.infoValue4.textContent = String(info.absorbed || 0);
      els.infoFlash.classList.add('hidden');
      return;
    }

    const st = (window.STAR_TYPES || []).find((t) => t.code === info.starType);
    els.infoTitle.textContent = st ? 'Star' : 'Core';
    els.infoLabel1.textContent = 'Type';
    els.infoValue1.textContent = st ? `${st.label} - ${st.colorName}` : 'Core';
    els.infoValue1.style.color = st ? st.color : '#fff6d6';
    els.infoLabel2.textContent = 'Mass';
    els.infoValue2.textContent = formatCompact(info.mass) + ' M☉';
    els.infoLabel3.textContent = 'Age';
    els.infoValue3.textContent = formatYears(info.age);
    els.infoLabel4.textContent = 'Lifetime';
    els.infoValue4.textContent = formatYears(info.lifetime);
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
    init(currentSeed(), currentStarCount());
    renderer.resetCamera();
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
      els.blackHoleStat.textContent = String(msg.blackHoleCount);
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
    } else if (msg.type === 'absorption') {
      renderer.markDead(msg.starIndex);
      // Brief white flash at the black hole, smaller/quicker than a supernova.
      renderer.spawnBurst(msg.x, msg.y, '#ffffff', {
        countMin: 10, countMax: 20, life: 0.3, speedMin: 20, speedMax: 120,
      });
      absorptionCount++;
      els.absorptionStat.textContent = String(absorptionCount);
      // The selected black hole's "Stars absorbed" count is kept current by
      // the periodic getStarInfo poll below - no extra push needed here.
    } else if (msg.type === 'starInfo') {
      if (msg.index === selectedIndex) showBodyInfo(msg);
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
