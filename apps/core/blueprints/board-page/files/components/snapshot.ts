// The board page's snapshots as its screen reads them from the App's
// store (operations/snapshots.ts), and what each refusal means to the
// person using it.

import type { Id } from "@grasp-os/sdk";

import type { SignalFigure, SnapshotRecord, WorkflowFigures } from "./board";

/** A snapshot, with its figures. */
export interface Snapshot {
  id: Id<"snapshots">;
  /** The revision it was read at, which a save of its narrative asserts. */
  revision: number;
  record: SnapshotRecord;
  /** Its narrative. */
  body: string;
}

/** A call's answer, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

type Basis = "estimated" | "observed";

/** A snapshot as the store keeps it. */
interface StoredSnapshot {
  _id: Id<"snapshots">;
  _rev: number;
  title: string;
  date: string;
  maturity: number;
  windowDays: number;
  signals: { workflow: string; kind: string; value: number }[];
  decisionNeeded: string;
  narrative: string;
}

/** A workflow's figures as the store keeps them. */
interface StoredFigure {
  workflow: string;
  title: string;
  team: string | null;
  state: "drawn" | "designed";
  drawn: { version: number; hoursPerWeek: number; basis: Basis } | null;
  designed: { version: number; hoursPerWeek: number; basis: Basis } | null;
  unavailable: boolean;
  running: {
    appId: string;
    workflowId: string;
    runs: number;
    hoursPerWeek: number;
  } | null;
}

/** A workflow's figures as the page reads them. */
const figuresFrom = (stored: StoredFigure): WorkflowFigures => ({
  path: stored.workflow,
  title: stored.title,
  ...(stored.team === null ? {} : { team: stored.team }),
  state: stored.state,
  ...(stored.drawn === null ? {} : { drawn: stored.drawn }),
  ...(stored.designed === null ? {} : { designed: stored.designed }),
  ...(stored.unavailable ? { unavailable: true } : {}),
  ...(stored.running === null ? {} : { running: stored.running }),
});

/** A snapshot and its figures as the page reads them. */
export const snapshotFrom = (
  stored: StoredSnapshot,
  figures: readonly StoredFigure[]
): Snapshot => ({
  id: stored._id,
  revision: stored._rev,
  record: {
    title: stored.title,
    date: stored.date,
    maturity: stored.maturity,
    ...(stored.decisionNeeded === ""
      ? {}
      : { decisionNeeded: stored.decisionNeeded }),
    figures: {
      windowDays: stored.windowDays,
      workflows: figures.map(figuresFrom),
      signals: stored.signals.map(
        ({ workflow, kind, value }): SignalFigure => ({
          path: workflow,
          kind,
          value,
        })
      ),
    },
  },
  body: stored.narrative,
});

/** The code of why a call failed, or that it couldn't be made. */
const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.unreachable";

/**
 * What `run` resolves with, or the code of why it rejected, so no call
 * ends in an unhandled rejection.
 */
export const settle = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/** What a refusal means to the person using the page. */
export const refusal = (code: string): string => {
  switch (code) {
    case "data.conflict":
    case "data.reads_changed": {
      return "Someone saved this snapshot since you opened it. Open it again to see their changes.";
    }
    case "data.access_denied":
    case "data.write_denied": {
      return "Only the App's builders take snapshots and write them.";
    }
    case "data.invalid":
    case "contract.invalid_args": {
      return "That can't be saved: the decision is at most 1,000 characters, and the narrative at most 30,000.";
    }
    case "board.not_found": {
      return "There's no such snapshot, or you can't open it.";
    }
    case "board.figures_incomplete": {
      return "The Apps linked here ran more workflows than one snapshot reads, so it wasn't taken: its figures would be incomplete.";
    }
    case "board.too_many_workflows": {
      return "The workflow map has more workflows than one snapshot holds (250).";
    }
    case "resource.unavailable": {
      return "The page can't read the workflow map yet: an admin binds it to the map first.";
    }
    case "app.unreachable": {
      return "Grasp can't be reached right now. Try again in a moment.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};
