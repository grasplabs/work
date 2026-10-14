import type {
  RunHistoryEntry,
  RunHistoryError,
  RunHistoryPage,
} from "@grasp-os/shared/workflows";

// A run's history (core's workflows/history.ts) as its page tells it: the
// entries in the order the engine journaled them, with each step's
// attempts under that one step, each wait as one item from when it opened
// to when it closed, and the run's own lifecycle and what couldn't be read
// between them. Core reads the journal page by page; the page groups every
// entry loaded so far, so a step whose retry came on a later page is still
// one step.

type Entry<Kind extends RunHistoryEntry["kind"]> = Extract<
  RunHistoryEntry,
  { kind: Kind }
>;

/** One attempt of a step or of a compensation. */
export interface HistoryAttempt {
  attempt: number;
  /** Unix milliseconds; null when its start isn't in the history read. */
  startedAt: number | null;
  /** When it ended, completed or failed; null while it goes on. */
  endedAt: number | null;
  state: "running" | "completed" | "retrying" | "failed";
  /** Why it failed, as core gives it: once the step failed at it. */
  error?: RunHistoryError;
}

/** What a run's history page shows, one item per line. */
export type HistoryItem =
  | {
      type: "lifecycle";
      id: string;
      at: number;
      entry: Entry<"lifecycle">;
    }
  | {
      type: "step";
      id: string;
      /** A step of the run, or the compensation that undoes one. */
      kind: "step" | "compensation";
      stepId: string;
      taskId: string | null;
      attempts: HistoryAttempt[];
    }
  | {
      type: "wait";
      id: string;
      waitKind: Entry<"wait">["waitKind"];
      taskId: string | null;
      /** Null when its opening isn't in the history read. */
      openedAt: number | null;
      /** Null while it is open. */
      closedAt: number | null;
      deadline: number | null;
    }
  | { type: "unreadable"; id: string; at: number; sequence: number };

/** The attempt `entry` tells of, as it is after it. */
const attemptAfter = (
  before: HistoryAttempt | undefined,
  entry: Entry<"step"> | Entry<"compensation">
): HistoryAttempt => {
  const { attempt, at } = entry;
  if (entry.state === "started") {
    return { attempt, startedAt: at, endedAt: null, state: "running" };
  }
  const startedAt = before?.startedAt ?? null;
  if (entry.state === "failed") {
    return {
      attempt,
      startedAt,
      endedAt: at,
      state: "failed",
      error: entry.error,
    };
  }
  return { attempt, startedAt, endedAt: at, state: entry.state };
};

/**
 * The history's entries as the page lists them, oldest first: a step's
 * (or a compensation's) attempts under it where it first appears, a wait
 * from its opening to its closing, and the rest one line each.
 */
export const historyItems = (
  entries: readonly RunHistoryEntry[]
): HistoryItem[] => {
  const items: HistoryItem[] = [];
  const steps = new Map<string, Extract<HistoryItem, { type: "step" }>>();
  // A wait still open, by its kind and ID: what closes it next.
  const openWaits = new Map<string, Extract<HistoryItem, { type: "wait" }>>();
  const ordered = entries.toSorted((a, b) => a.sequence - b.sequence);
  for (const entry of ordered) {
    if (entry.kind === "step" || entry.kind === "compensation") {
      const key = `${entry.kind}:${entry.stepId}`;
      let step = steps.get(key);
      if (step === undefined) {
        step = {
          type: "step",
          id: entry.id,
          kind: entry.kind,
          stepId: entry.stepId,
          taskId: entry.taskId,
          attempts: [],
        };
        steps.set(key, step);
        items.push(step);
      }
      // Any entry of the step that names its task names it for all.
      step.taskId ??= entry.taskId;
      const at = step.attempts.findIndex(
        ({ attempt }) => attempt === entry.attempt
      );
      const updated = attemptAfter(step.attempts[at], entry);
      if (at === -1) {
        step.attempts.push(updated);
        step.attempts.sort((a, b) => a.attempt - b.attempt);
      } else {
        step.attempts[at] = updated;
      }
    } else if (entry.kind === "wait") {
      const key = `${entry.waitKind}:${entry.waitId}`;
      const open = openWaits.get(key);
      if (entry.state === "closed" && open !== undefined) {
        open.closedAt = entry.at;
        openWaits.delete(key);
      } else {
        const wait: Extract<HistoryItem, { type: "wait" }> = {
          type: "wait",
          id: entry.id,
          waitKind: entry.waitKind,
          taskId: entry.taskId,
          openedAt: entry.state === "opened" ? entry.at : null,
          closedAt: entry.state === "closed" ? entry.at : null,
          deadline: entry.deadline,
        };
        if (entry.state === "opened") {
          openWaits.set(key, wait);
        }
        items.push(wait);
      }
    } else if (entry.kind === "lifecycle") {
      items.push({ type: "lifecycle", id: entry.id, at: entry.at, entry });
    } else {
      items.push({
        type: "unreadable",
        id: entry.id,
        at: entry.at,
        sequence: entry.sequence,
      });
    }
  }
  return items;
};

/** A run's history as read so far, and where to read on from. */
export interface LoadedHistory {
  /** The run it is the history of. */
  run: string;
  /** The first page it was read on from: a newer read starts it again. */
  first: RunHistoryPage;
  entries: RunHistoryEntry[];
  /** The cursor of the next page; null once the last page is read. */
  cursor: string | null;
}

/** Where a page was read from: which history, after which cursor. */
export interface PageRead {
  run: string;
  /** The first page of the history it was read for. */
  first: RunHistoryPage;
  cursor: string | null;
}

/** A run's history from its first page. */
export const firstHistory = (
  run: string,
  first: RunHistoryPage
): LoadedHistory => ({
  run,
  first,
  entries: [...first.items],
  cursor: first.nextCursor,
});

/**
 * The history to show for `run` now that its page has read `first`: the
 * one read so far while it is of that same run and first page, or that
 * page anew once the page read it again (its loader ran again, after the
 * chat changed something, say), dropping the pages read after the old
 * one, so nothing stale stays and more can be read from its own cursor.
 */
export const historyFor = (
  loaded: LoadedHistory,
  run: string,
  first: RunHistoryPage
): LoadedHistory =>
  loaded.run === run && loaded.first === first
    ? loaded
    : firstHistory(run, first);

/**
 * The history read so far once `page`, read from `from`, is read too. A
 * page of another run, of a history read anew since, or from a cursor
 * this history has moved past (an answer that came after the page went
 * on to another run, or after the same page was read again), changes
 * nothing: each run's history holds only its own entries, in its own
 * order.
 */
export const withPage = (
  loaded: LoadedHistory,
  from: PageRead,
  page: RunHistoryPage
): LoadedHistory => {
  if (
    from.run !== loaded.run ||
    from.first !== loaded.first ||
    from.cursor !== loaded.cursor
  ) {
    return loaded;
  }
  // Each entry once, should a page repeat what the one before held.
  const known = new Set(loaded.entries.map(({ id }) => id));
  return {
    ...loaded,
    entries: [
      ...loaded.entries,
      ...page.items.filter(({ id }) => !known.has(id)),
    ],
    cursor: page.nextCursor,
  };
};

const opaqueStep = /^step-(?<ordinal>\d+)$/u;

/**
 * The number of a step the review doesn't name (`taskId` null), from its
 * opaque `stepId` (`step-<ordinal>`); undefined for an ID of another shape.
 */
export const stepOrdinal = (stepId: string): number | undefined => {
  const ordinal = opaqueStep.exec(stepId)?.groups?.ordinal;
  return ordinal === undefined ? undefined : Number(ordinal);
};

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

/** The units a length of time is written in, largest first. */
const units = [
  ["day", day],
  ["hour", hour],
  ["minute", minute],
  ["second", second],
] as const;

/**
 * A length of time as the page's language writes it, in its largest
 * whole unit: "350 ms", "2.5 sec", "3 min", "2 hr", "4 days".
 */
export const formatDuration = (ms: number, locale: string): string => {
  const [unit, size] = units.find(([, length]) => ms >= length) ?? [
    "millisecond",
    1,
  ];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: unit === "day" ? "long" : "short",
    maximumFractionDigits: unit === "millisecond" ? 0 : 1,
  }).format(Math.max(0, ms) / size);
};
