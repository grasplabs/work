// The run object: one SQLite-backed Durable Object per workflow run. It is
// the only authority on the run: its creation, its status, its steps'
// outcomes. Register it privately (no route reaches it); callers go through
// the binding (binding.ts), the host by subclassing it to resolve
// definitions.
//
// Executing a run is always an alarm's job: creating it arms the alarm, and
// each alarm is one activation that replays the definition from the start.
// Alarms are at least once, on Cloudflare and on plain workerd alike: an
// alarm whose handler was cut off (the process killed, the object evicted)
// runs again, and one may run while another is still out. So:
//
// - Every activation takes a new generation, journaled before it runs any
//   of the definition. A call from an older generation, and an answer that
//   arrives for one, is refused: the fence.
// - A refused call is answered with a promise that never settles, never an
//   error. Definition code can catch errors (its own try/catch/finally, or
//   a transport that turns errors into values); a promise that never
//   settles just leaves it where it stopped, so no handler of the author's
//   runs in an activation that is over.
// - Before executing, an activation arms the alarm as a watchdog, a lease
//   away, and renews it at every step. If the activation dies, the watchdog
//   is the run's way back; when it settles, it removes the alarm in the
//   same write as its outcome. An object gets no alarm while its alarm
//   handler still runs, so a live activation is not raced by its own
//   watchdog, however long a step takes (test/process shows it on workerd).
// - A sleep or an event wait that isn't due suspends the run: in one write,
//   its deadline (journaled when it was first reached), the status
//   `waiting` and that deadline as the run's wake; then the alarm is set to
//   that wake, and the activation ends (activation.ts). Waits come one at
//   a time, so there is one deadline to wake for. Nothing of the run stays
//   in memory. Every alarm and event replays to the wait, which reads its
//   deadline back from the journal, so no duplicate, early or late alarm
//   moves it.
// - A step's failed attempt with a retry left journals the retry's
//   absolute time in the write that ends the attempt; a retry not yet due
//   parks the step, and once every step still out is parked the run
//   suspends the way a sleep does, its wake the earliest parked retry (or
//   at once, for an attempt left to a fresh activation's wall time). Every
//   alarm replays to the steps, which read their times back. An attempt
//   past its timeout is ended in the journal, and only a step's latest
//   attempt can journal its outcome, so the late answer of one that timed
//   out is ignored.
// - A storage failure the engine meets is a fault, never an error out of
//   `alarm()`: the activation is journaled `faulted` if storage lets it,
//   and the watchdog alarm brings the run back. Only when no alarm can be
//   set at all does the error go to the host, whose retry of the alarm is
//   then the run's one way back.
// - Each alarm write follows the journal write it goes with in the same
//   synchronous turn, so the alarm always says what the latest write
//   meant, whichever path wrote last.
//
// The host enables `nodejs_als` (or `nodejs_compat`, which includes it):
// each call of the step API is told apart by the attempt it comes from,
// through AsyncLocalStorage (activation.ts).
//
// A step's outcome is journaled before the definition sees it. A step cut
// off after its effect left but before that write runs again, with the
// same idempotency key (contracts.ts): at least once, not exactly once. So
// does a step whose attempt timed out or failed: its retry has a new
// attempt number, and the same key.
//
// A step's result is kept as codec text (codec.ts) or, for a byte stream,
// as chunks in this object's storage (streams.ts). A result the step can't
// keep ends the run, as it does on Cloudflare: the definition doesn't get
// to catch it, and it isn't retried. Observers read the run's history
// (history.ts), where a sensitive step's result is redacted; the raw result
// is for the run's own replay and the host's inspection (`stepOutput`).
import { DurableObject } from "cloudflare:workers";

import { Activation, superseded, suspended } from "./activation.ts";
import type { Settlement } from "./activation.ts";
import { decode, equivalent, streamResultOf } from "./codec.ts";
import { handlerBudgetMs as defaultHandlerBudgetMs } from "./config.ts";
import type {
  DefinitionIdentity,
  InstanceStatus,
  WorkflowDefinition,
} from "./contracts.ts";
import { errorRecord, namedError, parseError } from "./errors.ts";
import { readHistory } from "./history.ts";
import type { HistoryEvent } from "./history.ts";
import {
  createJournal,
  hasJournal,
  JournalSchemaError,
  journalSchemaVersion,
  readJournal,
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
  readRun,
  readStep,
} from "./journal.ts";
import type { Journal, RunRow } from "./journal.ts";
import {
  defaultMaxRunStreamBytes,
  defaultMaxStreamBytes,
  replayStream,
} from "./streams.ts";

/** What `WorkflowRun.journal()` returns. */
export type { Journal } from "./journal.ts";

/** How long an activation may go without journaling before it's recovered. */
export const defaultLeaseMs = 60_000;

/** What the binding asks the run object to create. */
export interface StartCommand {
  definition: string;
  version: string | null;
  instanceId: string;
  /** The params, already encoded (codec.ts): nothing live crosses. */
  params: string;
  /** Says which start this is: the same key again is the same start. */
  key: string;
}

/** What the instance asks the run object to accept into its inbox. */
export interface EventCommand {
  type: string;
  /** The payload, already encoded (codec.ts). */
  payload: string;
  /** The sender's delivery key, or null for an event with none. */
  key: string | null;
}

/**
 * `accepted`: the event is in the run's inbox. `duplicate`: an event with
 * this key and this content was accepted before. `conflict`: the key came
 * with another type or payload. `too_large`: the payload is over
 * `maxEventPayloadBytes`. `full`: the inbox is at one of its limits.
 * `ended`: the run has ended and takes no events. `missing`: there is no
 * such run.
 */
export type EventOutcome =
  | "accepted"
  | "duplicate"
  | "conflict"
  | "too_large"
  | "full"
  | "ended"
  | "missing";

interface EventDecision {
  outcome: EventOutcome;
  wake: boolean;
}

/**
 * A completed step's result, raw: a value, or a fresh stream of its bytes
 * with what they were committed as.
 */
export type StepOutput =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "stream";
      readonly stream: ReadableStream<Uint8Array>;
      readonly length: number;
      readonly sha256: string;
      readonly encoding: string;
    };

/**
 * `created`: this command created the run. `existing`: the run was created
 * by an earlier delivery of this same start. `collision`: another start
 * created a run under this ID. `conflict`: the same start key came with
 * other params, so it isn't the same start.
 */
export type StartOutcome = "created" | "existing" | "collision" | "conflict";

const statusOf = (run: RunRow): InstanceStatus => {
  switch (run.status) {
    case "complete": {
      return {
        status: "complete",
        output: run.output === null ? undefined : decode(run.output),
      };
    }
    case "errored": {
      return {
        status: "errored",
        error:
          run.error === null
            ? { name: "Error", message: "" }
            : parseError(run.error),
      };
    }
    case "queued":
    case "running":
    case "waiting": {
      return { status: run.status };
    }
    default: {
      throw new Error(
        `The journal holds an unknown status: ${String(run.status)}`
      );
    }
  }
};

const hasEnded = (run: RunRow): boolean =>
  run.status === "complete" || run.status === "errored";

/**
 * A workflow run. Subclass it to say which definition a run executes, and
 * register the subclass as a SQLite-backed Durable Object class with no
 * route to it. Its RPC methods are for the binding (binding.ts).
 */
export abstract class WorkflowRun<Env = unknown> extends DurableObject<Env> {
  /** How long an activation may go quiet before the alarm recovers the run. */
  protected readonly leaseMs: number = defaultLeaseMs;

  /** The most bytes a step's stream result may hold. */
  protected readonly maxStreamOutputBytes: number = defaultMaxStreamBytes;

  /** The most bytes all of a run's stream results may hold together. */
  protected readonly maxRunStreamBytes: number = defaultMaxRunStreamBytes;

  /**
   * How much of an alarm handler's wall time a run's attempts may take
   * (config.ts). A host whose handlers get less than Cloudflare's 15
   * minutes says so here; a test, to see an attempt left for a fresh
   * activation without waiting minutes.
   */
  protected readonly handlerBudgetMs: number = defaultHandlerBudgetMs;

  /**
   * The clock an attempt's running time, and a delay function's, is
   * measured on: Date.now(). A test stands in for it to measure code that
   * runs without awaiting anything.
   */
  // oxlint-disable-next-line class-methods-use-this -- the seam a subclass overrides
  protected clock(): number {
    return Date.now();
  }

  /**
   * The definition a run executes, built afresh for every activation:
   * nothing of it is kept between them. `undefined` when there is no such
   * definition, which ends the run as errored.
   */
  protected abstract definition(
    identity: DefinitionIdentity
  ): WorkflowDefinition | undefined;

  #run(): RunRow | undefined {
    const { sql } = this.ctx.storage;
    return hasJournal(sql) ? readRun(sql) : undefined;
  }

  /**
   * Creates the run, or finds the one this same start created before. The
   * run and its alarm are written together, before the answer: once a
   * caller hears `created` or `existing`, the run will execute.
   */
  async start(command: StartCommand): Promise<StartOutcome> {
    const existing = this.#run();
    if (existing !== undefined) {
      const sameStart =
        existing.start_key === command.key &&
        existing.definition === command.definition &&
        existing.instance_id === command.instanceId;
      if (!sameStart) {
        return "collision";
      }
      if (
        // The same params, whatever order a retry put their keys in.
        !equivalent(existing.params, command.params) ||
        existing.version !== command.version
      ) {
        return "conflict";
      }
      await this.#ensureWake(existing);
      return "existing";
    }
    const { storage } = this.ctx;
    const now = Date.now();
    createJournal(storage.sql);
    storage.sql.exec(
      "INSERT INTO run (singleton, schema, run_uid, definition, version, instance_id, start_key, params, created_at, status, generation) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0)",
      journalSchemaVersion,
      crypto.randomUUID(),
      command.definition,
      command.version,
      command.instanceId,
      command.key,
      command.params,
      now
    );
    // No await between the insert and this: one write.
    await storage.setAlarm(now);
    return "created";
  }

  /**
   * A run that hasn't ended always has an alarm; a repeated start re-arms
   * one that has gone missing, so asking again is a way to repair it. The
   * input gate holds other events while getAlarm is out; at worst this
   * brings an alarm forward, and an extra activation is fenced.
   */
  async #ensureWake(run: RunRow): Promise<void> {
    if (hasEnded(run)) {
      return;
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  status(): InstanceStatus | undefined {
    const run = this.#run();
    return run === undefined ? undefined : statusOf(run);
  }

  /**
   * The run's whole journal, as plain data: raw, a sensitive step's result
   * too, for the host's own inspection. Observers read `history`.
   */
  journal(): Journal | undefined {
    return hasJournal(this.ctx.storage.sql)
      ? readJournal(this.ctx.storage.sql)
      : undefined;
  }

  /**
   * What observers are shown of the run, in order: a sensitive step's
   * result is `"[REDACTED]"`, a stream result its length and hash.
   */
  history(): HistoryEvent[] {
    return hasJournal(this.ctx.storage.sql)
      ? readHistory(this.ctx.storage.sql)
      : [];
  }

  /**
   * The raw result of the `count`-th step named `name` that completed, a
   * sensitive one too, or undefined when there is none. For the host's own
   * inspection: like every method here, only the host reaches it.
   */
  async stepOutput(step: {
    name: string;
    count: number;
  }): Promise<StepOutput | undefined> {
    const { sql } = this.ctx.storage;
    if (!hasJournal(sql)) {
      return undefined;
    }
    const row = readStep(sql, {
      type: "do",
      name: step.name,
      occurrence: step.count,
    });
    if (row?.state !== "succeeded" || row.value === null) {
      return undefined;
    }
    const stream = streamResultOf(row.value);
    if (stream === undefined) {
      return { kind: "value", value: decode(row.value) };
    }
    const replay = await replayStream(sql, row.ordinal, stream);
    if ("corrupt" in replay) {
      throw replay.corrupt;
    }
    return {
      kind: "stream",
      stream: replay.stream,
      length: stream.length,
      sha256: stream.sha256,
      encoding: stream.encoding,
    };
  }

  /** The definition, or why there is none, as the run's end. */
  #resolve(run: RunRow): WorkflowDefinition | Settlement {
    const identity = {
      definition: run.definition,
      version: run.version ?? undefined,
    };
    try {
      const definition = this.definition(identity);
      if (definition !== undefined) {
        return definition;
      }
    } catch (error) {
      const { name, message } = errorRecord(error);
      return { ok: false, error: namedError(name, message) };
    }
    const version =
      identity.version === undefined
        ? ""
        : ` at version ${JSON.stringify(identity.version)}`;
    return {
      ok: false,
      error: namedError(
        "WorkflowDefinitionNotFound",
        `There is no workflow definition ${JSON.stringify(identity.definition)}${version}`
      ),
    };
  }

  /**
   * Leaves the run to a watchdog a lease from now, after a storage
   * failure before any of the definition ran. When even that alarm can't
   * be set, `error` goes to the host: with no alarm of the run's own, the
   * host's retry of this one is the run's only way back.
   */
  async #leaveToWatchdog(error: unknown): Promise<void> {
    try {
      await this.ctx.storage.setAlarm(Date.now() + this.leaseMs);
    } catch {
      throw error;
    }
  }

  /** One activation: replays the definition under a new generation. */
  override async alarm(): Promise<void> {
    let run: RunRow | undefined;
    try {
      run = this.#run();
    } catch (error) {
      if (!(error instanceof JournalSchemaError)) {
        // Storage failed as the run was read: nothing was written.
        await this.#leaveToWatchdog(error);
        return;
      }
      // A journal this engine doesn't read: nothing here can run it, and
      // retrying would only refuse it again. No alarm is left to do so.
      try {
        await this.ctx.storage.deleteAlarm();
      } catch {
        // An alarm left behind is refused the same way when it comes.
      }
      return;
    }
    if (run === undefined || hasEnded(run)) {
      // A duplicate or late alarm: what it would do is journaled already.
      return;
    }
    const { storage } = this.ctx;
    const generation = run.generation + 1;
    const now = Date.now();
    try {
      storage.transactionSync(() => {
        storage.sql.exec(
          "UPDATE run SET generation = ?, status = 'running', lease_until = ?, wake_at = NULL",
          generation,
          now + this.leaseMs
        );
        storage.sql.exec(
          "INSERT INTO activations (generation, started_at) VALUES (?, ?)",
          generation,
          now
        );
      });
    } catch (error) {
      // No generation was taken, and no activation journaled.
      await this.#leaveToWatchdog(error);
      return;
    }
    try {
      // The watchdog, in the same write as the new generation.
      await storage.setAlarm(now + this.leaseMs);
    } catch (error) {
      // The generation is taken, but nothing would bring the run back if
      // this activation died: none of the definition runs. Journaled as
      // faulted if storage lets it; the host's retry of this alarm is the
      // run's way back.
      try {
        storage.sql.exec(
          "UPDATE activations SET ended_at = ?, ended = 'faulted' WHERE generation = ? AND ended_at IS NULL",
          Date.now(),
          generation
        );
      } catch {
        // Its row stays open, as after a crash.
      }
      throw error;
    }

    const activation = new Activation(
      storage,
      run,
      generation,
      {
        leaseMs: this.leaseMs,
        handlerBudgetMs: this.handlerBudgetMs,
        maxStreamBytes: this.maxStreamOutputBytes,
        maxRunStreamBytes: this.maxRunStreamBytes,
      },
      () => this.clock()
    );
    const resolved = this.#resolve(run);
    if (!("run" in resolved)) {
      await activation.settle(resolved);
      return;
    }
    const settlement = await Promise.race([
      activation.execute(resolved),
      activation.stopped,
    ]);
    if (settlement === superseded || settlement === suspended) {
      // A later activation owns the run, or the run waits for the alarm
      // its suspension set. Either way this handler is done: a waiting run
      // holds no compute.
      return;
    }
    if ("halt" in settlement) {
      // Replaying would only reach the same thing again: the run ends,
      // with the reason as its error.
      await activation.settle({ ok: false, error: settlement.halt }, true);
      return;
    }
    if ("fault" in settlement) {
      // The journal write failed; the activation journaled that, if it
      // could. Returning leaves the alarm as it was, the watchdog or the
      // wake, to bring the run back with its deadlines as journaled.
      // Throwing would hand recovery to the host's alarm retries instead,
      // whose count is finite and whose timing isn't ours.
      return;
    }
    await activation.settle(settlement);
  }

  /**
   * Accepts an event into the run's inbox: journaled, in order, with the
   * time it was accepted, before the answer. A run that waits for an event
   * of this type, and is still before that wait's deadline, is woken in
   * the same write. A key the run has seen is the same event delivered
   * again, and accepted once.
   */
  async sendEvent(command: EventCommand): Promise<EventOutcome> {
    const { storage } = this.ctx;
    if (!hasJournal(storage.sql)) {
      return "missing";
    }
    const now = Date.now();
    const decision = storage.transactionSync((): EventDecision => {
      const run = readRun(storage.sql);
      if (run === undefined) {
        return { outcome: "missing", wake: false };
      }
      // A delivery's key is looked up first: one sent again after the run
      // ended is still the event it was.
      if (command.key !== null) {
        const [sent] = storage.sql
          .exec<{
            type: string;
            payload: string;
            accepted_at: number;
            consumed_by: number | null;
          }>(
            "SELECT type, payload, accepted_at, consumed_by FROM events WHERE key = ?",
            command.key
          )
          .toArray();
        if (sent !== undefined) {
          const same =
            sent.type === command.type &&
            // The same payload, whatever order a retry put its keys in, and
            // whichever of its parts it shared.
            equivalent(sent.payload, command.payload);
          if (!same) {
            return { outcome: "conflict", wake: false };
          }
          // The first delivery's wake may not have been written (its alarm
          // write failed after the event was): a retry that finds the
          // event still untaken, by a wait still in time for it, wakes
          // the run again.
          const wake =
            sent.consumed_by === null &&
            this.#wakeFor(run, sent.type, sent.accepted_at, now);
          return { outcome: "duplicate", wake };
        }
      }
      if (hasEnded(run)) {
        return { outcome: "ended", wake: false };
      }
      // Measured on the encoded text the journal keeps, here as well as
      // in the binding: this method is the run's boundary.
      const bytes = new TextEncoder().encode(command.payload).byteLength;
      if (bytes > maxEventPayloadBytes) {
        return { outcome: "too_large", wake: false };
      }
      if (
        run.event_count >= maxInboxEvents ||
        run.event_bytes + bytes > maxInboxBytes
      ) {
        return { outcome: "full", wake: false };
      }
      storage.sql.exec(
        "INSERT INTO events (type, payload, key, accepted_at) VALUES (?, ?, ?, ?)",
        command.type,
        command.payload,
        command.key,
        now
      );
      storage.sql.exec(
        "UPDATE run SET event_count = event_count + 1, event_bytes = event_bytes + ?",
        bytes
      );
      return {
        outcome: "accepted",
        wake: this.#wakeFor(run, command.type, now, now),
      };
    });
    if (decision.wake) {
      // With the write that accepted the event: no await between.
      await storage.setAlarm(now);
    }
    return decision.outcome;
  }

  /**
   * Whether an event of `type` accepted at `acceptedAt` should wake the
   * run now, journaling the wake if so. Only a suspended run needs waking:
   * a live activation reaches the wait itself, and a dead one has its
   * watchdog. The wait must be in time for the event and not yet over.
   * Called inside the transaction that accepted (or found) the event.
   */
  #wakeFor(
    run: RunRow,
    type: string,
    acceptedAt: number,
    now: number
  ): boolean {
    const { sql } = this.ctx.storage;
    const wake =
      run.status === "waiting" &&
      sql
        .exec(
          "SELECT 1 FROM steps WHERE state = 'waiting' AND type = 'waitForEvent' AND event_type = ? AND deadline > ? AND deadline > ?",
          type,
          now,
          acceptedAt
        )
        .toArray().length > 0;
    if (wake) {
      sql.exec("UPDATE run SET wake_at = ?", now);
    }
    return wake;
  }
}
