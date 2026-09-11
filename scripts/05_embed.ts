/**
 * Stage 5: embed each travel-time matrix into 2D and align to geography.
 *
 * Distances for the embedding are minutes; the Procrustes step then scales
 * the whole layout onto the geographic meter frame, so "one minute" gets
 * whatever physical size makes the time map best overlay the real one.
 * Time-space positions are finally expressed as pseudo lat/lon so the viewer
 * can treat both endpoints of the morph in one coordinate system.
 *
 * Input:  data/anchors.json, data/times__{mode}.json
 * Output: data/layout__{mode}.json
 *   { stress1, anchors: [{ lat, lon, tlat, tlon, stress }] }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { classicalMdsLayout } from "../src/embed/mds.ts";
import { smacofRefine } from "../src/embed/smacof.ts";
import { procrustesAlign } from "../src/embed/procrustes.ts";
import { REGION_BBOX, METERS_PER_DEG_LAT, METERS_PER_DEG_LON } from "../src/geo/region.ts";
import { SCENARIO_KEYS } from "../src/traffic/scenarios.ts";

const SMACOF_MAX_ITERATIONS = 400;
const MODES = SCENARIO_KEYS;

function main(): void {
  const { anchors } = JSON.parse(readFileSync("data/anchors.json", "utf8")) as {
    anchors: { lat: number; lon: number; node: number }[];
  };
  const n = anchors.length;

  // Geographic target frame in local meters (equirectangular around the region).
  const geoMeters = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    geoMeters[i * 2] = (anchors[i].lon - REGION_BBOX.west) * METERS_PER_DEG_LON;
    geoMeters[i * 2 + 1] = (anchors[i].lat - REGION_BBOX.south) * METERS_PER_DEG_LAT;
  }

  for (const mode of MODES) {
    const { minutes } = JSON.parse(readFileSync(`data/times__${mode}.json`, "utf8")) as {
      n: number; minutes: number[];
    };
    const distances = Float64Array.from(minutes);

    console.log(`${mode}: classical MDS init…`);
    const initial = classicalMdsLayout(distances, n);
    console.log(`${mode}: SMACOF refinement…`);
    const refined = smacofRefine(initial, distances, n, SMACOF_MAX_ITERATIONS);
    console.log(`${mode}: stress-1 ${refined.stress1.toFixed(4)} after ${refined.iterationsRun} iterations`);

    const aligned = procrustesAlign(refined.layout, geoMeters, n);

    const outAnchors = anchors.map((anchor, i) => ({
      lat: anchor.lat,
      lon: anchor.lon,
      tlat: Number((REGION_BBOX.south + aligned[i * 2 + 1] / METERS_PER_DEG_LAT).toFixed(6)),
      tlon: Number((REGION_BBOX.west + aligned[i * 2] / METERS_PER_DEG_LON).toFixed(6)),
      stress: Number(refined.perPointStress[i].toFixed(4)),
    }));
    writeFileSync(
      `data/layout__${mode}.json`,
      JSON.stringify({ stress1: Number(refined.stress1.toFixed(4)), anchors: outAnchors }),
    );
    console.log(`${mode}: wrote data/layout__${mode}.json`);
  }
}

main();
