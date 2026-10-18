import type { AccountEvent, AdminView } from "./admin-view.ts";
import { historyOf } from "./admin-view.ts";
import type { LogEvent } from "./onboarding-admin-record.ts";
import type { OrgEvent } from "./org-record.ts";
import type { TrailEntry } from "./trail.ts";

/**
 * The log of one organization as one list: what happened at the company day by day, what a person
 * at Grasp did by hand, and, where it is onboarded for real, everything the Worker noted with its
 * time. Each entry says what it is about and who did it, so the list can be narrowed; what two of
 * the three sources both tell is told once. Pure.
 *
 * Grasp OS's onboarding area shows the log core keeps itself, day by day and as CSV
 * (apps/web/src/onboarding/staff-log.ts), adapted from this.
 */

/** What an entry is about. */
export const LOG_TOPICS = [
  "interviews",
  "work",
  "people",
  "agreements",
  "platform",
  "setup",
] as const;
export type LogTopic = (typeof LOG_TOPICS)[number];

/** Who did it: a person at Grasp by hand, the company, someone in their interview, or Grasp by itself. */
export const LOG_ACTORS = ["grasp", "company", "person", "itself"] as const;
export type LogActor = (typeof LOG_ACTORS)[number];

/** Where an entry comes from, with what it was made from: the page says it in the reader's language. */
export type LogSource =
  | { from: "company"; event: LogEvent | AccountEvent }
  | { from: "hand"; entry: TrailEntry }
  | { from: "worker"; event: OrgEvent };

export interface LogItem {
  key: string;
  /** The day it happened, as the reader's own calendar has it. */
  on: string;
  /** The moment, where that is known; what is only known by its day has none. */
  at: number | null;
  topic: LogTopic;
  actor: LogActor;
  /** Something went wrong: a drawing that failed. */
  problem: boolean;
  /** The person, team or piece of work it is about, by id. */
  person?: string;
  team?: string;
  work?: string;
  source: LogSource;
}

const two = (value: number) => String(value).padStart(2, "0");

/** The day a moment falls on, on the reader's own calendar. */
export const localDay = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
};

const HAND_TOPIC: Record<TrailEntry["what"], LogTopic> = {
  made: "setup",
  transcript: "setup",
  reading: "setup",
  research: "setup",
  answer: "setup",
  passed: "setup",
  client: "setup",
  rules: "setup",
  rulesReset: "setup",
  stephen: "setup",
  stephenReset: "setup",
  threshold: "setup",
  company: "setup",
  contact: "setup",
  channel: "interviews",
  agreed: "agreements",
  contract: "agreements",
  go: "platform",
  goBack: "platform",
  part: "platform",
  invited: "platform",
  removed: "platform",
  restored: "platform",
  resent: "platform",
  role: "platform",
  asked: "platform",
  settled: "work",
  counted: "work",
  uncounted: "work",
  interviewRead: "interviews",
  interviewDeleted: "interviews",
  reminded: "interviews",
  away: "people",
  back: "people",
  teamIn: "people",
  teamOut: "people",
  teamAdded: "people",
  teamEdited: "people",
  teamRemoved: "people",
  leadSet: "people",
  personAdded: "people",
  personEdited: "people",
  personMoved: "people",
  personRemoved: "people",
  askedAbout: "people",
};

const COMPANY: Record<
  (LogEvent | AccountEvent)["kind"],
  { topic: LogTopic; actor: LogActor }
> = {
  contractSent: { topic: "agreements", actor: "grasp" },
  contractSigned: { topic: "agreements", actor: "company" },
  contractStarts: { topic: "agreements", actor: "itself" },
  agreement: { topic: "agreements", actor: "company" },
  connected: { topic: "platform", actor: "company" },
  invited: { topic: "platform", actor: "company" },
  joined: { topic: "platform", actor: "company" },
  live: { topic: "work", actor: "company" },
  conversation: { topic: "setup", actor: "company" },
  told: { topic: "interviews", actor: "company" },
  lead: { topic: "interviews", actor: "person" },
  reminded: { topic: "interviews", actor: "itself" },
  talked: { topic: "interviews", actor: "person" },
  go: { topic: "platform", actor: "grasp" },
  closed: { topic: "interviews", actor: "itself" },
};

/** What the Worker notes that the page says here; anything else it notes is told through another source, or not at all. */
const NOTED: Record<string, LogTopic> = {
  made: "setup",
  roster: "people",
  told: "interviews",
  sent: "interviews",
  opened: "interviews",
  started: "interviews",
  stopped: "interviews",
  completed: "interviews",
  interviewDeleted: "interviews",
  mapped: "work",
  drawn: "work",
  drawFailed: "work",
  drawGaveUp: "work",
  redraw: "work",
};

/**
 * What the Worker noted with its time takes the place of the same thing told by its day. A reminder
 * is not among it: the Worker notes none, so the day a link says one went is the only place it is
 * told (one sent by hand is told by hand instead, below).
 */
const TOLD_BY_WORKER: ReadonlySet<(LogEvent | AccountEvent)["kind"]> = new Set<
  (LogEvent | AccountEvent)["kind"]
>(["told", "lead", "talked"]);

/** Who did what the Worker noted, and what it is about. */
const byWorker = (
  event: OrgEvent,
  about: string,
  base: Omit<LogItem, "actor">
): LogItem | null => {
  const staff = event.by.includes("@");
  switch (event.what) {
    case "made": {
      return { ...base, actor: "grasp" };
    }
    case "roster": {
      return { ...base, actor: event.by === "client" ? "company" : "grasp" };
    }
    case "told": {
      return { ...base, actor: "company" };
    }
    case "sent": {
      return event.by === "grasp"
        ? { ...base, actor: "itself" }
        : { ...base, actor: "grasp", person: about };
    }
    case "opened":
    case "started":
    case "stopped":
    case "completed": {
      return { ...base, actor: "person", person: event.by };
    }
    case "interviewDeleted": {
      // Deleted by a person at Grasp, it is told as done by hand.
      return event.by === about
        ? { ...base, actor: "person", person: event.by }
        : null;
    }
    case "mapped": {
      return { ...base, actor: "itself", team: about };
    }
    case "drawn": {
      return { ...base, actor: "itself", work: about };
    }
    case "drawFailed":
    case "drawGaveUp": {
      const [kind, id] = about.split(":");
      return {
        ...base,
        actor: "itself",
        problem: true,
        ...(kind === "team" ? { team: id } : { work: id }),
      };
    }
    case "redraw": {
      return { ...base, actor: staff ? "grasp" : "itself" };
    }
    default: {
      return null;
    }
  }
};

const fromWorker = (event: OrgEvent, index: number): LogItem | null => {
  const topic = NOTED[event.what];
  if (!topic) {
    return null;
  }
  const at = Date.parse(event.at);
  if (Number.isNaN(at)) {
    return null;
  }
  const about = event.about ?? "";
  // What a person at Grasp did with its details is told as done by hand; here only what the Worker itself can say.
  if (about.startsWith("{")) {
    return null;
  }
  return byWorker(event, about, {
    key: `worker-${index}`,
    on: localDay(at),
    at,
    topic,
    problem: false,
    source: { from: "worker" as const, event },
  });
};

const fromHand = (entry: TrailEntry, index: number): LogItem => ({
  key: `hand-${index}`,
  on: localDay(entry.at),
  at: entry.at,
  topic: HAND_TOPIC[entry.what],
  actor: "grasp",
  problem: false,
  ...("person" in entry ? { person: entry.person } : {}),
  ...("team" in entry ? { team: entry.team } : {}),
  ...("work" in entry ? { work: entry.work } : {}),
  source: { from: "hand", entry },
});

/** Everything in an organization's log, the newest first; what is only known by its day comes after what has a time that day. */
export const logItemsOf = (
  view: AdminView,
  trail: TrailEntry[],
  activity: OrgEvent[] = []
): LogItem[] => {
  // Only where the Worker's activity came along: an organization read from core's snapshot has
  // none, and its days are the only place what happened is told.
  const real = view.org.real !== undefined && activity.length > 0;
  const hand = trail.map(fromHand);
  const worker = activity.flatMap((event, index) => {
    const item = fromWorker(event, index);
    return item ? [item] : [];
  });
  const gave = trail.some((entry) => entry.what === "go");
  const remindedByHand = trail.some((entry) => entry.what === "reminded");
  const agreedByHand = new Set(
    trail.flatMap((entry) =>
      entry.what === "agreed" && entry.to !== false && entry.to !== "waiting"
        ? [entry.paper]
        : []
    )
  );
  const company = historyOf(view).flatMap((event, index): LogItem[] => {
    // Told once: by the Worker with its time where it noted it, and by hand where a person at Grasp did it here.
    if (real && TOLD_BY_WORKER.has(event.kind)) {
      return [];
    }
    if (event.kind === "go" && gave) {
      return [];
    }
    if (event.kind === "reminded" && event.byHand && remindedByHand) {
      return [];
    }
    if (event.kind === "agreement" && agreedByHand.has(event.paper)) {
      return [];
    }
    const { topic, actor } = COMPANY[event.kind];
    return [
      {
        key: `company-${index}`,
        on: event.on,
        at: null,
        topic,
        actor: event.kind === "reminded" && event.byHand ? "grasp" : actor,
        problem: false,
        ...(event.kind === "lead" ? { team: event.team.id } : {}),
        source: { from: "company", event },
      },
    ];
  });
  // Within a day: what has a time, the latest first; then what is only known by its day, in the order the day went.
  return [...hand, ...worker, ...company].toSorted(
    (a, b) => b.on.localeCompare(a.on) || (b.at ?? -1) - (a.at ?? -1)
  );
};

/** How many entries each day has, by who did it: for the days from the first entry to the last, at most the `most` latest. */
export const logDays = (
  items: LogItem[],
  most = 30
): ({ day: string } & Record<LogActor, number>)[] => {
  if (items.length === 0) {
    return [];
  }
  const days = items.map((item) => item.on).toSorted();
  const last = days.at(-1) ?? "";
  const [first = ""] = days;
  const span: string[] = [];
  const at = new Date(`${last}T12:00:00Z`);
  while (span.length < most) {
    const day = at.toISOString().slice(0, 10);
    span.unshift(day);
    if (day <= first) {
      break;
    }
    at.setUTCDate(at.getUTCDate() - 1);
  }
  return span.map((day) => {
    const of = items.filter((item) => item.on === day);
    return {
      day,
      grasp: of.filter((item) => item.actor === "grasp").length,
      company: of.filter((item) => item.actor === "company").length,
      person: of.filter((item) => item.actor === "person").length,
      itself: of.filter((item) => item.actor === "itself").length,
    };
  });
};

/**
 * How many entries each hour of one day has, by who did it: for a log that is one day long. What
 * has no time is left out. Hours are UTC's, as the console shows times, so a page drawn on the
 * server and again in the reader's browser counts each entry in the same hour.
 */
export const logHours = (
  items: LogItem[]
): ({ hour: number } & Record<LogActor, number>)[] =>
  Array.from({ length: 24 }, (_, hour) => {
    const of = items.filter(
      (item) => item.at !== null && new Date(item.at).getUTCHours() === hour
    );
    return {
      hour,
      grasp: of.filter((item) => item.actor === "grasp").length,
      company: of.filter((item) => item.actor === "company").length,
      person: of.filter((item) => item.actor === "person").length,
      itself: of.filter((item) => item.actor === "itself").length,
    };
  });
