/**
 * Per-edge travel seconds for a scenario: the one place edge weights are
 * computed, shared by the matrix stage and the trip-route extraction.
 *
 * A contracted edge runs junction-to-junction. Its travel time has three
 * components:
 *
 *   1. Driving time on the deck: `length / (mph * congestion_multiplier)`
 *      where the congestion multiplier is per-way + per-scenario (see
 *      modeled_profile.ts).
 *   2. Intersection / signal delay at the destination junction (see
 *      intersection_penalties.ts). A per-edge additive term is a
 *      per-intersection cost because contraction guarantees one junction
 *      per edge traversal. This is the OSRM `traffic_light_penalty`
 *      mechanism and is where SF's per-mile time comes from -- without it
 *      the router thinks SF surface streets do 20 mph free-flow (reality:
 *      12.6-14 mph per TomTom, 9 mph observed in North Beach).
 *   3. Bridge / toll-plaza / metering-light lump-sum delay for the five
 *      named Bay crossings (Bay Bridge, San Mateo, Dumbarton, Golden Gate,
 *      Richmond-San Rafael). Precomputed as a per-edge Float64Array with
 *      `per_edge = 2 * lumpSum / N` for each bridge's `N` matched deck
 *      edges, so a full crossing accumulates ~`lumpSum` seconds and a
 *      non-crossing edge gets zero.
 */

import { congestionMultiplier } from "./modeled_profile.ts";
import {
  buildBridgePenaltyEdgeSeconds,
  intersectionPenaltySeconds,
} from "./intersection_penalties.ts";

export type { ScenarioKey } from "./scenarios.ts";
import type { ScenarioKey } from "./scenarios.ts";

const MPH_TO_METERS_PER_SECOND = 0.44704;

export interface WeightableGraph {
  edgeLengthM: number[];
  edgeWay: number[];
  ways: { cls: string; mph: number; bridge: boolean; lat?: number; lon?: number; name?: string; ref?: string }[];
}

export function computeScenarioWeightsSeconds(
  graph: WeightableGraph,
  scenario: ScenarioKey,
): Float64Array {
  const weights = new Float64Array(graph.edgeLengthM.length);
  const bridgePenalty = buildBridgePenaltyEdgeSeconds(graph, scenario);
  for (let e = 0; e < weights.length; e++) {
    const way = graph.ways[graph.edgeWay[e]];
    const multiplier = congestionMultiplier(way, scenario);
    const speedMps = (way.mph * MPH_TO_METERS_PER_SECOND) / multiplier;
    const driveSeconds = graph.edgeLengthM[e] / speedMps;
    const signalSeconds = intersectionPenaltySeconds(way.cls, scenario);
    weights[e] = driveSeconds + signalSeconds + bridgePenalty[e];
  }
  return weights;
}
