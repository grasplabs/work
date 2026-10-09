// How a caller reaches its runs: the Workflow binding's create, get and
// batches, and an instance's status, in Cloudflare Workflows' shapes. Each
// run is its own object in the namespace given, named from the definition
// and instance ID (identity.ts). Where its data lives is the namespace's to
// say: pass one scoped with `jurisdiction("eu")` to create runs in the EU.
//
// The batches follow the reference's documented shapes and codes:
// `createBatch({ instances } | { count })` reports an ID in use (10405) or
// repeated within the batch (10415) per entry, where `create` throws; the
// older array form skips both silently. `deleteBatch` deletes each ID once
// and answers per input position, an instance that doesn't exist as 10400.
// Every entry is checked before anything is created or deleted: an invalid
// one fails the whole call, as do params over 16 MiB of memory in all. One entry's
// failure never takes the others down: each is settled on its own, ten at
// a time, and one that failed for another reason is reported as 10001.
import { encode } from "./codec.ts";
import { describe, isPlainObject, readSettings } from "./config.ts";
import { namedError } from "./errors.ts";
import {
  assertInstanceId,
  isAddressableId,
  maxBatchSize,
  maxStartKeyLength,
  readSchedule,
  runObjectName,
  scheduleInstanceId,
} from "./identity.ts";
import type { Schedule } from "./identity.ts";
import { notFound, WorkflowInstance } from "./instance.ts";
import type { RunStub } from "./instance.ts";
import type { StartOutcome, WorkflowRun } from "./run.ts";

type RunNamespace = DurableObjectNamespace<WorkflowRun>;

const alreadyExists = (id: string): Error =>
  new Error(
    `instance.already_exists: a workflow instance ${JSON.stringify(id)} exists already`
  );

/** An error as the reference's binding throws it: named WorkflowError. */
const workflowError = (message: string): Error =>
  namedError("WorkflowError", message);

/** The codes a batch reports per entry, as the reference numbers them. */
export const batchCodes = {
  /** An instance with the entry's ID exists already. */
  alreadyExists: 10_405,
  /** An earlier entry of the same batch has the entry's ID. */
  repeated: 10_415,
  /** There is no instance with the ID. */
  notFound: 10_400,
  /** The entry failed for another reason (a storage failure, say). */
  internal: 10_001,
} as const;

const batchMessages: Record<number, string> = {
  [batchCodes.alreadyExists]: "An instance with this ID already exists.",
  [batchCodes.repeated]: "An earlier entry in the same batch uses this ID.",
  [batchCodes.notFound]: "workflows.api.error.instance.not_found",
  [batchCodes.internal]: "workflows.api.error.internal_server",
};

const batchError = (
  code: number
): { readonly code: number; readonly message: string } => ({
  code,
  message: batchMessages[code] ?? "workflows.api.error.internal_server",
});

/** What `create` takes, as the reference does; `retention` comes later. */
export interface CreateOptions<Params = unknown> {
  /** 1 to 100 letters, digits, - and _, not starting with -; drawn if absent. */
  id?: string;
  /** The run's params; `{}` when absent, as on the reference. */
  params?: Params;
}

/** `createBatch`'s options: its entries, or a count of runs alike. */
export type BatchCreateOptions<Params = unknown> =
  | { instances: readonly CreateOptions<Params>[] }
  | { count: number; params?: Params };

export interface BatchCreateError {
  /** The entry's position in the batch. */
  readonly index: number;
  readonly id?: string;
  readonly code: number;
  readonly message: string;
}

export interface BatchCreateResult {
  /** The runs the batch created, in input order. */
  readonly created: WorkflowInstance[];
  /** The entries it didn't create, in input order. */
  readonly errors: BatchCreateError[];
}

export interface BatchDeleteResult {
  readonly deleted: { readonly id: string }[];
  readonly errors: {
    readonly id: string;
    readonly code: number;
    readonly message: string;
  }[];
}

export interface Admission<Params> {
  id: string;
  params?: Params;
  /**
   * What makes this start this start: the same key again (a redelivered
   * trigger, a retry after an answer that never came) finds the run it
   * created instead of failing or creating another.
   */
  key: string;
}

/** One occurrence of a schedule, as the host's clock delivers it. */
export interface ScheduledStart<Params> {
  cron: string;
  /** When the schedule fired, in milliseconds since the Unix epoch. */
  scheduledTime: number;
  params?: Params;
}

/** A run to create: its ID and its params, encoded, both checked. */
interface Entry {
  id: string;
  params: string;
}

/**
 * A run's params, encoded here, so a value the journal can't keep fails
 * the caller before any run exists. Absent is `{}`, as on the reference.
 */
const encodeParams = (params?: unknown): string =>
  encode(params === undefined ? {} : params);

/** `create`'s options, read once each: an unknown setting is refused. */
const readCreateOptions = (options: unknown, what: string): Entry => {
  if (options === undefined) {
    return { id: crypto.randomUUID(), params: encodeParams() };
  }
  if (!isPlainObject(options)) {
    throw new TypeError(
      `${what} are { id?, params? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { id, params } = readSettings(what, options, ["id", "params"] as const);
  return {
    id: id === undefined ? crypto.randomUUID() : assertInstanceId(id),
    params: encodeParams(params),
  };
};

/** A batch's size, as the reference bounds it. */
const assertBatchSize = (size: number, what: string): void => {
  if (size === 0) {
    throw workflowError(`${what} should have at least 1 instance`);
  }
  if (size > maxBatchSize) {
    throw workflowError(
      `${what} only supports ${maxBatchSize} instances at a time`
    );
  }
};

/**
 * The most heap a batch's encoded params may take, all entries together:
 * well under an isolate's 128 MB, with room for the batch's own copies and
 * what each RPC serializes of them.
 */
export const maxBatchBytes = 16 * 1024 * 1024;

/** How many runs a batch starts or deletes at once. */
export const batchConcurrency = 10;

/**
 * What an encoded value takes on the heap: two bytes a UTF-16 code unit,
 * which is what a string holds once any of it is outside Latin-1 (codec
 * text keeps non-ASCII as it is). Counting UTF-8 bytes would let text of
 * other scripts take up to twice the cap. No copy is made to count.
 */
const heapBytes = (text: string): number => text.length * 2;

const assertBatchBytes = (bytes: number): void => {
  if (bytes > maxBatchBytes) {
    throw workflowError(
      `batchCreate params take at most ${maxBatchBytes} bytes of memory encoded, all entries together`
    );
  }
};

/**
 * Calls `work` for each index below `count`, at most `limit` at once, and
 * settles each on its own: one failure takes no other down. Results are
 * in index order.
 */
const settleEach = async <Result>(
  count: number,
  limit: number,
  work: (index: number) => Promise<Result>
): Promise<PromiseSettledResult<Result>[]> => {
  const settled: PromiseSettledResult<Result>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next;
      next += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- a worker takes one index at a time
        const value = await work(index);
        settled[index] = { status: "fulfilled", value };
      } catch (error) {
        settled[index] = { status: "rejected", reason: error };
      }
    }
  };
  // Never more workers than indexes; Promise.all is safe, as no worker
  // throws: each settles its own work.
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return settled;
};

/** The entries of an array batch, every one checked before any is created. */
const readEntries = (batch: readonly unknown[]): Entry[] => {
  assertBatchSize(batch.length, "batchCreate");
  const entries: Entry[] = [];
  let bytes = 0;
  for (const [index, options] of batch.entries()) {
    const entry = readCreateOptions(
      options,
      `Entry ${index} of the batch's options`
    );
    // Counted as each entry is read, so a batch over the cap is refused
    // holding little more than the cap.
    bytes += heapBytes(entry.params);
    assertBatchBytes(bytes);
    entries.push(entry);
  }
  return entries;
};

/** `{ instances } | { count, params? }`, checked as a whole. */
const readBatchOptions = (options: unknown): Entry[] => {
  if (!isPlainObject(options)) {
    throw new TypeError(
      `A batch is { instances } or { count, params? }, not ${options === null ? "null" : describe(options)}`
    );
  }
  const { instances, count, params } = readSettings(
    "A batch's options",
    options,
    ["instances", "count", "params"] as const
  );
  if (instances !== undefined) {
    if (count !== undefined || params !== undefined) {
      throw new TypeError(
        "A batch takes { instances } or { count, params? }, not both"
      );
    }
    if (!Array.isArray(instances)) {
      throw new TypeError(
        `A batch's instances are an array, not ${describe(instances)}`
      );
    }
    return readEntries(instances);
  }
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > maxBatchSize
  ) {
    throw workflowError(
      `batchCreate count must be a whole number from 1 to ${maxBatchSize}: ${typeof count === "number" ? String(count) : describe(count)}`
    );
  }
  const encoded = encodeParams(params);
  // Every run gets its own copy of the params: counted once per run.
  assertBatchBytes(heapBytes(encoded) * count);
  return Array.from({ length: count }, () => ({
    id: crypto.randomUUID(),
    params: encoded,
  }));
};

/** An `admit`'s or a schedule's key, checked. */
const assertStartKey = (key: unknown): string => {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > maxStartKeyLength
  ) {
    throw new TypeError(
      `A start key is 1 to ${maxStartKeyLength} characters long`
    );
  }
  return key;
};

export class Workflow<Params = unknown> {
  readonly #namespace: RunNamespace;
  readonly #definition: string;
  readonly #version: string | null;

  constructor(
    namespace: RunNamespace,
    definition: string,
    options: { version?: string } = {}
  ) {
    this.#namespace = namespace;
    this.#definition = definition;
    this.#version = options.version ?? null;
  }

  #stub(id: string): RunStub {
    return this.#namespace.get(
      this.#namespace.idFromName(runObjectName(this.#definition, id))
    );
  }

  #instance(id: string): WorkflowInstance {
    return new WorkflowInstance(id, this.#stub(id));
  }

  async #start(
    entry: Entry,
    key: string | null,
    schedule: Schedule | null
  ): Promise<StartOutcome> {
    return await this.#stub(entry.id).start({
      definition: this.#definition,
      version: this.#version,
      instanceId: entry.id,
      params: entry.params,
      // A key of its own when none is given: no other start is ever this
      // one, so it is never delivered again, and leaves no tombstone.
      key: key ?? crypto.randomUUID(),
      redeliverable: key !== null,
      schedule,
    });
  }

  /**
   * Creates a run, as Cloudflare Workflows' `create` does: an ID that
   * exists already is an error, even when it is this same call's. For a
   * start that may be delivered again, use `admit`.
   */
  async create(options?: CreateOptions<Params>): Promise<WorkflowInstance> {
    const entry = readCreateOptions(options, "A create's options");
    const outcome = await this.#start(entry, null, null);
    if (outcome !== "created") {
      throw alreadyExists(entry.id);
    }
    return this.#instance(entry.id);
  }

  /**
   * Creates up to 100 runs. Given `{ instances }` or `{ count, params? }`,
   * it reports each entry it didn't create: an ID in use (10405), one an
   * earlier entry has (10415, the first is created), or another failure
   * (10001). Given an array, the reference's older form, it skips IDs in
   * use or repeated without a word, and throws another failure once every
   * entry has settled. An invalid entry fails either form before any run
   * is created.
   */
  async createBatch(
    batch: readonly CreateOptions<Params>[]
  ): Promise<WorkflowInstance[]>;
  async createBatch(
    options: BatchCreateOptions<Params>
  ): Promise<BatchCreateResult>;
  async createBatch(
    batch: unknown
  ): Promise<WorkflowInstance[] | BatchCreateResult> {
    if (Array.isArray(batch)) {
      const { result, failures } = await this.#createAll(readEntries(batch));
      const [failure] = failures;
      if (failure !== undefined) {
        throw failure;
      }
      return result.created;
    }
    const { result } = await this.#createAll(readBatchOptions(batch));
    return result;
  }

  /** Creates each entry once, every one settled on its own. */
  async #createAll(
    entries: Entry[]
  ): Promise<{ result: BatchCreateResult; failures: Error[] }> {
    const first = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
      if (!first.has(entry.id)) {
        first.set(entry.id, index);
      }
    }
    const settled = await settleEach(
      entries.length,
      batchConcurrency,
      async (index) => {
        const entry = entries[index];
        if (entry === undefined || first.get(entry.id) !== index) {
          return "repeated" as const;
        }
        return await this.#start(entry, null, null);
      }
    );
    const created: WorkflowInstance[] = [];
    const errors: BatchCreateError[] = [];
    const failures: Error[] = [];
    for (const [index, outcome] of settled.entries()) {
      const { id } = entries[index] ?? { id: "" };
      if (outcome.status === "rejected") {
        failures.push(
          outcome.reason instanceof Error
            ? outcome.reason
            : new Error(String(outcome.reason))
        );
        errors.push({ index, id, ...batchError(batchCodes.internal) });
      } else if (outcome.value === "created") {
        created.push(this.#instance(id));
      } else if (outcome.value === "repeated") {
        errors.push({ index, id, ...batchError(batchCodes.repeated) });
      } else {
        // With a key of its own, only another start's run is in the way.
        errors.push({ index, id, ...batchError(batchCodes.alreadyExists) });
      }
    }
    return { result: { created, errors }, failures };
  }

  /**
   * Creates a run that may be asked for more than once: the same `key`,
   * ID and params find the run the first delivery created, whether or not
   * that delivery heard back, and find that it was deleted (`created`
   * false, and no run) rather than create it again. A different key under
   * the same ID is another start, and an error.
   */
  async admit(
    admission: Admission<Params>
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const id = assertInstanceId(admission.id);
    const key = assertStartKey(admission.key);
    return await this.#admit(
      { id, params: encodeParams(admission.params) },
      key,
      null
    );
  }

  /**
   * Starts the run of one occurrence of a schedule, as the reference's
   * schedules do: its definition gets the cron and time as
   * `event.schedule`. The occurrence is its identity (identity.ts): the
   * same cron and time again, a tick delivered twice, find the run the
   * first created, as `admit` does.
   */
  async schedule(
    occurrence: ScheduledStart<Params>
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    if (!isPlainObject(occurrence)) {
      throw new TypeError(
        `A scheduled start is { cron, scheduledTime, params? }, not ${describe(occurrence)}`
      );
    }
    const { cron, scheduledTime, params } = readSettings(
      "A scheduled start",
      occurrence,
      ["cron", "scheduledTime", "params"] as const
    );
    const schedule = readSchedule(cron, scheduledTime);
    const id = await scheduleInstanceId(schedule);
    return await this.#admit(
      { id, params: encodeParams(params) },
      id,
      schedule
    );
  }

  async #admit(
    entry: Entry,
    key: string,
    schedule: Schedule | null
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const outcome = await this.#start(entry, key, schedule);
    switch (outcome) {
      case "created":
      case "existing":
      case "removed": {
        return {
          instance: this.#instance(entry.id),
          created: outcome === "created",
        };
      }
      case "conflict": {
        throw new Error(
          `The start ${JSON.stringify(key)} of workflow instance ${JSON.stringify(entry.id)} was made with other params`
        );
      }
      case "collision": {
        throw alreadyExists(entry.id);
      }
      default: {
        throw new Error(`Unknown start outcome: ${String(outcome)}`);
      }
    }
  }

  /**
   * The run under `id`. One that doesn't exist, an ID `create` never
   * takes included, is `instance.not_found`: the reference checks no ID
   * here either. A lookup leaves nothing behind (journal.ts).
   */
  async get(id: string): Promise<WorkflowInstance> {
    const stub = this.#stub(id);
    if ((await stub.status()) === undefined) {
      throw notFound(id);
    }
    return new WorkflowInstance(id, stub);
  }

  /**
   * Deletes up to 100 runs, as the reference's `deleteBatch`: each ID
   * once, however often it is given, the result repeated for each of its
   * positions; one that doesn't exist is an error of its own (10400). An
   * invalid ID fails the call before anything is deleted.
   */
  async deleteBatch(
    instanceIds: readonly string[]
  ): Promise<BatchDeleteResult> {
    const ids: unknown = instanceIds;
    if (!Array.isArray(ids)) {
      throw workflowError("(body) Provided argument is invalid");
    }
    if (ids.length > maxBatchSize) {
      throw workflowError(
        `(body) batchDeleteInstances only supports ${maxBatchSize} instances at a time`
      );
    }
    if (ids.length === 0) {
      throw workflowError(
        "(body) batchDeleteInstances should have at least 1 instance"
      );
    }
    const checked: string[] = [];
    for (const id of ids) {
      if (!isAddressableId(id)) {
        throw workflowError("(instance.invalid_id) Instance ID is invalid");
      }
      checked.push(id);
    }
    const unique = [...new Set(checked)];
    const settled = await settleEach(
      unique.length,
      batchConcurrency,
      async (index) => await this.#stub(unique[index] ?? "").deleteRun()
    );
    const byId = new Map(unique.map((id, index) => [id, settled[index]]));
    const result: {
      deleted: { id: string }[];
      errors: { id: string; code: number; message: string }[];
    } = { deleted: [], errors: [] };
    for (const id of checked) {
      const outcome = byId.get(id);
      if (outcome?.status === "fulfilled" && outcome.value === "deleted") {
        result.deleted.push({ id });
      } else if (outcome?.status === "fulfilled") {
        result.errors.push({ id, ...batchError(batchCodes.notFound) });
      } else {
        result.errors.push({ id, ...batchError(batchCodes.internal) });
      }
    }
    return result;
  }
}
