// Entry point: load bundle, precompute displacements, wire UI, run the render loop.

import { precomputeDisplacements, makeProjection } from './warp.js';
import { renderFrame, groupStreetsByClass, ROAD_CLASSES } from './render.js';

const BUNDLE_URL = 'data/bundle.json';
const BG_COLOR = '#0a0f1c';
const MODE_TWEEN_MS = 600;
const CANVAS_PADDING = 16;

const state = {
    // Data
    bundle: null,
    projection: null,
    streetGroups: null,
    anchorDisp: null,     // { freeflow: Float32Array [dLon0, dLat0, ...], friday: same }
    tripDisp: null,       // per trip: { freeflow: {geo, dispA, dispB}, friday: {...} }
    // Interaction
    t: 0.0,               // morph 0..1
    targetBlend: 0,       // 0 = freeflow, 1 = friday
    currentBlend: 0,      // animated
    tweenStart: 0,
    tweenFrom: 0,
    tweenTo: 0,
    tweening: false,
    showXray: false,
    selectedTripIndex: -1,
    // Canvas
    canvas: null,
    ctx: null,
    dpr: 1,
    // Rendering
    needsFrame: true,
};

// -----------------------------------------------------------------------------
// Boot

async function boot() {
    setStatus('Loading Bay Area data...');
    const response = await fetch(BUNDLE_URL);
    if (!response.ok) {
        setStatus('Failed to load data bundle.', true);
        throw new Error('bundle fetch failed: ' + response.status);
    }
    const bundle = await response.json();
    state.bundle = bundle;

    setStatus('Computing warp field for 46k streets and 908 anchors...');
    // Yield once so the status text paints before the heavy precompute.
    await new Promise(r => setTimeout(r, 20));

    prepareAll(bundle);

    // Canvas setup
    state.canvas = document.getElementById('map-canvas');
    state.ctx = state.canvas.getContext('2d', { alpha: false });
    resizeCanvas();

    // UI wire-up
    setupModeToggle();
    setupMorphSlider();
    setupXrayToggle();
    setupTripsPanel();
    setupKeyboard();

    // Initial UI paint (mode + stress readout).
    applyMode('freeflow', /*instant*/ true);

    // Resize handling.
    const ro = new ResizeObserver(() => {
        resizeCanvas();
        state.needsFrame = true;
    });
    ro.observe(state.canvas.parentElement);

    // Kick off the render loop.
    requestAnimationFrame(loop);
    hideStatus();
}

function setStatus(text, isError = false) {
    const el = document.getElementById('boot-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
}

function hideStatus() {
    const el = document.getElementById('boot-status');
    if (el) el.classList.add('hidden');
}

// -----------------------------------------------------------------------------
// Precompute displacements for streets, anchors, and every trip path.

function prepareAll(bundle) {
    const anchors = bundle.anchors;
    const tposByMode = {
        freeflow: bundle.layouts.freeflow.tpos,
        friday: bundle.layouts.friday.tpos,
    };

    // Anchor displacements: for anchors themselves, disp = tpos - anchor, exact.
    const nA = anchors.length;
    const anchorDisp = {
        freeflow: new Float32Array(nA * 2),
        friday: new Float32Array(nA * 2),
    };
    for (let i = 0; i < nA; i++) {
        anchorDisp.freeflow[i * 2]     = tposByMode.freeflow[i][0] - anchors[i][0];
        anchorDisp.freeflow[i * 2 + 1] = tposByMode.freeflow[i][1] - anchors[i][1];
        anchorDisp.friday[i * 2]       = tposByMode.friday[i][0]   - anchors[i][0];
        anchorDisp.friday[i * 2 + 1]   = tposByMode.friday[i][1]   - anchors[i][1];
    }
    state.anchorDisp = anchorDisp;

    // Street displacements via KNN warp field.
    const streetGeo = bundle.streets.map(s => new Float32Array(s.pts));
    const streetDisp = precomputeDisplacements(streetGeo, anchors, tposByMode);
    const streets = bundle.streets.map((s, i) => ({ cls: s.cls, pts: streetGeo[i] }));
    state.streetGroups = groupStreetsByClass(streets, streetDisp);

    // Trip path displacements: each trip has TWO polylines (freeflow, friday).
    // We precompute displacements for BOTH so a mode switch swaps which is drawn
    // but the morph parameter t still animates that polyline smoothly.
    state.tripDisp = bundle.trips.map(trip => {
        const packed = {};
        for (const modeKey of ['freeflow', 'friday']) {
            const path = trip.paths[modeKey];
            if (!path || path.length < 4) { packed[modeKey] = null; continue; }
            const geo = new Float32Array(path);
            const disp = precomputeDisplacements([geo], anchors, tposByMode);
            packed[modeKey] = { geo, dispA: disp.freeflow[0], dispB: disp.friday[0] };
        }
        return packed;
    });
}

// -----------------------------------------------------------------------------
// Canvas sizing (DPR-aware)

function resizeCanvas() {
    // Read the canvas element's own CSS-driven size, not the parent's, so we never
    // feed back inline dimensions into the layout. CSS keeps the canvas at 100% of
    // .map-wrap; we only update the backing pixel resolution.
    const rect = state.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.dpr = dpr;
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(320, Math.floor(rect.height));
    state.canvas.width = cssW * dpr;
    state.canvas.height = cssH * dpr;
    state.projection = makeProjection(state.bundle.region, cssW, cssH, CANVAS_PADDING);
}

// -----------------------------------------------------------------------------
// UI wire-up

function setupModeToggle() {
    const buttons = document.querySelectorAll('.mode-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            applyMode(btn.dataset.mode, false);
        });
    });
}

function applyMode(modeKey, instant) {
    const target = (modeKey === 'friday') ? 1 : 0;
    if (instant) {
        state.currentBlend = target;
        state.targetBlend = target;
        state.tweening = false;
    } else if (target !== state.targetBlend) {
        state.tweenFrom = state.currentBlend;
        state.tweenTo = target;
        state.tweenStart = performance.now();
        state.targetBlend = target;
        state.tweening = true;
    }
    // UI toggle state
    document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === modeKey);
        b.setAttribute('aria-pressed', b.dataset.mode === modeKey ? 'true' : 'false');
    });
    // Mode caption + stress readout
    const mode = state.bundle.modes.find(m => m.key === modeKey);
    document.getElementById('mode-note').textContent = mode.note;
    const stress = mode.stress1.toFixed(2);
    document.getElementById('stress-value').textContent = stress;
    document.getElementById('stress-mode').textContent = mode.label.toLowerCase();
    // Refresh trip rows to bold the active mode's minutes.
    renderTripRows();
    state.needsFrame = true;
}

function setupMorphSlider() {
    const slider = document.getElementById('morph-slider');
    slider.addEventListener('input', () => {
        state.t = slider.value / 1000;
        document.documentElement.style.setProperty('--morph-t', String(state.t));
        state.needsFrame = true;
    });
    // Initial CSS var
    document.documentElement.style.setProperty('--morph-t', String(state.t));
}

function setupXrayToggle() {
    const btn = document.getElementById('xray-toggle');
    btn.addEventListener('click', () => {
        state.showXray = !state.showXray;
        btn.classList.toggle('active', state.showXray);
        btn.setAttribute('aria-pressed', state.showXray ? 'true' : 'false');
        document.getElementById('xray-legend').classList.toggle('visible', state.showXray);
        state.needsFrame = true;
    });
}

function setupTripsPanel() {
    renderTripRows();
}

function renderTripRows() {
    const list = document.getElementById('trip-list');
    const trips = state.bundle.trips;
    const activeMode = state.targetBlend === 1 ? 'friday' : 'freeflow';
    const otherMode = activeMode === 'friday' ? 'freeflow' : 'friday';
    list.innerHTML = '';
    trips.forEach((trip, i) => {
        const row = document.createElement('button');
        row.className = 'trip-row';
        row.dataset.index = String(i);
        if (i === state.selectedTripIndex) row.classList.add('selected');
        const activeMin = trip.minutes[activeMode];
        const otherMin = trip.minutes[otherMode];
        const delta = activeMin - otherMin;
        const deltaSign = delta > 0 ? '+' : '';
        const deltaStr = Math.abs(delta) < 0.05 ? '±0.0' : `${deltaSign}${delta.toFixed(1)}`;
        row.innerHTML = `
            <div class="trip-endpoints">
                <span class="trip-from">${trip.from}</span>
                <span class="trip-arrow" aria-hidden="true">&#8594;</span>
                <span class="trip-to">${trip.to}</span>
            </div>
            <div class="trip-metrics">
                <span class="trip-miles"><span class="num">${trip.miles.toFixed(1)}</span><span class="unit">mi</span></span>
                <span class="trip-minutes"><span class="num">${activeMin.toFixed(1)}</span><span class="unit">min</span></span>
                <span class="trip-delta" title="vs ${otherMode === 'friday' ? 'Friday 5 pm' : 'speed limits'}">${deltaStr} min</span>
            </div>
        `;
        row.addEventListener('click', () => {
            state.selectedTripIndex = (state.selectedTripIndex === i) ? -1 : i;
            renderTripRows();
            state.needsFrame = true;
        });
        list.appendChild(row);
    });
}

function setupKeyboard() {
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && state.selectedTripIndex >= 0) {
            state.selectedTripIndex = -1;
            renderTripRows();
            state.needsFrame = true;
        }
    });
}

// -----------------------------------------------------------------------------
// Render loop

function loop(now) {
    // Advance mode tween
    if (state.tweening) {
        const p = Math.min(1, (now - state.tweenStart) / MODE_TWEEN_MS);
        const eased = easeInOutCubic(p);
        state.currentBlend = state.tweenFrom + (state.tweenTo - state.tweenFrom) * eased;
        state.needsFrame = true;
        if (p >= 1) {
            state.tweening = false;
            state.currentBlend = state.tweenTo;
        }
    }
    if (state.needsFrame) {
        state.needsFrame = false;
        drawScene();
    }
    requestAnimationFrame(loop);
}

function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function drawScene() {
    let highlighted = null;
    if (state.selectedTripIndex >= 0) {
        const packed = state.tripDisp[state.selectedTripIndex];
        // Pick the polyline whose mode is closest to the current blend: freeflow when blend<0.5, friday otherwise.
        // Falls back to whichever exists if one is missing.
        const preferFriday = state.currentBlend >= 0.5;
        highlighted = preferFriday
            ? (packed.friday || packed.freeflow)
            : (packed.freeflow || packed.friday);
    }

    // Stress values per anchor come from the target mode's array (they don't tween;
    // the readout number tweens the display value but the per-dot radius follows the target).
    const activeMode = state.targetBlend === 1 ? 'friday' : 'freeflow';
    const stress = state.bundle.layouts[activeMode].stress;

    renderFrame(state.ctx, {
        canvas: state.canvas,
        dpr: state.dpr,
        projection: state.projection,
        groups: state.streetGroups,
        anchors: state.bundle.anchors,
        anchorDisp: state.anchorDisp,
        stress,
        t: state.t,
        modeBlend: state.currentBlend,
        showXray: state.showXray,
        highlightedTrip: highlighted,
        bg: BG_COLOR,
    });
}

// -----------------------------------------------------------------------------

boot().catch(err => {
    console.error(err);
    setStatus('Something went wrong loading the map. See console for details.', true);
});

// Expose road-class palette for legend rendering if the DOM asks for it.
export { ROAD_CLASSES };
