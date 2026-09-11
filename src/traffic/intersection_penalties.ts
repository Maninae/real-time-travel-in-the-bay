/**
 * Per-intersection + per-turn delay model for contracted junction-to-junction
 * edges.
 *
 * Motivation. The v1 edge weight was purely `length / speed`, which means SF
 * routed at ~20 mph free-flow -- a fantasy: TomTom measures SF average speed
 * at 12.6-14 mph, and dense-neighborhood surface driving (North Beach,
 * Chinatown, SoMa) runs closer to 9 mph. The missing ingredient is
 * intersection / traffic-signal delay, which on a dense signalized grid is
 * most of the trip. This is the same lever OSRM exposes as
 * `traffic_light_penalty` plus per-turn penalties in its car profile.
 *
 * Mechanism. The graph builder collapses degree-2 chains, so an edge here runs
 * junction-to-junction: exactly one intersection sits at the destination end
 * of every edge traversal. So a per-edge additive penalty IS a per-intersection
 * penalty, and junction density is automatically encoded (dense grids = short
 * edges = more penalties per mile; freeways = long edges + tiny penalty per
 * ramp). No graph rewrite needed.
 *
 * Calibration. Per-class penalty seconds are tuned so the resulting SF-core
 * per-mile time matches TomTom's SF citywide average (12.6-14 mph) at free
 * flow and ~9 mph in dense neighborhoods at Friday 5 pm. See
 * scripts/validate_ground_truth.ts for the regression check that pins these
 * numbers against measured drives.
 *
 * Sources:
 *   TomTom Traffic Index (2025), San Francisco: 12.6-14 mph average, ~50%
 *     congestion level, ~29.7 min per 10 km city-center.
 *     https://www.tomtom.com/traffic-index/city/san-francisco-ca/
 *   OSRM `traffic_light_penalty` + turn penalties (v26.4.0 car profile).
 *     https://project-osrm.org/docs/v26.4.0/profiles
 *   OSRM issue #1318 discusses the per-intersection modeling approach.
 *     https://github.com/Project-OSRM/osrm-backend/issues/1318
 */

import type { ScenarioKey } from "./scenarios.ts";

/**
 * Seconds of intersection delay added per contracted-edge traversal, keyed by
 * OSM highway class of the edge's parent way. The number captures: signalized
 * intersection average wait + one-turn maneuver friction, blended.
 *
 * Freeways get 0 (no at-grade intersections). Ramps get a small merge cost.
 * Trunk/primary have signalized intersections but fewer of them per edge on
 * average because contracted-edge length runs longer on arterials than on
 * residential blocks. Residential/tertiary are the SF-grid workhorses: signal
 * every block, high stop-sign density, unprotected-turn friction.
 */
const INTERSECTION_PENALTY_SECONDS_BY_CLASS: Record<string, number> = {
  motorway: 0,
  motorway_link: 2,
  trunk: 3,
  trunk_link: 2,
  primary: 9,
  primary_link: 6,
  secondary: 8,
  secondary_link: 5,
  tertiary: 7,
  tertiary_link: 5,
  unclassified: 6,
  residential: 6,
};

const DEFAULT_INTERSECTION_PENALTY_SECONDS = 5;

/**
 * Scale on the per-class penalty at each scenario. Signals still cycle on
 * empty roads (60% of the peak wait is baseline red-light expectation), so
 * free flow keeps most of the penalty. Midday and Friday get the full penalty
 * (plus a small boost at Friday, where signal queues spill across cycles).
 */
const PENALTY_SCALE_BY_SCENARIO: Record<ScenarioKey, number> = {
  freeflow: 0.6,
  midday: 1.0,
  friday: 1.15,
};

/** Effective per-edge intersection penalty (seconds) for one scenario. */
export function intersectionPenaltySeconds(highwayClass: string, scenario: ScenarioKey): number {
  const base =
    INTERSECTION_PENALTY_SECONDS_BY_CLASS[highwayClass] ?? DEFAULT_INTERSECTION_PENALTY_SECONDS;
  return base * PENALTY_SCALE_BY_SCENARIO[scenario];
}

// ---------------------------------------------------------------------------
// Bridge / toll-plaza / metering-light lump-sum delays.
//
// A per-edge multiplier already stretches the on-bridge drive time (see the
// corridor overrides in modeled_profile.ts). What multipliers cannot model is
// the queue AT the bridge -- the WB Bay Bridge metering-light backup, the
// approach-lane merge -- which is a lump-sum delay that lives on the entrance,
// not the deck. We add it per-edge on the bridge deck and let it apply to
// every crossing that traverses one of the deck's contracted edges. Order of
// magnitude of a "typical" bridge:
//
//   * SF-Oakland Bay Bridge WB (into SF), Friday PM peak: 10-15 min metering
//     backup (511.org caltrans real-time traffic; Google Maps typical times).
//   * Golden Gate SB, Friday PM: 5-8 min at the toll gantry approach.
//   * Richmond-San Rafael WB: 5-10 min bridge queue.
//   * San Mateo, Dumbarton: smaller queues, ~3-6 min typical.
//
// At midday: 2-4 min typical bridge delay.
// At free flow: 0 (idealized empty roads).
//
// We express the delay as SECONDS per contracted-edge traversal, calibrated
// against a rough estimate of the number of contracted edges on each named
// bridge; the total per-crossing penalty ends up close to the measured
// backup even if the deck's segment count wobbles a bit.
// ---------------------------------------------------------------------------

interface BridgeDelayProfile {
  pattern: RegExp;
  label: string;
  /** Delay seconds per contracted edge on this bridge, per scenario. */
  perEdgeSecondsByScenario: Record<ScenarioKey, number>;
  /** If set, only ways whose representative point is inside this bbox match. */
  bbox?: { south: number; west: number; north: number; east: number };
}

/**
 * Named-bridge delay profiles. Patterns run against "ref name". The Bay
 * Bridge is name-less in OSM (its ways carry ref "I 80" plus corridor names
 * "Route 80" / "Dwight D. Eisenhower Highway"), so it needs a bbox gate to
 * distinguish it from the rest of I-80.
 */
const BRIDGE_DELAY_PROFILES: BridgeDelayProfile[] = [
  {
    pattern: /\bI 80\b/,
    label: "SF-Oakland Bay Bridge",
    bbox: { south: 37.78, west: -122.41, north: 37.84, east: -122.28 },
    perEdgeSecondsByScenario: { freeflow: 0, midday: 30, friday: 90 },
  },
  {
    pattern: /Golden Gate Bridge/i,
    label: "Golden Gate Bridge",
    perEdgeSecondsByScenario: { freeflow: 0, midday: 20, friday: 60 },
  },
  {
    pattern: /San Rafael Bridge|Richmond.{0,3}San Rafael/i,
    label: "Richmond-San Rafael Bridge",
    perEdgeSecondsByScenario: { freeflow: 0, midday: 20, friday: 60 },
  },
  {
    pattern: /San Mateo.{0,3}Hayward Bridge|San Mateo Bridge/i,
    label: "San Mateo-Hayward Bridge",
    perEdgeSecondsByScenario: { freeflow: 0, midday: 15, friday: 45 },
  },
  {
    pattern: /Dumbarton Bridge/i,
    label: "Dumbarton Bridge",
    perEdgeSecondsByScenario: { freeflow: 0, midday: 15, friday: 40 },
  },
];

export interface BridgeMatchInfo {
  name?: string;
  ref?: string;
  lat?: number;
  lon?: number;
}

function wayInsideBbox(
  way: BridgeMatchInfo,
  bbox: NonNullable<BridgeDelayProfile["bbox"]>,
): boolean {
  if (way.lat === undefined || way.lon === undefined) return false;
  return way.lat >= bbox.south && way.lat <= bbox.north && way.lon >= bbox.west && way.lon <= bbox.east;
}

/**
 * Additive per-edge bridge/toll delay (seconds) for a way in a scenario.
 * Zero for ways that are not one of the named crossings above.
 */
export function bridgeCrossingPenaltySeconds(way: BridgeMatchInfo, scenario: ScenarioKey): number {
  const matchText = `${way.ref ?? ""} ${way.name ?? ""}`;
  for (const profile of BRIDGE_DELAY_PROFILES) {
    if (profile.bbox && !wayInsideBbox(way, profile.bbox)) continue;
    if (profile.pattern.test(matchText)) {
      return profile.perEdgeSecondsByScenario[scenario];
    }
  }
  return 0;
}
