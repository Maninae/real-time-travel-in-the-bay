/**
 * Stage 6: assemble the single JSON the static viewer loads.
 *
 * - Streets: secondary-and-up geometry (residential is visual mush at region
 *   scale), Douglas-Peucker simplified, coords rounded to ~1 m.
 * - Layouts: per-mode time-space anchor positions + per-anchor stress. The
 *   browser computes street-vertex warp weights itself (KNN over 1k anchors
 *   is subsecond), so no per-vertex weight tables ship in the bundle.
 * - Trips: storytelling pairs with times per mode and the fastest-route
 *   polyline per mode (routes differ under congestion).
 *
 * Input:  data/streets.json, data/graph.json, data/anchors.json,
 *         data/times__{mode}.json, data/layout__{mode}.json
 * Output: docs/data/bundle.json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { simplifyPolylineIndices } from "../src/geo/simplify.ts";
import { haversineMeters } from "../src/geo/haversine.ts";
import { buildWeightedCsr, dijkstraSeconds } from "../src/graph/dijkstra.ts";
import { computeScenarioWeightsSeconds } from "../src/traffic/scenario_weights.ts";
import { SCENARIOS } from "../src/traffic/scenarios.ts";
import { REGION_BBOX } from "../src/geo/region.ts";

const STREET_CLASSES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "secondary", "tertiary",
]);
const STREET_SIMPLIFY_TOLERANCE_M = 25;
const TRIP_SIMPLIFY_TOLERANCE_M = 60;
const METERS_PER_MILE = 1609.34;

/**
 * Scenarios shipped in the bundle. Sourced from the single scenarios.ts
 * table so the pipeline, viewer, and validation script never disagree.
 */
const MODES = SCENARIOS;

/** Storytelling endpoints; each snaps to its nearest anchor. */
const PLACES: Record<string, [number, number]> = {
  "Ferry Building": [37.7955, -122.3937],
  "Downtown Oakland": [37.8044, -122.2712],
  "Sausalito": [37.8591, -122.4853],
  "San Rafael": [37.9735, -122.5311],
  "Berkeley": [37.8719, -122.2585],
  "Palo Alto": [37.4419, -122.143],
  "Hayward": [37.6688, -122.0808],
  "Outer Sunset": [37.753, -122.4936],
  "Richmond": [37.9358, -122.3477],
};
const TRIPS: [string, string][] = [
  ["Ferry Building", "Downtown Oakland"],
  ["Palo Alto", "Hayward"],
  ["Outer Sunset", "Ferry Building"],
  ["San Rafael", "Richmond"],
  ["Sausalito", "Ferry Building"],
  ["Ferry Building", "Palo Alto"],
  ["Berkeley", "Downtown Oakland"],
];

interface GraphFile {
  nodeLat: number[]; nodeLon: number[];
  edgeFrom: number[]; edgeTo: number[]; edgeLengthM: number[]; edgeWay: number[];
  ways: { cls: string; mph: number; bridge: boolean; lat: number; lon: number; name?: string; ref?: string }[];
}
interface AnchorRecord { lat: number; lon: number; node: number }
interface LayoutFile { stress1: number; anchors: { lat: number; lon: number; tlat: number; tlon: number; stress: number }[] }

function main(): void {
  const graph = JSON.parse(readFileSync("data/graph.json", "utf8")) as GraphFile;
  const { anchors } = JSON.parse(readFileSync("data/anchors.json", "utf8")) as { anchors: AnchorRecord[] };
  const { ways } = JSON.parse(readFileSync("data/streets.json", "utf8")) as {
    ways: { cls: string; refs: number[]; lats: number[]; lons: number[] }[];
  };
  const layouts: Record<string, LayoutFile> = {};
  const matrices: Record<string, { n: number; minutes: number[] }> = {};
  for (const mode of MODES) {
    layouts[mode.key] = JSON.parse(readFileSync(`data/layout__${mode.key}.json`, "utf8"));
    matrices[mode.key] = JSON.parse(readFileSync(`data/times__${mode.key}.json`, "utf8"));
  }

  // --- streets ---
  const streets: { cls: string; pts: number[] }[] = [];
  let keptPoints = 0;
  for (const way of ways) {
    if (!STREET_CLASSES.has(way.cls)) continue;
    const kept = simplifyPolylineIndices(way.lats, way.lons, STREET_SIMPLIFY_TOLERANCE_M);
    if (kept.length < 2) continue;
    const pts: number[] = [];
    for (const i of kept) {
      pts.push(Number(way.lons[i].toFixed(5)), Number(way.lats[i].toFixed(5)));
    }
    keptPoints += kept.length;
    streets.push({ cls: way.cls, pts });
  }
  console.log(`Streets: ${streets.length} polylines, ${keptPoints} points`);

  // --- trips ---
  const nearestAnchorTo = (lat: number, lon: number): number => {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const d = haversineMeters(lat, lon, anchors[i].lat, anchors[i].lon);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  const nodeCount = graph.nodeLat.length;
  const edgeFrom = Int32Array.from(graph.edgeFrom);
  const edgeTo = Int32Array.from(graph.edgeTo);
  const csrByMode: Record<string, ReturnType<typeof buildWeightedCsr>> = {};
  for (const mode of MODES) {
    csrByMode[mode.key] = buildWeightedCsr(
      nodeCount, edgeFrom, edgeTo, computeScenarioWeightsSeconds(graph, mode.key),
    );
  }

  const trips = TRIPS.map(([fromName, toName]) => {
    const fromAnchor = nearestAnchorTo(...PLACES[fromName]);
    const toAnchor = nearestAnchorTo(...PLACES[toName]);
    const fromNode = anchors[fromAnchor].node;
    const toNode = anchors[toAnchor].node;
    const minutes: Record<string, number> = {};
    const paths: Record<string, number[]> = {};
    let miles = 0;
    for (const mode of MODES) {
      const matrix = matrices[mode.key];
      minutes[mode.key] = matrix.minutes[fromAnchor * matrix.n + toAnchor];
      const parents = new Int32Array(nodeCount);
      dijkstraSeconds(csrByMode[mode.key], nodeCount, fromNode, {
        earlyExitTargets: Int32Array.of(toNode), parents,
      });
      const pathLats: number[] = [];
      const pathLons: number[] = [];
      let reachedSource = false;
      for (let node = toNode; node !== -1; node = parents[node]) {
        pathLats.push(graph.nodeLat[node]);
        pathLons.push(graph.nodeLon[node]);
        if (node === fromNode) { reachedSource = true; break; }
      }
      if (!reachedSource) {
        throw new Error(`trip ${fromName} -> ${toName} (${mode.key}): no route reached the source node; SCC filtering should have prevented this`);
      }
      pathLats.reverse(); pathLons.reverse();
      if (mode.key === "freeflow") {
        for (let i = 1; i < pathLats.length; i++) {
          miles += haversineMeters(pathLats[i - 1], pathLons[i - 1], pathLats[i], pathLons[i]);
        }
        miles /= METERS_PER_MILE;
      }
      const kept = simplifyPolylineIndices(pathLats, pathLons, TRIP_SIMPLIFY_TOLERANCE_M);
      const pts: number[] = [];
      for (const i of kept) pts.push(Number(pathLons[i].toFixed(5)), Number(pathLats[i].toFixed(5)));
      paths[mode.key] = pts;
    }
    return { from: fromName, to: toName, miles: Number(miles.toFixed(1)), minutes, paths };
  });
  for (const trip of trips) {
    console.log(
      `Trip ${trip.from} -> ${trip.to}: ${trip.miles} mi, ` +
      MODES.map((m) => `${m.label} ${trip.minutes[m.key]} min`).join(", "),
    );
  }

  // --- bundle ---
  const bundle = {
    attribution: "Street data © OpenStreetMap contributors (ODbL)",
    region: REGION_BBOX,
    modes: MODES.map((mode) => ({ ...mode, stress1: layouts[mode.key].stress1 })),
    anchors: anchors.map((a) => [Number(a.lon.toFixed(5)), Number(a.lat.toFixed(5))]),
    layouts: Object.fromEntries(
      MODES.map((mode) => [
        mode.key,
        {
          tpos: layouts[mode.key].anchors.map((a) => [Number(a.tlon.toFixed(5)), Number(a.tlat.toFixed(5))]),
          stress: layouts[mode.key].anchors.map((a) => a.stress),
        },
      ]),
    ),
    streets,
    trips,
  };
  mkdirSync("docs/data", { recursive: true });
  const json = JSON.stringify(bundle);
  writeFileSync("docs/data/bundle.json", json);
  console.log(`Wrote docs/data/bundle.json (${(json.length / 1e6).toFixed(1)} MB)`);
}

main();
