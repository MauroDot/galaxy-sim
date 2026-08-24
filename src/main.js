// main.js
// Wires UI controls to the physics worker and drives the render loop.
// Also owns the galaxy<->system mode state machine, localStorage
// persistence of zoomed-in systems, and the info panel / tooltip logic.

(function () {
  const canvas = document.getElementById('sim-canvas');
  const renderer = new Renderer(canvas);
  const worker = new Worker('src/physics-worker.js');

  // Fixed system-view zoom (vs. galaxy's default 0.6). Chosen to frame a
  // star's full planet range (orbits placed 20-150 units out, see
  // system-bodies.js) with margin - not a literal reading of the spec's
  // "20,000/500 unit, 40x" figures, which assume a galaxy scale this sim
  // doesn't have (see README for the full explanation).
  const SYSTEM_ZOOM = 3.0;

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
    modeIndicator: document.getElementById('modeIndicator'),
    backBtn: document.getElementById('backToGalaxyBtn'),
    overlay: document.getElementById('transition-overlay'),
    tooltip: document.getElementById('tooltip'),
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
    infoRow5: document.getElementById('infoRow5'),
    infoLabel5: document.getElementById('infoLabel5'),
    infoValue5: document.getElementById('infoValue5'),
    infoRow6: document.getElementById('infoRow6'),
    infoLabel6: document.getElementById('infoLabel6'),
    infoValue6: document.getElementById('infoValue6'),
    infoAction: document.getElementById('infoAction'),
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
  let bodyMass = null; // full mass array from 'ready', for instant tooltip lookups

  // --- Sol System zoom state ---
  let mode = 'galaxy'; // 'galaxy' | 'system'
  let focusIndex = -1;
  let latestSystemSlots = [];
  let activeSeed = null;
  let autosaveTimer = null;

  // --- Audio: a short 440Hz beep on each supernova, plus a zoom "whoosh" ---
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
  function playWhoosh() {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.35);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(t0 + 0.42);
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
    activeSeed = seed;
    supernovaCount = 0;
    absorptionCount = 0;
    els.supernovaStat.textContent = '0';
    els.absorptionStat.textContent = '0';
    selectedIndex = -1;
    hideInfoPanel();
    resetToGalaxyUI();
    // The worker's step counter restarts at 0 for the new galaxy; without
    // this the next FPS sample window diffs against the old (much larger)
    // step count and briefly shows a negative Physics Hz.
    lastStepSeen = -1;
    physStepsAtLastFpsCheck = -1;
    worker.postMessage({ type: 'init', seed, numStars });
  }

  // --- Formatting helpers ---

  function formatYears(y) {
    if (!Number.isFinite(y)) return '∞';
    if (y >= 1e9) return (y / 1e9).toFixed(2) + 'B yr';
    if (y >= 1e6) return (y / 1e6).toFixed(2) + 'M yr';
    if (y >= 1e3) return (y / 1e3).toFixed(1) + 'k yr';
    if (y >= 1) return y.toFixed(2) + ' yr';
    // Sub-1-year periods happen for close-in planets, especially orbiting
    // "Sol" (the galactic core, mass 30000 - far heavier than a real Sun,
    // so even a modest orbit radius implies a very fast, short-period
    // orbit). Rounding straight to "0.00 yr" would look broken, so degrade
    // to days/hours instead - still the same real physics value, just in a
    // more legible unit.
    if (y > 0) {
      const days = y * 365.25;
      if (days >= 1) return days.toFixed(1) + ' days';
      return (days * 24).toFixed(1) + ' hours';
    }
    return '0 yr';
  }

  // Compact large-number formatting (k/M/B suffixes), used for masses and
  // the stylized black-hole/quasar event-horizon-style displays - ranges
  // from ~0.4 (a small star) up into the tens of thousands (a black hole).
  function formatCompact(n) {
    if (!Number.isFinite(n)) return '∞';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'k';
    return n.toFixed(2);
  }

  function formatStarLabel(typeCode, mass) {
    if (typeCode === CORE_TYPE_CODE) return 'Sol';
    const st = (window.STAR_TYPES || []).find((t) => t.code === typeCode);
    return st ? `${st.label}-type (${formatCompact(mass)} M☉)` : 'Star';
  }

  // --- localStorage persistence (main-thread only - a Worker has no
  // localStorage at all) ---

  function systemStorageKey(seedVal, starIndex) {
    return `galaxysim:system:${seedVal}:${starIndex}`;
  }
  function loadSavedSystem(starIndex) {
    try {
      const raw = localStorage.getItem(systemStorageKey(activeSeed, starIndex));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null; // corrupt entry, private-mode quota, etc. - just regenerate
    }
  }
  function saveSystemSnapshot(snapshot) {
    try {
      localStorage.setItem(systemStorageKey(activeSeed, snapshot.starIndex), JSON.stringify(snapshot));
    } catch (err) {
      /* best-effort only */
    }
  }

  // --- Transition overlay / camera tween helpers ---

  function pulseOverlay(totalMs) {
    els.overlay.classList.add('active');
    setTimeout(() => els.overlay.classList.remove('active'), Math.max(200, totalMs - 300));
  }

  function resetToGalaxyUI() {
    mode = 'galaxy';
    focusIndex = -1;
    latestSystemSlots = [];
    renderer.mode = 'galaxy';
    renderer.focusIndex = -1;
    renderer.clearSystemMeta();
    els.modeIndicator.textContent = 'Galaxy View';
    els.modeIndicator.classList.remove('mode-system');
    els.modeIndicator.classList.add('mode-galaxy');
    els.backBtn.classList.add('hidden');
    document.body.classList.remove('system-mode');
    stopAutosave();
  }

  function startAutosave() {
    stopAutosave();
    autosaveTimer = setInterval(() => {
      if (mode === 'system') worker.postMessage({ type: 'peekSystemSnapshot' });
    }, 5000);
  }
  function stopAutosave() {
    if (autosaveTimer) {
      clearInterval(autosaveTimer);
      autosaveTimer = null;
    }
  }

  // --- Sol System zoom ---

  function isZoomEligible(index) {
    if (!renderer.starType) return false;
    const t = renderer.starType[index];
    return t !== BLACKHOLE_TYPE_CODE && t !== QUASAR_TYPE_CODE && t !== NEUTRONSTAR_TYPE_CODE &&
      t !== PLANET_TYPE_CODE && t !== SYSTEM_EMPTY_TYPE_CODE;
  }

  function enterSystem(starIndex) {
    if (!isZoomEligible(starIndex)) return;
    const saved = loadSavedSystem(starIndex);
    worker.postMessage({ type: 'enterSystem', starIndex, saved });
    playWhoosh();
    focusIndex = starIndex;
    mode = 'system';
    els.backBtn.classList.remove('hidden');
    document.body.classList.add('system-mode');
    startAutosave();
  }

  function exitSystem() {
    if (mode !== 'system') return;
    if (selectedIndex !== -1 && latestSystemSlots.some((s) => s.index === selectedIndex)) {
      selectedIndex = -1;
    }
    hideInfoPanel();
    playWhoosh();
    worker.postMessage({ type: 'exitSystem' });
  }

  els.backBtn.addEventListener('click', exitSystem);
  els.modeIndicator.addEventListener('click', () => {
    if (mode === 'system') exitSystem();
  });

  // --- Info panel ---

  function hideInfoPanel() {
    els.infoPanel.classList.add('hidden');
    els.infoAction.classList.add('hidden');
    if (infoPollTimer) {
      clearInterval(infoPollTimer);
      infoPollTimer = null;
    }
  }

  function setInfoRows(title, rows) {
    els.infoPanel.classList.remove('hidden');
    els.infoTitle.textContent = title;
    const labelEls = [els.infoLabel1, els.infoLabel2, els.infoLabel3, els.infoLabel4];
    const valueEls = [els.infoValue1, els.infoValue2, els.infoValue3, els.infoValue4];
    for (let i = 0; i < 4; i++) {
      const row = rows[i] || ['', ''];
      labelEls[i].textContent = row[0];
      valueEls[i].textContent = row[1];
      valueEls[i].style.color = row[2] || '';
    }
    els.infoRow5.classList.add('hidden');
    els.infoRow6.classList.add('hidden');
    els.infoFlash.classList.add('hidden');
    els.infoAction.classList.add('hidden');
  }

  function showBodyInfo(info) {
    if (info.isPlanet) return showPlanetInfo(info);
    if (info.starType === QUASAR_TYPE_CODE) return showQuasarInfo(info);
    if (info.starType === NEUTRONSTAR_TYPE_CODE) return showNeutronStarInfo(info);
    if (info.isBlackHole) return showBlackHoleInfo(info); // literal black hole
    return showStarInfo(info);
  }

  function showBlackHoleInfo(info) {
    setInfoRows('Black Hole', [
      ['Type', 'Black Hole', '#c79bff'],
      ['Mass', formatCompact(info.mass) + ' M☉'],
      ['Event Horizon', formatCompact(info.mass * BLACKHOLE_EVENT_HORIZON_FACTOR) + ' units'],
      ['Stars absorbed', String(info.absorbed || 0)],
    ]);
  }

  function showQuasarInfo(info) {
    setInfoRows('Quasar', [
      ['Type', 'Quasar', '#fff7c2'],
      ['Mass', formatCompact(QUASAR_DISPLAY_MASS) + ' M☉ (visual)'],
      ['Accretion', 'Extreme - visual only'],
      ['Stars absorbed', String(info.absorbed || 0)],
    ]);
  }

  function showNeutronStarInfo(info) {
    setInfoRows('Neutron Star', [
      ['Type', 'Neutron Star', '#cfe8ff'],
      ['Mass', formatCompact(info.mass) + ' M☉'],
      ['Density', 'Extremely dense'],
      ['', ''],
    ]);
  }

  function showStarInfo(info) {
    const st = (window.STAR_TYPES || []).find((t) => t.code === info.starType);
    setInfoRows(st ? 'Star' : 'Core', [
      ['Type', st ? `${st.label} - ${st.colorName}` : 'Core', st ? st.color : '#fff6d6'],
      ['Mass', formatCompact(info.mass) + ' M☉'],
      ['Age', formatYears(info.age)],
      ['Lifetime', formatYears(info.lifetime)],
    ]);
    if (!info.alive) {
      els.infoFlash.textContent = '\u{1F4A5} Supernova!';
      els.infoFlash.classList.remove('hidden');
    }
    if (!(mode === 'system' && focusIndex === info.index)) {
      els.infoAction.textContent = 'View System →';
      els.infoAction.classList.remove('hidden');
      els.infoAction.onclick = () => enterSystem(info.index);
    }
  }

  function showPlanetInfo(info) {
    setInfoRows('Planet', [
      ['Name', info.name, '#dfe3ff'],
      ['Mass', formatCompact(info.massEarth) + ' M⊕'],
      ['Orbit radius', info.orbitRadius.toFixed(1) + ' units'],
      ['Temperature', info.tempK + ' K (' + info.composition + ')'],
    ]);
    els.infoLabel5.textContent = 'Orbital velocity';
    els.infoValue5.textContent = info.orbitalSpeed.toFixed(2) + ' u/s';
    els.infoLabel6.textContent = 'Period';
    els.infoValue6.textContent = formatYears(info.periodYears);
    els.infoRow5.classList.remove('hidden');
    els.infoRow6.classList.remove('hidden');
    els.infoAction.textContent = '← Back to Galaxy';
    els.infoAction.classList.remove('hidden');
    els.infoAction.onclick = () => exitSystem();
  }

  function showMoonInfo(planetIndex, moonIndex) {
    const slot = latestSystemSlots.find((s) => s.index === planetIndex);
    const moon = slot && slot.moons && slot.moons[moonIndex];
    if (!moon) return;
    if (infoPollTimer) {
      clearInterval(infoPollTimer);
      infoPollTimer = null;
    }
    selectedIndex = -1; // moons aren't physics bodies - no getStarInfo polling
    setInfoRows('Moon', [
      ['Name', moon.name, '#dfe3ff'],
      ['Orbits', slot.name],
      ['Orbit radius', moon.orbitRadius.toFixed(1) + ' units'],
      ['', ''],
    ]);
    els.infoAction.textContent = '← Back to Galaxy';
    els.infoAction.classList.remove('hidden');
    els.infoAction.onclick = () => exitSystem();
  }

  function selectStar(index) {
    selectedIndex = index;
    if (infoPollTimer) clearInterval(infoPollTimer);
    worker.postMessage({ type: 'getStarInfo', index });
    // Keep the panel live-ish while a body is selected.
    infoPollTimer = setInterval(() => {
      if (selectedIndex >= 0) worker.postMessage({ type: 'getStarInfo', index: selectedIndex });
    }, 500);
  }

  renderer.onClick = (sx, sy) => {
    if (!latestPositions) return;
    const idx = renderer.findBodyAt(latestPositions, latestN, sx, sy, 16);
    if (idx >= 0) {
      selectStar(idx);
      return;
    }
    if (mode === 'system') {
      const hit = renderer.findMoonAt(latestPositions, sx, sy, lastStepSeen, 10);
      if (hit) showMoonInfo(hit.planetIndex, hit.moonIndex);
    }
  };

  // --- Hover tooltips ---

  function tooltipTextForIndex(idx) {
    if (idx === 0) return `Sol (Core) · ${formatCompact(bodyMass ? bodyMass[0] : 0)} M☉`;
    const typeCode = renderer.starType ? renderer.starType[idx] : -1;
    if (typeCode === BLACKHOLE_TYPE_CODE) return `Black Hole · ${formatCompact(BLACKHOLE_MASS)} M☉ · absorbs nearby stars`;
    if (typeCode === QUASAR_TYPE_CODE) return `Quasar · ${formatCompact(QUASAR_DISPLAY_MASS)} M☉ (visual) · supermassive`;
    if (typeCode === NEUTRONSTAR_TYPE_CODE) return `Neutron Star · ${formatCompact(bodyMass ? bodyMass[idx] : 0)} M☉ · extremely dense`;
    if (typeCode === PLANET_TYPE_CODE) {
      const slot = latestSystemSlots.find((s) => s.index === idx);
      return slot ? `${slot.name} · ${formatCompact(slot.massEarth)} M⊕ · orbit ${slot.orbitRadius.toFixed(0)}u` : 'Planet';
    }
    const st = (window.STAR_TYPES || []).find((t) => t.code === typeCode);
    return st ? `${st.label}-type · ${formatCompact(bodyMass ? bodyMass[idx] : 0)} M☉` : 'Star';
  }

  function showTooltip(sx, sy, text) {
    els.tooltip.textContent = text;
    els.tooltip.style.left = sx + 14 + 'px';
    els.tooltip.style.top = sy + 14 + 'px';
    els.tooltip.classList.remove('hidden');
  }
  function hideTooltip() {
    els.tooltip.classList.add('hidden');
  }

  renderer.onHover = (sx, sy) => {
    if (sx < 0 || !latestPositions) {
      hideTooltip();
      return;
    }
    const idx = renderer.findBodyAt(latestPositions, latestN, sx, sy, 14);
    if (idx >= 0) {
      showTooltip(sx, sy, tooltipTextForIndex(idx));
      return;
    }
    if (mode === 'system') {
      const hit = renderer.findMoonAt(latestPositions, sx, sy, lastStepSeen, 8);
      if (hit) {
        const slot = latestSystemSlots.find((s) => s.index === hit.planetIndex);
        const moon = slot && slot.moons[hit.moonIndex];
        if (moon) {
          showTooltip(sx, sy, `${moon.name} · moon of ${slot.name}`);
          return;
        }
      }
    }
    hideTooltip();
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
      bodyMass = msg.mass;
      els.starStat.textContent = String(msg.realStarCount);
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
      // Brief white flash at the absorber, smaller/quicker than a supernova.
      renderer.spawnBurst(msg.x, msg.y, '#ffffff', {
        countMin: 10, countMax: 20, life: 0.3, speedMin: 20, speedMax: 120,
      });
      absorptionCount++;
      els.absorptionStat.textContent = String(absorptionCount);
      // The selected absorber's "Stars absorbed" count is kept current by
      // the periodic getStarInfo poll below - no extra push needed here.
    } else if (msg.type === 'starInfo') {
      if (msg.index === selectedIndex) showBodyInfo(msg);
    } else if (msg.type === 'systemReady') {
      const entries = msg.slots.map((s) => ({ index: s.index, starType: PLANET_TYPE_CODE, radius: s.radiusPx, color: s.color }));
      renderer.applySlotMeta(entries);
      renderer.setSystemMeta(msg.slots);
      renderer.mode = 'system';
      renderer.focusIndex = msg.starIndex;
      latestSystemSlots = msg.slots;

      const label = formatStarLabel(msg.starMeta.type, msg.starMeta.mass);
      els.modeIndicator.textContent = 'System View: ' + label;
      els.modeIndicator.classList.remove('mode-galaxy');
      els.modeIndicator.classList.add('mode-system');

      const hx = latestPositions ? latestPositions[msg.starIndex * 2] : 0;
      const hy = latestPositions ? latestPositions[msg.starIndex * 2 + 1] : 0;
      renderer.panZoomTo(hx, hy, SYSTEM_ZOOM, 1000);
      pulseOverlay(1000);

      // Always request a fresh, worker-computed (host-relative) snapshot
      // right after entering, whether freshly generated or loaded - keeps
      // localStorage in sync even if the tab closes before any autosave.
      worker.postMessage({ type: 'peekSystemSnapshot' });
    } else if (msg.type === 'systemSnapshot') {
      saveSystemSnapshot(msg);
      if (!msg.peek) {
        // A real exitSystem() completed - finalize the return-to-galaxy UI.
        resetToGalaxyUI();
        renderer.panZoomTo(0, 0, 0.6, 1000);
        pulseOverlay(1000);
      }
    }
  };

  // --- Render loop (decoupled from physics tick rate) ---

  let frames = 0;
  let lastFpsTime = performance.now();

  function frame(now) {
    // The focus star keeps moving during (and after) the zoom-in tween -
    // keep the camera locked onto its current position, not where it was
    // when the tween started.
    if (mode === 'system' && focusIndex >= 0 && latestPositions && renderer.tween) {
      renderer.retarget(latestPositions[focusIndex * 2], latestPositions[focusIndex * 2 + 1]);
    }
    renderer.draw(latestPositions, latestN, now, lastStepSeen);

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
