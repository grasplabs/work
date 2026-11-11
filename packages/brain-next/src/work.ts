import { takeToken } from "@grasp-os/shared/token-bucket";
import type { BucketRate } from "@grasp-os/shared/token-bucket";
import { count, eq, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { z } from "zod";

import {
  modelReplySchema,
  modelTimeoutMaxMs,
  parkedListed,
  sourceIdMaxLength,
  wellFormedString,
  workErrors,
} from "./contract.ts";
import type {
  AskModel,
  ModelTrouble,
  OverdueWork,
  WorkErrorCode,
  WorkOverview,
} from "./contract.ts";
import { workItems, workModelBucket } from "./db/schema.ts";
import { WorkError } from "./work-error.ts";

export { WorkError } from "./work-error.ts";

// The work queue: every piece of the Brain's background work (embedding,
// extracting memories, linking) is an item in one table of the store,
// worked by core's clock: each tick is one `workTick`. Nothing else drives
// it; the store sets no alarm of its own.
//
// Items run in order of their class (`workPriorities`), oldest first,
// 4 at once, at most 2 of one connection, never two of one kind and key; a
// newer item of a kind and key replaces one waiting or parked. An item's
// attempt is counted as it is claimed, before its work starts. Model calls
// take turns, first come first served, from one bucket for the whole queue
// (a burst of 10, then 30 a minute), at most 20 per attempt. The rules:
//
// 1. While the queue is paused, nothing is claimed: a tick ends at once.
// 2. The queue pauses only when the host says so, for something that isn't
//    about one item: the provider limits calls (`rate_limited`), the way to
//    a model fails (`unavailable`: a 5xx, connect or the host out of
//    reach), or the AI account needs someone (`account`: a key refused, no
//    model set up or allowed, out of credit). It pauses 60 s, or as long
//    as the provider asked if longer, at most 30 minutes; for the account,
//    15 minutes, as a person fixes it. An answered call
//    ends it early, except a rate limit's: that one lasts as long as the
//    provider asked, whatever a call already under way answers meanwhile.
//    An item that asks the model during the pause is put back with
//    its attempt given back. Staff see the pause, its reason and since when,
//    so a day-long account problem shows, and parks nothing.
// 3. Anything else is the item's failure and spends its attempt: its
//    handler throwing, the provider refusing its request, too many calls,
//    a request that can't be sent, and running out of time, wherever (in
//    line, waiting for a token, a model call taking all its time, a slow
//    handler). It is due again after 1, 2, 4 and 8 minutes; the fifth
//    failure parks it. Honest contention never times an item out: 4 items
//    of at most 20 calls each ask at most 80, of which the bucket's 10
//    come at once and the other 70 within 2 min 20 s at 30 a minute, well
//    inside an item's 4 minutes. That covers only the line: the model's
//    own time to answer counts against the item's time too (20 calls of
//    10 to 20 s each don't fit in 4 minutes), so a kind is written to
//    finish well inside its limit, with a handful of calls; and a handler
//    that finds what it was to work on gone or replaced by a newer version
//    when it runs is done, not failed.
// 4. When the store stops while items run, the next instance puts them
//    back as it starts, each to run alone until it settles. A first stop
//    gives the attempt back (a deploy as likely as the item); a stop while
//    the item ran alone is its own failure (`interrupted`).
// 5. Parked is not final: a parked item comes back by itself a day after
//    it was parked, its attempts reset, at most twice; parked a third time,
//    it stays. So an hour of a hanging provider parks the items that
//    called it, and they finish the next day with no one acting, and a
//    poisoned item costs at most 3 × 5 attempts.
// 6. A handler that ignores its signal past its time and a grace is
//    settled as timed out and left running, holding its key and a slot
//    (staff see it as overdue); when such handlers hold every slot, or are
//    all that keeps an interrupted item from running alone, the store
//    restarts, which ends them. Their rows were settled before (timed out,
//    the attempt spent, due after the backoff), and the restart waits until
//    that is on disk: it spends no attempt of its own and comes once for
//    each such wait. Until it lands, nothing more is claimed and no tick
//    works. Errors are kept as the queue's own codes (`workErrors`), never
//    as text a handler or a provider wrote.
//
// Time: the queue's own time is the tick's (`at`, core's clock's time
// now) with the real time since the tick began added. Backoffs, pauses,
// returns from parking and the bucket go by it.

/** The classes of work, the first first: an item of a class runs before any of the next. */
export const workPriorities = [
  /** What someone just asked about. */
  "asked",
  /** What people upload on purpose. */
  "upload",
  /** Conversations, meetings and runs. */
  "conversation",
  /** Recent documents. */
  "recent",
  /** Old documents and archives, which may never reach the front. */
  "archive",
] as const;
export type WorkPriority = (typeof workPriorities)[number];

/** Most items under way at once, across every tick. */
export const workAtOnce = 4;

/** Most items of one connection under way at once. */
export const workPerConnection = 2;

/** Attempts an item gets before it is parked. */
export const workAttemptsMax = 5;

/** Times an item is parked before it stays parked. */
export const workParksMax = 3;

/** How long a parked item waits before it comes back by itself. */
export const workParkedMs = 24 * 60 * 60_000;

/** The wait after an item's first failure, doubled after each next one: 1, 2, 4 and 8 minutes. */
const backoffFirstMs = 60_000;

/** The queue's pause: at least this, or what the provider asked, at most the most. */
const pauseLeastMs = 60_000;
const pauseMostMs = 30 * 60_000;

/**
 * The queue's pause for the AI account. A person fixes an account (a key,
 * a model to allow, credit), never a minute's wait: pausing a minute would
 * send about 3 calls a tick the gateway refuses and audits, for nothing.
 * A fixed account is picked up within the 15 minutes.
 */
const pauseAccountMs = 15 * 60_000;

/** Most model calls one attempt may make. */
export const workCallsMax = 20;

/** How long one attempt of an item may take: a kind may say less, never more. */
export const workItemTimeMs = modelTimeoutMaxMs;

/**
 * How long past its time an attempt's handler is waited for, once its
 * signal aborted: then its item is settled as timed out, and the handler,
 * which ignored its signal, left running on its own.
 */
const graceOf = (timeLimitMs: number): number => Math.min(30_000, timeLimitMs);

/**
 * How long a tick claims new items for, into whichever slots are free:
 * as items end, and every `tickLookMs` for items added meanwhile. Those
 * under way when it ends are waited for, each at most its time (4 min)
 * and its grace (30 s): so a tick ends within 4 min + 4 min + 30 s = 8 min
 * 30 s, inside the 10 minutes core's clock gives a task before it takes
 * it for dead (`clockLeaseMs`, @grasp-os/workerflow/clock).
 */
const tickClaimMs = 4 * 60_000;

/**
 * Most blocks of vector codes a tick repacks (vectors.ts) before its
 * queue, each its own short transaction of one block's codes (the store's
 * `work`): enough that a tick a minute keeps up with what versions
 * replace, few enough that the queue never waits on it. Measured: about
 * 40 ms per full block at 1,536 dimensions, 432 ms for 16; ours are 384,
 * and it only repeats while there is a backlog.
 */
export const repackPerTick = 16;

/** How often a tick looks for items added while its slots have room. */
const tickLookMs = 1000;

/** The queue's model calls: a burst, then a steady pace. A guess to be set by measuring. */
export const workModelRate: BucketRate = { burst: 10, perMinute: 30 };

/**
 * Most characters of a model request's instructions and message together:
 * far below what one call across the Durable Object boundary takes (32 MiB),
 * and above any prompt the Brain's work sends.
 */
export const workRequestMaxLength = 1_000_000;

/** A kind's name: lowercase words joined by dots, so its model calls' purpose is `brain.<kind>`. */
const kindPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const kindMaxLength = 48;

/** What a handler may use while it runs an item. */
export interface WorkContext {
  /** The store's storage, to read what the item is about and write what it made. */
  storage: DurableObjectStorage;
  /**
   * Asks the host's model, through its gateway, in its turn within the
   * queue's rate, with what is left of the item's time. Throws a
   * `WorkError` for the item's own failures, and `WorkWaitsError` while the
   * queue is paused: let both through.
   */
  ask: (request: { system: string; input: string }) => Promise<string>;
  /** Aborted once the item's time is up: end then, by throwing. */
  signal: AbortSignal;
}

/** A kind of work, and how one item of it is done. */
export interface WorkDefinition<Payload> {
  /** Lowercase words joined by dots, at most 48 characters. */
  kind: string;
  /** What an item carries: checked as it is added, and again as it runs. */
  payload: z.ZodType<Payload>;
  /** How long one attempt may take: `workItemTimeMs`, or less. */
  timeLimitMs?: number;
  /**
   * Does one item's work. It must be safe to run twice or more: an
   * attempt the object stopped in the middle of, that ran out of time, or
   * that failed after part of its work, is run again from the start. Write
   * so that a second run finds what the first left and ends the same: keys
   * from content, writes that can be repeated. Throwing fails the attempt;
   * throw a `WorkError` to say why with one of the queue's codes. End when
   * the signal aborts.
   *
   * What it derives follows the access rules: it carries the reader set of
   * what it read over to what it writes, never a wider one. It never
   * writes the queue's own tables (`work_items`, `work_model_bucket`).
   *
   * It makes at most `workCallsMax` model calls (20), each waiting its turn
   * in the queue's rate. The wait for a turn fits in its time (the header's
   * arithmetic); the model's own time to answer is the kind's to budget:
   * 20 calls of 10 to 20 s each don't fit in 4 minutes. Write it to finish
   * well inside its limit, with a handful of calls. When what it was to
   * work on is gone, or replaced by a newer version, it returns: done.
   */
  run: (payload: Payload, context: WorkContext) => Promise<void>;
}

/** An item to add. */
export interface NewWork<Payload> {
  /**
   * What it is about, as an ID (a source's, say), never content: staff
   * see it. A newer item of the same kind and key replaces one waiting.
   */
  key: string;
  payload: Payload;
  priority: WorkPriority;
  /** The connection it belongs to, if any. */
  connection?: string;
}

/** Thrown by `WorkContext.ask` while the queue is paused, until `until`. */
export class WorkWaitsError extends Error {
  readonly until: number;

  constructor(until: number) {
    super("The queue is paused for its model");
    this.name = "WorkWaitsError";
    this.until = until;
  }
}

/** A defined kind, its payload's type erased. */
interface Runner {
  timeLimitMs: number;
  run: (payload: unknown, context: WorkContext) => Promise<void>;
}

/** Each defined kind, by kind. */
const runners = new Map<string, Runner>();

/**
 * Defines a kind of work, once per kind, as the module that does it loads:
 * items of it are then run with `definition.run`. Returns the definition,
 * to add items of it with (`enqueueWork`).
 */
export const defineWork = <Payload>(
  definition: WorkDefinition<Payload>
): WorkDefinition<Payload> => {
  const { kind, timeLimitMs = workItemTimeMs } = definition;
  if (!kindPattern.test(kind) || kind.length > kindMaxLength) {
    throw new Error(`Not a kind of work: ${kind}`);
  }
  if (timeLimitMs <= 0 || timeLimitMs > workItemTimeMs) {
    throw new Error(`Not a time limit of work: ${timeLimitMs}`);
  }
  if (runners.has(kind)) {
    throw new Error(`Work of kind ${kind} is defined already`);
  }
  runners.set(kind, {
    timeLimitMs,
    run: async (payload, context) => {
      const parsed = definition.payload.safeParse(payload);
      if (!parsed.success) {
        throw new WorkError("invalid_payload");
      }
      await definition.run(parsed.data, context);
    },
  });
  return definition;
};

/**
 * An item's key, and a connection's ID: well-formed (`wellFormedString`),
 * so no two that differ are kept as one, and as long as a source's ID.
 */
const workIdSchema = wellFormedString().min(1).max(sourceIdMaxLength);

/**
 * Adds an item of `definition`'s kind to the queue in `storage`, due at
 * once, in place of one of the same kind and key still waiting or parked.
 */
export const enqueueWork = <Payload>(
  storage: DurableObjectStorage,
  definition: WorkDefinition<Payload>,
  item: NewWork<Payload>
): void => {
  const key = workIdSchema.parse(item.key);
  const connection =
    item.connection === undefined
      ? undefined
      : workIdSchema.parse(item.connection);
  const { payload, priority } = item;
  const json = JSON.stringify(definition.payload.parse(payload));
  storage.transactionSync(() => {
    storage.sql.exec(
      "DELETE FROM work_items WHERE kind = ? AND key = ? AND running = 0",
      definition.kind,
      key
    );
    drizzle(storage)
      .insert(workItems)
      .values({
        kind: definition.kind,
        key,
        payload: json,
        priority: workPriorities.indexOf(priority),
        connection: connection ?? null,
        addedAt: new Date(),
        notBefore: 0,
      })
      .run();
  });
};

/**
 * What one instance of the store keeps of its queue in memory, gone with
 * it: the model's turns, and the handlers left running past their time.
 */
export interface WorkState {
  turns: Promise<unknown>;
  /** By kind and key (`zombieOf`). */
  zombies: Map<string, OverdueWork & { connection: string | null }>;
  /**
   * Restarts the store once what it wrote is on disk: what ends handlers
   * no signal stops. Called through `restartStore` only.
   */
  restart: () => void;
  /** Whether a restart is on its way: nothing more is claimed meanwhile. */
  restarting: boolean;
}

/** An instance's state of its queue, as it starts; `restart` restarts its store. */
export const newWorkState = (restart: () => void): WorkState => ({
  turns: Promise.resolve(),
  zombies: new Map(),
  restart,
  restarting: false,
});

/** Restarts the store (rule 6), once however often asked. */
const restartStore = (state: WorkState): void => {
  if (!state.restarting) {
    state.restarting = true;
    state.restart();
  }
};

/** A kind and key, as `WorkState.zombies` keys them. */
const zombieOf = (item: { kind: string; key: string }): string =>
  JSON.stringify([item.kind, item.key]);

/** An item as a tick claimed it. */
interface Claimed extends Record<string, SqlStorageValue> {
  id: number;
  kind: string;
  key: string;
  payload: string;
  attempts: number;
  parks: number;
  priority: number;
  connection: string | null;
  interrupted: number;
}

const claimedColumns =
  "id, kind, key, payload, attempts, parks, priority, connection, interrupted";

type Db = DrizzleSqliteDODatabase;

/**
 * Takes `item` off the running, with `changes`; or deletes it when a newer
 * item of its kind and key waits meanwhile, which replaces it.
 */
const putBack = (
  storage: DurableObjectStorage,
  item: Claimed,
  changes: Partial<typeof workItems.$inferInsert>
): void => {
  const db = drizzle(storage);
  // Any that waits was added after this one was claimed: a newer one.
  const [newer] = storage.sql
    .exec(
      "SELECT id FROM work_items WHERE kind = ? AND key = ? AND running = 0",
      item.kind,
      item.key
    )
    .toArray();
  if (newer === undefined) {
    db.update(workItems)
      .set({ ...changes, running: false })
      .where(eq(workItems.id, item.id))
      .run();
  } else {
    db.delete(workItems).where(eq(workItems.id, item.id)).run();
  }
};

/**
 * Fails `item`'s attempt with `error` at `now`: parked once its attempts
 * are spent (rule 5), otherwise due again after its backoff; or, for a
 * stop of the store (`interrupted`), at once, to run alone.
 */
const fail = (
  storage: DurableObjectStorage,
  item: Claimed,
  error: WorkErrorCode,
  now: number,
  { interrupted }: { interrupted: boolean }
): void => {
  if (item.attempts >= workAttemptsMax) {
    putBack(storage, item, {
      parkedAt: new Date(now),
      parks: item.parks + 1,
      lastError: error,
      interrupted: false,
    });
    return;
  }
  putBack(storage, item, {
    notBefore: interrupted
      ? 0
      : now + backoffFirstMs * 2 ** (item.attempts - 1),
    lastError: error,
    interrupted,
  });
};

/**
 * Puts back what an earlier instance of the object had under way (rule 4).
 * Run as the object starts, before it handles anything.
 */
export const releaseInterrupted = (storage: DurableObjectStorage): void => {
  storage.transactionSync(() => {
    const interrupted = storage.sql
      .exec<Claimed>(
        `SELECT ${claimedColumns} FROM work_items WHERE running = 1`
      )
      .toArray();
    for (const item of interrupted) {
      if (item.interrupted === 1) {
        fail(storage, item, "interrupted", Date.now(), { interrupted: true });
      } else {
        putBack(storage, item, {
          attempts: item.attempts - 1,
          notBefore: 0,
          interrupted: true,
        });
      }
    }
  });
};

/** No item of a waiting row's kind and key runs. */
const keyIdle = `NOT EXISTS (
  SELECT 1 FROM work_items AS r
  WHERE r.running = 1 AND r.kind = w.kind AND r.key = w.key
)`;

/** The next interrupted item that is due. */
const nextInterruptedSql = `
SELECT ${claimedColumns} FROM work_items AS w
WHERE running = 0 AND parked_at IS NULL AND interrupted = 1
  AND not_before <= ? AND ${keyIdle}
ORDER BY priority, id
LIMIT 1`;

/** A waiting row the claim may take: the condition of `work_items_waiting_idx`. */
const waitingRow = "running = 0 AND parked_at IS NULL AND interrupted = 0";

/**
 * The connections with items waiting, each found by one lookup of the
 * index (a skip scan): as cheap with 20,000 items of one connection as
 * with one.
 */
const connectionsSql = `
WITH RECURSIVE waiting(connection) AS (
  SELECT min(connection) FROM work_items WHERE ${waitingRow}
  UNION ALL
  SELECT (SELECT min(connection) FROM work_items
          WHERE ${waitingRow} AND connection > waiting.connection)
  FROM waiting WHERE waiting.connection IS NOT NULL
)
SELECT connection FROM waiting WHERE connection IS NOT NULL`;

/**
 * The first `?3` due items of one connection (`?2`), or of none, the
 * first first: read along the index, so the items of a connection at its
 * limit are never walked.
 */
const nextOf = (of: "none" | "one"): string => `
SELECT ${claimedColumns} FROM work_items AS w
WHERE ${waitingRow} AND connection ${of === "none" ? "IS NULL" : "= ?2"}
  AND not_before <= ?1 AND ${keyIdle}
ORDER BY priority, id
LIMIT ?3`;
const nextOfNoneSql = nextOf("none");
const nextOfOneSql = nextOf("one");

/** Parked items whose day is over come back, attempts reset (rule 5). */
const returnParkedSql = `
UPDATE work_items SET parked_at = NULL, attempts = 0, not_before = 0
WHERE parked_at IS NOT NULL AND parked_at <= ? AND parks < ?`;

interface RunningRow extends Record<string, SqlStorageValue> {
  connection: string | null;
  interrupted: number;
}

/** The model bucket's row, as kept. */
const bucketOf = (db: Db) => db.select().from(workModelBucket).get();

/** Whether the queue is paused at `now` (rule 1). */
const pausedAt = (db: Db, now: number): boolean =>
  (bucketOf(db)?.pausedUntil ?? 0) > now;

/**
 * Up to `free` of the due items, the first first, within each connection's
 * limit: the first few of no connection and of each connection with room,
 * merged, never the backlog of one at its limit.
 */
const pick = (
  storage: DurableObjectStorage,
  state: WorkState,
  now: number,
  free: number,
  running: readonly RunningRow[]
): Claimed[] => {
  if (free <= 0) {
    return [];
  }
  // A handler left running past its time still holds its connection's
  // place, as it holds its slot.
  const perConnection = new Map<string, number>();
  for (const { connection } of [...running, ...state.zombies.values()]) {
    if (connection !== null) {
      perConnection.set(connection, (perConnection.get(connection) ?? 0) + 1);
    }
  }
  // Enough of each to fill the slots past items whose key is held.
  const enough = free + state.zombies.size;
  const candidates = storage.sql
    .exec<Claimed>(nextOfNoneSql, now, null, enough)
    .toArray();
  const connections = storage.sql
    .exec<{ connection: string }>(connectionsSql)
    .toArray();
  for (const { connection } of connections) {
    if ((perConnection.get(connection) ?? 0) < workPerConnection) {
      candidates.push(
        ...storage.sql
          .exec<Claimed>(nextOfOneSql, now, connection, enough)
          .toArray()
      );
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.id - b.id);
  const picked: Claimed[] = [];
  for (const row of candidates) {
    const { connection } = row;
    const under =
      connection === null ? 0 : (perConnection.get(connection) ?? 0);
    if (!state.zombies.has(zombieOf(row)) && under < workPerConnection) {
      if (connection !== null) {
        perConnection.set(connection, under + 1);
      }
      picked.push(row);
      if (picked.length >= free) {
        break;
      }
    }
  }
  return picked;
};

/**
 * The cost of a claim: one index lookup per connection with items
 * waiting (`connectionsSql`, `pick`), whatever their backlogs. Measured
 * flat for one connection with 20,000 items; hundreds of connections with
 * items waiting at once are unmeasured (GRA-1736, on staging).
 *
 * Claims what may start now within the queue's limits, counting each
 * one's attempt, in one synchronous step: so two ticks never claim one
 * item, and a crash in its work still counts it. Nothing while the queue
 * is paused. An interrupted item runs alone: first, once nothing else
 * runs, and nothing else while it does. When only handlers left running
 * past their time keep it waiting, the store restarts (rule 6). Nothing
 * while a restart is on its way.
 */
const claim = (
  storage: DurableObjectStorage,
  state: WorkState,
  now: number
): Claimed[] => {
  if (state.restarting || pausedAt(drizzle(storage), now)) {
    return [];
  }
  storage.sql.exec(returnParkedSql, now - workParkedMs, workParksMax);
  const running = storage.sql
    .exec<RunningRow>(
      "SELECT connection, interrupted FROM work_items WHERE running = 1"
    )
    .toArray();
  if (running.some(({ interrupted }) => interrupted === 1)) {
    return [];
  }
  const [alone] = storage.sql.exec<Claimed>(nextInterruptedSql, now).toArray();
  let claimed: Claimed[] = [];
  if (alone === undefined || state.zombies.has(zombieOf(alone))) {
    // A handler left running past its time still holds its slot.
    const free = workAtOnce - running.length - state.zombies.size;
    claimed = pick(storage, state, now, free, running);
  } else if (running.length === 0 && state.zombies.size === 0) {
    // Alone: not even beside a handler left running past its time.
    claimed = [alone];
  } else if (running.length === 0) {
    // Only handlers past their time stand in its way, and may never end:
    // the store restarts, which ends them, and claims nothing meanwhile.
    // Their rows are settled and on disk before it lands, so the next
    // instance starts with none of them running and runs the item alone.
    restartStore(state);
  }
  for (const item of claimed) {
    item.attempts += 1;
    storage.sql.exec(
      "UPDATE work_items SET running = 1, attempts = ? WHERE id = ?",
      item.attempts,
      item.id
    );
  }
  return claimed;
};

/**
 * Pauses the queue at `at` for `reason` (rule 2): 60 s, or what the
 * provider asked if longer, at most 30 minutes; 15 minutes for the
 * account. Returns until when.
 */
const pause = (
  storage: DurableObjectStorage,
  at: number,
  reason: ModelTrouble,
  askedMs = 0
): number => {
  const db = drizzle(storage);
  const kept = bucketOf(db);
  const keptUntil = kept?.pausedUntil ?? 0;
  const least = reason === "account" ? pauseAccountMs : pauseLeastMs;
  const asked = at + Math.min(pauseMostMs, Math.max(least, askedMs));
  // The pause keeps the reason that owns its end, the later one: a 5xx
  // within a longer rate limit never relabels it, nor lets an answer end it.
  const keptReason = kept?.pauseReason ?? null;
  const until = Math.max(keptUntil, asked);
  const paused = {
    pausedUntil: until,
    pausedSince: kept?.pausedSince ?? at,
    pauseReason:
      keptReason !== null && keptUntil >= asked ? keptReason : reason,
  };
  db.insert(workModelBucket)
    .values({ id: 1, tokens: workModelRate.burst, at, ...paused })
    .onConflictDoUpdate({ target: workModelBucket.id, set: paused })
    .run();
  return until;
};

/** An answered call ends the pause, unless it is a rate limit's still running (rule 2). */
const answered = (storage: DurableObjectStorage, at: number): void => {
  // A rate limit holds until the provider's own time, whatever an answer
  // to a call sent before it says.
  storage.sql.exec(
    `UPDATE work_model_bucket SET paused_until = 0, paused_since = NULL, pause_reason = NULL
     WHERE pause_reason IS NOT 'rate_limited' OR paused_until <= ?`,
    at
  );
};

/** Rejects once `signal` aborts, with no timer of its own; `release` drops its listener. */
const abortion = (signal: AbortSignal) => {
  const { promise, reject } = Promise.withResolvers<never>();
  const aborted = () => {
    reject(signal.reason);
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    aborted();
  }
  return {
    promise,
    release: () => {
      signal.removeEventListener("abort", aborted);
    },
  };
};

/**
 * Waits for the turns before this one, then takes a token for the
 * queue's model, waiting for one if needed: first come, first served, and
 * never past the item's time (`signal`). Throws `WorkWaitsError` once the
 * queue is paused.
 */
const takeTurn = async (
  storage: DurableObjectStorage,
  state: WorkState,
  { now, signal }: Attempt
): Promise<void> => {
  const before = state.turns;
  const { promise: mine, resolve } = Promise.withResolvers<true>();
  state.turns = mine;
  let ours = false;
  try {
    const stop = abortion(signal);
    try {
      await Promise.race([before, stop.promise]);
    } finally {
      stop.release();
    }
    ours = true;
    const db = drizzle(storage);
    for (;;) {
      signal.throwIfAborted();
      const at = now();
      const kept = bucketOf(db);
      if ((kept?.pausedUntil ?? 0) > at) {
        throw new WorkWaitsError(kept?.pausedUntil ?? at);
      }
      // Ticks at different times never move the bucket back.
      const { taken, bucket } = takeToken(
        kept === undefined ? undefined : { tokens: kept.tokens, at: kept.at },
        workModelRate,
        Math.max(at, kept?.at ?? at)
      );
      db.insert(workModelBucket)
        .values({ id: 1, ...bucket, pausedUntil: 0 })
        .onConflictDoUpdate({ target: workModelBucket.id, set: bucket })
        .run();
      if (taken) {
        return;
      }
      const untilToken = Math.ceil(
        ((1 - bucket.tokens) * 60_000) / workModelRate.perMinute
      );
      // oxlint-disable-next-line no-await-in-loop -- the next token, then take it
      await scheduler.wait(untilToken, { signal });
    }
  } finally {
    if (ours) {
      resolve(true);
    } else {
      // Left the line early: the next still waits for the one before.
      void (async () => {
        await before;
        resolve(true);
      })();
    }
  }
};

/** Whether `request` can be sent: text, and within `workRequestMaxLength`. */
const sendable = (request: unknown): boolean => {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const system: unknown = Reflect.get(request, "system");
  const input: unknown = Reflect.get(request, "input");
  return (
    typeof system === "string" &&
    typeof input === "string" &&
    system.length + input.length <= workRequestMaxLength
  );
};

/** One attempt: the queue's clock, its signal, and its calls so far. */
interface Attempt {
  now: () => number;
  signal: AbortSignal;
  /** When its time is up, in real time. */
  deadline: number;
  calls: number;
}

/**
 * `request` asked of the host's model for an item of `kind` (rules 2 and
 * 3): in its turn, given what is left of the item's time less a moment, so
 * the host can say it timed out before the item's time is up.
 */
const askWithin = async (
  storage: DurableObjectStorage,
  state: WorkState,
  ask: AskModel,
  kind: string,
  request: { system: string; input: string },
  attempt: Attempt
): Promise<string> => {
  const { now, signal, deadline } = attempt;
  signal.throwIfAborted();
  if (!sendable(request)) {
    throw new WorkError("invalid_request");
  }
  if (attempt.calls >= workCallsMax) {
    throw new WorkError("too_many_calls");
  }
  attempt.calls += 1;
  await takeTurn(storage, state, attempt);
  const left = deadline - Date.now();
  let reply: unknown = undefined;
  try {
    reply = await ask({
      purpose: `brain.${kind}`,
      ...request,
      timeoutMs: Math.max(1, left - Math.min(1000, Math.floor(left / 10))),
    });
  } catch {
    signal.throwIfAborted();
    // The host out of reach: its trouble, not the item's.
    throw new WorkWaitsError(pause(storage, now(), "unavailable"));
  }
  const parsed = modelReplySchema.safeParse(reply);
  if (!parsed.success || parsed.data.kind === "refused") {
    throw new WorkError("model_refused");
  }
  if (parsed.data.kind === "timed_out") {
    throw new WorkError("timed_out");
  }
  if (parsed.data.kind === "busy") {
    const askedMs = (parsed.data.retryAfterSeconds ?? 0) * 1000;
    throw new WorkWaitsError(
      pause(storage, now(), parsed.data.reason, askedMs)
    );
  }
  answered(storage, now());
  return parsed.data.text;
};

/** How an attempt's handler ended: done, or failed with `error`. */
interface Outcome {
  error?: unknown;
  /** Whether its time was up as it ended. */
  timedOut: boolean;
}

/** Settles `item` as its attempt ended at `now`: never throws. */
const settle = (
  storage: DurableObjectStorage,
  item: Claimed,
  { error, timedOut }: Outcome,
  now: number,
  done: boolean
): void => {
  if (done) {
    // Its work is done, in time or not.
    drizzle(storage).delete(workItems).where(eq(workItems.id, item.id)).run();
    return;
  }
  if (error instanceof WorkWaitsError) {
    // The queue's pause, not the item's failure: its attempt is given back.
    putBack(storage, item, {
      attempts: item.attempts - 1,
      notBefore: error.until,
    });
    return;
  }
  let code: WorkErrorCode = timedOut ? "timed_out" : "failed";
  if (error instanceof WorkError) {
    ({ code } = error);
  }
  fail(storage, item, code, now, { interrupted: false });
};

/**
 * Runs one claimed item's attempt and settles it; never throws. It ends
 * when its handler ends, or once its time and a grace are over (rule 6).
 * Every timer it starts is cleared once its race is decided.
 */
const runItem = async (
  storage: DurableObjectStorage,
  state: WorkState,
  item: Claimed,
  ask: AskModel,
  now: () => number
): Promise<void> => {
  const runner = runners.get(item.kind);
  if (runner === undefined) {
    fail(storage, item, "unknown_kind", now(), { interrupted: false });
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const limit = setTimeout(() => {
    controller.abort(new WorkError("timed_out"));
  }, runner.timeLimitMs);
  const attempt: Attempt = {
    now,
    signal,
    deadline: Date.now() + runner.timeLimitMs,
    calls: 0,
  };
  const handled = (async (): Promise<Outcome & { done: boolean }> => {
    try {
      await runner.run(JSON.parse(item.payload), {
        storage,
        signal,
        ask: async (request) =>
          await askWithin(storage, state, ask, item.kind, request, attempt),
      });
      return { done: true, timedOut: signal.aborted };
    } catch (error) {
      return { done: false, error, timedOut: signal.aborted };
    } finally {
      clearTimeout(limit);
      // Nothing of it asks the model once it ended: not an `ask` it left behind.
      controller.abort(new WorkError("timed_out"));
    }
  })();
  const { promise: graceOver, resolve: graceEnds } =
    Promise.withResolvers<"grace">();
  const grace = setTimeout(
    () => {
      graceEnds("grace");
    },
    runner.timeLimitMs + graceOf(runner.timeLimitMs)
  );
  const ended = await Promise.race([handled, graceOver]);
  clearTimeout(grace);
  if (ended !== "grace") {
    settle(storage, item, ended, now(), ended.done);
    return;
  }
  const zombie = zombieOf(item);
  state.zombies.set(zombie, {
    kind: item.kind,
    key: item.key,
    connection: item.connection,
  });
  settle(
    storage,
    item,
    { error: new WorkError("timed_out"), timedOut: true },
    now(),
    false
  );
  void (async () => {
    await handled;
    state.zombies.delete(zombie);
  })();
  if (state.zombies.size >= workAtOnce) {
    // Handlers that ignored their signal hold every slot. Their rows are
    // settled, and on disk before the restart lands: it ends them and
    // loses nothing.
    restartStore(state);
  }
};

/**
 * Works the queue in `storage` for one tick at `at`: claims what may start
 * as items end and as items are added, until nothing more is due or the
 * tick's claiming time is over, and returns once what it started has
 * settled. Model calls go to `ask`, which is used only while this runs.
 */
export const workTick = async (
  storage: DurableObjectStorage,
  state: WorkState,
  ask: AskModel,
  at: Date
): Promise<void> => {
  const began = Date.now();
  const now = () => at.getTime() + (Date.now() - began);
  /** This tick's items under way, by ID. */
  const underWay = new Map<number, Promise<void>>();
  for (;;) {
    const claiming = Date.now() - began < tickClaimMs;
    if (claiming) {
      for (const item of claim(storage, state, now())) {
        underWay.set(
          item.id,
          (async () => {
            await runItem(storage, state, item, ask, now);
            underWay.delete(item.id);
          })()
        );
      }
    }
    if (underWay.size === 0) {
      return;
    }
    const { promise: look, resolve: lookAgain } =
      Promise.withResolvers<"look">();
    const timer = claiming
      ? setTimeout(() => {
          lookAgain("look");
        }, tickLookMs)
      : undefined;
    // oxlint-disable-next-line no-await-in-loop -- claims again as each ends, or looks again
    await Promise.race([...underWay.values(), look]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const isErrorCode = (code: string): code is WorkErrorCode =>
  Object.hasOwn(workErrors, code);

/** A kept error's code: the queue writes only its own. */
const errorCodeOf = (kept: string | null): WorkErrorCode =>
  kept !== null && isErrorCode(kept) ? kept : "failed";

/** The queue in `storage`, as staff see it. */
export const workOverview = (
  storage: DurableObjectStorage,
  state: WorkState
): Omit<WorkOverview, "stepsFailed"> => {
  const db = drizzle(storage);
  const waiting = db
    .select({
      kind: workItems.kind,
      count: count(),
      oldestAddedAt: min(workItems.addedAt),
    })
    .from(workItems)
    .where(sql.raw("running = 0 AND parked_at IS NULL"))
    .groupBy(workItems.kind)
    .orderBy(workItems.kind)
    .all();
  const [running] = storage.sql
    .exec<{ count: number }>(
      "SELECT count(*) AS count FROM work_items WHERE running = 1"
    )
    .toArray();
  const parked = storage.sql
    .exec<{
      kind: string;
      key: string;
      attempts: number;
      parks: number;
      last_error: string | null;
      parked_at: number;
    }>(
      `SELECT kind, key, attempts, parks, last_error, parked_at FROM work_items
       WHERE parked_at IS NOT NULL ORDER BY parked_at DESC, id DESC LIMIT ?`,
      parkedListed
    )
    .toArray();
  const [parkedCount] = storage.sql
    .exec<{ count: number }>(
      "SELECT count(*) AS count FROM work_items WHERE parked_at IS NOT NULL"
    )
    .toArray();
  const bucket = bucketOf(db);
  const paused =
    bucket?.pausedSince === null ||
    bucket?.pausedSince === undefined ||
    bucket.pauseReason === null
      ? null
      : {
          reason: bucket.pauseReason,
          since: new Date(bucket.pausedSince),
          until: new Date(bucket.pausedUntil),
        };
  return {
    waiting: waiting.map(({ kind, count: waitingCount, oldestAddedAt }) => ({
      kind,
      count: waitingCount,
      oldestAddedAt: oldestAddedAt ?? new Date(0),
    })),
    running: running?.count ?? 0,
    parked: parked.map((row) => {
      const error = errorCodeOf(row.last_error);
      return {
        kind: row.kind,
        key: row.key,
        attempts: row.attempts,
        error,
        message: workErrors[error],
        parkedAt: new Date(row.parked_at),
        parks: row.parks,
        final: row.parks >= workParksMax,
      };
    }),
    parkedCount: parkedCount?.count ?? 0,
    paused,
    overdue: [...state.zombies.values()].map(({ kind, key }) => ({
      kind,
      key,
    })),
  };
};
