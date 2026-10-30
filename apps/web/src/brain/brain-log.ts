import type { Source, Workspace } from "@grasp-os/shared/brain";

import { isoWeek } from "../format.ts";
import type { Brain } from "./brain.ts";

/**
 * The brain's log, as the prototype has it (`lib/brain-log.ts`): what it took in and what Grasp
 * worked out, day by day, newest first. What came in is the brain's sources (a week's interviews,
 * a document, a connection); what Grasp did itself is the questions it noticed, asked and had
 * answered. Pure, so the page only draws it.
 *
 * Interviews never say who talked or when: they are one line a week, as core counts them
 * (`Workspace.interviewWeeks`, five or more each), on the week's Monday. The work going on now and
 * what Grasp thought through in the chat have no record in core yet; they join the log once they
 * do.
 */

/** What a line is about, and so its icon: talking, reading, looking through a connection, or a question. */
export type LogKind = "interview" | "reading" | "scanning" | "question";

/** The log's tabs: everything, or one kind of work. Grasp's own work is its questions. */
export const logTabs = [
  "all",
  "interview",
  "reading",
  "scanning",
  "grasp",
] as const;
export type LogTab = (typeof logTabs)[number];

/** One line of the log. */
export interface LogEntry {
  id: string;
  kind: LogKind;
  /** The day it happened, as an ISO date. */
  day: string;
  /** What it was, as the source names it; for a question, the question. Empty for a week's interviews. */
  title: string;
  /** Who gave it, and how, as a role: "Head of finance · Live, 45 minutes". */
  by?: string;
  /** What the brain keeps of it: one for each thing said in it. */
  said: number;
  /** The note it opens. */
  opens?: string;
  /** The interviews of one week, which are one line with how many there were: never who talked, nor on which day. */
  interviews?: { count: number; week: number };
  /** For a question: noticed, sent to who can answer it, or answered, and whether it is still open. */
  question?: {
    step: "noticed" | "asked" | "answered";
    open: boolean;
    answer?: string;
  };
}

/** A day of the log, newest first. */
export interface LogDay {
  day: string;
  entries: LogEntry[];
}

/** The tab a line is under. */
export const tabOf = (entry: LogEntry): Exclude<LogTab, "all"> =>
  entry.kind === "question" ? "grasp" : entry.kind;

/** What a source's kind is as work: talking, reading, or looking through a connection. */
const sourceKind: Record<Source["kind"], LogKind> = {
  interview: "interview",
  chat: "interview",
  document: "reading",
  import: "scanning",
  runLog: "scanning",
};

/** The note the week's interviews open: the conversations, where the brain has them. */
const conversations = "sources-conversations";

/** Every line of the log, unordered. */
const entriesOf = (ws: Workspace, brain: Brain): LogEntry[] => {
  const inBrain = new Set(brain.notes.map((note) => note.id));
  const said = new Map<string, number>();
  for (const statement of ws.statements) {
    said.set(statement.sourceId, (said.get(statement.sourceId) ?? 0) + 1);
  }
  const entries: LogEntry[] = ws.interviewWeeks.map(({ week, interviews }) => ({
    id: `interviews:${week}`,
    kind: "interview",
    day: week,
    title: "",
    said: 0,
    ...(inBrain.has(conversations) ? { opens: conversations } : {}),
    interviews: { count: interviews, week: isoWeek(week) },
  }));
  // What else came in, each on its day: a conversation never, which would say who talked and when.
  for (const source of ws.sources) {
    const kind = sourceKind[source.kind];
    if (kind === "interview" || !inBrain.has(source.id)) {
      continue;
    }
    const by = [source.who, source.how].filter(Boolean).join(" · ");
    entries.push({
      id: source.id,
      kind,
      day: source.date,
      title: source.title,
      ...(by === "" ? {} : { by }),
      said: said.get(source.id) ?? 0,
      opens: source.id,
    });
  }
  // Grasp's questions: noticed in a source, sent to who can answer it, answered.
  const dated = new Map(ws.sources.map((source) => [source.id, source.date]));
  for (const gap of ws.gaps) {
    const open = gap.closedAt === undefined;
    const opens = inBrain.has(gap.id) ? { opens: gap.id } : {};
    const noticed = dated.get(gap.sourceId);
    const line = { kind: "question" as const, title: gap.question, said: 0 };
    if (noticed !== undefined) {
      entries.push({
        ...line,
        id: `${gap.id}:noticed`,
        day: noticed,
        ...opens,
        question: { step: "noticed", open },
      });
    }
    if (gap.askedAt !== undefined) {
      entries.push({
        ...line,
        id: `${gap.id}:asked`,
        day: gap.askedAt.slice(0, 10),
        by: gap.owner,
        ...opens,
        question: { step: "asked", open },
      });
    }
    if (gap.closedAt !== undefined) {
      // Answered by the role it was asked of: never the name of whoever typed the answer.
      entries.push({
        ...line,
        id: `${gap.id}:answered`,
        day: gap.closedAt.slice(0, 10),
        by: gap.owner,
        ...opens,
        question: {
          step: "answered",
          open: false,
          ...(gap.answer === undefined ? {} : { answer: gap.answer }),
        },
      });
    }
  }
  return entries;
};

/** The whole log, day by day, newest first, for one tab. */
export const brainLog = (
  ws: Workspace,
  brain: Brain,
  tab: LogTab = "all"
): LogDay[] => {
  const all = entriesOf(ws, brain);
  const order = new Map(all.map((entry, index) => [entry.id, index]));
  // Newest day first; within a day, in the reverse of the order it came in.
  const shown = all
    .filter((entry) => tab === "all" || tabOf(entry) === tab)
    .toSorted(
      (one, other) =>
        other.day.localeCompare(one.day) ||
        (order.get(other.id) ?? 0) - (order.get(one.id) ?? 0)
    );
  const days: LogDay[] = [];
  for (const entry of shown) {
    const last = days.at(-1);
    if (last?.day === entry.day) {
      last.entries.push(entry);
    } else {
      days.push({ day: entry.day, entries: [entry] });
    }
  }
  return days;
};

/** How a dot of the chart is drawn: taken in, or a question still open. */
export type LogDot = "known" | "open";

/** One day of the chart and its dots. */
export interface LogColumn {
  day: string;
  dots: LogDot[];
}

const dayMs = 86_400_000;

/**
 * The log as a chart: a column for every day from the first to today, empty days included, with a
 * dot for everything that came in or happened that day; a week's interviews stand on its Monday,
 * a dot each.
 */
export const logColumns = (days: LogDay[], today: string): LogColumn[] => {
  const first = days.at(-1)?.day;
  const newest = days[0]?.day;
  if (first === undefined || newest === undefined) {
    return [];
  }
  const byDay = new Map(days.map((each) => [each.day, each.entries]));
  const last = today > newest ? today : newest;
  const columns: LogColumn[] = [];
  for (let at = Date.parse(`${first}T12:00:00Z`); ; at += dayMs) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > last) {
      break;
    }
    const dots = (byDay.get(day) ?? []).flatMap((entry): LogDot[] => {
      const dot: LogDot = entry.question?.open === true ? "open" : "known";
      return Array.from({ length: entry.interviews?.count ?? 1 }, () => dot);
    });
    columns.push({ day, dots });
  }
  return columns;
};
