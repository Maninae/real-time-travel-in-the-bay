# real-time-travel-in-the-bay

A time-space cartogram of the SF Bay Area: the map redrawn so pairwise distances match travel times. TypeScript pipeline, static viewer on GitHub Pages.

## Locked decisions

- **Language**: TypeScript end to end, run via `npx tsx`. Algorithms (Dijkstra, MDS, SMACOF, Procrustes) are hand-rolled with typed arrays; no runtime dependencies, devDeps only.
- **v1 region scope**: SF + Peninsula down to Palo Alto + East Bay from Richmond to Hayward + southern Marin to San Rafael (the bbox rectangle includes it, and it makes the Golden Gate and Richmond bridges meaningful instead of dead ends). Grid stays near 1,000 anchors because the all-pairs matrix grows as N².
- **v1 traffic**: modeled congestion profiles (no API key). The TomTom provider activates when a key lands in `.env`. Transit waits for a 511.org key.

## Architecture

Pipeline stages under `scripts/`, numbered in execution order, each writing JSON to `data/` for the next stage (`npm run pipeline` runs them all). Core algorithms live in `src/` as pure modules the scripts orchestrate. The viewer in `docs/` is a static page consuming one bundled JSON, served by GitHub Pages.

1. Street network via tiled Overpass queries (mirror rotation + retry), cached raw in `data/cache/` (gitignored)
2. Graph build: junction detection, degree-2 chain contraction into weighted edges, largest strongly connected component
3. Hex anchor grid; a lattice point survives only if a graph junction sits within 500 m (no water polygons needed: the bay has no roads, so road proximity IS the land mask)
4. All-pairs anchor times: early-exit binary-heap Dijkstra per anchor per scenario, symmetrized by averaging A to B with B to A
5. Embedding: classical MDS init, SMACOF refinement, Procrustes alignment back to geographic orientation, per-anchor stress
6. Viewer bundle to `docs/data/bundle.json`: anchors, per-mode time-space layouts, simplified secondary-and-up street geometry, sample trips with routed paths (the browser computes vertex warp weights itself at load)

## Data sources

`docs/DATA_SOURCES.md` is the authoritative research: OSM/Overpass, TomTom free-tier limits, Caltrans PeMS, 511.org GTFS, what is legally off-limits (Google as base data), and dead ends. Read it before proposing any data acquisition.

## Constraints

- API keys (TomTom, 511.org) live in `.env`, never committed.
- Google Routes API results must never be stored or used as base data (ToS forbids derived datasets); spot-check validation only.
- The viewer must be a static site (GitHub Pages), no server.
- OSM data requires "© OpenStreetMap contributors" attribution in the viewer.
- Bulk downloads and generated matrices are regenerable and stay out of git (`data/cache/`); anything over ~1 GB belongs on `/Volumes/vega`.
