import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Stephen's requests outside Grasp: the unit his use is counted and priced
// by. One request is one message a known person sends him in a place
// outside Grasp (Teams, Slack, …) that he takes on: the platform sending
// the same message again, a press on a card he showed and a tap on a reply
// he offered are all part of it. Grasp's own chat is not counted: members'
// seats pay for it. Only finished work (`done`) is billed.
//
// A request carries labels, never words: the topic it was sorted into, the
// question it was in Grasp's own wording (named only once five or more
// people asked it), the tools he called and how each ended, and the thumb
// the person gave. Core keeps one record per request (core's
// stephen-requests.ts) and builds the report from them with
// `requestsReport`: every split's groups of fewer than five people folded
// into one, and people one by one only for owners and admins once an
// owner turned that on. Everything here is pure.

/** What he did with a request, the first that applies, read from what he did and never from what was written. */
export const requestKinds = [
  "answered",
  "lookedUp",
  "changed",
  "workflow",
] as const;
export type RequestKind = (typeof requestKinds)[number];

/**
 * How a request ended. Only finished work is billed (`done`): an answer,
 * a look-up in their apps, a change shown to confirm (pressed or not), a
 * workflow offered to start. A "don't know" or a question back
 * (`unanswered`), something he cannot do yet (`notPossible`: the app or
 * the action is off or missing, or the workflow is not open to him), a
 * stop (cut off, refused, over budget) and a failure are not.
 */
export const requestOutcomes = [
  "done",
  "unanswered",
  "notPossible",
  "stopped",
  "failed",
] as const;
export type RequestOutcome = (typeof requestOutcomes)[number];

/**
 * Why a tool he would need is not there for him: its app is off, the
 * action is off, the workflow is not open to asking, or there is no such
 * app or action yet.
 */
export const missingReasons = [
  "appOff",
  "actionOff",
  "workflowClosed",
  "noApp",
  "noAction",
] as const;
export type MissingReason = (typeof missingReasons)[number];

/**
 * A tool he called: the brain (`brain`), an action of an app as
 * `<connection or provider>.<action>`, or a workflow he offered to start
 * (`workflow:<id>`).
 */
export type RequestTool = string;

/** The brain, as a tool: what he searches to answer from the company's own knowledge. */
export const brainTool = "brain";

/** A tool he called for a request, and whether it worked. */
export interface RequestToolCall {
  id: RequestTool;
  ok: boolean;
}

/** A tool a request would have taken that is off or missing, and why. */
export interface MissingTool {
  id: RequestTool;
  why: MissingReason;
}

export const requestRatings = ["up", "down"] as const;
export type RequestRating = (typeof requestRatings)[number];

/** One request as core keeps it: labels and a day, never the words and never the time of day. */
export interface StephenRequest {
  /** The place's own id for the message, so a message sent twice counts once. */
  id: string;
  /** `YYYY-MM-DD`, in the organization's time zone. */
  day: string;
  /** The chat platform, by its adapter's name (`teams`, `slack`, …). */
  place: string;
  personId: string;
  teamId: string | null;
  kind: RequestKind;
  outcome: RequestOutcome;
  /** The topic it was sorted into, by id; null until (or unless) it was. */
  topic: string | null;
  /** The question it was, by id, when it is one of those Grasp named. */
  question: string | null;
  /** The tools he called for it, in order, each with whether it worked. */
  tools: RequestToolCall[];
  /** For one he could not do yet: the tools it would have taken that are off or missing. */
  missing: MissingTool[];
  /** The thumb the person gave his reply; most give none. */
  rating: RequestRating | null;
}

/** A split's groups of fewer people than this are folded into one, so no group points at a few people. */
export const fewestPeople = 5;

/** The key of the group the small ones are folded into. */
export const elsewhere = "elsewhere";

/** How much there was of one group: its requests, how many were billed, and how many people made them. */
export interface RequestCount {
  requests: number;
  billed: number;
  people: number;
}

/** How his replies were rated. */
export interface Thumbs {
  up: number;
  down: number;
}

/** One bar of the chart, a day or (over a year) a month: the billed requests by kind and by place, and those not billed. */
export interface RequestBar {
  at: string;
  kinds: Record<RequestKind, number>;
  places: Record<string, number>;
  notBilled: number;
}

/** A span of days, with whether its bars are days or months. */
export interface RequestSpan {
  from: string;
  to: string;
  by: "day" | "month";
}

/** A question many asked, by its topic and its id. */
export interface AskedQuestion extends Thumbs {
  topic: string;
  question: string;
  requests: number;
  people: number;
}

/** What a page shows of a span. Every split's groups of fewer than five people are already folded into `elsewhere`. */
export interface RequestsReport extends RequestSpan {
  total: RequestCount;
  /** Why requests were not billed. */
  notBilled: Record<Exclude<RequestOutcome, "done">, number>;
  bars: RequestBar[];
  /** The billed requests by kind, then those not billed (`notBilled`), whatever their kind. */
  byKind: (RequestCount & { key: string })[];
  byPlace: (RequestCount & { key: string })[];
  /** Per team, with how many people it has who can reach him. */
  byTeam: (RequestCount & { key: string; reach: number })[];
  /** Per topic, with the tools he called most for it and the thumbs its replies got. */
  byTopic: (RequestCount &
    Thumbs & { key: string; tools: { key: RequestTool; calls: number }[] })[];
  /** The questions five or more people asked, most asked first. */
  questions: AskedQuestion[];
  thumbs: Thumbs;
  /** Questions whose rated replies came from five or more people, at least four and a quarter of them down. */
  poorAnswers: (Thumbs & { topic: string; question: string; people: number })[];
  /** What five or more people asked that he cannot do yet, with the tools it would take. */
  notPossible: {
    topic: string;
    question: string;
    missing: MissingTool[];
    requests: number;
    people: number;
  }[];
  /** What five or more people asked that he did not know. */
  unanswered: {
    topic: string;
    question: string;
    requests: number;
    people: number;
  }[];
  /** Every tool he called for five or more people, the rest folded: how often, how often it failed. */
  byTool: { key: RequestTool; calls: number; failed: number; people: number }[];
  /** How many people asked him something each week of the span, oldest first. */
  weeks: { week: string; people: number }[];
  /** How the requests spread over the people who made them. */
  spread: { least: number; most: number | null; people: number }[];
  /** Per person, counts only; null for a viewer who may not see it. */
  byPerson: (Omit<RequestCount, "people"> & { key: string })[] | null;
}

/** From this share of rated replies down, once there are `poorDowns` of them, a question's answers count as poor. */
export const poorShare = 0.25;
export const poorDowns = 4;

/** The lengths of time a page shows: the billing month so far, the one before, and the twelve months up to this one. */
export const requestRanges = ["month", "lastMonth", "year"] as const;
export type RequestRange = (typeof requestRanges)[number];

const dayMs = 86_400_000;

/** The day `by` days after `day` (before, when negative). */
export const dayFrom = (day: string, by: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * dayMs)
    .toISOString()
    .slice(0, 10);

/** The first day of the month `by` months before or after the one `day` is in. */
const monthFrom = (day: string, by: number): string => {
  const [year = 1970, month = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + by, 1)).toISOString().slice(0, 10);
};

/** The days a range covers, in whole months. A billing month is a calendar month. */
export const rangeSpan = (range: RequestRange, today: string): RequestSpan => {
  const back = { month: 0, lastMonth: -1, year: -11 }[range];
  const from = monthFrom(today, back);
  const to = dayFrom(monthFrom(range === "lastMonth" ? from : today, 1), -1);
  return { from, to, by: range === "year" ? "month" : "day" };
};

/** The Monday of the week `day` is in. */
export const weekOf = (day: string): string => {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return dayFrom(day, -weekday);
};

const isBilled = (request: StephenRequest): boolean =>
  request.outcome === "done";

const peopleIn = (requests: readonly StephenRequest[]): number =>
  new Set(requests.map(({ personId }) => personId)).size;

const countOf = (requests: readonly StephenRequest[]): RequestCount => ({
  requests: requests.length,
  billed: requests.filter(isBilled).length,
  people: peopleIn(requests),
});

const thumbsOf = (requests: readonly StephenRequest[]): Thumbs => ({
  up: requests.filter(({ rating }) => rating === "up").length,
  down: requests.filter(({ rating }) => rating === "down").length,
});

/** Requests in groups by a key, in the order of first sight; a null key leaves a request out. */
const groupBy = (
  requests: readonly StephenRequest[],
  keyOf: (request: StephenRequest) => string | null
): Map<string, StephenRequest[]> => {
  const groups = new Map<string, StephenRequest[]>();
  for (const request of requests) {
    const key = keyOf(request);
    if (key === null) {
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [request]);
    } else {
      group.push(request);
    }
  }
  return groups;
};

/** Requests in groups by a key, the most billed first, the groups of fewer than five people folded into one at the end. */
const split = (
  requests: readonly StephenRequest[],
  keyOf: (request: StephenRequest) => string | null
): (RequestCount & { key: string })[] => {
  const rows: (RequestCount & { key: string })[] = [];
  const small: StephenRequest[] = [];
  for (const [key, group] of groupBy(requests, keyOf)) {
    const count = countOf(group);
    if (count.people < fewestPeople) {
      small.push(...group);
    } else {
      rows.push({ key, ...count });
    }
  }
  const sorted = rows.toSorted((a, b) => b.billed - a.billed);
  return small.length > 0
    ? [...sorted, { key: elsewhere, ...countOf(small) }]
    : sorted;
};

/** The buckets of the spread: one or two requests, up to five, ten, twenty, fifty, and more. */
const spreadBuckets: readonly [number, number | null][] = [
  [1, 2],
  [3, 5],
  [6, 10],
  [11, 20],
  [21, 50],
  [51, null],
];

const questionKey = (request: StephenRequest): string | null =>
  request.question === null || request.topic === null
    ? null
    : `${request.topic}\u0000${request.question}`;

const keyParts = (key: string): { topic: string; question: string } => {
  const [topic = "", question = ""] = key.split("\u0000");
  return { topic, question };
};

const emptyKinds = (): Record<RequestKind, number> => ({
  answered: 0,
  lookedUp: 0,
  changed: 0,
  workflow: 0,
});

const barsOf = (
  shown: readonly StephenRequest[],
  span: RequestSpan
): RequestBar[] => {
  const bars = new Map<string, RequestBar>();
  for (
    let at = span.from;
    at <= span.to;
    at = span.by === "day" ? dayFrom(at, 1) : monthFrom(at, 1)
  ) {
    bars.set(at, { at, kinds: emptyKinds(), places: {}, notBilled: 0 });
  }
  for (const request of shown) {
    const bar = bars.get(
      span.by === "day" ? request.day : `${request.day.slice(0, 7)}-01`
    );
    if (bar === undefined) {
      continue;
    }
    if (isBilled(request)) {
      bar.kinds[request.kind] += 1;
      bar.places[request.place] = (bar.places[request.place] ?? 0) + 1;
    } else {
      bar.notBilled += 1;
    }
  }
  return [...bars.values()];
};

const toolsOf = (shown: readonly StephenRequest[]) => {
  const tools = new Map<
    RequestTool,
    { calls: number; failed: number; people: Set<string> }
  >();
  for (const request of shown) {
    for (const call of request.tools) {
      const tool = tools.get(call.id) ?? {
        calls: 0,
        failed: 0,
        people: new Set<string>(),
      };
      tool.calls += 1;
      if (!call.ok) {
        tool.failed += 1;
      }
      tool.people.add(request.personId);
      tools.set(call.id, tool);
    }
  }
  const rows = [...tools]
    .map(([key, tool]) => ({
      key,
      calls: tool.calls,
      failed: tool.failed,
      people: tool.people,
    }))
    .toSorted((a, b) => b.calls - a.calls);
  const shownRows = rows
    .filter(({ people }) => people.size >= fewestPeople)
    .map(({ people, ...row }) => ({ ...row, people: people.size }));
  const small = rows.filter(({ people }) => people.size < fewestPeople);
  if (small.length === 0) {
    return shownRows;
  }
  const people = new Set(small.flatMap((row) => [...row.people]));
  return [
    ...shownRows,
    {
      key: elsewhere,
      calls: small.reduce((sum, row) => sum + row.calls, 0),
      failed: small.reduce((sum, row) => sum + row.failed, 0),
      people: people.size,
    },
  ];
};

const topicTools = (
  shown: readonly StephenRequest[],
  topic: string
): { key: RequestTool; calls: number }[] => {
  const calls = new Map<RequestTool, number>();
  for (const request of shown) {
    if (request.topic !== topic) {
      continue;
    }
    for (const tool of request.tools) {
      calls.set(tool.id, (calls.get(tool.id) ?? 0) + 1);
    }
  }
  return [...calls]
    .map(([key, count]) => ({ key, calls: count }))
    .toSorted((a, b) => b.calls - a.calls)
    .slice(0, 3);
};

const missingOf = (group: readonly StephenRequest[]): MissingTool[] => {
  const seen = new Map<RequestTool, MissingTool>();
  for (const request of group) {
    for (const tool of request.missing) {
      if (!seen.has(tool.id)) {
        seen.set(tool.id, tool);
      }
    }
  }
  return [...seen.values()];
};

/** The questions of `outcome` five or more people asked, most asked first. */
const askedWith = (shown: readonly StephenRequest[], outcome: RequestOutcome) =>
  [
    ...groupBy(shown, (each) =>
      each.outcome === outcome ? questionKey(each) : null
    ),
  ]
    .map(([key, group]) => ({
      ...keyParts(key),
      group,
      requests: group.length,
      people: peopleIn(group),
    }))
    .filter(({ people }) => people >= fewestPeople)
    .toSorted((a, b) => b.people - a.people || b.requests - a.requests);

/**
 * The report of the requests in a span: the counts, a bar per day or
 * month, the splits by kind, place, team and topic, the questions many
 * ask, the tools he called, the people a week, and how the requests spread
 * over people. Per person only with `perPerson`. `reach` is how many
 * people of each team can reach him, so a team's share can be said.
 */
export const requestsReport = (
  requests: readonly StephenRequest[],
  span: RequestSpan,
  {
    perPerson,
    reach,
  }: { perPerson: boolean; reach: ReadonlyMap<string, number> }
): RequestsReport => {
  const shown = requests.filter(
    ({ day }) => day >= span.from && day <= span.to
  );
  const billed = shown.filter(isBilled);
  const notBilled = shown.filter((each) => !isBilled(each));
  const asked = [...groupBy(shown, questionKey)];
  const perPersonCounts = groupBy(shown, ({ personId }) => personId);
  const outcomeCount = (outcome: RequestOutcome) =>
    notBilled.filter((each) => each.outcome === outcome).length;
  return {
    ...span,
    total: countOf(shown),
    notBilled: {
      unanswered: outcomeCount("unanswered"),
      notPossible: outcomeCount("notPossible"),
      stopped: outcomeCount("stopped"),
      failed: outcomeCount("failed"),
    },
    bars: barsOf(shown, span),
    byKind: [
      ...split(billed, ({ kind }) => kind),
      ...(notBilled.length > 0
        ? [{ key: "notBilled", ...countOf(notBilled) }]
        : []),
    ],
    byPlace: split(shown, ({ place }) => place),
    byTeam: split(shown, ({ teamId }) => teamId).map((row) => ({
      ...row,
      reach: row.key === elsewhere ? 0 : (reach.get(row.key) ?? 0),
    })),
    byTopic: split(shown, ({ topic }) => topic).map((row) => ({
      ...row,
      ...thumbsOf(shown.filter(({ topic }) => topic === row.key)),
      tools: row.key === elsewhere ? [] : topicTools(shown, row.key),
    })),
    questions: asked
      .map(([key, group]) => ({
        ...keyParts(key),
        requests: group.length,
        people: peopleIn(group),
        ...thumbsOf(group),
      }))
      .filter(({ people }) => people >= fewestPeople)
      .toSorted((a, b) => b.people - a.people || b.requests - a.requests),
    thumbs: thumbsOf(shown),
    poorAnswers: asked
      .map(([key, group]) => {
        const rated = group.filter(({ rating }) => rating !== null);
        return {
          ...keyParts(key),
          people: peopleIn(rated),
          ...thumbsOf(rated),
        };
      })
      .filter(
        (row) =>
          row.people >= fewestPeople &&
          row.down >= poorDowns &&
          row.down / (row.up + row.down) >= poorShare
      )
      .toSorted((a, b) => b.down / (b.up + b.down) - a.down / (a.up + a.down)),
    notPossible: askedWith(shown, "notPossible").map(({ group, ...row }) => ({
      ...row,
      missing: missingOf(group),
    })),
    unanswered: askedWith(shown, "unanswered").map(
      ({ group: _group, ...row }) => row
    ),
    byTool: toolsOf(shown),
    weeks: [...groupBy(shown, ({ day }) => weekOf(day))]
      .map(([week, group]) => ({ week, people: peopleIn(group) }))
      .toSorted((a, b) => a.week.localeCompare(b.week)),
    spread: spreadBuckets.map(([least, most]) => ({
      least,
      most,
      people: [...perPersonCounts.values()].filter(
        (each) => each.length >= least && (most === null || each.length <= most)
      ).length,
    })),
    byPerson: perPerson
      ? [...perPersonCounts]
          .map(([key, each]) => ({
            key,
            requests: each.length,
            billed: each.filter(isBilled).length,
          }))
          .toSorted((a, b) => b.billed - a.billed || a.key.localeCompare(b.key))
      : null,
  };
};

const billedIn = (bar: RequestBar): number =>
  Object.values(bar.kinds).reduce((sum, each) => sum + each, 0);

/**
 * Where the billed requests of a month will end if the rest of it goes as
 * the last week went: a pace, not a promise. Only for the month today is
 * in; a month that is over has its count.
 */
export const paceToEnd = (
  report: Pick<RequestsReport, "by" | "from" | "to" | "bars" | "total">,
  today: string
): number | null => {
  if (report.by !== "day" || today < report.from || today > report.to) {
    return null;
  }
  const week = report.bars.filter(
    (bar) => bar.at > dayFrom(today, -7) && bar.at <= today
  );
  const aDay =
    week.reduce((sum, bar) => sum + billedIn(bar), 0) /
    Math.max(1, week.length);
  const left = report.bars.filter((bar) => bar.at > today).length;
  return Math.round(report.total.billed + aDay * left);
};

/** Minutes a request of each kind saves the person who asked, unless the company set its own. */
export const defaultMinutesSaved: Readonly<Record<RequestKind, number>> = {
  answered: 4,
  lookedUp: 3,
  changed: 6,
  workflow: 20,
};

/** The minutes the billed requests of a report saved; from the bars, which fold no small group away. */
export const minutesSaved = (
  report: Pick<RequestsReport, "bars">,
  minutes: Partial<Record<RequestKind, number>> = {}
): number =>
  report.bars.reduce(
    (sum, bar) =>
      sum +
      requestKinds.reduce(
        (each, kind) =>
          each + bar.kinds[kind] * (minutes[kind] ?? defaultMinutesSaved[kind]),
        0
      ),
    0
  );

/**
 * The span to hold a range against: as many days of the month before as
 * have gone of this one, the whole month before last month, and nothing
 * for twelve months.
 */
export const spanBefore = (
  range: RequestRange,
  today: string
): RequestSpan | null => {
  if (range === "year") {
    return null;
  }
  const span = rangeSpan(range, today);
  const from = monthFrom(span.from, -1);
  const end = dayFrom(span.from, -1);
  if (range === "lastMonth") {
    return { from, to: end, by: "day" };
  }
  const to = dayFrom(from, Number(today.slice(8, 10)) - 1);
  return { from, to: to < end ? to : end, by: "day" };
};

/** How something grew against the span before: `new` when nobody asked it then, the growth when it grew by a fifth or more of at least ten, otherwise null. */
export const growth = (now: number, before: number): "new" | number | null => {
  if (now < fewestPeople) {
    return null;
  }
  if (before === 0) {
    return "new";
  }
  if (before < 10) {
    return null;
  }
  const change = now / before - 1;
  return change >= 0.2 ? change : null;
};

/** The last whole week, Monday to Sunday, before the week `today` is in, and the one before it. */
export const lastWeeks = (
  today: string
): { week: RequestSpan; before: RequestSpan } => {
  const monday = dayFrom(weekOf(today), -7);
  return {
    week: { from: monday, to: dayFrom(monday, 6), by: "day" },
    before: { from: dayFrom(monday, -7), to: dayFrom(monday, -1), by: "day" },
  };
};

/**
 * Teams that have hardly found him: five or more of their people can
 * reach him, and fewer than a third of them asked him anything in the
 * span. A team with fewer than five who asked is folded away in the
 * report, so says only that (`asked` is null).
 */
export const quietTeams = (
  report: Pick<RequestsReport, "byTeam">,
  reach: ReadonlyMap<string, number>
): { teamId: string; asked: number | null; reach: number }[] =>
  [...reach]
    .map(([teamId, people]) => {
      const row = report.byTeam.find(({ key }) => key === teamId);
      return {
        teamId,
        asked: row === undefined ? null : row.people,
        reach: people,
      };
    })
    .filter(
      (team) =>
        team.reach >= fewestPeople && (team.asked ?? 0) / team.reach < 1 / 3
    )
    .toSorted((a, b) => (a.asked ?? 0) / a.reach - (b.asked ?? 0) / b.reach);

/** The billed requests up to and with each day, from the first of the span, and the pace on from today: the line the plan block draws. */
export const runningTotal = (
  report: Pick<RequestsReport, "by" | "from" | "to" | "bars" | "total">,
  today: string
): { at: string; total: number | null; pace: number | null }[] => {
  let total = 0;
  const left = report.bars.filter((bar) => bar.at > today).length;
  const pace = paceToEnd(report, today);
  const aDay =
    pace === null || left === 0 ? 0 : (pace - report.total.billed) / left;
  return report.bars.map((bar) => {
    if (bar.at > today) {
      const ahead =
        report.total.billed +
        aDay *
          report.bars.filter((each) => each.at > today && each.at <= bar.at)
            .length;
      return { at: bar.at, total: null, pace: Math.round(ahead) };
    }
    total += billedIn(bar);
    return {
      at: bar.at,
      total,
      pace: bar.at === today && pace !== null ? total : null,
    };
  });
};

/* ── Over RPC ─────────────────────────────────────────────────────────── */

/** What the company set for Stephen's requests: kept in org settings, beside billing. */
export const stephenRequestSettingsSchema = z.strictObject({
  /** The requests the plan includes each month; null without a plan that counts them. */
  requestsIncluded: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .nullable()
    .default(null),
  /** The minutes a request of each kind saves, where the company set its own. */
  minutesSaved: z
    .strictObject({
      answered: z.number().int().min(0).max(600).optional(),
      lookedUp: z.number().int().min(0).max(600).optional(),
      changed: z.number().int().min(0).max(600).optional(),
      workflow: z.number().int().min(0).max(600).optional(),
    })
    .default({}),
  /**
   * People one by one, for owners and admins: off until an owner turns it
   * on (in the Netherlands the works council may need to agree first).
   */
  requestsPerPerson: z.boolean().default(false),
});
export type StephenRequestSettings = z.output<
  typeof stephenRequestSettingsSchema
>;
export type StephenRequestSettingsInput = z.input<
  typeof stephenRequestSettingsSchema
>;

/** The settings until an owner sets them. */
export const noRequestSettings: StephenRequestSettings = {
  requestsIncluded: null,
  minutesSaved: {},
  requestsPerPerson: false,
};

/** What a page may narrow the report to. */
export const requestsFilterSchema = z.strictObject({
  range: z.enum(requestRanges),
  place: z.string().min(1).max(64).nullable().default(null),
  team: z.string().min(1).max(128).nullable().default(null),
  /** One row's panel: a topic, a question, or a person (where people one by one may be seen). */
  topic: z.string().min(1).max(128).nullable().default(null),
  question: z.string().min(1).max(128).nullable().default(null),
  person: z.string().min(1).max(128).nullable().default(null),
});
export type RequestsFilter = z.input<typeof requestsFilterSchema>;

/** A name for an id the report holds: a topic, a team, a person, a question. */
export interface Named {
  id: string;
  name: string;
}

/** The report a page reads, with the names its ids stand for. */
export interface RequestsPage {
  today: string;
  range: RequestRange;
  /**
   * Whether the filter narrowed it to fewer than five people, so it holds
   * nothing: a team or a place that few would point at them.
   */
  tooFew: boolean;
  report: RequestsReport;
  /** The same over the span before (`spanBefore`), for growth; null for twelve months. */
  before: Pick<RequestsReport, "byTopic" | "questions" | "total"> | null;
  settings: StephenRequestSettings;
  /** The month's pace, for the month today is in. */
  pace: number | null;
  topics: Named[];
  /** The questions the report names: only those five or more people asked. */
  questions: (Named & { role: string | null })[];
  teams: (Named & { reach: number })[];
  /** The people `byPerson` names; empty unless the viewer may see them. */
  people: Named[];
  places: string[];
  /** Whether the viewer may turn people one by one on or off: an owner. */
  canSetPerPerson: boolean;
}

/** One thing Needs you lists: what to fix. */
export const needKinds = [
  "notPossible",
  "poorAnswer",
  "unanswered",
  "quietTeam",
] as const;
export type NeedKind = (typeof needKinds)[number];

export const needStatuses = ["working", "fixed", "leftAsIs"] as const;
export type NeedStatus = (typeof needStatuses)[number];

/** The id a need is kept by: its kind and what it is about. */
export const needKeySchema = z
  .string()
  .min(3)
  .max(300)
  .regex(/^(?:notPossible|poorAnswer|unanswered|quietTeam):[^\s]+$/u);

export interface Need {
  key: string;
  kind: NeedKind;
  /** The topic and question it is about, or the team. */
  topic: string | null;
  question: string | null;
  teamId: string | null;
  /** What it is about, as a page names it: the question in Grasp's wording, or the team's name. */
  label: string;
  /** How many people and requests it stands for; `reach` for a quiet team. */
  people: number | null;
  requests: number;
  reach: number | null;
  /** The thumbs, for a poor answer. */
  thumbs: Thumbs | null;
  /** The tools it would take and why they aren't there, for what he cannot do. */
  missing: MissingTool[];
  /** The role best placed to answer, for what he did not know. */
  role: string | null;
  /** Grasp's proposal, in the viewer's language; null until one could be made. */
  proposal: string | null;
  status: { status: NeedStatus; at: string; by: string } | null;
  /**
   * What happened since its status was set: the requests about it since,
   * how many of them he did, the thumbs they got, and how many people
   * asked (null under five).
   */
  since: {
    requests: number;
    done: number;
    up: number;
    down: number;
    people: number | null;
  } | null;
}

export const summaryVias = ["teams", "email"] as const;
export type SummaryVia = (typeof summaryVias)[number];

/** The weekly summary as it goes out, for a page to show before it does. */
export interface WeeklySummary {
  week: RequestSpan;
  billed: number;
  billedBefore: number;
  minutes: number;
  /** Needs new this week, up to three; and those fixed in the last four weeks, up to two. */
  fresh: Need[];
  fixed: Need[];
  pace: number | null;
  included: number | null;
  /** Where it goes to the viewer: off (null), Teams or mail. */
  via: SummaryVia | null;
  /** Whether Teams can carry it: the viewer has a chat with Stephen there. */
  teamsOpen: boolean;
}

/** Stephen's week, for the card on top of Settings › Stephen. */
export interface StephenWeek {
  /** People who asked him something these seven days, and people who may reach him. */
  asked: number;
  reach: number;
  /** People who asked him something each week, the last eight weeks, oldest first. */
  weeks: { week: string; people: number }[];
  /** The share of questions he answered over thirty days; null without any. */
  answeredShare: number | null;
  answered: number;
  questions: number;
  /** What five or more people asked that he could not answer, with the role best placed to. */
  unanswered: {
    question: string;
    wording: string;
    people: number;
    role: string | null;
  }[];
  /** Per app (pack): calls done and failed over thirty days. */
  packs: { pack: string; done: number; failed: number }[];
}

/** Stephen's requests over `/rpc`, on `stephenRequests`: owners and admins only. */
export interface StephenRequestsApi {
  /** The report of a range, narrowed to a place or a team. */
  report: (filter: RequestsFilter) => Promise<RequestsPage>;
  /** What the company set: the plan's requests, minutes saved, people one by one. */
  settings: () => Promise<StephenRequestSettings>;
  /** Changes them: the organization's own admins (owners) only; turning people one by one on or off is audited. */
  updateSettings: (
    settings: StephenRequestSettingsInput
  ) => Promise<StephenRequestSettings>;
  /** What to fix, with Grasp's proposal in `locale` and each item's status. */
  needs: (locale: string) => Promise<Need[]>;
  /** Sets, or clears (null), what is being done about a need. */
  setNeedStatus: (key: string, status: NeedStatus | null) => Promise<void>;
  /** The weekly summary as it would go to the viewer now. */
  summary: () => Promise<WeeklySummary>;
  /** Where the viewer's weekly summary goes: off (null), Teams or mail. */
  setSummary: (via: SummaryVia | null) => Promise<void>;
  /** Stephen's week, for Settings › Stephen. */
  week: () => Promise<StephenWeek>;
}

/** Why a call on Stephen's requests was refused. */
export const stephenRequestErrors = defineErrorFamily({
  "stephen_requests.settings_invalid":
    "Those aren't settings for Stephen's requests: a whole number of requests, minutes from 0 to 600 per kind.",
  "stephen_requests.filter_invalid":
    "That isn't a filter of Stephen's requests: this month, last month or twelve months, and a place or a team.",
  "stephen_requests.need_not_found": "There's nothing like that to fix.",
  "stephen_requests.teams_closed":
    "Stephen can only send it in Microsoft Teams once you've had a chat with him there.",
});
