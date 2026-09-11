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
 *   3. Bridge / toll-plaza / metering-light additive delay for the named
 *      Bay crossings (Bay Bridge, San Mateo, Dumbarton, Golden Gate,
 *      Richmond-San Rafael). See intersection_penalties.ts.
 */

import { congestionMultiplier } from "./modeled_profile.ts";
import { bridgeCrossingPenaltySeconds, intersectionPenaltySeconds } from "./intersection_penalties.ts";

export type { ScenarioKey } from "./scenarios.ts";
import type { ScenarioKey } from "./scenarios.ts";

const MPH_TO_METERS_PER_SECOND = 0.44704;

export interface WeightableGraph {
  edgeLengthM: number[];
  edgeWay: number[];
  ways: { cls: string; mph: number; lat?: number; lon?: number; name?: string; ref?: string }[];
}

export function computeScenarioWeightsSeconds(
  graph: WeightableGraph,
  scenario: ScenarioKey,
): Float64Array {
  const weights = new Float64Array(graph.edgeLengthM.length);
  for (let e = 0; e < weights.length; e++) {
    const way = graph.ways[graph.edgeWay[e]];
    const multiplier = congestionMultiplier(way, scenario);
    const speedMps = (way.mph * MPH_TO_METERS_PER_SECOND) / multiplier;
    const driveSeconds = graph.edgeLengthM[e] / speedMps;
    const signalSeconds = intersectionPenaltySeconds(way.cls, scenario);
    const bridgeSeconds = bridgeCrossingPenaltySeconds(way, scenario);
    weights[e] = driveSeconds + signalSeconds + bridgeSeconds;
  }
  return weights;
}
