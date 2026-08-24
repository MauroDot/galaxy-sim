# Galaxy N-Body Simulator

A 2D galaxy-scale N-body gravity simulator running entirely in the browser:
vanilla JS, no frameworks, no build step.

- **Barnes-Hut quadtree** ([src/quadtree.js](src/quadtree.js)) for O(n log n) gravity instead of the naive O(n²) all-pairs sum.
- **Physics runs in a Web Worker** ([src/physics-worker.js](src/physics-worker.js)) at a fixed 60 Hz tick, symplectic (semi-implicit) Euler integration, so the main thread stays free for rendering. The worker also ages every star each step and triggers supernovae.
- **Stellar diversity** ([src/star-types.js](src/star-types.js)): seven spectral types (O/B/A/F/G/K/M), each with a realistic relative frequency (mostly M dwarfs, ~1% O giants), mass, radius and main-sequence lifetime. Shared between the worker (generation, aging) and the main thread (color, info panel) so there's one source of truth.
- **Procedural spiral galaxy generator** ([src/galaxy.js](src/galaxy.js)), seeded (mulberry32 PRNG) — same seed always produces the same galaxy. A central mass anchors a disk of spectral-typed stars laid out along logarithmic spiral arms, given near-circular initial velocities from an enclosed-mass approximation. Each star also gets a randomized starting age so a fresh galaxy isn't perfectly coeval - deaths stagger naturally instead of arriving in one synchronized burst.
- **Supernovae**: when a star's age reaches its lifetime, the worker removes it from the simulation (stops integrating/inserting it into the quadtree) and broadcasts a one-off event. The main thread reacts with a gravity-free particle burst (100-200 particles, world-space, fade out over 0.5s), a short 440 Hz Web Audio beep, and a running "Supernovae" counter. Calibrated to ~1-2 events/minute in a 500-star galaxy at 1x speed (dominated by the short-lived O/B stars - realistic, since G/K/M lifetimes run into the billions of years and essentially never complete during a play session).
- **Canvas 2D renderer** ([src/renderer.js](src/renderer.js)) with pan (drag) and zoom (scroll wheel), decoupled from the physics tick rate so rendering stays smooth even if physics lags. Stars render in their spectral-type color at a size derived from their radius; click a star (a small in-place click, not a drag) to select it.
- **UI controls** ([src/main.js](src/main.js)): play/pause, speed (0-20x), seed, star count, "new galaxy" (random seed), reset, live FPS / physics-Hz / star-count / supernova-count stats, a spectral-type color legend, and an info panel (type, mass, age, lifetime, "Supernova!" flash) for the selected star.

Tested at 500 stars: ~1.2 ms/physics-step (~0.25 ms/galaxy generation), steady
60 FPS render and ~60 Hz physics at 1x on the sample hardware, with headroom
to spare (scales to well over 1000 stars before dropping frames). Physics tick
rate and step cost are unaffected by stellar diversity/aging - both are O(n)
additions to the existing per-step loops.

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
| Click a star | show its type/mass/age/lifetime in the info panel |
| Space | toggle play/pause |

To watch a supernova, push the speed slider to 10x+ and wait 20-30s (or
click New Galaxy a few times - some galaxies roll an O-star close to death
at spawn and one goes within seconds).

## File structure

```
galaxy-sim/
├── index.html          # page shell, canvas, UI panel, info panel
├── style.css            # dark theme, UI/info panel styling
└── src/
    ├── quadtree.js       # Barnes-Hut quadtree (force calc)
    ├── star-types.js      # spectral-type table (O/B/A/F/G/K/M): mass, radius, color, lifetime
    ├── galaxy.js           # seeded procedural galaxy generation
    ├── physics-worker.js    # simulation loop: gravity, aging, supernova detection - runs off main thread
    ├── renderer.js            # canvas drawing, camera/pan/zoom, supernova particle bursts
    └── main.js                 # UI wiring, worker messaging, render loop, audio, star selection
```
