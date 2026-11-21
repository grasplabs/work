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
// stephen-requests.ts) and builds Stephen's week from them with
// `requestsReport`: a question is named only once five or more people
// asked it, and never anyone one by one. Everything here is pure.

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

/**
 * One request as Stephen's week reads it: a day, who asked, how it ended,
 * the question it was and the tools he called. Labels only, never the
 * words and never the time of day.
 */
export interface StephenRequest {
  /** `YYYY-MM-DD`, in the organization's time zone. */
  day: string;
  personId: string;
  outcome: RequestOutcome;
  /** The topic it was sorted into, by id; null until (or unless) it was. */
  topic: string | null;
  /** The question it was, by id, when it is one of those Grasp named. */
  question: string | null;
  /** The tools he called for it, in order, each with whether it worked. */
  tools: RequestToolCall[];
}

/** Groups of fewer people than this are left out or folded into one, so no group points at a few people. */
export const fewestPeople = 5;

/** The key of the group the small ones are folded into. */
export const elsewhere = "elsewhere";

/** A span of days, both ends included. */
export interface RequestSpan {
  from: string;
  to: string;
}

/** What Stephen's week reads of a span. A question asked by fewer than five people is left out. */
export interface RequestsReport {
  /** What five or more people asked that he did not know, most asked first. */
  unanswered: {
    topic: string;
    question: string;
    requests: number;
    people: number;
  }[];
  /** How many people asked him something each week of the span, oldest first, every week however quiet. */
  weeks: { week: string; people: number }[];
}

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

/** The calendar month `today` is in: a billing month. */
export const monthSpan = (today: string): RequestSpan => ({
  from: monthFrom(today, 0),
  to: dayFrom(monthFrom(today, 1), -1),
});

/** The Monday of the week `day` is in. */
export const weekOf = (day: string): string => {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return dayFrom(day, -weekday);
};

const peopleIn = (requests: readonly StephenRequest[]): number =>
  new Set(requests.map(({ personId }) => personId)).size;

/** The Mondays from the week `from` is in to the week `to` is in, oldest first. */
const mondaysOf = (from: string, to: string): string[] => {
  const mondays: string[] = [];
  for (let at = weekOf(from); at <= to; at = dayFrom(at, 7)) {
    mondays.push(at);
  }
  return mondays;
};

/** The unanswered requests by their topic and question, those without either left out. */
const unansweredGroups = (
  requests: readonly StephenRequest[]
): Map<string, StephenRequest[]> => {
  const groups = new Map<string, StephenRequest[]>();
  for (const request of requests) {
    if (
      request.outcome !== "unanswered" ||
      request.topic === null ||
      request.question === null
    ) {
      continue;
    }
    const key = `${request.topic}\u0000${request.question}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [request]);
    } else {
      group.push(request);
    }
  }
  return groups;
};

/** The report of the requests in a span: the questions he didn't know, and the people a week. */
export const requestsReport = (
  requests: readonly StephenRequest[],
  span: RequestSpan
): RequestsReport => {
  const shown = requests.filter(
    ({ day }) => day >= span.from && day <= span.to
  );
  return {
    unanswered: [...unansweredGroups(shown)]
      .map(([key, group]) => {
        const [topic = "", question = ""] = key.split("\u0000");
        return {
          topic,
          question,
          requests: group.length,
          people: peopleIn(group),
        };
      })
      .filter(({ people }) => people >= fewestPeople)
      .toSorted((a, b) => b.people - a.people || b.requests - a.requests),
    // Every week of the span, a quiet one as none, so no gap closes up.
    weeks: mondaysOf(span.from, span.to).map((week) => ({
      week,
      people: peopleIn(
        shown.filter(({ day }) => day >= week && day <= dayFrom(week, 6))
      ),
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
  /** The requests billed this month, for Settings › Billing. */
  billed: () => Promise<MonthBilled>;
}
