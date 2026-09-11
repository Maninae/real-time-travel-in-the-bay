/**
 * Modeled congestion profiles: the no-API-key traffic source.
 *
 * Every multiplier here is a hand-tuned model based on published measurements
 * (TomTom Traffic Index 2025 for SF, INRIX Global Traffic Scorecard 2024 for
 * Bay Area corridors), not a live probe. When a TomTom key lands in .env, the
 * TomTom provider replaces this with per-edge probe multipliers (see
 * docs/DATA_SOURCES.md).
 *
 * Two scenarios ship:
 *   - "midday": weekday Tue-Thu ~1 pm. Freeways near free-flow, SF surface
 *     streets bite because of signal density (intersection_penalties.ts adds
 *     that piece). This is the scenario where SF's per-mile time is roughly
 *     4-4.5x the Peninsula freeway corridor -- the ratio observed on the
 *     ground and consistent with the TomTom SF citywide average.
 *   - "friday": weekday Friday 5 pm peak. Freeways crawl (Bay Bridge 2.4x,
 *     I-80 Eastshore 2.2x, US-101 1.9x), SF surface streets slow further.
 *
 * Shape of each model:
 *   - Base multiplier per road class.
 *   - Corridor overrides for named chokepoints, matched on OSM ref/name.
 *   - Dense-SF-core surface bbox override, applied on top for local streets.
 *   A way takes the max of its class base, any corridor match, and any
 *   dense-SF-core override, then is capped at CONGESTION_MULTIPLIER_CAP.
 *
 * Sources:
 *   TomTom Traffic Index (2025), San Francisco: 12.6-14 mph average, ~50%
 *     congestion level, second-slowest US city.
 *     https://www.tomtom.com/traffic-index/city/san-francisco-ca/
 *   SF Examiner (Jan 15 2025) coverage of the TomTom index:
 *     https://www.sfexaminer.com/news/transit/sf-traffic-is-second-slowest-in-us-and-getting-worse/article_ebe26770-d45c-11ef-9a49-5fba319c395e.html
 *   Caltrans SR-80 / SF-Oakland Bay Bridge peak-period travel-time reports
 *     (10th District PeMS station 400001 & aggregated corridor summaries).
 */

import type { ScenarioKey } from "./scenarios.ts";

export interface TrafficWayInfo {
  cls: string;
  name?: string;
  ref?: string;
  /** Representative point (first vertex), used by bbox-scoped corridor overrides. */
  lat?: number;
  lon?: number;
}

/** Hard ceiling on any single-way multiplier -- guards against runaway compounding. */
export const CONGESTION_MULTIPLIER_CAP = 4.0;

/**
 * Base multipliers per road class, per scenario. Surface classes carry a
 * meaningful multiplier even at midday because SF's average speed is only
 * ~13-14 mph -- most of that stretch is intersection delay (added separately
 * in intersection_penalties.ts) plus a ~1.2-1.4x congestion-tax the signal
 * penalty alone cannot explain (double-parked cars, transit stops, unprotected
 * lefts, bike lane friction).
 *
 * TomTom levels:
 *   SF citywide congestion ~50% at typical peak (traffic-index/city/san-francisco-ca).
 *   Peninsula freeway peak congestion ~30-45% (segment reports in same index).
 *   Peninsula freeway midday congestion ~5-15%.
 */
const BASE_MULTIPLIER_BY_CLASS_AND_SCENARIO: Record<ScenarioKey, Record<string, number>> = {
  freeflow: {
    // Free flow keeps posted-limit speeds on every class; intersection
    // penalties (at 0.6x scale) already model the signal-cycle expectation
    // that never goes away.
    motorway: 1.0, motorway_link: 1.0,
    trunk: 1.0, trunk_link: 1.0,
    primary: 1.0, primary_link: 1.0,
    secondary: 1.0, secondary_link: 1.0,
    tertiary: 1.0, tertiary_link: 1.0,
    unclassified: 1.0, residential: 1.0,
  },
  midday: {
    // Freeways near free-flow: light congestion.
    motorway: 1.05, motorway_link: 1.05,
    trunk: 1.05, trunk_link: 1.05,
    // Surface streets around SF/Berkeley/Oakland cores are congested most of the day.
    primary: 1.25, primary_link: 1.2,
    secondary: 1.25, secondary_link: 1.2,
    tertiary: 1.2, tertiary_link: 1.15,
    unclassified: 1.2, residential: 1.2,
  },
  friday: {
    // Freeways crawl systemwide at 5 pm; corridors extend below.
    motorway: 1.6, motorway_link: 1.5,
    trunk: 1.5, trunk_link: 1.4,
    // Surface classes rebalanced upward. Old values (1.15 residential, 1.25
    // tertiary) inverted the SF-vs-freeway ratio -- moving the slider to
    // "Friday 5 pm" made SF *relatively less* stretched, the opposite of
    // reality. New values put surface classes ~1.4-1.55x, consistent with
    // TomTom's SF citywide congestion level (~50%) at rush hour.
    primary: 1.55, primary_link: 1.45,
    secondary: 1.5, secondary_link: 1.4,
    tertiary: 1.45, tertiary_link: 1.35,
    unclassified: 1.4, residential: 1.4,
  },
};

interface CorridorOverride {
  pattern: RegExp;
  /** Per-scenario multiplier. Missing entries fall back to the class base. */
  multiplierByScenario: Partial<Record<ScenarioKey, number>>;
  label: string;
  /** When set, the override only applies to ways whose representative point falls inside. */
  bbox?: { south: number; west: number; north: number; east: number };
}

/**
 * Chokepoint corridors. Patterns run against "ref name". The Bay Bridge is
 * matched by ref + bbox because its OSM ways are named "Route 80" and
 * "Dwight D. Eisenhower Highway", never "Bay Bridge". The Golden Gate Bridge
 * carries ref US 101, so the general US-101 multiplier below also touches it.
 *
 * Friday multipliers preserve the audit-validated v1 values -- reasonable for
 * an actual Friday 5 pm. Midday multipliers are light (1.1-1.3x) since the
 * chokepoints ARE lighter at midday, and freeflow multipliers stay at 1.0.
 */
const CORRIDOR_OVERRIDES: CorridorOverride[] = [
  {
    pattern: /\bI 80\b/,
    label: "SF-Oakland Bay Bridge",
    bbox: { south: 37.78, west: -122.41, north: 37.84, east: -122.28 },
    multiplierByScenario: { midday: 1.4, friday: 2.4 },
  },
  {
    pattern: /San Rafael Bridge/i,
    label: "Richmond-San Rafael Bridge",
    multiplierByScenario: { midday: 1.2, friday: 1.8 },
  },
  {
    pattern: /San Mateo.{0,3}Hayward Bridge|San Mateo Bridge/i,
    label: "San Mateo-Hayward Bridge",
    multiplierByScenario: { midday: 1.2, friday: 2.0 },
  },
  {
    pattern: /Dumbarton Bridge/i,
    label: "Dumbarton Bridge",
    multiplierByScenario: { midday: 1.2, friday: 1.9 },
  },
  {
    pattern: /\bI 80\b/,
    label: "I-80 Eastshore / MacArthur Maze",
    multiplierByScenario: { midday: 1.15, friday: 2.2 },
  },
  {
    pattern: /\bUS 101\b/,
    label: "US-101",
    multiplierByScenario: { midday: 1.1, friday: 1.9 },
  },
  {
    pattern: /\bI 880\b/,
    label: "I-880 Nimitz",
    multiplierByScenario: { midday: 1.15, friday: 1.9 },
  },
  {
    pattern: /\bI 238\b/,
    label: "I-238 connector",
    multiplierByScenario: { midday: 1.1, friday: 1.8 },
  },
  {
    pattern: /\bI 580\b/,
    label: "I-580",
    multiplierByScenario: { midday: 1.1, friday: 1.7 },
  },
  {
    pattern: /\bCA 24\b/,
    label: "CA-24 Caldecott approach",
    multiplierByScenario: { midday: 1.1, friday: 1.6 },
  },
  {
    pattern: /19th Avenue/i,
    label: "19th Ave (CA-1)",
    multiplierByScenario: { midday: 1.35, friday: 1.8 },
  },
  {
    pattern: /\bI 280\b/,
    label: "I-280",
    multiplierByScenario: { midday: 1.05, friday: 1.5 },
  },
];

/**
 * Dense-SF-core surface-street uplift. Applied on top of class-base for surface
 * classes whose representative point falls inside the SF-core bbox (roughly
 * Van Ness to the Embarcadero, Mission to North Beach). The neighborhoods here
 * -- SoMa, Chinatown, North Beach, Financial District -- have signal density,
 * curb-lane friction, unprotected-turn friction, and pedestrian volume that
 * ordinary residential blocks in the Sunset or Peninsula suburbia do not.
 *
 * The bbox is intentionally narrow (SF-core proper, ~4 km on a side) so it
 * does not flatten the SF-vs-suburbs contrast.
 */
const SF_CORE_BBOX = { south: 37.775, west: -122.44, north: 37.81, east: -122.395 };
const SF_CORE_SURFACE_CLASSES = new Set([
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "unclassified", "residential",
]);
const SF_CORE_UPLIFT_BY_SCENARIO: Partial<Record<ScenarioKey, number>> = {
  midday: 1.5,   // dense signal + curb-lane friction, tourism traffic
  friday: 1.6,   // same but with commuter compounding
};

function wayInsideBbox(way: TrafficWayInfo, bbox: NonNullable<CorridorOverride["bbox"]>): boolean {
  if (way.lat === undefined || way.lon === undefined) return false;
  return way.lat >= bbox.south && way.lat <= bbox.north && way.lon >= bbox.west && way.lon <= bbox.east;
}

/** Congestion multiplier for one way in one scenario (>= 1.0, capped). */
export function congestionMultiplier(way: TrafficWayInfo, scenario: ScenarioKey): number {
  const baseTable = BASE_MULTIPLIER_BY_CLASS_AND_SCENARIO[scenario];
  let multiplier = baseTable[way.cls] ?? 1.05;
  const matchText = `${way.ref ?? ""} ${way.name ?? ""}`;
  for (const corridor of CORRIDOR_OVERRIDES) {
    const corridorMultiplier = corridor.multiplierByScenario[scenario];
    if (corridorMultiplier === undefined) continue;
    if (corridorMultiplier <= multiplier) continue;
    if (corridor.bbox && !wayInsideBbox(way, corridor.bbox)) continue;
    if (corridor.pattern.test(matchText)) multiplier = corridorMultiplier;
  }
  const coreUplift = SF_CORE_UPLIFT_BY_SCENARIO[scenario];
  if (coreUplift !== undefined && SF_CORE_SURFACE_CLASSES.has(way.cls) && wayInsideBbox(way, SF_CORE_BBOX)) {
    if (coreUplift > multiplier) multiplier = coreUplift;
  }
  return Math.min(multiplier, CONGESTION_MULTIPLIER_CAP);
}

/**
 * Back-compat shim so callers that were pinned to the old two-scenario name
 * keep working; new callers should use `congestionMultiplier(way, scenario)`.
 */
export function fridayEveningMultiplier(way: TrafficWayInfo): number {
  return congestionMultiplier(way, "friday");
}
