# Real-time travel in the bay

**The Bay Area redrawn so that distance means travel time.**

<p align="center">
  <img src="https://img.shields.io/badge/status-live-brightgreen" alt="Status: live">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT">
</p>

**[Live map](https://maninae.github.io/real-time-travel-in-the-bay/)** | **[Data sources](docs/DATA_SOURCES.md)**

---

The cortical homunculus draws the human body the way the brain feels it: huge hands, huge lips, a tiny torso. This map draws the Bay Area the way a driver feels it. The two miles across a bridge swell into a long haul, and the ten freeway miles down 280 shrink to almost nothing. Everyone who lives here knows the Bay's signature move: a crossing you could kayak in 20 minutes takes 45 by car at 5pm.

Drag the slider and the map morphs from familiar geography to a layout where every pair of points sits as far apart as the drive between them takes, computed from the real street network. Ferry Building to Palo Alto is 34.3 miles; at posted limits it plays like 37.5 minutes, on a modeled Friday at 5pm it plays like 64.5.

| Geography (day theme) | Travel time, Friday 5 pm (night theme) |
|---|---|
| ![The Bay Area drawn geographically as a printed day atlas, persimmon freeways on paper](assets/preview__desktop__geography.jpg) | ![The same map at night, warped so distances match Friday-evening travel times](assets/preview__desktop__t1-friday.jpg) |

## How it works

You don't need to buy an origin-destination travel-time dataset. Travel times come from routing over the free OpenStreetMap street network; external data is only needed for congestion and transit schedules.

1. **Sample the region.** A hexagonal lattice at 1.5 km spacing, keeping only points with a road junction within 500 m. The bay has no roads, so road proximity is the land mask: 908 anchors survive.
2. **Build the street graph.** 96k drivable OSM ways become 111k junction nodes and 248k directed edges after degree-2 chain contraction; only the largest strongly connected component survives.
3. **Route everything.** Early-exit binary-heap Dijkstra from every anchor: 411,778 pairs per scenario, symmetrized, in about 8 seconds per scenario.
4. **Add traffic.** v1 ships a modeled Friday-5pm profile: per-class multipliers plus corridor overrides for the famous chokepoints (Bay Bridge 2.4x, I-80 Eastshore 2.2x, US-101 1.9x). Clearly labeled as modeled; measured TomTom data slots in when an API key lands.
5. **Embed.** Classical MDS initializes, SMACOF stress majorization refines, orthogonal Procrustes rotates the result back onto geographic north. Kruskal stress-1: 0.099 at speed limits, 0.085 on Friday.
6. **Morph.** The viewer precomputes a warp field (6 nearest anchors per street vertex, inverse-square weights) and interpolates every road between its geographic and time-space position at 60fps.

Some travel-time sets cannot be drawn on a flat page at all: two neighborhoods equidistant from a bridge cannot both keep their measured times. The x-ray view shows per-anchor stress, where the map had to bend to fit the page.

## Run it yourself

```bash
npm install
npm run pipeline   # fetch -> graph -> grid -> route -> embed -> bundle
```

The first run fetches OSM data from Overpass (tiled, cached, ~10 minutes); everything after is local and takes about a minute. Serve `docs/` for the viewer.

## Where the data comes from

| Source | Provides | Cost |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org) (Overpass) | Streets, speed limits, one-way rules | Free (ODbL) |
| Modeled congestion profile | v1 Friday-5pm multipliers | Built in |
| [TomTom Traffic API](https://developer.tomtom.com/traffic-api/documentation/traffic-flow/flow-segment-data) | Measured per-segment congestion (planned) | Free tier |
| [Caltrans PeMS](https://pems.dot.ca.gov) | Measured freeway speeds for calibration (planned) | Free account |
| [511.org Open Data](https://511.org/open-data/transit) | Regional GTFS for the transit mode (planned) | Free API key |

The full research, including what's dead (RIP Uber Movement) and what's legally off-limits for derived maps, lives in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Status

- [x] Six-stage TypeScript pipeline, no runtime dependencies
- [x] Live viewer: morph slider, two scenarios, x-ray stress view, sample trips
- [ ] Measured traffic via TomTom free tier (needs API key)
- [ ] PeMS calibration of freeway multipliers
- [ ] Transit mode from 511.org GTFS + RAPTOR routing

## Credits

Street data © OpenStreetMap contributors. The derived dataset `docs/data/bundle.json` remains under the [ODbL](https://opendatacommons.org/licenses/odbl/); the code is MIT.

## License

[MIT](LICENSE)
