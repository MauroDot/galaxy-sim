# Galaxy N-Body Simulator

A 2D galaxy-scale N-body gravity simulator running entirely in the browser:
vanilla JS, no frameworks, no build step.

- **Barnes-Hut quadtree** ([src/quadtree.js](src/quadtree.js)) for O(n log n) gravity instead of the naive O(n²) all-pairs sum.
- **Physics runs in a Web Worker** ([src/physics-worker.js](src/physics-worker.js)) at a fixed 60 Hz tick, symplectic (semi-implicit) Euler integration, so the main thread stays free for rendering. The worker also ages every star each step and triggers supernovae.
- **Stellar diversity** ([src/star-types.js](src/star-types.js)): seven spectral types (O/B/A/F/G/K/M), each with a realistic relative frequency (mostly M dwarfs, ~1% O giants), mass, radius and main-sequence lifetime. Shared between the worker (generation, aging) and the main thread (color, info panel) so there's one source of truth.
- **Procedural spiral galaxy generator** ([src/galaxy.js](src/galaxy.js)), seeded (mulberry32 PRNG) — same seed always produces the same galaxy. A central mass anchors a disk of spectral-typed stars laid out along logarithmic spiral arms, given near-circular initial velocities from an enclosed-mass approximation. Each star also gets a randomized starting age so a fresh galaxy isn't perfectly coeval - deaths stagger naturally instead of arriving in one synchronized burst.
- **Supernovae**: when a star's age reaches its lifetime, the worker removes it from the simulation (stops integrating/inserting it into the quadtree) and broadcasts a one-off event. The main thread reacts with a gravity-free particle burst (100-200 particles, world-space, fade out over 0.5s), a short 440 Hz Web Audio beep, and a running "Supernovae" counter. Calibrated to ~1-2 events/minute in a 500-star galaxy at 1x speed (dominated by the short-lived O/B stars - realistic, since G/K/M lifetimes run into the billions of years and essentially never complete during a play session).
- **Black holes** ([src/star-types.js](src/star-types.js), [src/physics-worker.js](src/physics-worker.js)): ~0.3% of disk slots (roughly 1-2 per 500-star galaxy) spawn as a wandering black hole instead of a star - a point mass (radius 0) with near-zero drift velocity that needs no special gravity code, since it's just another (very heavy) body in the same quadtree. Any star that drifts within its capture radius (70 sim units) is removed from the simulation, incrementing that black hole's absorbed-star count. The main thread reacts with a quick white particle flash (10-20 particles, 0.3s) at the black hole. *Calibration note:* the spec's suggested 1e7 solar masses is a real-astronomy figure, but this sim's `G` and distances were already tuned around a much smaller range (stars top out around ~80, the galactic core anchor is ~30000) - plugging 1e7 into that unmodified devoured 498 of 500 stars within 10 seconds in testing, leaving nothing to watch orbit. It's calibrated down to match the core's own mass (30000) instead: still ~400x any star and clearly dominant, but the galaxy survives to be watched. The info panel always shows this same simulated value, never a different display number.
- **Quasars & neutron stars** ([src/star-types.js](src/star-types.js)): quasars (~1 per 1000 disk slots) are physically identical to a black hole (same mass, same capture-radius absorption - the absorption loop treats both as "absorbers") with a distinct bright yellow/white ring visual and a separate, cosmetic-only "displayed" mass (1e6) shown in the info panel, never fed to gravity. Neutron stars (~0.5% of disk slots) are ordinary, gravitationally unremarkable immortal point masses (2-3 solar masses) - already-dead remnants that orbit the core like any star but never go supernova again.
- **Sol System zoom** ([src/system-bodies.js](src/system-bodies.js), [src/physics-worker.js](src/physics-worker.js)): click any ordinary star (or the galactic core itself, "Sol") and hit "View System →" to smoothly zoom into its neighborhood. On first visit, 1-5 planets are auto-generated deterministically from a seed derived from the star's index - realistic log-uniform mass distribution (0.3-300 Earth masses), composition/color biased by a stylized equilibrium-temperature estimate, circular orbits computed from this sim's actual `G` and the host's real mass. Planets are genuine N-body physics bodies (reserved capacity slots in the same typed arrays as everything else, populated on demand - `buildTree()`/`step()` need zero changes since dormant slots just use the existing `alive` skip); moons are cosmetic-only orbital animation (see calibration note below for why). Camera and info-panel state persist to `localStorage` per star (keyed by seed+index), so revisiting a star resumes its planets from where they were, re-anchored to the star's current galaxy position.
  - *Units note:* planet mass is converted Earth-masses → solar-masses via a real physical constant (`EARTH_MASS_IN_SOLAR`), not an empirical fudge - even a 300-Earth-mass giant is <0.1% of the lightest star's mass, so planets never meaningfully perturb their star.
  - *Stability note:* this galaxy's own stars already pass startlingly close to each other as ordinary N-body behavior (closest-approach distances as low as ~1 unit were measured across a sample of hosts - pre-existing, unrelated to this feature), which tugs on any planet regardless of orbit radius. Orbit radii (20-150 units) were tuned empirically so systems read as stable circles for the timeframe a user actually watches (tight within ~15% at 15s); slower drift over a multi-minute session is real N-body physics, not a bug - the same principle as a wandering black hole "eating" the galaxy over time. Moons were kept out of the physics arrays entirely for the same reason: a stable moon orbit at this scale would sit *inside* the force-softening length, which flattens gravity into near-uselessness there.
  - *Visibility note:* planets were once reported as "not rendering" in system view. Debugging (pixel-position math cross-checked against a screenshot, plus a toggleable bounding-box overlay - press **D** - and temporary `console.log`s in generation/placement/render, all left in place) showed generation, worker placement, and the camera transform were all correct all along; the real problem was legibility - a 1-3px dot in the majority ("airless") composition's muted `#9a9a9a` gray was easy to miss against the near-black background. Fixed by raising the minimum planet size (1→1.8px, both at generation time and as a render-time floor so it also covers systems already saved to `localStorage`), brightening the airless color, and giving planets a small soft glow (the same radial-gradient technique already used for black holes/quasars/neutron stars) so they read as a distinct body rather than background noise.
- **The core grows**: the galactic core (index 0, "Sol") is itself a supermassive black hole, and eats any wandering black hole/quasar that strays within its own capture radius - same mechanic as a black hole eating a star, just running with the core as the eater (`state.absorberIndices` is filtered each step to drop anything the core just consumed, so a just-eaten black hole can't also "capture" a star that same step via its now-frozen last position). Its mass grows by exactly the absorbed body's mass (30000 + 30000 = 60000, etc.), which feeds straight into the *existing* gravity code with no special-casing - stars genuinely orbit differently once the core is heavier. The core's glow ring radius scales with `sqrt(mass)` and its brightness increases too (both relative to the galaxy's starting core mass, so a fresh galaxy's core looks exactly as before - it only visibly swells once it's eaten something), while the dark center stays a fixed size. A "Core growth: 30.0k → 90.0k M☉" stat appears once it's consumed anything.
- **Interactive system editing** ([src/system-editor.js](src/system-editor.js), [src/share-codec.js](src/share-codec.js), [src/physics-worker.js](src/physics-worker.js)): system view is a full editor, not just a viewer.
  - *The core never moves.* `state.pinned[0]=1` skips index 0 in the velocity-update loop only - it still exerts and receives gravity normally (still grows by eating wandering black holes, per above), it just never accelerates. The same `pinned` mechanism (not a one-off `if (type==='core')` check) is what lets a shared system's synthetic host (see below) also stay put.
  - *Create Planet / Add Asteroid Field / Add Comet / Add Moon*: click "Create Planet" then click the canvas to place a 1-Earth-mass planet on a circular orbit at that radius (auto-named `Custom-N`, briefly outlined, info panel auto-opens); "Add Asteroid Field" spawns 5-10 small gray bodies around a ~150-unit belt; "Add Comet" places one fast, bright body on an eccentric path; "Add Moon" (click the button, then a planet) attaches a moon in a close orbit. Planets/asteroids/comets are genuine N-body bodies (reserved pool slots, `SYSTEM_POOL_CAPACITY=128` on top of the existing per-star planet pool); moons stay kinematic-only for the same Hill-sphere reason documented above.
  - *Editing*: right-click any body for a context menu (mass ×1.5/÷1.5, cycle color, delete, copy orbital data to the clipboard as JSON); the info panel gets a mass +/- row, a color/lock-orbit/delete row, and a stability dot (reusing the already-documented ±15%/±40% drift thresholds - no new numbers invented). Keyboard: Delete, M/C/R (mass focus/color/recalc-orbit), Ctrl+Z. "Lock Orbit" reuses the exact kinematic formula moons already use, applied to a *real* body - it still exerts gravity, it just stops integrating.
  - *Collisions*: one O(k²) pass over just the zoomed system's own bodies (dormant unless 2+ exist), mass-weighted momentum-conserving merge into the larger body, with a particle burst and a merge sound. Tuning this took a real empirical pass, not just a formula on paper: an initial `COLLISION_RADIUS_BASE=1.5` (chosen to make a deliberately-overlapping user-placed pair merge convincingly) looked reasonable next to the ~26-unit nominal adjacent-orbit spacing for a 5-planet system, but a 30-trial/5-sim-minute sweep of real auto-generated systems showed spurious merges (ordinary planets merging into each other from nothing but documented orbital drift) in ~38% of trials, occasionally wiping out 4 of 5 planets. The high-mass tail of the log-uniform mass distribution was the culprit - two adjacent 300-Earth-mass planets alone summed to a ~20-unit combined collision radius, uncomfortably close to that 26-unit spacing before any drift. Retuned to `0.35` (~4.7-unit worst-case combined radius) cut that to occasional single mergers over the same 5-minute sweep, while a deliberately-overlapping pair still merges within a few steps.
  - *A body can also be absorbed by a wandering black hole*, exactly like a galaxy star can - this is real, intentional physics (see the black-hole section above), not specific to system bodies. Making it work correctly surfaced a genuine bug during testing: the absorber-capture loop was setting `alive=0` on a captured system body without removing it from `state.systemBodyIndices` or freeing its pool slot, leaving a "zombie" entry that different code paths disagreed on (an undo snapshot filters by `alive` and correctly excluded it; the status-line count and every `systemBodyDelta` broadcast didn't, and kept counting it - and its slot leaked forever, since `findFreeSlot` only reclaims slots whose `type` says empty). Fixed by giving an absorbed system body the same slot-freeing cleanup `deleteBody()` does, plus a `systemBodyDelta` resync broadcast so the UI reflects the loss immediately instead of waiting for the next unrelated action.
  - *Save & share*: "Save System" packs the current system (host type/mass + each body's kind/mass/current orbital radius & angle/composition) into a compact binary layout, base64url-encoded into a `?system=` URL param - no JSON, so a worst-case ~100-body system still lands around ~1,200 characters (verified, not assumed). Velocity is never stored; it's recomputed at decode time from radius/angle/`G`, the same formula used everywhere else. Opening a shared link allocates a synthetic pinned host far outside the visible galaxy and lands straight in system view, labeled "Shared System" (or "Loaded: `<name>`'s System" if a creator name is ever added to the payload).
  - *Experiments*: "Crazy Physics" (G×10) and "Low Gravity" (G÷4) are mutually exclusive toggles on the one shared `G` used by gravity everywhere (not a per-body-group special case) - both reset on reload/regenerate, same as everything else in this section. "Time Warp" is just the existing speed control jumped to a high preset and restored on toggle-off, not a new mechanism. All persist to `localStorage` per star and support a 10-entry undo stack (worker-side, popped via the Undo button or Ctrl+Z) plus autosave every ~5s and after every mutating action.
- **Canvas 2D renderer** ([src/renderer.js](src/renderer.js)) with pan (drag) and zoom (scroll wheel), decoupled from the physics tick rate so rendering stays smooth even if physics lags. Stars render in their spectral-type color at a size derived from their radius; black holes are a solid dark disc with a purple glow ring; quasars are a brighter/bigger version of that same ring, in yellow/white; neutron stars are a tiny, extra-bright sparkle; the core is the same dark-disc-plus-glow language as a black hole, just bigger and growing. In system view, planets get faint orbit-ring guides and cosmetic moon dots. Click a body (a small in-place click, not a drag) to select it; hover any body for a brief tooltip.
- **UI controls** ([src/main.js](src/main.js)): play/pause, speed (0-20x), seed, star count, "new galaxy" (random seed), reset, live FPS / physics-Hz / star-count / black-hole-count / supernova-count / absorbed-count / core-growth stats, a full color legend, a color-coded mode indicator (blue = Galaxy View, green = System View - click it to zoom back out), a "Back to Galaxy" button, and an info panel with type-specific fields plus an action button ("View System →" / "← Back to Galaxy") for every body type: star, core, black hole, quasar, neutron star, planet, and moon.

Tested at 500 stars: ~1.2 ms/physics-step (~0.1 ms/galaxy generation with the
full stellar + black-hole + exotic-body logic), steady 60 FPS render and ~60 Hz
physics at 1x on the sample hardware, in both galaxy and system view, with
headroom to spare (scales to well over 1000 stars before dropping frames).
Physics tick rate and step cost are unaffected by any of the above - stellar
diversity/aging/absorption/planets are all cheap O(n) (or O(n * a handful of
absorbers) additions to the existing per-step loops, and a star's reserved
planet slots cost nothing at all until that star is actually zoomed into.

## Running it

The app uses a `Worker`, which browsers block from loading over `file://`.
Serve the folder over HTTP instead:

```bash
# from this directory
python -m http.server 8000
# or: npx http-server -p 8000
```

Then open **http://localhost:8000/** in a browser.

## Controls

| Control | Effect |
|---|---|
| Play / Pause | starts/stops the simulation |
| Speed slider | 0x-20x physics rate |
| Seed field + Reset | re-run the same galaxy from scratch |
| New Galaxy | generate a fresh random seed |
| Star count | bodies to simulate (central mass + disk stars) |
| Scroll | zoom |
| Drag | pan |
| Click a body | show its info panel (fields vary by type) |
| Hover a body | brief tooltip |
| "View System →" (info panel, on a star) | zoom smoothly into that star's planets |
| "← Back to Galaxy" (back button, mode indicator, or info panel on a planet/moon) | zoom back out |
| Space | toggle play/pause |
| D | toggle debug overlay (labeled bounding box on every live body - green if on-screen, red if clipped) |
| Create Planet / Add Asteroid Field / Add Comet / Add Moon (system view toolbar) | spawn a new body (Create Planet and Add Moon are click-to-place; the other two are instant) |
| Right-click a body (system view) | context menu: mass ×1.5/÷1.5, cycle color, delete, copy orbital data |
| Delete / M / C / R (system view, body selected) | delete / focus mass field / cycle color / recalculate a fresh circular orbit |
| Ctrl+Z / Undo button (system view) | undo the last create/delete/edit (10-entry stack) |
| Save System (system view toolbar) | generate a shareable `?system=` URL for the current system |
| Crazy Physics / Low Gravity / Time Warp (side panel) | G×10 / G÷4 / speed jump - affect the whole simulation, reset on reload |
| Esc (system view) | exit creation mode / close the context menu |

To watch a supernova, push the speed slider to 10x+ and wait 20-30s (or
click New Galaxy a few times - some galaxies roll an O-star close to death
at spawn and one goes within seconds). Black holes are rarer (~1-2 per
500-star galaxy) - click New Galaxy until "Black Holes" in the stats reads
1 or more, then watch the "Absorbed" counter climb as nearby stars fall in.
Quasars (~0.5 per galaxy) and neutron stars (~2-3 per galaxy) are rarer
still - keep clicking New Galaxy and watch the stats, or just look for a
bright yellow ring (quasar) or an extra-bright sparkle (neutron star)
among the ordinary stars. To see a planetary system, click any ordinary
star (or the core near the middle of the galaxy - "Sol") and use "View
System →" in its info panel. To watch the core grow, click New Galaxy
until "Black Holes" reads 2 or more, then just watch - the core's glow
visibly swells (and "Core growth" appears in the stats) once it eats one,
usually within the first minute or so at 1x speed.

To build your own system, enter any star's system view and use the
toolbar: "Create Planet" then click to place one, "Add Asteroid Field" /
"Add Comet" for an instant spawn, "Add Moon" then click a planet. Right-
click any body to edit or delete it, or select it and use the info
panel's mass/color/lock/delete row. Drop two bodies on (almost) the same
spot to watch them collide and merge. "Save System" builds a shareable
link that reproduces the system for whoever opens it - try it in a second
tab. Everything (including a hand-edited system) survives a full page
reload as long as the same seed is in the Seed field.

## File structure

```
galaxy-sim/
├── index.html          # page shell, canvas, UI panel, info/mode/tooltip UI
├── style.css            # dark theme, all panel/overlay/tooltip styling
└── src/
    ├── quadtree.js       # Barnes-Hut quadtree (force calc)
    ├── star-types.js      # every body-type table/constant: spectral types, black hole,
    │                        quasar, neutron star, planet/moon (single source of truth,
    │                        shared by the worker via importScripts and the main thread
    │                        via a <script> tag)
    ├── galaxy.js           # seeded procedural galaxy generation (stars + all exotic bodies)
    ├── system-bodies.js     # seeded procedural planet/moon generation for one star (worker-only)
    ├── system-editor.js      # worker-side system editor: create/delete/edit bodies, asteroid
    │                            fields/comets/moons, collisions, undo stack (worker-only)
    ├── share-codec.js          # packed-binary encode/decode for the "Save This System" share URL
    │                            (main-thread <script> tag, not importScripts)
    ├── physics-worker.js         # simulation loop: gravity, aging, supernova, absorber-capture,
    │                               system enter/exit/snapshot, and the system-editor message
    │                               handlers - runs off main thread
    ├── renderer.js                 # canvas drawing, camera/pan/zoom + tween, particle bursts,
    │                                 orbit rings/moons, selection/new-body/delete-fade visuals,
    │                                 hit-testing for click, hover, and right-click
    └── main.js                      # UI wiring, worker messaging, render loop, audio,
                                        galaxy<->system mode state machine, creation/context-menu/
                                        share-dialog UI, localStorage persistence, ?system= loading
```
