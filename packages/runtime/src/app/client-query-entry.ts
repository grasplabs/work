import { isPlainObject } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import { readAnswer } from "./call-answers.ts";
import type { Settled } from "./call-answers.ts";
import { clientError } from "./client-error.ts";
import type { GraspError } from "./client-error.ts";
import type { ReadReference } from "./client-request.ts";
import { nothingRanCodes } from "./refusals.ts";

/** What a query's readers see: its value (undefined while loading) or failure. */
export interface QuerySnapshot {
  readonly value: unknown;
  readonly error: GraspError | undefined;
}

/** A query with nothing to show yet, or a skipped one. */
export const loading: QuerySnapshot = Object.freeze({
  value: undefined,
  error: undefined,
});

/** A query's subscription, while components read it. */
export interface Live {
  /** Its place among the client's subscriptions: a later one is newer. */
  readonly attempt: number;
  /** What releases it, once core answered. */
  release: (() => void) | undefined;
  /** The revision of the latest push shown. */
  revision: number;
  /**
   * How many times in a row it was lost before one lasted `steadyMs`: a
   * push alone doesn't reset it, so a subscription lost right after each
   * push still backs off.
   */
  failures: number;
  /** When it was made. */
  readonly since: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  /** Released, ended, or fenced: nothing of it is shown any more. */
  stopped: boolean;
}

/** One query, by reference and normalized arguments, shared by its readers. */
export interface QueryEntry {
  readonly key: string;
  readonly reference: ReadReference;
  readonly input: Json;
  /** Its request as the host reads it. */
  readonly request: string;
  snapshot: QuerySnapshot;
  /** Components reading it now. */
  readonly listeners: Set<() => void>;
  /** Imperative reads waiting on it now. */
  interest: number;
  /** Its subscription, while components read it (over the frame). */
  live: Live | undefined;
  /** The number of the latest read sent, and of the one shown. */
  sent: number;
  shown: number;
  /** Set once a confirmed change may have made what it shows old. */
  stale: boolean;
  /**
   * How many confirmed changes marked it old: a read clears `stale` only
   * if none came after it was sent.
   */
  changes: number;
  reading:
    | { readonly done: Promise<unknown>; readonly stop: AbortController }
    | undefined;
  evict: ReturnType<typeof setTimeout> | undefined;
  /** How many snapshots it showed: a later one is newer. */
  settled: number;
}

/** Tells `entry`'s readers of its new snapshot. */
export const show = (entry: QueryEntry, snapshot: QuerySnapshot): void => {
  entry.snapshot = snapshot;
  entry.settled += 1;
  for (const listener of entry.listeners) {
    listener();
  }
};

/** Whether anyone still waits on `entry`. */
export const wanted = (entry: QueryEntry): boolean =>
  entry.listeners.size > 0 || entry.interest > 0;

/** Whether a read that settled as `settled` is worth sending again. */
export const worthRetrying = (settled: Settled): boolean =>
  settled.kind === "lost" ||
  (settled.kind === "failed" && nothingRanCodes.has(settled.error.code));

/** A push of core's, read: its revision and result, or none if malformed. */
export const readPush = (
  push: unknown
): { revision: number; settled: Settled } | undefined => {
  if (
    !isPlainObject(push) ||
    typeof push.revision !== "number" ||
    !Number.isSafeInteger(push.revision) ||
    push.revision < 1
  ) {
    return undefined;
  }
  const settled = readAnswer({ result: push.result });
  return settled.kind === "lost"
    ? undefined
    : { revision: push.revision, settled };
};

/**
 * Shows what read `number` of `entry` settled as, unless a newer read is
 * shown already or the query is followed (its pushes are what it shows),
 * and answers it: its value, or its failure thrown. A query that shows
 * data keeps it while its server is unreachable.
 */
export const settleRead = (
  entry: QueryEntry,
  read: { readonly number: number; readonly changes: number },
  settled: Settled
): unknown => {
  const { number } = read;
  const newest = number > entry.shown && entry.live === undefined;
  // A change confirmed after the read was sent may be missing from it.
  const current = read.changes === entry.changes;
  if (settled.kind === "lost") {
    const error = clientError("function.unreachable");
    if (newest && entry.snapshot.value === undefined) {
      entry.shown = number;
      show(entry, { value: undefined, error });
    }
    throw error;
  }
  if (settled.kind === "failed") {
    if (newest) {
      entry.shown = number;
      entry.stale &&= !current;
      show(entry, { value: undefined, error: settled.error });
    }
    throw settled.error;
  }
  if (newest) {
    entry.shown = number;
    entry.stale &&= !current;
    show(entry, { value: settled.value, error: undefined });
  }
  return settled.value;
};

/** How long a query no one reads stays cached: across a quick remount. */
export const keepMs = 30_000;
