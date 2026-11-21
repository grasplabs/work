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
// into one, and never anyone one by one. Everything here is pure.

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
  /** How many people asked him something each week of the span, oldest first, every week however quiet. */
  weeks: { week: string; people: number }[];
  /** How the requests spread over the people who made them. */
  spread: { least: number; most: number | null; people: number }[];
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

/**
 * The tools he called most for `topic`: only those he called for five or
 * more of its people, as `byTool` names them, so a topic's row never names
 * what one or two people had done.
 */
const topicTools = (
  shown: readonly StephenRequest[],
  topic: string
): { key: RequestTool; calls: number }[] => {
  const tools = new Map<RequestTool, { calls: number; people: Set<string> }>();
  for (const request of shown) {
    if (request.topic !== topic) {
      continue;
    }
    for (const call of request.tools) {
      const tool = tools.get(call.id) ?? { calls: 0, people: new Set() };
      tool.calls += 1;
      tool.people.add(request.personId);
      tools.set(call.id, tool);
    }
  }
  return [...tools]
    .filter(([, { people }]) => people.size >= fewestPeople)
    .map(([key, { calls }]) => ({ key, calls }))
    .toSorted((a, b) => b.calls - a.calls)
    .slice(0, 3);
};

/** The Mondays from the week `from` is in to the week `to` is in, oldest first. */
const mondaysOf = (from: string, to: string): string[] => {
  const mondays: string[] = [];
  for (let at = weekOf(from); at <= to; at = dayFrom(at, 7)) {
    mondays.push(at);
  }
  return mondays;
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
 * over people. `reach` is how many people of each team can reach him,
 * so a team's share can be said.
 */
export const requestsReport = (
  requests: readonly StephenRequest[],
  span: RequestSpan,
  { reach }: { reach: ReadonlyMap<string, number> }
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
    // Every week of the span, a quiet one as none, so no gap closes up.
    weeks: mondaysOf(span.from, span.to).map((week) => ({
      week,
      people: peopleIn(
        shown.filter(({ day }) => day >= week && day <= dayFrom(week, 6))
      ),
    })),
    spread: spreadBuckets.map(([least, most]) => ({
      least,
      most,
      people: [...perPersonCounts.values()].filter(
        (each) => each.length >= least && (most === null || each.length <= most)
      ).length,
    })),
  };
};

/* ── Over RPC ─────────────────────────────────────────────────────────── */

/** The requests billed this month, the whole company's. */
export interface MonthBilled {
  billed: number;
}

/** Stephen's week, for the card on the first agent's Access tab. */
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
  /** Stephen's week, for the first agent's Access tab. */
  week: () => Promise<StephenWeek>;
  /** The requests billed this month and what the plan includes, for Settings › Billing. */
  billed: () => Promise<MonthBilled>;
}
