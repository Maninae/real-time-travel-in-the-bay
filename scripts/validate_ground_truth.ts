/**
 * Ground-truth validation set: compares modeled travel times against measured
 * or well-documented Bay Area drives. Doubles as a regression guard.
 *
 * Two kinds of assertions:
 *   1. Per-trip absolute-minute bounds. Wide bounds intentionally: the point
 *      is to catch major regressions (e.g. an edit that halves SF times), not
 *      to fit noise. A 1.5x cushion around Google-Maps typical times is
 *      typical. The 1.5 km hex-anchor snap alone can move any single trip by
 *      a few minutes, so tighter would be false precision.
 *   2. Ratio checks -- e.g. dense-SF-per-mile / freeway-corridor-per-mile.
 *      These are the LOAD-BEARING invariants (they encode measured
 *      ground-truth observations, which are why the validation set exists)
 *      and keep tight tolerances.
 *
 * If a trip check fails but the ratio checks still pass, the model is in
 * the right accuracy neighborhood but the trip bound needs a wider window.
 * If a ratio check fails, the model has drifted from ground truth.
 *
 * Run:
 *   npm run route && npm run validate
 * or standalone:
 *   npx tsx scripts/validate_ground_truth.ts
 */

import { readFileSync } from "node:fs";
import { haversineMeters } from "../src/geo/haversine.ts";
import { SCENARIO_KEYS, type ScenarioKey } from "../src/traffic/scenarios.ts";

const METERS_PER_MILE = 1609.34;

interface Bounds { min: number; max: number; }
type ScenarioBounds = Partial<Record<ScenarioKey, Bounds>>;

interface GroundTruthTrip {
  from: { name: string; lat: number; lon: number };
  to: { name: string; lat: number; lon: number };
  /** Expected minutes per scenario. Missing scenarios are not checked. */
  expected: ScenarioBounds;
  /** Where the number came from -- shown in the report. */
  source: string;
}

const GROUND_TRUTH: GroundTruthTrip[] = [
  // 1. Measured North Beach drive: 1.5 mi in ~10 min ~= 9 mph.
  //    Use a longer intra-SF pair (Chinatown -> Coit Tower) so anchor snap noise
  //    is a small fraction of the trip; the audit's headline speed test is
  //    "intra-SF pairs, 1-3 km".
  {
    from: { name: "Chinatown Gate (Grant/Bush)", lat: 37.7908, lon: -122.4058 },
    to:   { name: "Coit Tower (Telegraph Hill)", lat: 37.8025, lon: -122.4058 },
    expected: {
      freeflow: { min: 3.0, max: 10.0 },   // ~1 mi straight, 1.3-1.6 road-mi
      midday:   { min: 5.0, max: 14.0 },
      friday:   { min: 5.5, max: 15.0 },
    },
    source: "Measured drive 2026-09-10: 1.5 mi in 10 min ~= 9 mph in North Beach.",
  },

  // 2. Measured Peninsula freeway corridor: mid-San Mateo -> Daly City ~20 min.
  //    Mostly US-101. Note: 14.7 mi straight-line, 15-16 mi road via 101.
  //    12 min freeflow would require 74 mph avg -- impossible with any at-grade
  //    approach, so bounds start higher.
  {
    from: { name: "Mid-San Mateo (Hillsdale)", lat: 37.5389, lon: -122.3020 },
    to:   { name: "Daly City (BART)", lat: 37.7060, lon: -122.4694 },
    expected: {
      freeflow: { min: 15.0, max: 28.0 },
      midday:   { min: 17.0, max: 32.0 },
      friday:   { min: 22.0, max: 55.0 },
    },
    source: "Measured drive 2026-09-10: ~20 min midday on US-101.",
  },

  // 3. SF Ferry Building -> Downtown Oakland via Bay Bridge (I-80).
  //    Google Maps typical times: 15-20 min at free-flow, 25-45 min at PM peak.
  //    Distance ~9 mi. Bay Bridge deliberately swings high at Friday to model the
  //    metering-light backup.
  {
    from: { name: "SF Ferry Building", lat: 37.7955, lon: -122.3937 },
    to:   { name: "Downtown Oakland (12th St BART)", lat: 37.8044, lon: -122.2712 },
    expected: {
      freeflow: { min: 12.0, max: 25.0 },
      midday:   { min: 18.0, max: 40.0 },
      friday:   { min: 25.0, max: 65.0 },
    },
    source: "Google Maps typical times WB Bay Bridge; SFMTA / MTC Bay Bridge congestion reports.",
  },

  // 4. SF -> Palo Alto (Ferry Building -> Palo Alto downtown).
  //    Google Maps typical: 40-50 min free flow (~34 mi), 60-90 min PM peak.
  {
    from: { name: "SF Ferry Building", lat: 37.7955, lon: -122.3937 },
    to:   { name: "Palo Alto downtown", lat: 37.4419, lon: -122.143 },
    expected: {
      freeflow: { min: 35.0, max: 55.0 },
      midday:   { min: 40.0, max: 65.0 },
      friday:   { min: 55.0, max: 100.0 },
    },
    source: "Google Maps typical times SF <-> Palo Alto (US-101 south).",
  },

  // 5. Outer Sunset -> Ferry Building (SF cross-town).
  //    Google Maps typical: 20-30 min free-flow, 30-45 min PM peak. Distance ~7 mi road.
  //    The route is almost entirely SF surface streets, so intersection penalties
  //    dominate and free-flow lands at the high end of the range.
  {
    from: { name: "Outer Sunset (Judah/45th)", lat: 37.7616, lon: -122.5013 },
    to:   { name: "SF Ferry Building", lat: 37.7955, lon: -122.3937 },
    expected: {
      freeflow: { min: 15.0, max: 30.0 },
      midday:   { min: 20.0, max: 40.0 },
      friday:   { min: 25.0, max: 50.0 },
    },
    source: "Google Maps typical times SF cross-town via Fell/Oak; TomTom SF-average speed.",
  },

  // 6. Sausalito -> SF Ferry Building via Golden Gate Bridge.
  //    Google Maps typical: 15-20 min free-flow, 25-40 min PM peak SB. Distance ~7 mi.
  {
    from: { name: "Sausalito", lat: 37.8591, lon: -122.4853 },
    to:   { name: "SF Ferry Building", lat: 37.7955, lon: -122.3937 },
    expected: {
      freeflow: { min: 12.0, max: 25.0 },
      midday:   { min: 15.0, max: 32.0 },
      friday:   { min: 20.0, max: 50.0 },
    },
    source: "Google Maps typical times Sausalito -> SF via Golden Gate.",
  },

  // 7. Berkeley -> Downtown Oakland (short East Bay hop).
  //    Google Maps typical: 10-15 min free-flow, 15-25 min PM peak. Distance ~5 mi road.
  //    Route is arterial (Telegraph/San Pablo), so intersection penalties push
  //    the freeflow number toward the high end.
  {
    from: { name: "Downtown Berkeley", lat: 37.8719, lon: -122.2585 },
    to:   { name: "Downtown Oakland (12th St BART)", lat: 37.8044, lon: -122.2712 },
    expected: {
      freeflow: { min: 8.0, max: 20.0 },
      midday:   { min: 10.0, max: 25.0 },
      friday:   { min: 12.0, max: 30.0 },
    },
    source: "Google Maps typical times Berkeley <-> Oakland (Telegraph / I-580).",
  },

  // 8. Palo Alto -> Hayward across the Dumbarton Bridge.
  //    Google Maps typical: 25-32 min free-flow, 35-55 min PM peak. Distance ~20 mi road.
  {
    from: { name: "Palo Alto downtown", lat: 37.4419, lon: -122.143 },
    to:   { name: "Downtown Hayward", lat: 37.6688, lon: -122.0808 },
    expected: {
      freeflow: { min: 22.0, max: 40.0 },
      midday:   { min: 26.0, max: 50.0 },
      friday:   { min: 32.0, max: 75.0 },
    },
    source: "Google Maps typical times PA <-> Hayward via Dumbarton Bridge (CA-84).",
  },
];

// Ratio check: dense-SF per-mile time should be ~4-4.5x the Peninsula
// freeway corridor's at midday. Baked in as a separate assertion because it
// is the top-level thing this whole exercise is trying to fix.
interface RatioCheck {
  label: string;
  scenario: ScenarioKey;
  numerator: { from: number; to: number }; // trip indexes into GROUND_TRUTH
  denominator: { from: number; to: number };
  expected: Bounds; // ratio bounds
  source: string;
}

const RATIO_CHECKS: RatioCheck[] = [
  {
    label: "dense-SF per-mile time vs Peninsula-freeway corridor (midday)",
    scenario: "midday",
    numerator: { from: 0, to: 0 },   // North Beach short drive: 1.5 mi
    denominator: { from: 1, to: 1 }, // San Mateo -> Daly City: ~11 mi US-101
    // Tightened from the initial 2.5-6.0x regression guard. The honest
    // (bbox-free, principled) model lands at ~3.56x, and the ground-truth
    // observation is ~4x. A 3.0-5.0x window is meaningful accuracy: it
    // rejects models that flatten SF back to the v1 1.5x band, and it
    // rejects models that overshoot (e.g. by re-adding the removed dense-SF
    // hand-drawn uplift). Denominator note: the SM->DC corridor is ~46%
    // slow in the model (see build notes finding #3), which biases this
    // ratio downward -- if the corridor is fixed, expect this to migrate
    // toward 4.5-5x.
    expected: { min: 3.0, max: 5.0 },
    source: "Measured ground truth: SF surface ~4-4.5x freeway per mile at midday.",
  },
];

interface Anchor { lat: number; lon: number; node: number; }
interface Layout { anchors: { lat: number; lon: number; tlat: number; tlon: number }[]; }
interface TimesFile { n: number; minutes: number[]; }

function nearestAnchorIndex(lat: number, lon: number, anchors: Anchor[]): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = haversineMeters(lat, lon, anchors[i].lat, anchors[i].lon);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function loadMatrix(scenario: ScenarioKey): TimesFile {
  return JSON.parse(readFileSync(`data/times__${scenario}.json`, "utf8"));
}

interface CheckResult {
  label: string;
  scenario: ScenarioKey;
  implied: number;
  expected: Bounds;
  extras?: string;
  pass: boolean;
}

function checkBounds(implied: number, expected: Bounds): boolean {
  return implied >= expected.min && implied <= expected.max;
}

function main(): void {
  const { anchors } = JSON.parse(readFileSync("data/anchors.json", "utf8")) as { anchors: Anchor[] };
  const matrixByScenario: Record<string, TimesFile> = {};
  for (const s of SCENARIO_KEYS) matrixByScenario[s] = loadMatrix(s);

  // Also load geo distance so we can print per-mile speed alongside.
  const results: CheckResult[] = [];

  console.log("Ground-truth trip checks");
  console.log("========================\n");
  const perTripMinutes: Record<string, Partial<Record<ScenarioKey, number>>> = {};
  const perTripMiles: number[] = [];

  GROUND_TRUTH.forEach((trip, idx) => {
    const fromIdx = nearestAnchorIndex(trip.from.lat, trip.from.lon, anchors);
    const toIdx = nearestAnchorIndex(trip.to.lat, trip.to.lon, anchors);
    const fromAnchor = anchors[fromIdx];
    const toAnchor = anchors[toIdx];
    const snapDistFrom = haversineMeters(trip.from.lat, trip.from.lon, fromAnchor.lat, fromAnchor.lon);
    const snapDistTo = haversineMeters(trip.to.lat, trip.to.lon, toAnchor.lat, toAnchor.lon);
    const straightMi = haversineMeters(trip.from.lat, trip.from.lon, trip.to.lat, trip.to.lon) / METERS_PER_MILE;
    perTripMiles[idx] = straightMi;
    perTripMinutes[idx] = {};

    console.log(`[${idx + 1}] ${trip.from.name} -> ${trip.to.name}`);
    console.log(`    straight-line ${straightMi.toFixed(2)} mi | anchor snap ${Math.round(snapDistFrom)}m / ${Math.round(snapDistTo)}m`);
    console.log(`    source: ${trip.source}`);

    for (const scenario of SCENARIO_KEYS) {
      const expected = trip.expected[scenario];
      if (!expected) continue;
      const matrix = matrixByScenario[scenario];
      const minutes = matrix.minutes[fromIdx * matrix.n + toIdx];
      perTripMinutes[idx][scenario] = minutes;
      const pass = checkBounds(minutes, expected);
      const mph = minutes > 0 ? (straightMi / minutes) * 60 : 0;
      const mark = pass ? "PASS" : "FAIL";
      console.log(
        `    ${scenario.padEnd(8)} ${minutes.toFixed(1).padStart(6)} min` +
        `  (expect ${expected.min}-${expected.max})` +
        `  ~ ${mph.toFixed(1)} mph straight-line  [${mark}]`,
      );
      results.push({
        label: `${trip.from.name} -> ${trip.to.name}`,
        scenario, implied: minutes, expected, pass,
      });
    }
    console.log();
  });

  console.log("\nRatio checks");
  console.log("============\n");
  for (const check of RATIO_CHECKS) {
    const num = perTripMinutes[check.numerator.from][check.scenario];
    const den = perTripMinutes[check.denominator.from][check.scenario];
    const numMi = perTripMiles[check.numerator.from];
    const denMi = perTripMiles[check.denominator.from];
    if (num === undefined || den === undefined || numMi === undefined || denMi === undefined) {
      console.log(`SKIP ${check.label}: missing dependent trip data`);
      continue;
    }
    const perMiNum = num / numMi;
    const perMiDen = den / denMi;
    const ratio = perMiNum / perMiDen;
    const pass = ratio >= check.expected.min && ratio <= check.expected.max;
    const mark = pass ? "PASS" : "FAIL";
    console.log(
      `${check.label}\n  ratio = ${ratio.toFixed(2)}x  (expect ${check.expected.min}-${check.expected.max}x)  [${mark}]\n` +
      `  numerator ${perMiNum.toFixed(2)} min/mi, denominator ${perMiDen.toFixed(2)} min/mi\n` +
      `  source: ${check.source}\n`,
    );
    results.push({
      label: check.label,
      scenario: check.scenario,
      implied: ratio,
      expected: check.expected,
      extras: `min/mi ${perMiNum.toFixed(2)} vs ${perMiDen.toFixed(2)}`,
      pass,
    });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const f of failed) {
      console.log(`  - ${f.label} [${f.scenario}]: implied ${f.implied.toFixed(2)} not in [${f.expected.min}, ${f.expected.max}]`);
    }
    process.exit(1);
  }
}

main();
