// Entry point: load bundle, precompute displacements, wire UI, run the render loop.
//
// Modes: the bundle ships N scenarios (v2: freeflow, midday, friday), each
// with its own layout. At any moment we are animating between exactly two of
// them -- `fromMode` and `toMode`, crossfaded by `modeBlend` in [0, 1]. When
// a click switches modes we set fromMode := previous target, toMode := new
// target, kick blend back to 0, and let the tween run. When the tween ends
// we collapse fromMode := toMode so a subsequent switch tweens cleanly from
// whichever mode the user was on.

import { precomputeDisplacements, makeProjection } from './warp.js';
import { renderFrame, groupStreetsByClass, MAP_PALETTES } from './render.js';

const BUNDLE_URL = 'data/bundle.json';
const MODE_TWEEN_MS = 600;
const CANVAS_PADDING = 16;
const THEME_STORAGE_KEY = 'bay-theme';

const state = {
    // Data
    bundle: null,
    projection: null,
    streetGroups: null,
    anchorDisp: null,     // { [modeKey]: Float32Array [dLon0, dLat0, ...] }
    tripDisp: null,       // per trip: { [modeKey]: {geo, disps: { [modeKey]: Float32Array }} }
    // Interaction
    t: 0.0,               // morph 0..1 (geography <-> time-space)
    fromMode: 'freeflow', // tween start mode
    toMode: 'freeflow',   // tween end mode (settled when currentBlend === 1)
    currentBlend: 1,      // 0 = fromMode, 1 = toMode (settled state: 1)
    tweenStart: 0,
    tweening: false,
    showXray: false,
    selectedTripIndex: -1,
    // Theme ('dark' | 'light'); the boot script in index.html sets the initial attribute.
    theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
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

    // Bundle-driven mode set: the pipeline is the single source of truth for
    // which scenarios exist. The default active mode is the first one.
    const defaultMode = bundle.modes[0].key;
    state.fromMode = defaultMode;
    state.toMode = defaultMode;

    setStatus('Computing warp field for streets and anchors...');
    // Yield once so the status text paints before the heavy precompute.
    await new Promise(r => setTimeout(r, 20));

    prepareAll(bundle);

    // Canvas setup
    state.canvas = document.getElementById('map-canvas');
    state.ctx = state.canvas.getContext('2d', { alpha: false });
    resizeCanvas();

    // UI wire-up
    setupModeToggle();
    setupThemeToggle();
    setupMorphSlider();
    setupXrayToggle();
    setupTripsPanel();
    setupKeyboard();

    // Initial UI paint (mode + stress readout).
    applyMode(defaultMode, /*instant*/ true);

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
    const modeKeys = bundle.modes.map(m => m.key);
    const tposByMode = {};
    for (const m of modeKeys) tposByMode[m] = bundle.layouts[m].tpos;

    // Anchor displacements: for anchors themselves, disp = tpos - anchor, exact.
    const nA = anchors.length;
    const anchorDisp = {};
    for (const m of modeKeys) anchorDisp[m] = new Float32Array(nA * 2);
    for (let i = 0; i < nA; i++) {
        for (const m of modeKeys) {
            anchorDisp[m][i * 2]     = tposByMode[m][i][0] - anchors[i][0];
            anchorDisp[m][i * 2 + 1] = tposByMode[m][i][1] - anchors[i][1];
        }
    }
    state.anchorDisp = anchorDisp;

    // Street displacements via KNN warp field.
    const streetGeo = bundle.streets.map(s => new Float32Array(s.pts));
    const streetDisp = precomputeDisplacements(streetGeo, anchors, tposByMode);
    const streets = bundle.streets.map((s, i) => ({ cls: s.cls, pts: streetGeo[i] }));
    state.streetGroups = groupStreetsByClass(streets, streetDisp);

    // Trip path displacements: each trip has one polyline per mode. We
    // precompute its warp field under every mode's layout so a mode switch
    // can crossfade the polyline's shape smoothly. On mode change the trip
    // ALSO swaps to that mode's routed path (routes differ under congestion).
    state.tripDisp = bundle.trips.map(trip => {
        const packed = {};
        for (const modeKey of modeKeys) {
            const path = trip.paths[modeKey];
            if (!path || path.length < 4) { packed[modeKey] = null; continue; }
            const geo = new Float32Array(path);
            const disp = precomputeDisplacements([geo], anchors, tposByMode);
            const disps = {};
            for (const m of modeKeys) disps[m] = disp[m][0];
            packed[modeKey] = { geo, disps };
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

function setupThemeToggle() {
    const btn = document.getElementById('theme-toggle');
    btn.addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = state.theme;
        localStorage.setItem(THEME_STORAGE_KEY, state.theme);
        state.needsFrame = true;
    });
}

function applyMode(modeKey, instant) {
    if (!state.bundle.modes.some(m => m.key === modeKey)) return;

    // Snap the current in-flight tween to its landing point before starting a new one.
    // Otherwise a rapid switch would compound a partial blend with a new fromMode.
    if (state.tweening) {
        state.fromMode = state.toMode;
        state.currentBlend = 1;
        state.tweening = false;
    }

    if (modeKey === state.toMode) {
        // Already targeting this mode. Nothing to animate, but still refresh UI.
    } else {
        state.fromMode = state.toMode;
        state.toMode = modeKey;
        state.currentBlend = 0;
        if (instant) {
            state.currentBlend = 1;
            state.fromMode = modeKey;
            state.tweening = false;
        } else {
            state.tweenStart = performance.now();
            state.tweening = true;
        }
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
    const modes = state.bundle.modes;
    const activeMode = state.toMode;
    // "Other" mode for the delta chip: pick the next mode in the shipped list
    // (wrapping), so a three-mode UI still exposes one at-a-glance comparison
    // per row and the chip tooltip names which one.
    const activeIdx = modes.findIndex(m => m.key === activeMode);
    const otherMode = modes[(activeIdx + 1) % modes.length].key;
    const otherLabel = modes[(activeIdx + 1) % modes.length].label;

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
        // Built with createElement/textContent (not innerHTML) so bundle strings
        // can never be interpreted as markup.
        const span = (cls, text) => {
            const el = document.createElement('span');
            el.className = cls;
            el.textContent = text;
            return el;
        };
        const endpoints = document.createElement('div');
        endpoints.className = 'trip-endpoints';
        const arrow = span('trip-arrow', '→');
        arrow.setAttribute('aria-hidden', 'true');
        endpoints.append(span('trip-from', trip.from), arrow, span('trip-to', trip.to));
        const metrics = document.createElement('div');
        metrics.className = 'trip-metrics';
        const miles = span('trip-miles', '');
        miles.append(span('num', trip.miles.toFixed(1)), span('unit', 'mi'));
        const mins = span('trip-minutes', '');
        mins.append(span('num', activeMin.toFixed(1)), span('unit', 'min'));
        const deltaEl = span('trip-delta', `${deltaStr} min`);
        deltaEl.title = `vs ${otherLabel}`;
        metrics.append(miles, mins, deltaEl);
        row.append(endpoints, metrics);
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
        state.currentBlend = eased;
        state.needsFrame = true;
        if (p >= 1) {
            state.tweening = false;
            state.currentBlend = 1;
            // Collapse to the settled mode so a subsequent switch tweens cleanly.
            state.fromMode = state.toMode;
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
        // Pick the routed polyline for whichever endpoint mode is currently
        // dominating the blend (>=0.5 -> toMode, else fromMode). Falls back to
        // whichever exists if one is missing.
        const preferTo = state.currentBlend >= 0.5;
        const primary = preferTo ? state.toMode : state.fromMode;
        const backup  = preferTo ? state.fromMode : state.toMode;
        highlighted = packed[primary] || packed[backup] || null;
    }

    // Stress values per anchor come from the settled/target mode.
    const stress = state.bundle.layouts[state.toMode].stress;

    renderFrame(state.ctx, {
        canvas: state.canvas,
        dpr: state.dpr,
        projection: state.projection,
        groups: state.streetGroups,
        anchors: state.bundle.anchors,
        anchorDisp: state.anchorDisp,
        stress,
        t: state.t,
        fromMode: state.fromMode,
        toMode: state.toMode,
        modeBlend: state.currentBlend,
        showXray: state.showXray,
        highlightedTrip: highlighted,
        palette: MAP_PALETTES[state.theme],
    });
}

// -----------------------------------------------------------------------------

boot().catch(err => {
    console.error(err);
    setStatus('Something went wrong loading the map. See console for details.', true);
});
