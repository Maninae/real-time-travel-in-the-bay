// Canvas rendering: streets grouped by class, anchors as x-ray dots, highlighted trip.
//
// One Path2D per street class per frame. Per-frame allocation is limited to the
// Path2D objects (one per class); vertex loops read the cached geo + per-mode
// displacement Float32Arrays and write only to the canvas context.
//
// Modes: the v2 pipeline ships three scenarios (freeflow, midday, friday). At
// any moment the viewer is animating between exactly two of them -- `fromMode`
// on the left of the tween and `toMode` on the right, with `modeBlend` in
// [0, 1] doing the crossfade. Precomputed displacements live in a per-mode
// map on each segment, and the renderer picks up the right two per frame.
//
// Two palettes, one per theme: night is sodium-lit freeways with glow on ink,
// day is the printed-atlas look, persimmon highways on paper with no glow
// (print does not glow). Same widths hierarchy, day slightly heavier to make
// up for the missing bloom.

// Draw order, back to front: widest+dimmest first, freeways on top.
export const ROAD_CLASS_ORDER = [
    'tertiary', 'secondary', 'primary', 'trunk_link', 'trunk', 'motorway_link', 'motorway',
];

export const MAP_PALETTES = {
    dark: {
        bg: '#0a0f1c',
        anchor: 'rgba(232, 230, 222, 0.55)',
        trip: '#8fc8d8',
        tripGlow: 10,
        roads: {
            tertiary:      { color: '#2c3448', width: 0.55, glow: 0 },
            secondary:     { color: '#3a4762', width: 0.75, glow: 0 },
            primary:       { color: '#6a5a3d', width: 0.90, glow: 0 },
            trunk_link:    { color: '#8a6a34', width: 0.85, glow: 0 },
            trunk:         { color: '#b58436', width: 1.30, glow: 3 },
            motorway_link: { color: '#c89138', width: 1.10, glow: 4 },
            motorway:      { color: '#e8ae4c', width: 1.55, glow: 6 },
        },
    },
    light: {
        bg: '#faf5e8',
        anchor: 'rgba(46, 44, 36, 0.5)',
        trip: '#1d7a93',
        tripGlow: 0,
        roads: {
            tertiary:      { color: '#d8cfb4', width: 0.60, glow: 0 },
            secondary:     { color: '#b9b49e', width: 0.80, glow: 0 },
            primary:       { color: '#c9995c', width: 1.00, glow: 0 },
            trunk_link:    { color: '#dfa06a', width: 0.95, glow: 0 },
            trunk:         { color: '#dd8f3c', width: 1.40, glow: 0 },
            motorway_link: { color: '#e0764a', width: 1.20, glow: 0 },
            motorway:      { color: '#d95f36', width: 1.75, glow: 0 },
        },
    },
};

const TRIP_HIGHLIGHT_WIDTH = 2.4;
const TRIP_ENDPOINT_RADIUS = 5;

const ANCHOR_BASE_RADIUS = 0.9;
const ANCHOR_STRESS_SCALE = 22;

// Group streets by class once for the render loop. Each segment carries the
// per-mode displacement arrays (keyed by mode key) so the renderer picks up
// `fromMode` and `toMode` at frame time.
export function groupStreetsByClass(streets, dispByMode) {
    const modeKeys = Object.keys(dispByMode);
    const groups = new Map();
    for (const key of ROAD_CLASS_ORDER) groups.set(key, []);
    for (let i = 0; i < streets.length; i++) {
        const s = streets[i];
        const bucket = groups.get(s.cls);
        if (!bucket) continue;   // ignore unknown class
        const disps = {};
        for (const m of modeKeys) disps[m] = dispByMode[m][i];
        bucket.push({ geo: s.pts, disps });
    }
    return groups;
}

// Draw one class group as a single stroked Path2D. `t` is the morph amount
// from geography (0) to time-space (1); `fromMode`/`toMode`/`blend` selects
// which two mode-fields are being crossfaded and how far.
function drawClass(ctx, group, style, projection, t, fromMode, toMode, blend) {
    if (group.length === 0) return;
    const path = new Path2D();
    for (let s = 0; s < group.length; s++) {
        const seg = group[s];
        const geo = seg.geo;
        const dA = seg.disps[fromMode];
        const dB = seg.disps[toMode];
        const nVerts = geo.length / 2;
        let lon = geo[0];
        let lat = geo[1];
        let dispLon = dA[0] + (dB[0] - dA[0]) * blend;
        let dispLat = dA[1] + (dB[1] - dA[1]) * blend;
        path.moveTo(projection.projectX(lon + t * dispLon), projection.projectY(lat + t * dispLat));
        for (let v = 1; v < nVerts; v++) {
            const i2 = v * 2;
            lon = geo[i2];
            lat = geo[i2 + 1];
            dispLon = dA[i2] + (dB[i2] - dA[i2]) * blend;
            dispLat = dA[i2 + 1] + (dB[i2 + 1] - dA[i2 + 1]) * blend;
            path.lineTo(projection.projectX(lon + t * dispLon), projection.projectY(lat + t * dispLat));
        }
    }
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    if (style.glow > 0) {
        ctx.shadowColor = style.color;
        ctx.shadowBlur = style.glow;
    } else {
        ctx.shadowBlur = 0;
    }
    ctx.stroke(path);
    ctx.shadowBlur = 0;
}

export function renderFrame(ctx, state) {
    const {
        canvas, projection, groups, anchors, anchorDisp, stress,
        t, fromMode, toMode, modeBlend, showXray, highlightedTrip, palette,
    } = state;

    // Clear with the theme background.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Apply DPR transform for the rest of the frame.
    ctx.scale(state.dpr, state.dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Draw road classes back-to-front.
    for (const key of ROAD_CLASS_ORDER) {
        drawClass(ctx, groups.get(key), palette.roads[key], projection, t, fromMode, toMode, modeBlend);
    }

    // Highlighted trip on top of the road network.
    if (highlightedTrip) {
        drawTrip(ctx, highlightedTrip, palette, projection, t, fromMode, toMode, modeBlend);
    }

    // X-ray anchors on top of everything.
    if (showXray) {
        drawAnchors(ctx, anchors, anchorDisp, stress, palette, projection, t, fromMode, toMode, modeBlend);
    }

    ctx.restore();
}

function drawTrip(ctx, trip, palette, projection, t, fromMode, toMode, blend) {
    const geo = trip.geo;
    const dA = trip.disps[fromMode];
    const dB = trip.disps[toMode];
    const nVerts = geo.length / 2;
    if (nVerts < 2) return;

    if (palette.tripGlow > 0) {
        ctx.shadowColor = palette.trip;
        ctx.shadowBlur = palette.tripGlow;
    }
    ctx.strokeStyle = palette.trip;
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
    ctx.fillStyle = palette.trip;
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

function drawAnchors(ctx, anchors, anchorDisp, stress, palette, projection, t, fromMode, toMode, blend) {
    ctx.fillStyle = palette.anchor;
    const dispA = anchorDisp[fromMode];
    const dispB = anchorDisp[toMode];
    for (let i = 0; i < anchors.length; i++) {
        const lon = anchors[i][0];
        const lat = anchors[i][1];
        // For anchors themselves the "displacement" IS tpos - anchor, exact per mode.
        const dispLon = dispA[i * 2] + (dispB[i * 2] - dispA[i * 2]) * blend;
        const dispLat = dispA[i * 2 + 1] + (dispB[i * 2 + 1] - dispA[i * 2 + 1]) * blend;
        const x = projection.projectX(lon + t * dispLon);
        const y = projection.projectY(lat + t * dispLat);
        // Radius grows with stress: bigger dot = the fabric bent harder here.
        const r = ANCHOR_BASE_RADIUS + ANCHOR_STRESS_SCALE * (stress[i] || 0);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
}
