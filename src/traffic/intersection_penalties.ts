/**
 * Per-intersection + per-turn delay model for contracted junction-to-junction
 * edges, plus per-crossing lump-sum delay for the five named Bay bridges.
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
// Bridge / toll-plaza / metering-light lump-sum delay per crossing.
//
// A per-edge class multiplier already stretches the on-bridge drive time (see
// the corridor overrides in modeled_profile.ts). What multipliers cannot model
// is the queue AT the bridge: the WB Bay Bridge metering-light backup, the
// Golden Gate southbound-toll gantry approach, the Richmond-San Rafael tie-up.
// Those are lump sums, not proportional to deck length.
//
// The mechanism:
//
//   1. Each bridge is identified by a TIGHT bbox around the actual deck (not
//      approaches) plus the OSM `bridge:true` tag on the way, and optionally
//      a `ref` filter. This avoids two v1 bugs the audit caught: (a) the loose
//      Bay-Bridge bbox that leaked onto ~9 miles of I-80 approach and East
//      Bay non-crossing trips, and (b) the name-regex matcher missing bridges
//      whose OSM deck ways are unnamed (Golden Gate, Dumbarton, San Mateo).
//
//   2. At weight-computation time we build a per-scenario Float64Array of
//      per-edge additive seconds. For each bridge we count the matched deck
//      edges N and set per-edge = 2 * lumpSum / N. A full crossing traverses
//      one direction's edges (~N/2), so total added time per crossing lands
//      at `lumpSum`. Non-crossing trips traverse zero deck edges and pay zero.
//
// Real-world calibration (Google Maps typical times, primary-source cited in
// each bridge entry below):

interface BridgeCrossing {
  key: string;
  label: string;
  /**
   * Deck matcher. An edge is a "deck edge" of this bridge iff its parent way
   * has bridge:true AND (a) its representative point falls inside `bbox`,
   * AND (b) either the way's `name` matches `nameMatch` when set, or the
   * way's `ref` matches `refFilter` when set (bbox alone is used if both
   * are null). Four of the five Bay crossings have unique names on their
   * deck ways (Golden Gate Bridge, Richmond-San Rafael Bridge, San Mateo -
   * Hayward Bridge, Dumbarton Bridge). Only the SF-Oakland Bay Bridge is
   * name-less in OSM (deck ways are "Route 80" / "Dwight D. Eisenhower
   * Highway"), so it uses bbox + I-80 ref.
   */
  bbox: { south: number; west: number; north: number; east: number };
  nameMatch?: RegExp;
  refFilter?: RegExp;
  /** Total additive seconds per crossing, per scenario. Free-flow is always 0. */
  lumpSumSecondsByScenario: Record<ScenarioKey, number>;
  /** Source note that ends up in the code so calibration is auditable. */
  source: string;
}

const BRIDGE_CROSSINGS: BridgeCrossing[] = [
  {
    key: "bay",
    label: "SF-Oakland Bay Bridge",
    // Tight deck: SF landing (Fremont/Rincon) to Oakland landing (Bay Bridge
    // toll plaza). YBI tunnel included. Excludes MacArthur Maze / I-80
    // through-corridor and downtown-SF I-80 approach.
    bbox: { south: 37.788, west: -122.395, north: 37.826, east: -122.298 },
    refFilter: /\bI 80\b/,
    // Peak WB PM metering + queue routinely runs 10-15 min at 5 pm; midday
    // adds ~3-5 min for the toll plaza approach; free-flow is negligible.
    lumpSumSecondsByScenario: { freeflow: 0, midday: 240, friday: 900 },
    source: "Google Maps typical times WB SF-Oakland Bay Bridge PM peak (10-15 min queue); MTC bridge congestion reports.",
  },
  {
    key: "goldenGate",
    label: "Golden Gate Bridge",
    // Wide enough to admit the whole named deck (Presidio to Vista Point).
    bbox: { south: 37.800, west: -122.485, north: 37.835, east: -122.470 },
    nameMatch: /Golden Gate Bridge/i,
    lumpSumSecondsByScenario: { freeflow: 0, midday: 120, friday: 360 },
    source: "Google Maps typical times SB Golden Gate PM peak (5-8 min); GGB district travel-time reports.",
  },
  {
    key: "richmondSanRafael",
    label: "Richmond-San Rafael Bridge",
    bbox: { south: 37.925, west: -122.505, north: 37.945, east: -122.395 },
    nameMatch: /Richmond.{0,4}San Rafael Bridge/i,
    lumpSumSecondsByScenario: { freeflow: 0, midday: 120, friday: 360 },
    source: "Google Maps typical times WB Richmond-San Rafael PM peak (5-10 min queue).",
  },
  {
    key: "sanMateoHayward",
    label: "San Mateo-Hayward Bridge",
    // Widen south to 37.570 so both direction edges (37.5729 WB, 37.6169 EB)
    // are inside; earlier 37.583 excluded WB and delivered only half the
    // intended crossing delay.
    bbox: { south: 37.570, west: -122.267, north: 37.640, east: -122.118 },
    nameMatch: /San Mateo.{0,4}Hayward Bridge/i,
    lumpSumSecondsByScenario: { freeflow: 0, midday: 120, friday: 240 },
    source: "Google Maps typical times CA-92 San Mateo Bridge EB PM peak (~4 min added).",
  },
  {
    key: "dumbarton",
    label: "Dumbarton Bridge",
    // Widen south to 37.495 so the westernmost direction edge (37.4979) is
    // inside.
    bbox: { south: 37.495, west: -122.150, north: 37.517, east: -122.083 },
    nameMatch: /Dumbarton Bridge/i,
    lumpSumSecondsByScenario: { freeflow: 0, midday: 120, friday: 300 },
    source: "Google Maps typical times CA-84 Dumbarton EB PM peak (~5 min added).",
  },
];

export interface BridgeEdgeGraph {
  edgeWay: number[];
  ways: { cls: string; bridge: boolean; lat?: number; lon?: number; name?: string; ref?: string }[];
}

function wayInsideBridgeBbox(
  lat: number | undefined,
  lon: number | undefined,
  bbox: BridgeCrossing["bbox"],
): boolean {
  if (lat === undefined || lon === undefined) return false;
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

/**
 * Precompute per-edge additive bridge/toll-plaza delay (seconds) for one
 * scenario. For each named bridge we count the deck edges N in the extract
 * and set per-edge = 2 * lumpSum / N, so a full crossing (one direction,
 * ~N/2 edges) accumulates ~lumpSum seconds total, independent of how the
 * graph builder chose to contract the deck. Non-crossing edges get 0.
 *
 * Returns a Float64Array parallel to graph.edgeWay.
 */
function edgeMatchesBridge(
  way: BridgeEdgeGraph["ways"][number],
  bridge: BridgeCrossing,
): boolean {
  if (!way.bridge) return false;
  if (!wayInsideBridgeBbox(way.lat, way.lon, bridge.bbox)) return false;
  if (bridge.nameMatch) {
    if (!way.name || !bridge.nameMatch.test(way.name)) return false;
  } else if (bridge.refFilter) {
    if (!way.ref || !bridge.refFilter.test(way.ref)) return false;
  }
  return true;
}

export function buildBridgePenaltyEdgeSeconds(
  graph: BridgeEdgeGraph,
  scenario: ScenarioKey,
): Float64Array {
  const perEdge = new Float64Array(graph.edgeWay.length);

  for (const bridge of BRIDGE_CROSSINGS) {
    const lumpSum = bridge.lumpSumSecondsByScenario[scenario];
    if (lumpSum <= 0) continue;

    // Pass 1: enumerate the matched deck edges.
    const matchedEdges: number[] = [];
    for (let e = 0; e < graph.edgeWay.length; e++) {
      if (edgeMatchesBridge(graph.ways[graph.edgeWay[e]], bridge)) matchedEdges.push(e);
    }
    if (matchedEdges.length === 0) continue;

    // Pass 2: apply the normalized per-edge penalty. Factor of 2 because a
    // one-direction crossing traverses ~half the total (bidirectional) edges;
    // for oneway=1 divided-highway bridges the two carriageways still each
    // supply their own set of edges to `matchedEdges`, so this still holds.
    const perEdgeSeconds = (2 * lumpSum) / matchedEdges.length;
    for (const e of matchedEdges) perEdge[e] += perEdgeSeconds;
  }

  return perEdge;
}

/**
 * Diagnostic helper: returns per-bridge match counts + per-crossing delivered
 * delay for auditing. Not on the hot path; called from scripts and validation.
 */
export function describeBridgeMatches(
  graph: BridgeEdgeGraph,
  scenario: ScenarioKey = "friday",
): Array<{
  key: string;
  label: string;
  matchedEdges: number;
  perCrossingSeconds: number;
  intendedLumpSumSeconds: number;
  source: string;
}> {
  const out = [];
  for (const bridge of BRIDGE_CROSSINGS) {
    let count = 0;
    for (let e = 0; e < graph.edgeWay.length; e++) {
      if (edgeMatchesBridge(graph.ways[graph.edgeWay[e]], bridge)) count++;
    }
    const lumpSum = bridge.lumpSumSecondsByScenario[scenario];
    out.push({
      key: bridge.key,
      label: bridge.label,
      matchedEdges: count,
      // Under the 2*lumpSum/N formula, a one-direction crossing traverses N/2
      // edges and thus accumulates exactly lumpSum. Left here explicitly for
      // audit clarity when diagnosing miscalibrations.
      perCrossingSeconds: count > 0 ? lumpSum : 0,
      intendedLumpSumSeconds: lumpSum,
      source: bridge.source,
    });
  }
  return out;
}
