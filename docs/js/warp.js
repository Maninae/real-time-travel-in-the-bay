// Warp math: geographic projection, KNN over anchors, per-vertex displacement caches.
//
// The morph maps every street/trip vertex through a smooth field defined by
// the anchor pairs (geo, tpos). For each vertex we find its K nearest anchors
// (spatial-hash grid), weight them by 1/d^2, and cache the resulting displacement
// per mode. At render time we blend cached displacements between modes and
// scale by the morph parameter t; no per-frame allocation.

export const K_NEAREST = 6;
export const GRID_CELL_LON = 0.02;   // ~1.6 km at this latitude, ~55 cells across the region
export const GRID_CELL_LAT = 0.02;   // ~2.2 km
export const EPS_DISTANCE = 1e-9;    // guard against divide-by-zero when a vertex sits on an anchor

// Build a spatial hash of anchor indices keyed by integer (lon-bin, lat-bin).
export function buildAnchorGrid(anchors) {
    const grid = new Map();
    for (let i = 0; i < anchors.length; i++) {
        const lon = anchors[i][0];
        const lat = anchors[i][1];
        const key = binKey(lon, lat);
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(i);
    }
    return grid;
}

function binKey(lon, lat) {
    const bx = Math.floor(lon / GRID_CELL_LON);
    const by = Math.floor(lat / GRID_CELL_LAT);
    // Cantor-pair-ish string key; small and fast, JS Maps hash strings well.
    return bx + '|' + by;
}

// Find the K nearest anchors to (lon, lat). Expands the search ring until enough
// candidates are gathered, then keeps the top K by squared distance.
function findKNearest(lon, lat, anchors, grid, k) {
    const bx = Math.floor(lon / GRID_CELL_LON);
    const by = Math.floor(lat / GRID_CELL_LAT);
    const candidates = [];
    // Expand ring outward until we have at least ~2k candidates (buffer to
    // avoid boundary bias: neighbours slightly beyond the closest cells may
    // still beat cells inside the initial ring).
    for (let ring = 0; ring <= 20; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                // Only visit the shell of the current ring, not the interior we already scanned.
                if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                const bucket = grid.get((bx + dx) + '|' + (by + dy));
                if (!bucket) continue;
                for (const idx of bucket) candidates.push(idx);
            }
        }
        if (candidates.length >= k * 2) break;
    }
    // Partial sort: pick top-k by squared distance. K is tiny (6), so a linear
    // scan with an insertion into a fixed-size top list beats a full sort.
    const bestIdx = new Int32Array(k).fill(-1);
    const bestD2 = new Float64Array(k).fill(Infinity);
    for (const idx of candidates) {
        const dLon = anchors[idx][0] - lon;
        const dLat = anchors[idx][1] - lat;
        const d2 = dLon * dLon + dLat * dLat;
        // Insert into the top-k list if better than the current worst.
        if (d2 >= bestD2[k - 1]) continue;
        let slot = k - 1;
        while (slot > 0 && bestD2[slot - 1] > d2) {
            bestD2[slot] = bestD2[slot - 1];
            bestIdx[slot] = bestIdx[slot - 1];
            slot--;
        }
        bestD2[slot] = d2;
        bestIdx[slot] = idx;
    }
    return { bestIdx, bestD2 };
}

// Precompute displacement per vertex for a set of polylines.
//
// Input `polylines`: Array<Float32Array> where each element is [lon0,lat0,lon1,lat1,...].
// Anchor positions and per-mode target positions come from the bundle.
//
// Output: for each polyline, a Float32Array of the same length holding
// (dispLon, dispLat) per vertex, one array per mode.
export function precomputeDisplacements(polylines, anchors, tposByMode) {
    const grid = buildAnchorGrid(anchors);
    const modeKeys = Object.keys(tposByMode);
    // dispByMode[mode] = Array of Float32Arrays, one per polyline.
    const dispByMode = {};
    for (const m of modeKeys) dispByMode[m] = new Array(polylines.length);

    // Reusable scratch: KNN result buffers.
    for (let p = 0; p < polylines.length; p++) {
        const pts = polylines[p];
        const nVerts = pts.length / 2;
        const bufs = {};
        for (const m of modeKeys) bufs[m] = new Float32Array(pts.length);

        for (let v = 0; v < nVerts; v++) {
            const lon = pts[v * 2];
            const lat = pts[v * 2 + 1];
            const { bestIdx, bestD2 } = findKNearest(lon, lat, anchors, grid, K_NEAREST);

            // Convert squared distances to inverse-square weights, normalize.
            let wSum = 0;
            const weights = new Float64Array(K_NEAREST);
            for (let i = 0; i < K_NEAREST; i++) {
                if (bestIdx[i] < 0) continue;
                const w = 1 / Math.max(bestD2[i], EPS_DISTANCE);
                weights[i] = w;
                wSum += w;
            }
            if (wSum <= 0) continue;
            for (let i = 0; i < K_NEAREST; i++) weights[i] /= wSum;

            // Per-mode displacement = sum_k w_k * (tpos_k - anchor_k).
            for (const m of modeKeys) {
                const tpos = tposByMode[m];
                let dLon = 0, dLat = 0;
                for (let i = 0; i < K_NEAREST; i++) {
                    const idx = bestIdx[i];
                    if (idx < 0) continue;
                    const w = weights[i];
                    dLon += w * (tpos[idx][0] - anchors[idx][0]);
                    dLat += w * (tpos[idx][1] - anchors[idx][1]);
                }
                bufs[m][v * 2] = dLon;
                bufs[m][v * 2 + 1] = dLat;
            }
        }
        for (const m of modeKeys) dispByMode[m][p] = bufs[m];
    }
    return dispByMode;
}

// Equirectangular projection with cos-latitude correction for x.
//
// Given the region bounding box, the central latitude, and canvas dimensions,
// returns { scale, offsetX, offsetY, cosLat } so that:
//     canvasX = (lon - region.west) * cosLat * scale + offsetX
//     canvasY = (region.north - lat) * scale + offsetY
// Preserves aspect (letterboxed inside the canvas rect with `padding` px).
export function makeProjection(region, canvasWidth, canvasHeight, padding = 0) {
    const centralLat = (region.south + region.north) / 2;
    const cosLat = Math.cos(centralLat * Math.PI / 180);
    const mapWidth = (region.east - region.west) * cosLat;
    const mapHeight = region.north - region.south;
    const innerWidth = Math.max(1, canvasWidth - 2 * padding);
    const innerHeight = Math.max(1, canvasHeight - 2 * padding);
    const scale = Math.min(innerWidth / mapWidth, innerHeight / mapHeight);
    const drawnWidth = mapWidth * scale;
    const drawnHeight = mapHeight * scale;
    const offsetX = padding + (innerWidth - drawnWidth) / 2;
    const offsetY = padding + (innerHeight - drawnHeight) / 2;
    return {
        cosLat,
        scale,
        offsetX,
        offsetY,
        west: region.west,
        north: region.north,
        // Inline helpers so the render loop can call directly.
        projectX(lon) { return (lon - this.west) * this.cosLat * this.scale + this.offsetX; },
        projectY(lat) { return (this.north - lat) * this.scale + this.offsetY; },
    };
}
