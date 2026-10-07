// One activation: one execution of a run's definition, from the start,
// under one generation (run.ts says when there is one). Steps the journal
// has an outcome for return it; the first step without one runs.
import { decode, encode } from "./codec.ts";
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepContext,
} from "./contracts.ts";
import { errorRecord, rebuild } from "./errors.ts";
import { assertStepName, stepKey } from "./identity.ts";
import { readRun, readStep } from "./journal.ts";
import type { RunRow, StepRow } from "./journal.ts";

/** What the definition did: returned, or threw. */
export type Settlement =
  | { ok: true; output: unknown }
  | { ok: false; error: unknown };

/** What `stopped` resolves with. */
export const superseded = Symbol("superseded");

/**
 * What a refused call gets: a promise that never settles. Definition code
 * can catch an error; it can't catch this, so it stays where it stopped.
 */
const never = async (): Promise<never> =>
  await Promise.withResolvers<never>().promise;

type StepWork<T> = (context: WorkflowStepContext) => Promise<T> | T;

interface StepIdentity {
  type: string;
  name: string;
  occurrence: number;
}

interface Claim {
  ordinal: number;
  attempt: number;
  key: string;
}

type StepOutcome = { ok: true; value: string } | { ok: false; error: string };

export class Activation {
  readonly #storage: DurableObjectStorage;
  readonly #run: RunRow;
  readonly #generation: number;
  readonly #leaseMs: number;
  /** Settled or superseded: every later call is refused. */
  #over = false;
  readonly #supersede: () => void;
  /** Resolves when a later generation took over this one. */
  readonly stopped: Promise<typeof superseded>;
  readonly #occurrences = new Map<string, number>();

  /** What the definition is handed as `step`. */
  readonly step: WorkflowStep;

  constructor(
    storage: DurableObjectStorage,
    run: RunRow,
    generation: number,
    leaseMs: number
  ) {
    this.#storage = storage;
    this.#run = run;
    this.#generation = generation;
    this.#leaseMs = leaseMs;
    const { promise, resolve } = Promise.withResolvers<typeof superseded>();
    this.stopped = promise;
    this.#supersede = () => {
      resolve(superseded);
    };
    this.step = {
      do: async <T>(
        name: string,
        work: StepWork<T>,
        ...rest: unknown[]
      ): Promise<T> => await this.#do(name, work, rest),
    };
  }

  /** Whether this activation may still act: not over, not superseded. */
  #current(): boolean {
    return (
      !this.#over && readRun(this.#storage.sql)?.generation === this.#generation
    );
  }

  /** Ends this activation as superseded, once. */
  #endSuperseded(): void {
    if (this.#over) {
      return;
    }
    this.#over = true;
    this.#storage.sql.exec(
      "UPDATE activations SET ended_at = ?, ended = 'superseded' WHERE generation = ? AND ended_at IS NULL",
      Date.now(),
      this.#generation
    );
    this.#supersede();
  }

  /** Refuses a call from this activation, which is over. */
  async #refuse(): Promise<never> {
    this.#endSuperseded();
    return await never();
  }

  #renewLease(now: number): void {
    this.#storage.sql.exec(
      "UPDATE run SET lease_until = ?",
      now + this.#leaseMs
    );
  }

  /**
   * Moves the watchdog alarm to a lease from now. Called right after the
   * journal write it goes with, with no await between: one write.
   */
  async #renewWatchdog(): Promise<void> {
    await this.#storage.setAlarm(Date.now() + this.#leaseMs);
  }

  /** Journals a new attempt at the step, if this activation is current. */
  #claim(step: StepIdentity, journaled: StepRow | undefined): Claim | null {
    return this.#storage.transactionSync(() => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const now = Date.now();
      let claim: Claim;
      if (journaled === undefined) {
        const key = stepKey(this.#run.run_uid, step);
        const { ordinal } = sql
          .exec<{ ordinal: number }>(
            "INSERT INTO steps (type, name, occurrence, idempotency_key, state, attempt) VALUES (?, ?, ?, ?, 'running', 1) RETURNING ordinal",
            step.type,
            step.name,
            step.occurrence,
            key
          )
          .one();
        claim = { ordinal, attempt: 1, key };
      } else {
        // An earlier attempt was cut off before its outcome was journaled:
        // this one goes out again under the same key.
        claim = {
          ordinal: journaled.ordinal,
          attempt: journaled.attempt + 1,
          key: journaled.idempotency_key,
        };
        sql.exec(
          "UPDATE steps SET attempt = ?, state = 'running' WHERE ordinal = ?",
          claim.attempt,
          claim.ordinal
        );
      }
      sql.exec(
        "INSERT INTO attempts (ordinal, attempt, generation, started_at) VALUES (?, ?, ?, ?)",
        claim.ordinal,
        claim.attempt,
        this.#generation,
        now
      );
      this.#renewLease(now);
      return claim;
    });
  }

  /**
   * Journals the attempt's outcome if this activation is current and the
   * attempt is still the step's latest; otherwise records that its answer
   * was ignored.
   */
  #commit(claim: Claim, outcome: StepOutcome): boolean {
    return this.#storage.transactionSync(() => {
      const { sql } = this.#storage;
      const now = Date.now();
      const latest = sql
        .exec<{ attempt: number }>(
          "SELECT attempt FROM steps WHERE ordinal = ?",
          claim.ordinal
        )
        .one();
      if (!this.#current() || latest.attempt !== claim.attempt) {
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = 'superseded' WHERE ordinal = ? AND attempt = ? AND ended_at IS NULL",
          now,
          claim.ordinal,
          claim.attempt
        );
        return false;
      }
      sql.exec(
        "UPDATE steps SET state = ?, value = ?, error = ? WHERE ordinal = ?",
        outcome.ok ? "succeeded" : "failed",
        outcome.ok ? outcome.value : null,
        outcome.ok ? null : outcome.error,
        claim.ordinal
      );
      sql.exec(
        "UPDATE attempts SET ended_at = ?, ended = ? WHERE ordinal = ? AND attempt = ?",
        now,
        outcome.ok ? "succeeded" : "failed",
        claim.ordinal,
        claim.attempt
      );
      this.#renewLease(now);
      return true;
    });
  }

  /** Runs the step's work once, journaling what it returned or threw. */
  async #attempt<T>(
    identity: StepIdentity,
    journaled: StepRow | undefined,
    work: StepWork<T>
  ): Promise<T> {
    const claim = this.#claim(identity, journaled);
    if (claim === null) {
      return await this.#refuse();
    }
    await this.#renewWatchdog();
    let outcome: StepOutcome;
    try {
      const value = await work({
        step: { name: identity.name, count: identity.occurrence },
        attempt: claim.attempt,
        idempotencyKey: claim.key,
      });
      // A value the journal can't keep fails the step, as a throw would.
      outcome = { ok: true, value: encode(value) };
    } catch (error) {
      outcome = { ok: false, error: JSON.stringify(errorRecord(error)) };
    }
    if (!this.#commit(claim, outcome)) {
      return await this.#refuse();
    }
    await this.#renewWatchdog();
    if (!outcome.ok) {
      throw rebuild(outcome.error);
    }
    // SAFETY: the work's own value through the codec, which is what every
    // replay of this step returns too.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return decode(outcome.value) as T;
  }

  async #do<T>(name: string, work: StepWork<T>, rest: unknown[]): Promise<T> {
    if (!this.#current()) {
      return await this.#refuse();
    }
    assertStepName(name);
    if (typeof work !== "function" || rest.length > 0) {
      // A configured step (`do(name, config, callback)`) would retry and
      // time out; until retries are built it is refused, not run without.
      throw new TypeError(
        "step.do takes a name and a callback; configured steps aren't supported yet"
      );
    }
    const occurrence = (this.#occurrences.get(name) ?? 0) + 1;
    this.#occurrences.set(name, occurrence);
    const identity = { type: "do", name, occurrence };

    const journaled = readStep(this.#storage.sql, identity);
    if (journaled?.state === "succeeded" && journaled.value !== null) {
      // SAFETY: what this step's work returned, through the codec, as the
      // attempt that journaled it returned it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return decode(journaled.value) as T;
    }
    if (journaled?.state === "failed" && journaled.error !== null) {
      throw rebuild(journaled.error);
    }
    return await this.#attempt(identity, journaled, work);
  }

  /** Runs the definition; resolves when it returns or throws. */
  async execute(definition: WorkflowDefinition): Promise<Settlement> {
    try {
      const event: WorkflowEvent = {
        payload: decode(this.#run.params),
        timestamp: new Date(this.#run.created_at),
        instanceId: this.#run.instance_id,
      };
      return { ok: true, output: await definition.run(event, this.step) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Journals the run's end, unless a later activation took over. */
  async settle(settlement: Settlement): Promise<void> {
    let output: string | null = null;
    let failure: string | null = null;
    if (settlement.ok) {
      try {
        output = encode(settlement.output);
      } catch (error) {
        failure = JSON.stringify(errorRecord(error));
      }
    } else {
      failure = JSON.stringify(errorRecord(settlement.error));
    }
    const settled = this.#storage.transactionSync(() => {
      if (!this.#current()) {
        return false;
      }
      const now = Date.now();
      this.#storage.sql.exec(
        "UPDATE run SET status = ?, output = ?, error = ?, ended_at = ?, lease_until = NULL",
        failure === null ? "complete" : "errored",
        output,
        failure,
        now
      );
      this.#storage.sql.exec(
        "UPDATE activations SET ended_at = ?, ended = 'settled' WHERE generation = ?",
        now,
        this.#generation
      );
      return true;
    });
    if (!settled) {
      this.#endSuperseded();
      return;
    }
    this.#over = true;
    // In the same write as the outcome: nothing is left to wake for.
    await this.#storage.deleteAlarm();
  }
}
