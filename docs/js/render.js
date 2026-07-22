// Canvas rendering: streets grouped by class, anchors as x-ray dots, highlighted trip.
//
// One Path2D per street class per frame. Per-frame allocation is limited to the
// eight Path2D objects (one per class); vertex loops read the cached geo + per-mode
// displacement Float32Arrays and write only to the canvas context.

// Road class hierarchy, ordered draw-back to draw-front (widest, dimmest first;
// narrowest, brightest on top). Stroke widths scale with canvas density but stay
// perceptually within the same band across zoom levels.
export const ROAD_CLASSES = [
    { key: 'tertiary',      color: '#2c3448', width: 0.55, glow: 0 },
    { key: 'secondary',     color: '#3a4762', width: 0.75, glow: 0 },
    { key: 'primary',       color: '#6a5a3d', width: 0.90, glow: 0 },
    { key: 'trunk_link',    color: '#8a6a34', width: 0.85, glow: 0 },
    { key: 'trunk',         color: '#b58436', width: 1.30, glow: 3 },
    { key: 'motorway_link', color: '#c89138', width: 1.10, glow: 4 },
    { key: 'motorway',      color: '#e8ae4c', width: 1.55, glow: 6 },
];

const TRIP_HIGHLIGHT_COLOR = '#8fc8d8';
const TRIP_HIGHLIGHT_WIDTH = 2.4;
const TRIP_HIGHLIGHT_GLOW = 10;
const TRIP_ENDPOINT_RADIUS = 5;

const ANCHOR_BASE_RADIUS = 0.9;
const ANCHOR_STRESS_SCALE = 22;
const ANCHOR_COLOR = 'rgba(232, 230, 222, 0.55)';

// Group streets by class once for the render loop.
export function groupStreetsByClass(streets, dispByMode) {
    const groups = new Map();
    for (const rc of ROAD_CLASSES) groups.set(rc.key, []);
    for (let i = 0; i < streets.length; i++) {
        const s = streets[i];
        const bucket = groups.get(s.cls);
        if (!bucket) continue;   // ignore unknown class
        bucket.push({
            geo: s.pts,
            dispA: dispByMode.freeflow[i],
            dispB: dispByMode.friday[i],
        });
    }
    return groups;
}

// Compute the effective displacement for one vertex under a mode-blend.
//   blend = 0 -> use dispA (previous mode), blend = 1 -> use dispB (current mode).
// Inlined into each polyline loop below for speed; this signature is documentary.

// Draw one class group as a single stroked Path2D.
// `blend` is the current tween value from previous mode (0) to current mode (1);
// `modeSign` = 1 if current mode is freeflow, so dispA=freeflow, dispB=friday.
// Actually we take dispA and dispB directly so the caller decides which is "from" and "to".
function drawClass(ctx, group, rc, projection, t, blend, projectVertex) {
    if (group.length === 0) return;
    const path = new Path2D();
    for (let s = 0; s < group.length; s++) {
        const seg = group[s];
        const geo = seg.geo;
        const dA = seg.dispA;
        const dB = seg.dispB;
        const nVerts = geo.length / 2;
        // First vertex
        let lon = geo[0];
        let lat = geo[1];
        let dispLon = dA[0] + (dB[0] - dA[0]) * blend;
        let dispLat = dA[1] + (dB[1] - dA[1]) * blend;
        let wLon = lon + t * dispLon;
        let wLat = lat + t * dispLat;
        path.moveTo(projection.projectX(wLon), projection.projectY(wLat));
        for (let v = 1; v < nVerts; v++) {
            const i2 = v * 2;
            lon = geo[i2];
            lat = geo[i2 + 1];
            dispLon = dA[i2] + (dB[i2] - dA[i2]) * blend;
            dispLat = dA[i2 + 1] + (dB[i2 + 1] - dA[i2 + 1]) * blend;
            wLon = lon + t * dispLon;
            wLat = lat + t * dispLat;
            path.lineTo(projection.projectX(wLon), projection.projectY(wLat));
        }
    }
    ctx.strokeStyle = rc.color;
    ctx.lineWidth = rc.width;
    if (rc.glow > 0) {
        ctx.shadowColor = rc.color;
        ctx.shadowBlur = rc.glow;
    } else {
        ctx.shadowBlur = 0;
    }
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    // projectVertex is a hint that future callers might want to project inline; unused here.
    void projectVertex;
}

export function renderFrame(ctx, state) {
    const {
        canvas, projection, groups, anchors, anchorDisp, stress,
        t, modeBlend, showXray, highlightedTrip, bg,
    } = state;

    // Clear with background.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Apply DPR transform for the rest of the frame.
    ctx.scale(state.dpr, state.dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Draw road classes back-to-front.
    for (const rc of ROAD_CLASSES) {
        const group = groups.get(rc.key);
        drawClass(ctx, group, rc, projection, t, modeBlend);
    }

    // Highlighted trip on top of the road network.
    if (highlightedTrip) {
        drawTrip(ctx, highlightedTrip, projection, t, modeBlend);
    }

    // X-ray anchors on top of everything.
    if (showXray) {
        drawAnchors(ctx, anchors, anchorDisp, stress, projection, t, modeBlend);
    }

    ctx.restore();
}

function drawTrip(ctx, trip, projection, t, blend) {
    const geo = trip.geo;
    const dA = trip.dispA;
    const dB = trip.dispB;
    const nVerts = geo.length / 2;
    if (nVerts < 2) return;

    ctx.shadowColor = TRIP_HIGHLIGHT_COLOR;
    ctx.shadowBlur = TRIP_HIGHLIGHT_GLOW;
    ctx.strokeStyle = TRIP_HIGHLIGHT_COLOR;
    ctx.lineWidth = TRIP_HIGHLIGHT_WIDTH;
    ctx.beginPath();
    for (let v = 0; v < nVerts; v++) {
        const i2 = v * 2;
        const lon = geo[i2];
        const lat = geo[i2 + 1];
        const dispLon = dA[i2] + (dB[i2] - dA[i2]) * blend;
        const dispLat = dA[i2 + 1] + (dB[i2 + 1] - dA[i2 + 1]) * blend;
        const x = projection.projectX(lon + t * dispLon);
        const y = projection.projectY(lat + t * dispLat);
        if (v === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Endpoints
    const endpoints = [
        [geo[0], geo[1], dA[0], dA[1], dB[0], dB[1]],
        [geo[(nVerts - 1) * 2], geo[(nVerts - 1) * 2 + 1],
         dA[(nVerts - 1) * 2], dA[(nVerts - 1) * 2 + 1],
         dB[(nVerts - 1) * 2], dB[(nVerts - 1) * 2 + 1]],
    ];
    ctx.fillStyle = TRIP_HIGHLIGHT_COLOR;
    for (const e of endpoints) {
        const [lon, lat, dAx, dAy, dBx, dBy] = e;
        const dispLon = dAx + (dBx - dAx) * blend;
        const dispLat = dAy + (dBy - dAy) * blend;
        const x = projection.projectX(lon + t * dispLon);
        const y = projection.projectY(lat + t * dispLat);
        ctx.beginPath();
        ctx.arc(x, y, TRIP_ENDPOINT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawAnchors(ctx, anchors, anchorDisp, stress, projection, t, blend) {
    ctx.fillStyle = ANCHOR_COLOR;
    for (let i = 0; i < anchors.length; i++) {
        const lon = anchors[i][0];
        const lat = anchors[i][1];
        // For anchors themselves the "displacement" IS tpos - anchor, exact per mode.
        const dispLon = anchorDisp.freeflow[i * 2] + (anchorDisp.friday[i * 2] - anchorDisp.freeflow[i * 2]) * blend;
        const dispLat = anchorDisp.freeflow[i * 2 + 1] + (anchorDisp.friday[i * 2 + 1] - anchorDisp.freeflow[i * 2 + 1]) * blend;
        const x = projection.projectX(lon + t * dispLon);
        const y = projection.projectY(lat + t * dispLat);
        // Radius grows with stress: bigger dot = the fabric bent harder here.
        const r = ANCHOR_BASE_RADIUS + ANCHOR_STRESS_SCALE * (stress[i] || 0);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
}
