/**
 * Stage 4: all-pairs anchor travel times, one matrix per scenario.
 *
 * Per scenario, per-edge seconds = length / (freeflow mph / congestion mult),
 * then one early-exit Dijkstra per anchor. A->B and B->A differ (one-ways,
 * asymmetric congestion), and a distance matrix for embedding must be
 * symmetric, so the two directions are averaged.
 *
 * Input:  data/graph.json, data/anchors.json
 * Output: data/times__freeflow.json, data/times__friday.json
 *   { n, minutes: flat row-major n*n, rounded to 0.1 }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildWeightedCsr, dijkstraSeconds } from "../src/graph/dijkstra.ts";
import { computeScenarioWeightsSeconds } from "../src/traffic/scenario_weights.ts";
import { SCENARIO_KEYS } from "../src/traffic/scenarios.ts";

interface GraphFile {
  nodeLat: number[]; nodeLon: number[];
  edgeFrom: number[]; edgeTo: number[]; edgeLengthM: number[]; edgeWay: number[];
  ways: { cls: string; mph: number; bridge: boolean; lat: number; lon: number; name?: string; ref?: string }[];
}

function main(): void {
  const graph = JSON.parse(readFileSync("data/graph.json", "utf8")) as GraphFile;
  const { anchors } = JSON.parse(readFileSync("data/anchors.json", "utf8")) as {
    anchors: { lat: number; lon: number; node: number }[];
  };
  const nodeCount = graph.nodeLat.length;
  const anchorNodes = Int32Array.from(anchors.map((a) => a.node));
  const edgeFrom = Int32Array.from(graph.edgeFrom);
  const edgeTo = Int32Array.from(graph.edgeTo);

  for (const scenarioKey of SCENARIO_KEYS) {
    const weights = computeScenarioWeightsSeconds(graph, scenarioKey);
    const csr = buildWeightedCsr(nodeCount, edgeFrom, edgeTo, weights);

    const n = anchors.length;
    const minutes = new Float64Array(n * n);
    const startedAt = Date.now();
    for (let i = 0; i < n; i++) {
      const dist = dijkstraSeconds(csr, nodeCount, anchorNodes[i], { earlyExitTargets: anchorNodes });
      for (let j = 0; j < n; j++) minutes[i * n + j] = dist[anchorNodes[j]] / 60;
      if ((i + 1) % 200 === 0) {
        console.log(`  ${scenarioKey}: ${i + 1}/${n} sources (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`);
      }
    }

    // Symmetrize and sanity-check reachability.
    let unreachablePairs = 0;
    let maxMinutes = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const avg = (minutes[i * n + j] + minutes[j * n + i]) / 2;
        if (!Number.isFinite(avg)) unreachablePairs++;
        const rounded = Math.round(avg * 10) / 10;
        minutes[i * n + j] = rounded;
        minutes[j * n + i] = rounded;
        if (rounded > maxMinutes) maxMinutes = rounded;
      }
      minutes[i * n + i] = 0;
    }
    if (unreachablePairs > 0) {
      throw new Error(`${scenarioKey}: ${unreachablePairs} unreachable anchor pairs; SCC filtering should have prevented this`);
    }

    writeFileSync(`data/times__${scenarioKey}.json`, JSON.stringify({ n, minutes: [...minutes] }));
    console.log(`${scenarioKey}: wrote ${n}x${n} matrix, max ${maxMinutes.toFixed(1)} min`);
  }
}

main();
