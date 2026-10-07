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
//   its deadline, the status `waiting` and the nearest deadline of all its
//   waits as the run's wake; then the alarm is set to that wake, and the
//   activation ends (activation.ts). Nothing of the run stays in memory.
//   Every alarm and event replays to the wait, which reads its deadline
//   back from the journal, so no duplicate, early or late alarm moves it.
// - Each alarm write follows the journal write it goes with in the same
//   synchronous turn, so the alarm always says what the latest write
//   meant, whichever path wrote last.
//
// A step's outcome is journaled before the definition sees it. A step cut
// off after its effect left but before that write runs again, with the
// same idempotency key (contracts.ts): at least once, not exactly once.
import { DurableObject } from "cloudflare:workers";

import { Activation, superseded, suspended } from "./activation.ts";
import type { Settlement } from "./activation.ts";
import { canonical, decode } from "./codec.ts";
import type {
  DefinitionIdentity,
  InstanceStatus,
  WorkflowDefinition,
} from "./contracts.ts";
import { errorRecord, namedError, parseError } from "./errors.ts";
import {
  createJournal,
  hasJournal,
  journalSchemaVersion,
  readJournal,
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
  readRun,
} from "./journal.ts";
import type { Journal, RunRow } from "./journal.ts";

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
        canonical(existing.params) !== canonical(command.params) ||
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

  /** The run's whole journal, as plain data. */
  journal(): Journal | undefined {
    return hasJournal(this.ctx.storage.sql)
      ? readJournal(this.ctx.storage.sql)
      : undefined;
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

  /** One activation: replays the definition under a new generation. */
  override async alarm(): Promise<void> {
    const run = this.#run();
    if (run === undefined || hasEnded(run)) {
      // A duplicate or late alarm: what it would do is journaled already.
      return;
    }
    const { storage } = this.ctx;
    const generation = run.generation + 1;
    const now = Date.now();
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
    // The watchdog, in the same write as the new generation.
    await storage.setAlarm(now + this.leaseMs);

    const activation = new Activation(storage, run, generation, this.leaseMs);
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
            // The same payload, whatever order a retry put its keys in.
            canonical(sent.payload) === canonical(command.payload);
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
