/**
 * Traffic scenarios: the closed set of "how bad is it right now" profiles the
 * map can render, in order from least to most congested.
 *
 * The v1 shipped set was ["freeflow", "friday"]. That could not express the
 * ratio measured on the ground: dense SF surface streets take ~4-4.5x per
 * mile what a Peninsula freeway takes at midday, because SF's per-mile cost
 * is dominated by traffic-signal delay (present all day) while the freeways
 * at midday are near free flow. Friday 5 pm cannot show that ratio, because
 * at Friday 5 pm the freeways ALSO crawl (Bay Bridge ~2.4x, US-101 ~1.9x),
 * which flattens the SF-vs-freeway ratio back down.
 *
 * "midday" is the new scenario that carries the biggest visible SF swelling:
 * intersection penalties at full weight (signals cycle whether or not there
 * is a queue), surface streets mildly slower than free flow, freeways near
 * free flow.
 *
 * Order matters: viewer mode toggles step through this array left to right.
 */

export const SCENARIO_KEYS = ["freeflow", "midday", "friday"] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export interface ScenarioMeta {
  key: ScenarioKey;
  label: string;
  note: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    key: "freeflow",
    label: "Speed limits",
    note: "driving at posted limits, empty roads (signals still cycle)",
  },
  {
    key: "midday",
    label: "Weekday midday",
    note: "modeled Tue-Thu 1 pm: freeways near free-flow, SF surface streets bite",
  },
  {
    key: "friday",
    label: "Friday 5 pm",
    note: "modeled peak rush hour: freeways crawl, chokepoints back up",
  },
];
