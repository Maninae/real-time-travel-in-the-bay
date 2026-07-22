/**
 * Tiled Overpass API fetch for drivable ways in the region.
 *
 * The region bbox is split into a grid of tiles so no single query exceeds
 * what the public server tolerates. Each tile's raw JSON response is cached
 * under data/cache/, so reruns cost nothing and the server is hit once.
 *
 * - Ways crossing a tile boundary appear in multiple tiles; callers dedupe by way id.
 * - Retries with backoff on 429 (rate limit) and 5xx (server load).
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundingBox } from "../geo/region.ts";

/** Rotated on retry: the public instances rate-limit and 504 under load independently. */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "real-time-travel-in-the-bay/0.1 (https://github.com/Maninae/real-time-travel-in-the-bay)";
const REQUEST_GAP_MS = 6000;
const MAX_RETRIES = 6;

/** Road classes we route on. `service` is excluded: parking aisles and driveways add noise, not connectivity. */
const DRIVABLE_HIGHWAY_REGEX =
  "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";

export interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

function buildTileQuery(tile: BoundingBox): string {
  const bbox = `${tile.south},${tile.west},${tile.north},${tile.east}`;
  return `[out:json][timeout:180][maxsize:536870912];
way["highway"~"${DRIVABLE_HIGHWAY_REGEX}"]["area"!="yes"]["access"!~"^(private|no)$"](${bbox});
out geom;`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTileWithRetry(query: string, label: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length];
    const response = await fetch(endpoint, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
    });
    if (response.ok) return await response.text();
    const retryable = response.status === 429 || response.status === 406 || response.status >= 500;
    console.warn(
      `  ${label}: HTTP ${response.status} from ${new URL(endpoint).host}${retryable ? ", retrying" : ""} (attempt ${attempt}/${MAX_RETRIES})`,
    );
    if (!retryable) throw new Error(`Overpass rejected ${label}: HTTP ${response.status}`);
    await sleep(10_000 * attempt);
  }
  throw new Error(`Overpass gave up on ${label} after ${MAX_RETRIES} attempts`);
}

/**
 * Fetch all drivable ways in `bbox`, tiled `rows` x `cols`, caching each tile.
 * Returns deduped ways (by way id) across tiles.
 */
export async function fetchDrivableWays(
  bbox: BoundingBox,
  rows: number,
  cols: number,
  cacheDir: string,
): Promise<OverpassWay[]> {
  mkdirSync(cacheDir, { recursive: true });
  const waysById = new Map<number, OverpassWay>();
  const latStep = (bbox.north - bbox.south) / rows;
  const lonStep = (bbox.east - bbox.west) / cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile: BoundingBox = {
        south: bbox.south + r * latStep,
        north: bbox.south + (r + 1) * latStep,
        west: bbox.west + c * lonStep,
        east: bbox.west + (c + 1) * lonStep,
      };
      const label = `tile r${r}c${c}`;
      const cachePath = join(cacheDir, `overpass_tile__r${r}_c${c}.json`);
      let rawJson: string;
      if (existsSync(cachePath)) {
        rawJson = readFileSync(cachePath, "utf8");
        console.log(`  ${label}: cache hit`);
      } else {
        console.log(`  ${label}: fetching…`);
        rawJson = await fetchTileWithRetry(buildTileQuery(tile), label);
        writeFileSync(cachePath, rawJson);
        await sleep(REQUEST_GAP_MS);
      }
      const parsed = JSON.parse(rawJson) as { elements: OverpassWay[] };
      let added = 0;
      for (const element of parsed.elements) {
        if (element.type !== "way") continue;
        if (!waysById.has(element.id)) {
          waysById.set(element.id, element);
          added++;
        }
      }
      console.log(`  ${label}: ${parsed.elements.length} ways (${added} new)`);
    }
  }
  return [...waysById.values()];
}
