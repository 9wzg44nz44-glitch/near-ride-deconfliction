# NEAR Route & Start Time Deconfliction Estimator

**Northeast Adventure Riders (NEAR)**: a static web tool that simulates dual-sport ride groups on GPX routes, predicts when groups will meet, overtake or cross (and on what terrain), and suggests start-time staggers that avoid it.

**Live site:** https://9wzg44nz44-glitch.github.io/near-ride-deconfliction/

Created by Dan Britton with Grok Bot (AI assistant). Contact: BrittonSolutions@icloud.com.
This project is separate from, and unrelated to, Dan's physics experiments.

> **Estimates only.** Not a safety system. Obey posted limits and stop signs. Class VI roads are used at your own risk; verify legal status and seasonal closures. See `docs/about.html` for the model and its limits.

## What it does

- Two bundled routes: **SBH Monadnock** and **MBH Monadnock** (New Hampshire). More routes can be added (see below).
- Set riders per route (0 = not riding), departure time (7:00 AM to 3:00 PM local Eastern clock time, 1 minute or 15 second resolution), skill (intermediate or fast), direction, plus an optional solo **observer rider**.
- Default scenario: SBH 18 riders at 9:00 AM, MBH 7 riders at 9:30 AM.
- Terrain per route stretch (paved, maintained dirt, Class VI) from OpenStreetMap, with confidence levels and an in-browser **terrain editor** (edits stored in localStorage, exportable and importable as JSON).
- Speed model from the riders' own figures: Class VI 16 mph (intermediate) or 23.5 mph (fast); posted limit +7.5 mph (adjustable 5 to 10) on maintained roads; stop signs obeyed; accelerations, braking, cornering limits; column spacing by time gap (2 s, 4.5 s on Class VI); regroup stops at gas/food waypoints.
- Encounter detection by map distance (default 30 m, adjustable 15 to 100 m), classified as same direction (overtaking or catching up), opposite direction, or crossing/merge, with terrain, duration, riders involved and severity.
- Animated Leaflet map with time slider, play/pause, 1x/10x/60x/300x/900x speed, Eastern clock, flashing ring and banner at encounters, optional beep, timeline ticks.
- **Start-time optimizer** (top 3 schedules with before/after counts), **Monte Carlo leader briefing** (probability and time window per encounter, Markdown copy and print).
- **Question card**: "Is SBH overtaking MBH on a Class VI section between 10 and 11 AM?" answered from the model.
- Client-side **GPX import** for extra routes.

## Run it

No build step and no API keys. The site is plain static files in `docs/`.

```bash
npm run serve        # http://localhost:8080/  (any static server works, e.g. python3 -m http.server -d docs)
npm test             # node:test unit tests for the simulator
```

GitHub Pages publishes `docs/` from the `main` branch.

## How the data was built

```bash
npm run build:routes   # GPX (raw/) -> simplified geometry + waypoints (data/routes-geom.json)
npm run fetch:osm      # Overpass API -> data/osm-cache/ (ways with tags, stop/yield/signal nodes); no key needed
npm run build:terrain  # map-match, classify, smooth -> docs/data/routes.json
```

1. `scripts/build-routes.mjs` parses the GPX files, keeps the longest track segment (BBH-style stub tracks are dropped), simplifies with Douglas-Peucker at 2.5 m, and attaches each waypoint to the nearest track point.
2. `scripts/fetch-osm.mjs` downloads, tile by tile, every `highway` way (except footways, steps, cycleways) and every stop, give-way, signal and level-crossing node near the routes. Mirrors are tried in turn. Results are cached in `data/osm-cache/` so the next step is reproducible offline.
3. `scripts/classify.mjs` samples each route every 10 m, matches to the nearest way within 30 m (direction aware, with a continuity bonus), classifies each way from its tags, applies waypoint hints, fills gaps, merges stretches shorter than 80 m, and extracts `maxspeed`, stop signs (only for the direction facing the sign), signals and inferred junction stops. It writes `docs/data/routes.json` with a confidence on every stretch.

To add a route permanently: put the GPX in `raw/`, add it to the list in `scripts/build-routes.mjs`, run the three commands above.

### Terrain rules

| Class | Rules (first match wins) |
|---|---|
| Class VI | Tags/name mention Class VI, unmaintained, jeep or legal trail; `maintenance=no`; `highway=path/bridleway/track` (unless paved, or tracktype grade 1 or 2); unpaved road with rough tags (grade 3 to 5, bad smoothness, ground/mud); unnamed unpaved road with no speed limit; plus waypoint hints ("Jeep Trail", "Class VI", "gate", "cellar hole") on nearby unpaved road. |
| Maintained dirt | Unpaved residential/unclassified/service/tertiary road with `maxspeed` or tracktype grade 1 or 2, or a named road; track grade 1 or 2. |
| Paved | Paved surface tags, or primary/secondary/tertiary/residential with no surface tag; unclassified/service with no surface tag is assumed paved at low confidence. |

Default posted limits when OSM has no `maxspeed`: paved 35 mph, maintained dirt 25 mph. Class VI has none.

### Terrain breakdown of the bundled routes (OSM snapshot 2026-10-04)

| Route | Miles | Paved | Maint. dirt | Class VI | Confidence high / med / low (%) | `maxspeed` tagged | Mapped stops / inferred / signals |
|---|---|---|---|---|---|---|---|
| SBH Monadnock | 120.3 | 59.7 mi (49.6%) | 24.9 mi (20.7%) | 35.7 mi (29.7%) | 38.8 / 56.7 / 4.6 | 21.8% | 4 / 48 / 1 |
| MBH Monadnock | 107.9 | 52.7 mi (48.9%) | 24.4 mi (22.6%) | 30.7 mi (28.5%) | 37.4 / 58.3 / 4.3 | 21.1% | 6 / 36 / 1 |

Only about 2 to 3 percent of route length is Class VI with high confidence (explicit tags); most Class VI is `highway=track` with no grade, classified at medium confidence. Review it with the terrain editor.

## Repository layout

```
docs/                 the website (GitHub Pages root)
  index.html          simulator
  about.html          method, data, limits
  js/sim.js           simulator core (browser, Web Worker and Node)
  js/app.js           UI;  js/worker.js optimizer and Monte Carlo worker;  js/gpx.js client GPX import
  data/routes.json    processed routes, terrain, stops, waypoints
  vendor/leaflet/     Leaflet 1.9.4 (self-hosted)
raw/                  source GPX files
data/                 intermediate geometry and cached OSM downloads
scripts/              build pipeline and a tiny static server
tests/                node:test tests
```

## Tests

`npm test` runs `tests/sim.test.mjs`: terrain speed values (paved, dirt, posted limit, Class VI intermediate and fast), column growth, stop sign delay, a faster group overtaking a slower one on Class VI, no encounter with a large stagger, head-on meeting, crossing, terrain override, optimizer, Monte Carlo and a run on the real data.

## Data, license and attribution

- Code: MIT (see `LICENSE`).
- Map data and derived terrain data: (c) OpenStreetMap contributors, ODbL 1.0. `docs/data/routes.json` and `data/osm-cache/` are derived from OpenStreetMap and carry the same license.
- Leaflet: BSD 2-Clause, (c) Vladimir Agafonkin.
- Map tiles are loaded from the OpenStreetMap tile servers by the visitor's browser.
- The GPX files are the riders' own routes.

## Limitations

Estimates from a simplified model; not calibrated against recorded rides. Real rides include photo stops, mud, wrong turns, breakdowns and weather. OSM classification and stop signs are incomplete. Groups are modeled as one column. See `docs/about.html`.
