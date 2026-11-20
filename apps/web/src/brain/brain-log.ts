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
  /** The note it opens. */
  opens?: string;
  /** The interviews of one week, which are one line with how many there were: never who talked, nor on which day. */
  interviews?: { count: number; week: number };
  /** For a question: noticed, sent to who can answer it, or answered, and whether it is still open. */
  question?: {
    /** The gap it is. */
    gap: string;
    step: "noticed" | "asked" | "answered";
    open: boolean;
    answer?: string;
  };
}

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
  const entries: LogEntry[] = ws.interviewWeeks.map(({ week, interviews }) => ({
    id: `interviews:${week}`,
    kind: "interview",
    day: week,
    title: "",
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
      opens: source.id,
    });
  }
  // Grasp's questions: noticed in a source, sent to who can answer it, answered.
  const dated = new Map(ws.sources.map((source) => [source.id, source.date]));
  for (const gap of ws.gaps) {
    const open = gap.closedAt === undefined;
    const opens = inBrain.has(gap.id) ? { opens: gap.id } : {};
    const noticed = dated.get(gap.sourceId);
    const line = { kind: "question" as const, title: gap.question };
    if (noticed !== undefined) {
      entries.push({
        ...line,
        id: `${gap.id}:noticed`,
        day: noticed,
        ...opens,
        question: { gap: gap.id, step: "noticed", open },
      });
    }
    if (gap.askedAt !== undefined) {
      entries.push({
        ...line,
        id: `${gap.id}:asked`,
        day: gap.askedAt.slice(0, 10),
        by: gap.owner,
        ...opens,
        question: { gap: gap.id, step: "asked", open },
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
          gap: gap.id,
          step: "answered",
          open: false,
          ...(gap.answer === undefined ? {} : { answer: gap.answer }),
        },
      });
    }
  }
  return entries;
};

/** The log's stretches, newest first: this week, last week, and before. */
export interface LogStretches {
  thisWeek: LogEntry[];
  lastWeek: LogEntry[];
  earlier: LogEntry[];
}

const weekMs = 7 * 86_400_000;

/** The Monday of the week `day` is in, as an ISO date. */
const mondayOf = (day: string): number => {
  const at = Date.parse(`${day}T12:00:00Z`);
  return at - ((new Date(at).getUTCDay() + 6) % 7) * 86_400_000;
};

/**
 * The whole log, newest first, in its stretches as of `today` (an ISO date where the reader is):
 * within a day, in the reverse of the order it came in.
 */
export const brainLog = (
  ws: Workspace,
  brain: Brain,
  today: string
): LogStretches => {
  const all = entriesOf(ws, brain);
  const order = new Map(all.map((entry, index) => [entry.id, index]));
  const thisWeek = mondayOf(today);
  const stretches: LogStretches = { thisWeek: [], lastWeek: [], earlier: [] };
  for (const entry of all.toSorted(
    (one, other) =>
      other.day.localeCompare(one.day) ||
      (order.get(other.id) ?? 0) - (order.get(one.id) ?? 0)
  )) {
    const monday = mondayOf(entry.day);
    if (monday >= thisWeek) {
      stretches.thisWeek.push(entry);
    } else if (monday >= thisWeek - weekMs) {
      stretches.lastWeek.push(entry);
    } else {
      stretches.earlier.push(entry);
    }
  }
  return stretches;
};
