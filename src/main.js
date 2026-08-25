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
    coreGrowthRow: document.getElementById('coreGrowthRow'),
    coreGrowthStat: document.getElementById('coreGrowthStat'),
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
    infoRow7: document.getElementById('infoRow7'),
    infoLabel7: document.getElementById('infoLabel7'),
    infoValue7: document.getElementById('infoValue7'),
    infoAction: document.getElementById('infoAction'),
    infoFlash: document.getElementById('infoFlash'),
    editRow: document.getElementById('infoEditRow'),
    massMinus: document.getElementById('massMinusBtn'),
    massPlus: document.getElementById('massPlusBtn'),
    massValue: document.getElementById('massEditValue'),
    colorBtn: document.getElementById('colorEditBtn'),
    deleteBtn: document.getElementById('deleteEditBtn'),
    lockBtn: document.getElementById('lockEditBtn'),
    stabilityDot: document.getElementById('stabilityDot'),

    toolbar: document.getElementById('systemToolbar'),
    createPlanetBtn: document.getElementById('createPlanetBtn'),
    addAsteroidBtn: document.getElementById('addAsteroidBtn'),
    addCometBtn: document.getElementById('addCometBtn'),
    addMoonBtn: document.getElementById('addMoonBtn'),
    saveSystemBtn: document.getElementById('saveSystemBtn'),
    orbitStabilitySlider: document.getElementById('orbitStabilitySlider'),
    orbitStabilityValue: document.getElementById('orbitStabilityValue'),
    undoBtn: document.getElementById('undoBtn'),
    statusLine: document.getElementById('statusLine'),
    statusBodies: document.getElementById('statusBodies'),
    statusStability: document.getElementById('statusStability'),
    creationStatus: document.getElementById('creationStatus'),
    proximityWarning: document.getElementById('proximityWarning'),

    contextMenu: document.getElementById('contextMenu'),
    ctxIncreaseMass: document.getElementById('ctxIncreaseMass'),
    ctxDecreaseMass: document.getElementById('ctxDecreaseMass'),
    ctxColor: document.getElementById('ctxColor'),
    ctxDelete: document.getElementById('ctxDelete'),
    ctxCopy: document.getElementById('ctxCopy'),

    shareDialog: document.getElementById('shareDialog'),
    shareUrlInput: document.getElementById('shareUrlInput'),
    shareCopyBtn: document.getElementById('shareCopyBtn'),
    shareCloseBtn: document.getElementById('shareCloseBtn'),

    crazyPhysicsBtn: document.getElementById('crazyPhysicsBtn'),
    lowGravityBtn: document.getElementById('lowGravityBtn'),
    timeWarpBtn: document.getElementById('timeWarpBtn'),

    cosmicToolbar: document.getElementById('cosmicToolbar'),
    createGalaxyBtn: document.getElementById('createGalaxyBtn'),
    mergeGalaxiesBtn: document.getElementById('mergeGalaxiesBtn'),
    collideGalaxiesBtn: document.getElementById('collideGalaxiesBtn'),
    undoCosmicBtn: document.getElementById('undoCosmicBtn'),
    saveUniverseBtn: document.getElementById('saveUniverseBtn'),
    cosmicStatusLine: document.getElementById('cosmicStatusLine'),
    cosmicStatusCount: document.getElementById('cosmicStatusCount'),
    mergeSelectionStatus: document.getElementById('mergeSelectionStatus'),

    galaxyContextMenu: document.getElementById('galaxyContextMenu'),
    ctxGalaxyMerge: document.getElementById('ctxGalaxyMerge'),
    ctxGalaxyIncreaseMass: document.getElementById('ctxGalaxyIncreaseMass'),
    ctxGalaxyChangeType: document.getElementById('ctxGalaxyChangeType'),
    ctxGalaxyDelete: document.getElementById('ctxGalaxyDelete'),
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
  let coreConsumedCount = 0; // black holes/quasars the core has eaten this session

  // --- Sol System zoom state ---
  let mode = 'cosmic'; // 'cosmic' | 'galaxy' | 'system' - boots into cosmic per the Cosmic Web Sandbox spec
  let focusIndex = -1;
  let latestSystemSlots = [];
  let activeSeed = null;
  let autosaveTimer = null;

  // --- Cosmic Web Sandbox state ---
  let universeSeed = null;
  let latestCosmicPositions = null;
  let latestCosmicN = 0;
  let latestCosmicMeta = []; // [{id,name,x,y,mass,morphology,starCount}], buffer-index-aligned
  let selectedGalaxyId = -1;
  let loadedGalaxyId = -1; // which galaxy (if any) currently has its star-level state loaded
  let loadedFromUniverseShare = false;
  let cosmicAutosaveTimer = null;
  let mergeSelection = []; // up to 2 galaxy ids, for the "select two, then Merge/Collision" flow
  let cosmicCreationMode = false; // "Create Galaxy" click-to-place, mirrors creationMode one level down

  // --- Interactive editor state ---
  let creationMode = null; // null | 'planet' | 'moon'
  const contextMenuState = { planetIndex: null, moonId: null, parentPlanetIndex: null };
  let crazyPhysicsOn = false;
  let lowGravityOn = false;
  let timeWarpOn = false;
  let speedBeforeTimeWarp = 1;
  const TIME_WARP_SPEED = 8;
  let loadedFromShare = false;

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

  // Repurposes the same input field (relabeled "Galaxies" in index.html)
  // now that the app's top level is a universe, not a single galaxy - a
  // single galaxy's own star count is no longer user-controlled at all,
  // it comes from that galaxy's own cosmic-layer record (300-1000,
  // generateUniverse's own range). Clamped to the spec's own stated
  // "20-50 galaxies per universe" range.
  function currentGalaxyCount() {
    const v = parseInt(els.starCount.value, 10);
    return Number.isFinite(v) ? Math.min(50, Math.max(20, v)) : 32;
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
    coreConsumedCount = 0;
    els.supernovaStat.textContent = '0';
    els.absorptionStat.textContent = '0';
    els.coreGrowthRow.classList.add('hidden');
    selectedIndex = -1;
    hideInfoPanel();
    resetToGalaxyUI();
    loadedFromShare = false;
    crazyPhysicsOn = false;
    lowGravityOn = false;
    timeWarpOn = false;
    els.crazyPhysicsBtn.classList.remove('active');
    els.lowGravityBtn.classList.remove('active');
    els.timeWarpBtn.classList.remove('active');
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

  // Shows/hides the "Core Growth: 30.0k -> 45.2k M☉" stat - only relevant
  // (and only shown) once the core has actually consumed something, since
  // before that it'd just be a redundant "30.0k -> 30.0k".
  function updateCoreGrowthStat() {
    if (coreConsumedCount > 0 && renderer.initialCoreMass != null) {
      els.coreGrowthStat.textContent =
        formatCompact(renderer.initialCoreMass) + ' → ' + formatCompact(renderer.coreMass) + ' M☉';
      els.coreGrowthRow.classList.remove('hidden');
    } else {
      els.coreGrowthRow.classList.add('hidden');
    }
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
    els.proximityWarning.classList.add('hidden');
    // Every galaxy is always cosmic-sourced now (the app boots straight
    // into cosmic view) - the back button stays visible in galaxy mode too,
    // now meaning "back to cosmos" rather than being hidden as the old
    // top-level state. galaxyLabel() falls back to a generic label if this
    // is somehow called before a galaxyEntered message ever arrived.
    els.modeIndicator.textContent = 'Galaxy View: ' + galaxyLabel();
    els.modeIndicator.classList.remove('mode-system');
    els.modeIndicator.classList.add('mode-galaxy');
    els.backBtn.classList.remove('hidden');
    els.backBtn.textContent = '← Back to Cosmos';
    document.body.classList.remove('system-mode');
    stopAutosave();
  }

  function galaxyLabel() {
    const g = latestCosmicMeta.find((gal) => gal.id === loadedGalaxyId);
    return g ? g.name : 'Galaxy';
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
    els.backBtn.textContent = '← Back to Galaxy';
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

  // Back always goes exactly one level up (system->galaxy, or
  // galaxy->cosmic) - a direct system->cosmic skip would need coordinating
  // two async worker round-trips (exitSystem's save-then-reset, then
  // exitGalaxy) into one gesture; two clicks is simpler and matches the
  // plan's explicit "cascades, never skips" transition table.
  function handleBack() {
    if (mode === 'system') exitSystem();
    else if (mode === 'galaxy') exitToCosmic();
  }
  els.backBtn.addEventListener('click', handleBack);
  els.modeIndicator.addEventListener('click', () => {
    if (mode !== 'cosmic') handleBack();
  });

  // --- Cosmic Web Sandbox ---

  function universeStorageKey(seedVal) {
    return `galaxysim:universe:${seedVal}`;
  }
  // Only the cosmic-layer summary (positions/velocities/mass/morphology/
  // starCount/name for every galaxy) - never any galaxy's full star array,
  // consistent with the perf/memory budget ("only the active galaxy is
  // ever loaded"). Whichever individual galaxy(s) the user actually zoomed
  // into and edited persist via the existing, unmodified per-derived-seed
  // system storage - "restoring the whole universe" only ever means
  // restoring what was ever actually loaded, the same guarantee that
  // mechanism already provides today.
  function loadSavedUniverse(seedVal) {
    try {
      const raw = localStorage.getItem(universeStorageKey(seedVal));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }
  function saveUniverseSnapshot() {
    if (!universeSeed || loadedFromUniverseShare) return;
    try {
      localStorage.setItem(universeStorageKey(universeSeed), JSON.stringify({ galaxies: latestCosmicMeta }));
    } catch (err) {
      /* best-effort only */
    }
  }
  function startCosmicAutosave() {
    stopCosmicAutosave();
    cosmicAutosaveTimer = setInterval(() => {
      if (mode === 'cosmic' || loadedGalaxyId !== -1) saveUniverseSnapshot();
    }, 30000); // spec: "every 30 seconds", coarser than the per-system 5s (a bigger, less URGENT payload)
  }
  function stopCosmicAutosave() {
    if (cosmicAutosaveTimer) { clearInterval(cosmicAutosaveTimer); cosmicAutosaveTimer = null; }
  }

  function initUniverse(seedVal, opts) {
    els.seed.value = seedVal;
    universeSeed = seedVal;
    loadedFromUniverseShare = false;
    // Matches init()'s own reset - without it, the first post-boot FPS
    // window diffs against a stale (possibly larger) step count from
    // whatever ran before and briefly shows a wrong/negative Physics Hz.
    lastStepSeen = -1;
    physStepsAtLastFpsCheck = -1;
    latestCosmicPositions = null;
    latestCosmicN = 0;
    latestCosmicMeta = [];
    loadedGalaxyId = -1;
    mode = 'cosmic';
    renderer.mode = 'cosmic';
    selectedGalaxyId = -1;
    renderer.selectedGalaxyId = -1;
    mergeSelection = [];
    hideInfoPanel();
    els.modeIndicator.textContent = 'Cosmic View';
    els.modeIndicator.classList.remove('mode-galaxy', 'mode-system');
    els.modeIndicator.classList.add('mode-cosmic');
    els.backBtn.classList.add('hidden');
    document.body.classList.remove('system-mode', 'creation-mode');
    document.body.classList.add('cosmic-mode');
    renderer.tween = null;
    renderer.camera.x = 0;
    renderer.camera.y = 0;
    renderer.camera.zoom = 0.012; // frames roughly the whole 100,000-unit plane
    worker.postMessage({ type: 'initCosmic', seed: seedVal, opts: opts || { galaxyCount: 32 } });
    startCosmicAutosave();
  }

  // Cosmic<->galaxy is a HARD CUT, not a continuous tween: a galaxy's
  // cosmic-plane position and its own star-level local frame (core always
  // pinned at that galaxy's own (0,0)) are two unrelated origins by design
  // - there's no continuous function between them. Phase 1 tweens the
  // camera toward the target IN COSMIC COORDINATES (still rendering cosmic
  // content) while the transition overlay pulses; phase 2, timed to the
  // overlay's opaque peak, does a non-tweened swap of mode/camera/state
  // underneath it. See the Cosmic Web Sandbox plan's Context section for
  // the full reasoning.
  const COSMIC_TRANSITION_MS = 900;
  const COSMIC_TRANSITION_SWAP_DELAY = 450; // overlay's opaque peak, see pulseOverlay's own timing

  function enterGalaxy(galaxyId) {
    if (mode !== 'cosmic') return;
    const idx = latestCosmicMeta.findIndex((g) => g.id === galaxyId);
    if (idx === -1) return;
    const meta = latestCosmicMeta[idx];
    const gx = latestCosmicPositions ? latestCosmicPositions[idx * 2] : meta.x;
    const gy = latestCosmicPositions ? latestCosmicPositions[idx * 2 + 1] : meta.y;
    playWhoosh();
    hideInfoPanel();
    renderer.panZoomTo(gx, gy, 1.2, COSMIC_TRANSITION_MS); // phase 1: still cosmic content, tweened
    pulseOverlay(COSMIC_TRANSITION_MS);
    setTimeout(() => {
      // Phase 2 (hard cut): swap mode/camera/state, no interpolation.
      mode = 'galaxy';
      renderer.mode = 'galaxy';
      renderer.tween = null;
      renderer.camera.x = 0;
      renderer.camera.y = 0;
      renderer.camera.zoom = 0.6; // the existing default galaxy zoom
      document.body.classList.remove('cosmic-mode');
      els.modeIndicator.textContent = 'Galaxy View: ' + meta.name;
      els.modeIndicator.classList.remove('mode-cosmic');
      els.modeIndicator.classList.add('mode-galaxy');
      els.backBtn.classList.remove('hidden');
      els.backBtn.textContent = '← Back to Cosmos';
      stopCosmicAutosave();
      worker.postMessage({ type: 'enterGalaxy', galaxyId });
    }, COSMIC_TRANSITION_SWAP_DELAY);
  }

  function exitToCosmic() {
    if (mode !== 'galaxy') return;
    const galaxyIdBeingExited = loadedGalaxyId; // captured now, before the reset below runs
    playWhoosh();
    hideInfoPanel();
    renderer.panZoomTo(0, 0, 0.05, COSMIC_TRANSITION_MS); // phase 1: pull back within the galaxy's own local frame
    pulseOverlay(COSMIC_TRANSITION_MS);
    setTimeout(() => {
      worker.postMessage({ type: 'exitGalaxy' });
      loadedGalaxyId = -1;
      mode = 'cosmic';
      renderer.mode = 'cosmic';
      renderer.tween = null;
      // Re-center on wherever this galaxy actually sits on the plane,
      // rather than snapping back to the plane's center every time.
      const idx = latestCosmicMeta.findIndex((g) => g.id === galaxyIdBeingExited);
      if (idx >= 0 && latestCosmicPositions) {
        renderer.camera.x = latestCosmicPositions[idx * 2];
        renderer.camera.y = latestCosmicPositions[idx * 2 + 1];
      }
      renderer.camera.zoom = 0.012;
      document.body.classList.add('cosmic-mode');
      els.modeIndicator.textContent = 'Cosmic View';
      els.modeIndicator.classList.remove('mode-galaxy');
      els.modeIndicator.classList.add('mode-cosmic');
      els.backBtn.classList.add('hidden');
      startCosmicAutosave();
      updateCosmicStatus();
    }, COSMIC_TRANSITION_SWAP_DELAY);
  }

  function updateCosmicStatus() {
    if (mode !== 'cosmic') return;
    els.cosmicStatusCount.textContent = String(latestCosmicMeta.length);
    els.mergeSelectionStatus.textContent = mergeSelection.length
      ? `${mergeSelection.length}/2 selected for merge`
      : '';
  }

  function randomMorphologyForCreate() {
    return GALAXY_MORPHOLOGIES[Math.floor(Math.random() * GALAXY_MORPHOLOGIES.length)];
  }

  function enterCosmicCreationMode() {
    if (mode !== 'cosmic') return;
    cosmicCreationMode = !cosmicCreationMode;
    document.body.classList.toggle('creation-mode', cosmicCreationMode);
    els.createGalaxyBtn.classList.toggle('active', cosmicCreationMode);
    els.creationStatus.textContent = cosmicCreationMode ? 'Click to place a new galaxy' : '';
    els.creationStatus.classList.toggle('hidden', !cosmicCreationMode);
  }
  function exitCosmicCreationMode() {
    cosmicCreationMode = false;
    document.body.classList.remove('creation-mode');
    els.createGalaxyBtn.classList.remove('active');
    els.creationStatus.classList.add('hidden');
  }

  els.createGalaxyBtn.addEventListener('click', enterCosmicCreationMode);

  // Merge/Collision: click Merge or Collision, then click two galaxies -
  // the SAME two-click "select then act" flow Add Moon already uses one
  // level down, applied to picking a pair instead of a single target.
  let mergeSelectMode = null; // null | 'merge' | 'collide'
  function beginMergeSelection(kind) {
    if (mode !== 'cosmic') return;
    mergeSelectMode = mergeSelectMode === kind ? null : kind;
    mergeSelection = [];
    els.mergeGalaxiesBtn.classList.toggle('active', mergeSelectMode === 'merge');
    els.collideGalaxiesBtn.classList.toggle('active', mergeSelectMode === 'collide');
    updateCosmicStatus();
  }
  els.mergeGalaxiesBtn.addEventListener('click', () => beginMergeSelection('merge'));
  els.collideGalaxiesBtn.addEventListener('click', () => beginMergeSelection('collide'));

  els.undoCosmicBtn.addEventListener('click', () => {
    if (mode === 'cosmic') worker.postMessage({ type: 'undoCosmic' });
  });

  els.saveUniverseBtn.addEventListener('click', () => {
    if (mode !== 'cosmic' || !universeSeed) return;
    const encoded = encodeUniverse({ galaxies: latestCosmicMeta });
    const url = `${location.origin}${location.pathname}?universe=${encoded}`;
    els.shareUrlInput.value = url;
    els.shareDialog.classList.remove('hidden');
  });

  // --- Galaxy right-click context menu ---

  function hideGalaxyContextMenu() {
    els.galaxyContextMenu.classList.add('hidden');
  }
  let contextGalaxyId = -1;
  function showGalaxyContextMenu(clientX, clientY, galaxyId) {
    contextGalaxyId = galaxyId;
    els.galaxyContextMenu.style.left = clientX + 'px';
    els.galaxyContextMenu.style.top = clientY + 'px';
    els.galaxyContextMenu.classList.remove('hidden');
  }
  canvas.addEventListener('contextmenu', (e) => {
    if (mode !== 'cosmic') return;
    e.preventDefault();
    const galaxyId = renderer.findGalaxyAt(latestCosmicPositions, latestCosmicN, e.offsetX, e.offsetY, 20);
    if (galaxyId >= 0) {
      selectGalaxy(galaxyId);
      showGalaxyContextMenu(e.clientX, e.clientY, galaxyId);
    } else {
      hideGalaxyContextMenu();
    }
  });
  window.addEventListener('click', (e) => {
    if (!els.galaxyContextMenu.contains(e.target)) hideGalaxyContextMenu();
  });
  els.ctxGalaxyIncreaseMass.addEventListener('click', () => {
    if (contextGalaxyId >= 0) worker.postMessage({ type: 'adjustGalaxyMass', galaxyId: contextGalaxyId, multiplier: 1.5 });
    hideGalaxyContextMenu();
  });
  els.ctxGalaxyChangeType.addEventListener('click', () => {
    if (contextGalaxyId < 0) { hideGalaxyContextMenu(); return; }
    const g = latestCosmicMeta.find((gal) => gal.id === contextGalaxyId);
    if (g) {
      const next = GALAXY_MORPHOLOGIES[(GALAXY_MORPHOLOGIES.indexOf(g.morphology) + 1) % GALAXY_MORPHOLOGIES.length];
      worker.postMessage({ type: 'changeGalaxyType', galaxyId: contextGalaxyId, morphology: next });
    }
    hideGalaxyContextMenu();
  });
  els.ctxGalaxyDelete.addEventListener('click', () => {
    if (contextGalaxyId >= 0) worker.postMessage({ type: 'deleteGalaxy', galaxyId: contextGalaxyId });
    hideGalaxyContextMenu();
  });
  els.ctxGalaxyMerge.addEventListener('click', () => {
    if (contextGalaxyId >= 0) { beginMergeSelection('merge'); mergeSelection = [contextGalaxyId]; updateCosmicStatus(); }
    hideGalaxyContextMenu();
  });

  // --- Creation tools ---

  function enterCreationMode(kind) {
    if (mode !== 'system') return;
    creationMode = creationMode === kind ? null : kind; // clicking the same tool again toggles it off
    document.body.classList.toggle('creation-mode', !!creationMode);
    els.createPlanetBtn.classList.toggle('active', creationMode === 'planet');
    els.addMoonBtn.classList.toggle('active', creationMode === 'moon');
    els.creationStatus.textContent = creationMode === 'planet' ? 'Click to place planet'
      : creationMode === 'moon' ? 'Click a planet to add a moon' : '';
    els.creationStatus.classList.toggle('hidden', !creationMode);
  }
  function exitCreationMode() {
    creationMode = null;
    document.body.classList.remove('creation-mode');
    els.createPlanetBtn.classList.remove('active');
    els.addMoonBtn.classList.remove('active');
    els.creationStatus.classList.add('hidden');
  }
  function handleCreationClick(sx, sy) {
    if (creationMode === 'planet') {
      const world = renderer.screenToWorld(sx, sy);
      worker.postMessage({ type: 'createPlanet', x: world.x, y: world.y });
      exitCreationMode();
    } else if (creationMode === 'moon') {
      const idx = renderer.findBodyAt(latestPositions, latestN, sx, sy, 16);
      if (idx >= 0 && renderer.systemMeta[idx]) {
        worker.postMessage({ type: 'addMoon', planetIndex: idx });
      }
      exitCreationMode();
    }
  }

  els.createPlanetBtn.addEventListener('click', () => enterCreationMode('planet'));
  els.addMoonBtn.addEventListener('click', () => enterCreationMode('moon'));
  els.addAsteroidBtn.addEventListener('click', () => {
    if (mode === 'system') worker.postMessage({ type: 'addAsteroidField' });
  });
  els.addCometBtn.addEventListener('click', () => {
    if (mode === 'system') worker.postMessage({ type: 'addComet' });
  });
  els.undoBtn.addEventListener('click', () => {
    if (mode === 'system') worker.postMessage({ type: 'undo' });
  });

  // --- Save & share ---

  // encodeSystem's format stores orbitRadius+angle0 (not velocity) per
  // body, recomputing velocity at decode time - so this reads the CURRENT
  // live angle/distance from the host, not the original creation-time
  // values. A comet's exact eccentricity isn't reconstructible from
  // position alone without also storing velocity (deliberately not
  // stored, to keep the URL short) - shared comets get a representative
  // default speedMult instead of their exact current one. Sharing
  // preserves the system's STRUCTURE, not a byte-identical replay.
  function buildShareableSnapshot() {
    if (mode !== 'system' || !latestPositions) return null;
    const hostX = latestPositions[focusIndex * 2], hostY = latestPositions[focusIndex * 2 + 1];
    const bodies = latestSystemSlots.map((s) => {
      const dx = latestPositions[s.index * 2] - hostX, dy = latestPositions[s.index * 2 + 1] - hostY;
      return {
        kind: s.kind, massEarth: s.massEarth, orbitRadius: Math.hypot(dx, dy),
        angle0: Math.atan2(dy, dx), composition: s.composition,
        speedMult: s.kind === 'comet' ? 0.4 : 1,
      };
    });
    const hostMass = focusIndex === 0 ? renderer.coreMass : (bodyMass ? bodyMass[focusIndex] : 1);
    return { hostType: renderer.starType[focusIndex], hostMass, bodies };
  }

  els.saveSystemBtn.addEventListener('click', () => {
    const snapshot = buildShareableSnapshot();
    if (!snapshot) return;
    const encoded = encodeSystem(snapshot);
    // location.origin + pathname, NOT a hardcoded domain - correct
    // wherever this actually happens to be hosted (local dev server,
    // whatever it's deployed to, etc.), unlike a literal fixed URL.
    const url = `${location.origin}${location.pathname}?system=${encoded}`;
    els.shareUrlInput.value = url;
    els.shareDialog.classList.remove('hidden');
  });
  els.shareCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.shareUrlInput.value);
      els.shareCopyBtn.textContent = 'Copied!';
      setTimeout(() => { els.shareCopyBtn.textContent = 'Copy'; }, 1500);
    } catch (err) {
      els.shareUrlInput.select(); // best-effort fallback so the user can Ctrl+C manually
    }
  });
  els.shareCloseBtn.addEventListener('click', () => els.shareDialog.classList.add('hidden'));

  // --- Right-click context menu ---

  function hideContextMenu() {
    els.contextMenu.classList.add('hidden');
  }
  function showContextMenu(clientX, clientY, index) {
    contextMenuState.planetIndex = index;
    contextMenuState.moonId = null;
    els.contextMenu.style.left = clientX + 'px';
    els.contextMenu.style.top = clientY + 'px';
    els.contextMenu.classList.remove('hidden');
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (mode !== 'system' || !latestPositions) { hideContextMenu(); return; }
    const idx = renderer.findBodyAt(latestPositions, latestN, e.offsetX, e.offsetY, 16);
    if (idx >= 0 && renderer.systemMeta[idx]) {
      selectStar(idx);
      showContextMenu(e.clientX, e.clientY, idx);
    } else {
      hideContextMenu();
    }
  });
  window.addEventListener('click', (e) => {
    if (!els.contextMenu.contains(e.target)) hideContextMenu();
  });

  function contextTargetIndex() {
    return contextMenuState.planetIndex;
  }

  els.ctxIncreaseMass.addEventListener('click', () => {
    const idx = contextTargetIndex();
    if (idx == null) return;
    const meta = renderer.systemMeta[idx];
    worker.postMessage({ type: 'adjustMass', index: idx, massEarth: meta.massEarth * 1.5 });
    hideContextMenu();
  });
  els.ctxDecreaseMass.addEventListener('click', () => {
    const idx = contextTargetIndex();
    if (idx == null) return;
    const meta = renderer.systemMeta[idx];
    worker.postMessage({ type: 'adjustMass', index: idx, massEarth: meta.massEarth / 1.5 });
    hideContextMenu();
  });
  els.ctxColor.addEventListener('click', () => {
    const idx = contextTargetIndex();
    if (idx == null) return;
    worker.postMessage({ type: 'cycleColor', index: idx });
    hideContextMenu();
  });
  els.ctxDelete.addEventListener('click', () => {
    const idx = contextTargetIndex();
    if (idx == null) return;
    worker.postMessage({ type: 'deleteBody', index: idx });
    hideContextMenu();
  });
  els.ctxCopy.addEventListener('click', async () => {
    const idx = contextTargetIndex();
    if (idx == null) return;
    const meta = renderer.systemMeta[idx];
    const data = {
      name: meta.name, kind: meta.kind, massEarth: meta.massEarth,
      orbitRadius: meta.orbitRadius, composition: meta.composition,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    } catch (err) {
      /* clipboard best-effort only (permissions, insecure context, etc.) */
    }
    hideContextMenu();
  });

  // --- Info panel ---

  function hideInfoPanel() {
    els.infoPanel.classList.add('hidden');
    els.infoAction.classList.add('hidden');
    els.editRow.classList.add('hidden');
    renderer.selectedIndex = -1;
    selectedGalaxyId = -1;
    renderer.selectedGalaxyId = -1;
    contextMenuState.planetIndex = null;
    contextMenuState.moonId = null;
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
    if (info.starType === CORE_TYPE_CODE) return showCoreInfo(info);
    if (info.isBlackHole) return showBlackHoleInfo(info); // literal wandering black hole
    return showStarInfo(info);
  }

  function showCoreInfo(info) {
    setInfoRows('Supermassive Black Hole (Core)', [
      ['Type', 'Supermassive BH (Core)', '#c9a6ff'],
      ['Mass', formatCompact(info.mass) + ' M☉'],
      ['Event Horizon', formatCompact(info.mass * BLACKHOLE_EVENT_HORIZON_FACTOR) + ' units'],
      ['Black holes consumed', String(info.coreConsumedCount || 0)],
    ]);
    // The core is still "Sol" - always a valid zoom target, unlike an
    // ordinary wandering black hole/quasar.
    if (!(mode === 'system' && focusIndex === info.index)) {
      els.infoAction.textContent = 'View System →';
      els.infoAction.classList.remove('hidden');
      els.infoAction.onclick = () => enterSystem(info.index);
    }
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
    // Reaches here only for genuine spectral-type stars - the core
    // (CORE_TYPE_CODE) is dispatched to showCoreInfo before this is called.
    const st = (window.STAR_TYPES || []).find((t) => t.code === info.starType);
    setInfoRows('Star', [
      ['Type', st ? `${st.label} - ${st.colorName}` : 'Unknown', st ? st.color : '#fff6d6'],
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

  const STABILITY_COLOR = { stable: '#5fd68a', marginal: '#e8c95a', unstable: '#ff6b6b', unknown: '#888' };

  function showPlanetInfo(info) {
    const kindLabel = info.kind === 'asteroid' ? 'Asteroid' : info.kind === 'comet' ? 'Comet' : 'Planet';
    setInfoRows(kindLabel, [
      ['Name', info.name, '#dfe3ff'],
      ['Mass', formatCompact(info.massEarth) + ' M⊕'],
      ['Orbit radius', info.currentRadius.toFixed(1) + ' units'],
      ['Temperature', info.tempK != null ? info.tempK + ' K (' + info.composition + ')' : info.composition],
    ]);
    els.infoLabel5.textContent = 'Orbital velocity';
    els.infoValue5.textContent = info.orbitalSpeed.toFixed(2) + ' u/s';
    els.infoLabel6.textContent = 'Period';
    els.infoValue6.textContent = formatYears(info.periodYears);
    els.infoRow5.classList.remove('hidden');
    els.infoRow6.classList.remove('hidden');
    // Δv-from-circular % and eccentricity - both computed worker-side in
    // sendStarInfo from the body's CURRENT state (not new physics, just
    // exposing numbers the worker already derives). Shown together since
    // both answer the same question ("how far off a clean circle is this
    // right now") from two different angles.
    if (typeof info.deltaVFromCircularPct === 'number') {
      els.infoLabel7.textContent = 'Δv / eccentricity';
      const sign = info.deltaVFromCircularPct >= 0 ? '+' : '';
      els.infoValue7.textContent =
        sign + info.deltaVFromCircularPct.toFixed(1) + '% · e=' + info.eccentricity.toFixed(2);
      els.infoRow7.classList.remove('hidden');
    } else {
      els.infoRow7.classList.add('hidden');
    }
    els.infoAction.textContent = '← Back to Galaxy';
    els.infoAction.classList.remove('hidden');
    els.infoAction.onclick = () => exitSystem();

    // Edit row: mass +/-, color cycle, delete, lock orbit + a stability dot
    // (green/yellow/red) using the SAME thresholds already documented for
    // ordinary orbital drift, not new unverified numbers.
    els.editRow.classList.remove('hidden');
    els.massValue.textContent = formatCompact(info.massEarth) + ' M⊕';
    const lockStrength = info.lockStrength || 0;
    els.lockBtn.textContent = info.locked
      ? (lockStrength >= 1 ? '🔓 Unlock Orbit' : `🔓 Unlock Orbit (${Math.round(lockStrength * 100)}% assisted)`)
      : '🔒 Lock Orbit';
    els.stabilityDot.style.background = STABILITY_COLOR[info.stability] || STABILITY_COLOR.unknown;
    els.stabilityDot.title = 'Orbit stability: ' + (info.stability || 'unknown');
  }

  function showMoonInfo(planetIndex, moonId) {
    const slot = latestSystemSlots.find((s) => s.index === planetIndex);
    const moon = slot && slot.moons && slot.moons.find((m) => m.id === moonId);
    if (!moon) return;
    if (infoPollTimer) {
      clearInterval(infoPollTimer);
      infoPollTimer = null;
    }
    selectedIndex = -1; // moons aren't physics bodies - no getStarInfo polling
    renderer.selectedIndex = -1;
    setInfoRows('Moon', [
      ['Name', moon.name, '#dfe3ff'],
      ['Orbits', slot.name],
      ['Orbit radius', moon.orbitRadius.toFixed(1) + ' units'],
      ['', ''],
    ]);
    els.infoAction.textContent = '← Back to Galaxy';
    els.infoAction.classList.remove('hidden');
    els.infoAction.onclick = () => exitSystem();
    els.editRow.classList.add('hidden'); // moons aren't mass/color-editable real bodies
    contextMenuState.planetIndex = null;
    contextMenuState.moonId = moonId;
    contextMenuState.parentPlanetIndex = planetIndex;
  }

  function selectStar(index) {
    selectedIndex = index;
    renderer.selectedIndex = index;
    contextMenuState.planetIndex = renderer.systemMeta[index] ? index : null;
    contextMenuState.moonId = null;
    if (infoPollTimer) clearInterval(infoPollTimer);
    worker.postMessage({ type: 'getStarInfo', index });
    // Keep the panel live-ish while a body is selected.
    infoPollTimer = setInterval(() => {
      if (selectedIndex >= 0) worker.postMessage({ type: 'getStarInfo', index: selectedIndex });
    }, 500);
  }

  // No polling needed the way selectStar's getStarInfo loop is - the full
  // galaxy list (name/mass/morphology/starCount) is already known
  // client-side from the last cosmicReady/cosmicBodyDelta message, and
  // showGalaxyInfo is also re-invoked directly by the cosmicBodyDelta
  // handler below whenever the selected galaxy might have changed (a mass
  // edit, a merge involving it, etc.).
  function selectGalaxy(galaxyId) {
    if (galaxyId === -1) { hideInfoPanel(); return; }
    if (mergeSelectMode) {
      if (!mergeSelection.includes(galaxyId)) mergeSelection.push(galaxyId);
      updateCosmicStatus();
      if (mergeSelection.length >= 2) {
        worker.postMessage({
          type: mergeSelectMode === 'collide' ? 'collideGalaxies' : 'mergeGalaxies',
          idA: mergeSelection[0], idB: mergeSelection[1],
        });
        mergeSelectMode = null;
        mergeSelection = [];
        els.mergeGalaxiesBtn.classList.remove('active');
        els.collideGalaxiesBtn.classList.remove('active');
      }
      return;
    }
    selectedGalaxyId = galaxyId;
    renderer.selectedGalaxyId = galaxyId;
    showGalaxyInfo(galaxyId);
  }

  function showGalaxyInfo(galaxyId) {
    const g = latestCosmicMeta.find((gal) => gal.id === galaxyId);
    if (!g) { hideInfoPanel(); return; }
    setInfoRows(g.name, [
      ['Morphology', g.morphology.charAt(0).toUpperCase() + g.morphology.slice(1)],
      ['Mass', formatCompact(g.mass) + ' M☉'],
      ['Stars', String(g.starCount)],
      ['', ''],
    ]);
    els.infoAction.textContent = 'Enter Galaxy →';
    els.infoAction.classList.remove('hidden');
    els.infoAction.onclick = () => enterGalaxy(galaxyId);
  }

  renderer.onClick = (sx, sy) => {
    if (mode === 'cosmic') {
      if (cosmicCreationMode) {
        const world = renderer.screenToWorld(sx, sy);
        worker.postMessage({ type: 'createGalaxy', x: world.x, y: world.y, morphology: randomMorphologyForCreate() });
        exitCosmicCreationMode();
        return;
      }
      const galaxyId = renderer.findGalaxyAt(latestCosmicPositions, latestCosmicN, sx, sy, 20);
      selectGalaxy(galaxyId);
      return;
    }
    if (!latestPositions) return;
    if (creationMode) {
      handleCreationClick(sx, sy);
      return;
    }
    const idx = renderer.findBodyAt(latestPositions, latestN, sx, sy, 16);
    if (idx >= 0) {
      selectStar(idx);
      return;
    }
    if (mode === 'system') {
      const hit = renderer.findMoonAt(latestPositions, sx, sy, lastStepSeen, 10);
      if (hit) showMoonInfo(hit.planetIndex, hit.moonId);
    }
  };

  // --- Hover tooltips ---

  function tooltipTextForIndex(idx) {
    if (idx === 0) {
      const mass = renderer.coreMass != null ? renderer.coreMass : (bodyMass ? bodyMass[0] : 0);
      return `Sol · Supermassive BH (Core) · ${formatCompact(mass)} M☉`;
    }
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
    if (mode === 'cosmic') {
      if (sx < 0 || !latestCosmicPositions) { hideTooltip(); return; }
      const galaxyId = renderer.findGalaxyAt(latestCosmicPositions, latestCosmicN, sx, sy, 18);
      const g = latestCosmicMeta.find((gal) => gal.id === galaxyId);
      if (g) {
        showTooltip(sx, sy, `${g.name} · ${g.morphology} · ${formatCompact(g.mass)} M☉ · ~${g.starCount} stars`);
      } else {
        hideTooltip();
      }
      return;
    }
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
        const moon = slot && slot.moons.find((m) => m.id === hit.moonId);
        if (moon) {
          showTooltip(sx, sy, `${moon.name} · moon of ${slot.name}`);
          return;
        }
      }
    }
    hideTooltip();
  };

  // --- Info-panel edit row (mass +/-, color, delete, lock orbit) ---

  els.massMinus.addEventListener('click', () => {
    if (selectedIndex < 0 || !renderer.systemMeta[selectedIndex]) return;
    const meta = renderer.systemMeta[selectedIndex];
    worker.postMessage({ type: 'adjustMass', index: selectedIndex, massEarth: meta.massEarth / 1.5 });
  });
  els.massPlus.addEventListener('click', () => {
    if (selectedIndex < 0 || !renderer.systemMeta[selectedIndex]) return;
    const meta = renderer.systemMeta[selectedIndex];
    worker.postMessage({ type: 'adjustMass', index: selectedIndex, massEarth: meta.massEarth * 1.5 });
  });
  els.colorBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    worker.postMessage({ type: 'cycleColor', index: selectedIndex });
  });
  els.deleteBtn.addEventListener('click', () => {
    if (selectedIndex < 0) return;
    worker.postMessage({ type: 'deleteBody', index: selectedIndex });
  });
  els.lockBtn.addEventListener('click', () => {
    if (selectedIndex < 0 || !renderer.systemMeta[selectedIndex]) return;
    const locked = !!renderer.systemMeta[selectedIndex].locked;
    worker.postMessage({ type: 'lockOrbit', index: selectedIndex, locked: !locked });
  });

  // --- Orbit Stability slider ("Realism <-> Stability") ---
  // Sets the default blend strength (0-1) applied to bodies the user
  // creates AFTER this point in THIS system only - see
  // physics-worker.js's 'setOrbitStabilityDefault' handler. Pure physics
  // (0%) is the default; this never touches the shared gravity/force-calc
  // path, only how newly-placed bodies are post-processed each tick.
  if (els.orbitStabilitySlider) {
    els.orbitStabilitySlider.addEventListener('input', () => {
      const pct = Number(els.orbitStabilitySlider.value);
      els.orbitStabilityValue.textContent = pct + '%';
      worker.postMessage({ type: 'setOrbitStabilityDefault', strength: pct / 100 });
    });
  }

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

  // Both now operate at the universe level, not a single galaxy - "New
  // Universe"/"Reset" regenerate the whole cosmic web (see currentGalaxyCount's
  // comment for why). Forces a full cascade back to cosmic first if
  // currently deeper (galaxy/system), same "one gesture, one clear
  // outcome" reasoning as the rest of this feature's transitions.
  els.reset.addEventListener('click', () => {
    if (mode === 'system') exitSystem();
    initUniverse(currentSeed(), { galaxyCount: currentGalaxyCount() });
    setPlaying(true);
  });

  els.regen.addEventListener('click', () => {
    if (mode === 'system') exitSystem();
    const seed = randomSeed();
    els.seed.value = seed;
    initUniverse(seed, { galaxyCount: currentGalaxyCount() });
    setPlaying(true);
  });

  els.speed.addEventListener('input', () => {
    const speed = parseFloat(els.speed.value);
    els.speedLabel.textContent = speed.toFixed(2) + 'x';
    if (!timeWarpOn) speedBeforeTimeWarp = speed; // remember the user's manual setting even while warped
    worker.postMessage({ type: 'setSpeed', speed });
  });

  // --- System Experiments: G is a single worker-global, so these affect
  // the WHOLE simulation, not just the zoomed system - there is one shared
  // force-calc path for every body in this project, on purpose. Called out
  // in each button's title (native tooltip) rather than done silently. ---

  function applyG() {
    let G = DEFAULT_G;
    if (crazyPhysicsOn) G *= CRAZY_PHYSICS_G_MULT;
    else if (lowGravityOn) G /= LOW_GRAVITY_G_DIV;
    worker.postMessage({ type: 'setPhysicsParams', G });
  }
  els.crazyPhysicsBtn.addEventListener('click', () => {
    crazyPhysicsOn = !crazyPhysicsOn;
    if (crazyPhysicsOn) lowGravityOn = false;
    els.crazyPhysicsBtn.classList.toggle('active', crazyPhysicsOn);
    els.lowGravityBtn.classList.toggle('active', lowGravityOn);
    applyG();
  });
  els.lowGravityBtn.addEventListener('click', () => {
    lowGravityOn = !lowGravityOn;
    if (lowGravityOn) crazyPhysicsOn = false;
    els.lowGravityBtn.classList.toggle('active', lowGravityOn);
    els.crazyPhysicsBtn.classList.toggle('active', crazyPhysicsOn);
    applyG();
  });
  els.timeWarpBtn.addEventListener('click', () => {
    timeWarpOn = !timeWarpOn;
    els.timeWarpBtn.classList.toggle('active', timeWarpOn);
    const speed = timeWarpOn ? TIME_WARP_SPEED : speedBeforeTimeWarp;
    els.speed.value = String(speed);
    els.speedLabel.textContent = speed.toFixed(2) + 'x';
    worker.postMessage({ type: 'setSpeed', speed });
  });

  window.addEventListener('keydown', (e) => {
    if (e.target !== document.body) return; // never hijack typing in an input field

    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!playing);
      return;
    }
    if (e.code === 'KeyD') {
      // Debug bounding-box overlay - useful any time a body's position is
      // in doubt, not just during the one investigation it was added for.
      renderer.debugMode = !renderer.debugMode;
      console.log('[main] debug bounding-box overlay:', renderer.debugMode ? 'ON' : 'OFF');
      return;
    }
    if (e.code === 'Escape') {
      if (creationMode) exitCreationMode();
      hideContextMenu();
      return;
    }
    if (mode !== 'system') return;
    if ((e.code === 'Delete' || e.code === 'Backspace') && selectedIndex >= 0) {
      e.preventDefault();
      worker.postMessage({ type: 'deleteBody', index: selectedIndex });
    } else if (e.code === 'KeyM' && selectedIndex >= 0 && renderer.systemMeta[selectedIndex]) {
      els.massPlus.focus();
    } else if (e.code === 'KeyC' && selectedIndex >= 0) {
      worker.postMessage({ type: 'cycleColor', index: selectedIndex });
    } else if (e.code === 'KeyR' && selectedIndex >= 0) {
      worker.postMessage({ type: 'recalcOrbit', index: selectedIndex });
    } else if (e.ctrlKey && e.code === 'KeyZ') {
      e.preventDefault();
      worker.postMessage({ type: 'undo' });
    }
  });

  // --- System-editor reactions ---

  let toastTimer = null;
  function showToast(text) {
    els.creationStatus.textContent = text;
    els.creationStatus.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (!creationMode) els.creationStatus.classList.add('hidden');
    }, 2500);
  }

  function updateSystemStatus() {
    if (mode !== 'system') return;
    els.statusBodies.textContent = String(latestSystemSlots.length);
    let worst = 'stable';
    for (const s of latestSystemSlots) {
      // Cheap client-side re-derivation using the same documented
      // thresholds, so the status line updates every frame-ish without a
      // worker round trip; the authoritative per-body value (from
      // getStarInfo) is what the info panel itself shows.
      if (s.orbitRadius > 0 && latestPositions) {
        const hostX = latestPositions[focusIndex * 2], hostY = latestPositions[focusIndex * 2 + 1];
        const dx = latestPositions[s.index * 2] - hostX, dy = latestPositions[s.index * 2 + 1] - hostY;
        const drift = Math.abs(Math.hypot(dx, dy) / s.orbitRadius - 1);
        if (drift > 0.40) worst = 'unstable';
        else if (drift > 0.15 && worst !== 'unstable') worst = 'marginal';
      }
    }
    els.statusStability.textContent = worst;
    els.statusStability.style.color = STABILITY_COLOR[worst] || STABILITY_COLOR.unknown;
  }

  // Every mutating worker action replies with the FULL current slot list
  // (cheap at this scale) - re-syncing wholesale is simpler and more
  // robust than trying to diff, and matches how 'systemReady' already works.
  function applySystemBodyDelta(msg) {
    const priorIndices = new Set(latestSystemSlots.map((s) => s.index));
    const newIndices = new Set(msg.slots.map((s) => s.index));

    const entries = msg.slots.map((s) => ({ index: s.index, starType: PLANET_TYPE_CODE, radius: s.radiusPx, color: s.color }));
    renderer.applySlotMeta(entries);
    renderer.setSystemMeta(msg.slots);

    // Freed slots (present before, gone now) get a value-snapshotted fade -
    // read from the OLD slot list, not the new one (it no longer exists there).
    for (const old of latestSystemSlots) {
      if (!newIndices.has(old.index) && latestPositions) {
        renderer.markSlotsEmpty([old.index]);
        renderer.startDeleteFade(
          latestPositions[old.index * 2], latestPositions[old.index * 2 + 1], old.color, old.radiusPx * renderer.dpr
        );
      }
    }
    // Newly-appeared slots get a welcome flash.
    for (const s of msg.slots) {
      if (!priorIndices.has(s.index)) renderer.flashNew(s.index);
    }

    latestSystemSlots = msg.slots;
    updateSystemStatus();
    if (!loadedFromShare) saveSystemSnapshot(msg.snapshot);

    // Keep the info panel in sync: a delete of the selected body should
    // close it; anything else refreshes via the existing 500ms poll.
    if (selectedIndex >= 0 && !newIndices.has(selectedIndex) && msg.action === 'deleteBody') {
      selectedIndex = -1;
      hideInfoPanel();
    }
    if (msg.result && msg.result.index != null && (msg.action === 'createPlanet' || msg.action === 'addComet')) {
      selectStar(msg.result.index);
    }
    if (msg.result && msg.result.poolFull) {
      showToast('System is full - delete something first');
    }
  }

  const COLLISION_SOUND_FREQ = { planet: 220, asteroid: 330, comet: 150 };
  function handleCollision(msg) {
    const color = msg.loserKind === 'comet' ? '#ffffff' : msg.loserKind === 'asteroid' ? '#c9ced6' : '#ffcf7a';
    renderer.spawnBurst(msg.x, msg.y, color, {
      countMin: msg.loserKind === 'comet' ? 60 : 20, countMax: msg.loserKind === 'comet' ? 100 : 40,
      life: 0.45, speedMin: 40, speedMax: 220,
    });
    playCollisionSound(COLLISION_SOUND_FREQ[msg.loserKind] || 220);
  }

  function playCollisionSound(freq) {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (err) {
      /* audio best-effort only */
    }
  }

  // --- Worker messages ---

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      renderer.setStarMeta(msg.starType, msg.radius, msg.n);
      bodyMass = msg.mass;
      renderer.coreMass = msg.mass[0];
      renderer.initialCoreMass = msg.mass[0];
      updateCoreGrowthStat();
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
    } else if (msg.type === 'coreAbsorption') {
      renderer.markDead(msg.blackHoleIndex);
      renderer.coreMass = msg.newCoreMass;
      coreConsumedCount = msg.coreConsumedCount;
      // A bigger, brighter, purple-tinted burst - the core just ate a whole
      // black hole, a rarer and more dramatic event than a star falling in.
      renderer.spawnBurst(msg.x, msg.y, '#c9a6ff', {
        countMin: 60, countMax: 100, life: 0.6, speedMin: 30, speedMax: 180,
      });
      updateCoreGrowthStat();
      // If the core is currently selected, its info panel picks up the new
      // mass/count via the existing periodic getStarInfo poll below.
    } else if (msg.type === 'starInfo') {
      if (msg.index === selectedIndex) showBodyInfo(msg);
    } else if (msg.type === 'systemReady') {
      const entries = msg.slots.map((s) => ({ index: s.index, starType: PLANET_TYPE_CODE, radius: s.radiusPx, color: s.color }));
      renderer.applySlotMeta(entries);
      renderer.setSystemMeta(msg.slots);
      renderer.mode = 'system';
      renderer.focusIndex = msg.starIndex;
      latestSystemSlots = msg.slots;
      // Unconditional (not just for the normal click-driven flow): a
      // boot-time shared-system load has no earlier point where main.js
      // knows the synthetic host's index yet, so this is the one place
      // that's guaranteed to run for every path into system view.
      mode = 'system';
      focusIndex = msg.starIndex;
      if (msg.fromShare) {
        els.backBtn.classList.remove('hidden');
        document.body.classList.add('system-mode');
        startAutosave();
      }

      const label = msg.fromShare
        ? (msg.creatorName ? `Shared: ${msg.creatorName}` : 'Shared System')
        : formatStarLabel(msg.starMeta.type, msg.starMeta.mass);
      els.modeIndicator.textContent = 'System View: ' + label;
      els.modeIndicator.classList.remove('mode-galaxy');
      els.modeIndicator.classList.add('mode-system');
      if (msg.fromShare) showToast(msg.creatorName ? `Loaded: ${msg.creatorName}'s System` : 'Loaded shared system');

      const hx = latestPositions ? latestPositions[msg.starIndex * 2] : 0;
      const hy = latestPositions ? latestPositions[msg.starIndex * 2 + 1] : 0;
      renderer.panZoomTo(hx, hy, SYSTEM_ZOOM, 1000);
      pulseOverlay(1000);
      updateSystemStatus();

      // Orbit Stability resets to 0% (pure physics) per system, matching
      // the worker's own state.orbitStabilityDefault reset on entry - a
      // slider setting from a previously-visited system must never leak
      // into this one.
      if (els.orbitStabilitySlider) {
        els.orbitStabilitySlider.value = 0;
        els.orbitStabilityValue.textContent = '0%';
      }
      els.proximityWarning.classList.add('hidden');

      // Always request a fresh, worker-computed (host-relative) snapshot
      // right after entering, whether freshly generated or loaded - keeps
      // localStorage in sync even if the tab closes before any autosave.
      // Skipped for shared systems - those persist via the share URL
      // itself, not a per-star localStorage slot tied to a real seed.
      if (!msg.fromShare) worker.postMessage({ type: 'peekSystemSnapshot' });
    } else if (msg.type === 'systemSnapshot') {
      if (!loadedFromShare) saveSystemSnapshot(msg);
      if (!msg.peek) {
        // A real exitSystem() completed - finalize the return-to-galaxy UI.
        resetToGalaxyUI();
        renderer.panZoomTo(0, 0, 0.6, 1000);
        pulseOverlay(1000);
      }
    } else if (msg.type === 'systemBodyDelta') {
      applySystemBodyDelta(msg);
    } else if (msg.type === 'proximityWarning') {
      // Surfaces a real (if rare) wandering-absorber sweep-through as a
      // diagnosable event instead of planets silently disappearing - see
      // physics-worker.js's tick()/absorberProximityWarning wiring. Never
      // alters anything, purely informational.
      els.proximityWarning.classList.toggle('hidden', !msg.active);
    } else if (msg.type === 'collision') {
      handleCollision(msg);
    } else if (msg.type === 'cosmicReady') {
      latestCosmicMeta = msg.galaxies;
      if (msg.fromShare) {
        loadedFromUniverseShare = true;
        universeSeed = null;
        mode = 'cosmic';
        renderer.mode = 'cosmic';
        document.body.classList.remove('system-mode');
        document.body.classList.add('cosmic-mode');
        els.modeIndicator.textContent = 'Cosmic View';
        els.modeIndicator.classList.remove('mode-galaxy', 'mode-system');
        els.modeIndicator.classList.add('mode-cosmic');
        els.backBtn.classList.add('hidden');
        showToast('Loaded a shared universe');
      }
      updateCosmicStatus();
    } else if (msg.type === 'cosmicPositions') {
      latestCosmicPositions = msg.buf;
      latestCosmicN = msg.n;
      renderer.setCosmicMeta(latestCosmicMeta);
      // cosmicPositions.step and positions.step both come from the SAME
      // shared stepCount in physics-worker.js - updating lastStepSeen here
      // too (not just from 'positions') is what keeps the Physics Hz stat
      // accurate while in pure cosmic view, where no galaxy is loaded and
      // 'positions' messages never fire at all (found empirically: it read
      // a permanent 0 in cosmic view before this).
      lastStepSeen = msg.step;
    } else if (msg.type === 'galaxyEntered') {
      loadedGalaxyId = msg.galaxyId;
      // A galaxy's own star-level system saves need a per-galaxy derived
      // seed, not the app's single global seed field - this is the SAME
      // storage mechanism (galaxysim:system:${seed}:${starIndex}) every
      // system save already used, just fed a different seed value at the
      // one point that matters (activeSeed is read by loadSavedSystem/
      // saveSystemSnapshot via closure, so setting it here is enough - no
      // signature changes needed at any of their call sites).
      activeSeed = universeSeed != null
        ? `${universeSeed}:galaxy:${msg.galaxyId}`
        : `shared:galaxy:${msg.galaxyId}`;
    } else if (msg.type === 'cosmicBodyDelta') {
      latestCosmicMeta = msg.galaxies;
      renderer.setCosmicMeta(latestCosmicMeta);
      updateCosmicStatus();
      if (selectedGalaxyId !== -1) {
        if (latestCosmicMeta.some((g) => g.id === selectedGalaxyId)) showGalaxyInfo(selectedGalaxyId);
        else hideInfoPanel();
      }
      saveUniverseSnapshot();
    } else if (msg.type === 'galaxyCollision') {
      // Cosmic-layer-only flourish (see cosmic-editor.js's mergeGalaxies
      // comment for why this isn't a real dual-galaxy star-level collision)
      // - a bigger, more dramatic burst than an in-system collision gets,
      // at the merged galaxy's own resulting position.
      renderer.spawnBurst(msg.merged.x, msg.merged.y, '#ffd24d', {
        countMin: 80, countMax: 140, life: 0.9, speedMin: 40, speedMax: 220,
      });
      playCollisionSound(160);
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
    // Cosmic mode draws from its own small positions buffer instead of the
    // star-level one - draw() branches on renderer.mode internally and
    // treats whichever buffer is passed as "the" positions for that mode,
    // so no signature change was needed there, just picking the right
    // buffer here.
    if (mode === 'cosmic') {
      renderer.draw(latestCosmicPositions, latestCosmicN, now, lastStepSeen);
    } else {
      renderer.draw(latestPositions, latestN, now, lastStepSeen);
    }

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

  const urlParams = new URLSearchParams(location.search);
  const universeParam = urlParams.get('universe');
  const universePayload = universeParam ? decodeUniverse(universeParam) : null;
  const sharedParam = urlParams.get('system');
  const sharedPayload = sharedParam ? decodeSystem(sharedParam) : null;

  if (universePayload) {
    // `?universe=` takes priority: land directly in the shared cosmic
    // view, bypassing the normal seed-based generateUniverse() path
    // entirely (a full snapshot, not seed+diff - see universe-codec.js).
    mode = 'cosmic';
    renderer.mode = 'cosmic';
    document.body.classList.add('cosmic-mode');
    renderer.camera.x = 0; renderer.camera.y = 0; renderer.camera.zoom = 0.012;
    worker.postMessage({ type: 'loadUniverse', payload: universePayload });
  } else if (sharedPayload) {
    // A `?system=` link needs SOME galaxy underneath it (init() sets up the
    // worker's typed-array state, star meta, etc. that everything else
    // depends on) - just not necessarily the one implied by the seed/count
    // fields, since the visitor is here for the shared system, not a
    // random galaxy. init() is still called with the normal seed/count so
    // Back-to-galaxy and a page refresh without the query param behave
    // normally; loadSharedSystem is queued right after - the worker
    // processes its message queue in order, so it runs once init's own
    // 'ready' has already been emitted, same as any other post-init
    // message. A system share deliberately bypasses the cosmic wrapper
    // entirely too - the whole point of the link is "jump straight to this
    // system," the same way a universe share jumps straight to cosmic view.
    init(currentSeed() || randomSeed(), currentStarCount());
    loadedFromShare = true;
    worker.postMessage({ type: 'loadSharedSystem', payload: sharedPayload });
  } else {
    // Default: boot straight into cosmic view (spec's own stated default).
    initUniverse(currentSeed() || randomSeed(), { galaxyCount: currentGalaxyCount() });
  }

  worker.postMessage({ type: 'setSpeed', speed: parseFloat(els.speed.value) });
  setPlaying(true);
  requestAnimationFrame(frame);
})();
