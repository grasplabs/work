import { minTeamShown } from "@grasp-os/shared/onboarding";

import type {
  ObservedRoutine,
  ObservedRoutineStep,
  ObservedVariant,
} from "./contract.ts";

// Routines seen in activity (GRA-1764): the one reader of events
// (events.ts). Which step usually follows which, worked out by plain
// counting, the way process mining draws a directly-follows graph: each
// person's steps in a team, in the order they took them, are their trail,
// and each step and the one after it on a trail is a move. No model sees
// any of it. How it keeps to the rule that people are only ever shown
// what five of them did, and how each way round it is closed:
//
// - A move one to four people made: a move counts only when at least
//   `minTeamShown` distinct people of the team (`who`) made it, held in
//   the query itself, so no caller can lower it. Steps, timings and
//   variants are drawn from such moves alone. Five events of one person
//   are one person.
// - One person setting a figure: a timing is the middle of each person's
//   own middle, so someone who made a move a hundred times counts once.
// - Something of a person in the answer: never `who`, an item, a time, or
//   a count of people or of steps; only steps, hours between them, and
//   variants.
// - A routine outliving what it rests on: nothing here is kept. Each call
//   works it out again from the events there are, so after an erasure, an
//   expiry or an emptied table a routine resting on fewer than five
//   people is gone at the next call.

/** An hour, in milliseconds: events are kept to it. */
const hourMs = 60 * 60 * 1000;

/** A step as one value: its system and its kind. */
const keyOf = (system: string, step: string): string =>
  JSON.stringify([system, step]);

/** One kept move of one person, at one gap, and how often they made it at that gap. */
interface MoveRow extends Record<string, SqlStorageValue> {
  team: string;
  who: string;
  system: string;
  step: string;
  next_system: string;
  next_step: string;
  hours: number;
  times: number;
}

/**
 * Every move at least `minTeamShown` distinct people of its team made, by
 * person and gap: a move is a step and the next step of the same person in
 * the same team (by time, then by when it was kept), the same step twice
 * in a row aside.
 */
const keptMovesSql = `
WITH trail AS (
  SELECT team, who, system, step, at,
    LEAD(system) OVER w AS next_system,
    LEAD(step) OVER w AS next_step,
    LEAD(at) OVER w AS next_at
  FROM events
  WINDOW w AS (PARTITION BY team, who ORDER BY at, row)
),
moves AS (
  SELECT team, who, system, step, next_system, next_step,
    (next_at - at) / ${hourMs} AS hours
  FROM trail
  WHERE next_step IS NOT NULL
    AND NOT (next_system = system AND next_step = step)
),
kept AS (
  SELECT team, system, step, next_system, next_step
  FROM moves
  GROUP BY team, system, step, next_system, next_step
  HAVING COUNT(DISTINCT who) >= ?
)
SELECT moves.team, moves.who, moves.system, moves.step,
  moves.next_system, moves.next_step, moves.hours, COUNT(*) AS times
FROM moves
JOIN kept USING (team, system, step, next_system, next_step)
GROUP BY moves.team, moves.who, moves.system, moves.step,
  moves.next_system, moves.next_step, moves.hours`;

/** The middle of `values` counted `times` each: the mean of the two middles when even. */
const middleOf = (counted: ReadonlyMap<number, number>): number => {
  const sorted = [...counted].toSorted(([one], [other]) => one - other);
  const total = sorted.reduce((sum, [, times]) => sum + times, 0);
  /** The value at `place` (from 0) of the sorted whole. */
  const at = (place: number): number => {
    let seen = 0;
    for (const [value, times] of sorted) {
      seen += times;
      if (place < seen) {
        return value;
      }
    }
    return 0;
  };
  return total % 2 === 1
    ? at((total - 1) / 2)
    : (at(total / 2 - 1) + at(total / 2)) / 2;
};

/** A move kept in a team: where it goes and each person's gaps on it. */
interface Move {
  to: string;
  /** Each person's gaps, in hours, with how often each. */
  people: Map<string, Map<number, number>>;
}

/** How many hours a move takes: the middle of each person's own middle. */
const hoursOf = (move: Move): number => {
  const middles = new Map<number, number>();
  for (const gaps of move.people.values()) {
    const middle = middleOf(gaps);
    middles.set(middle, (middles.get(middle) ?? 0) + 1);
  }
  return middleOf(middles);
};

/** The moves from a step, most people first, then by step. */
const rankedOf = (moves: ReadonlyMap<string, Move>): Move[] =>
  [...moves.values()].toSorted(
    (one, other) =>
      other.people.size - one.people.size || one.to.localeCompare(other.to)
  );

/** The steps a team's routines start at: those no kept move leads to; else where its most made move starts. */
const startsOf = (graph: ReadonlyMap<string, Map<string, Move>>): string[] => {
  const reached = new Set(
    [...graph.values()].flatMap((moves) => [...moves.keys()])
  );
  const starts = [...graph.keys()].filter((from) => !reached.has(from));
  if (starts.length > 0) {
    return starts.toSorted();
  }
  const [busiest] = [...graph]
    .flatMap(([from, moves]) =>
      rankedOf(moves).map((move) => ({ from, people: move.people.size }))
    )
    .toSorted(
      (one, other) =>
        other.people - one.people || one.from.localeCompare(other.from)
    );
  return busiest === undefined ? [] : [busiest.from];
};

/**
 * The routine starting at `start` in a team's `graph`: each step followed
 * by the one most people take next, until none or one already on it.
 */
const routineFrom = (
  team: string,
  start: string,
  graph: ReadonlyMap<string, Map<string, Move>>,
  writing: ReadonlySet<string>,
  partsOf: (key: string) => { system: string; step: string }
): ObservedRoutine => {
  const path = [start];
  const hours: (number | null)[] = [null];
  for (;;) {
    const [next] = rankedOf(graph.get(path.at(-1) ?? "") ?? new Map());
    if (next === undefined || path.includes(next.to)) {
      break;
    }
    path.push(next.to);
    hours.push(hoursOf(next));
  }
  const steps = path.map((key, at): ObservedRoutineStep => {
    const { system, step } = partsOf(key);
    const writes = writing.has(`${team}\u0000${key}`);
    const before = at === 0 ? undefined : partsOf(path[at - 1] ?? "");
    return {
      system,
      step,
      writes,
      hoursAfter: hours[at] ?? null,
      copied: writes && before !== undefined && before.system !== system,
    };
  });
  const variants = path.flatMap((key, at): ObservedVariant[] =>
    rankedOf(graph.get(key) ?? new Map())
      .filter(({ to }) => to !== path[at + 1])
      .map(({ to }) => ({ after: at, ...partsOf(to) }))
  );
  return { team, steps, variants };
};

/**
 * The routines seen in every team's events now: one from each step its
 * kept moves start at (`startsOf`), each with at least two steps.
 */
export const observedRoutines = (sql: SqlStorage): ObservedRoutine[] => {
  const rows = sql.exec<MoveRow>(keptMovesSql, minTeamShown).toArray();
  const teams = new Map<string, Map<string, Map<string, Move>>>();
  // Each step's system and kind, by its key.
  const parts = new Map<string, { system: string; step: string }>();
  const partsOf = (key: string) => parts.get(key) ?? { system: "", step: "" };
  for (const row of rows) {
    const graph = teams.get(row.team) ?? new Map<string, Map<string, Move>>();
    teams.set(row.team, graph);
    const from = keyOf(row.system, row.step);
    const to = keyOf(row.next_system, row.next_step);
    const moves = graph.get(from) ?? new Map<string, Move>();
    graph.set(from, moves);
    parts.set(from, { system: row.system, step: row.step });
    parts.set(to, { system: row.next_system, step: row.next_step });
    const move: Move = moves.get(to) ?? {
      to,
      people: new Map<string, Map<number, number>>(),
    };
    moves.set(to, move);
    const gaps = move.people.get(row.who) ?? new Map<number, number>();
    move.people.set(row.who, gaps);
    gaps.set(row.hours, (gaps.get(row.hours) ?? 0) + row.times);
  }
  const writing = new Set(
    sql
      .exec<{ team: string; system: string; step: string }>(
        "SELECT DISTINCT team, system, step FROM events WHERE writes = 1"
      )
      .toArray()
      .map(({ team, system, step }) => `${team}\u0000${keyOf(system, step)}`)
  );
  return [...teams]
    .toSorted(([one], [other]) => one.localeCompare(other))
    .flatMap(([team, graph]) =>
      startsOf(graph).map((start) =>
        routineFrom(team, start, graph, writing, partsOf)
      )
    );
};
