// The binding's identities and batches, through its public methods and the
// run objects behind them: generated and supplied IDs, createBatch and
// deleteBatch with their per-entry outcomes, the tombstone a deleted run
// leaves for its start, and the runs a schedule's occurrences start.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { batchCodes, batchConcurrency, maxBatchBytes } from "../src/binding.ts";
import { decode } from "../src/codec.ts";
import type { WorkflowInstance } from "../src/instance.ts";
import {
  ended,
  journalOf,
  newId,
  pastTime,
  runObject,
  until,
  workflow,
} from "./helpers.ts";
import { effectsOf, handled, hold } from "./outside.ts";
import {
  countedPrefix,
  shortTombstoneMs,
  startsOut,
  undeletablePrefix,
  unstartablePrefix,
} from "./worker.ts";
import type { TestRuns } from "./worker.ts";

const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

const idsOf = (instances: WorkflowInstance[]): string[] =>
  instances.map((instance) => instance.id);

/** A value as a caller with no types could pass it. */
const untyped = (value: unknown): never =>
  // SAFETY: the point is a value the types refuse; the binding checks it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  value as never;

/** Whether a run exists under `id`: `get` finds it. */
const exists = async (definition: string, id: string): Promise<boolean> => {
  try {
    await workflow(definition).get(id);
    return true;
  } catch {
    return false;
  }
};

/** How many of `ids` have a run. */
const existing = async (definition: string, ids: string[]): Promise<number> => {
  const found = await Promise.all(
    ids.map(async (id) => await exists(definition, id))
  );
  return found.filter(Boolean).length;
};

/** What `promise` was refused with, as `name: message`. */
const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
  return "not refused";
};

/** The tables the run's object holds, the host's own left out. */
const tablesOf = async (
  definition: string,
  id: string,
  runs: DurableObjectNamespace<TestRuns> = env.RUNS
): Promise<string[]> =>
  await runInDurableObject(runObject(definition, id, runs), (_, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .toArray()
      .map((table) => table.name)
  );

/** Whether the run's object holds anything at all, and any alarm. */
const emptied = async (
  definition: string,
  id: string,
  runs: DurableObjectNamespace<TestRuns> = env.RUNS
): Promise<{ tables: string[]; alarm: number | null }> =>
  await runInDurableObject(
    runObject(definition, id, runs),
    async (_, state) => ({
      tables: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        )
        .toArray()
        .map((table) => table.name),
      alarm: await state.storage.getAlarm(),
    })
  );

describe("creating a run", () => {
  it("draws an ID when none is given, and hands the run `{}` for params when none are", async () => {
    const instance = await workflow("echo").create();

    const status = await ended("echo", instance.id);

    const { run } = await journalOf("echo", instance.id);
    expect(instance.id).toMatch(uuidPattern);
    expect(status).toStrictEqual({
      status: "complete",
      output: {
        payload: {},
        timestamp: new Date(run.created_at),
        instanceId: instance.id,
        workflowName: "echo",
        scheduled: false,
        schedule: null,
      },
    });
  });

  it.each([
    ["starting with -", "-dash"],
    ["of 101 characters", "x".repeat(101)],
    ["that is empty", ""],
    ["with a space", "has space"],
    ["with a dot", "dot.ted"],
    ["that isn't a string", 7],
  ])(
    "refuses an ID %s as the reference does, creating nothing",
    async (_, id) => {
      await expect(
        refusalOf(workflow("orders").create({ id: untyped(id) }))
      ).resolves.toMatch(/^WorkflowError: Workflow instance has invalid id/u);
    }
  );

  it("takes an ID of 100 letters, digits, _ and -", async () => {
    const id = `x${"_-".repeat(49)}9`;

    const instance = await workflow("orders").create({ id });

    expect(instance.id).toBe(id);
    await ended("orders", id);
  });

  it.each([
    ["retention", { retention: { successRetention: "1 day" } }],
    ["a location hint", { locationHint: "weur" }],
    ["a misspelled setting", { param: { order: 7 } }],
  ])("refuses %s rather than create the run without it", async (_, options) => {
    const id = newId();

    await expect(
      workflow("orders").create(untyped({ id, ...options }))
    ).rejects.toThrow(TypeError);
    await expect(exists("orders", id)).resolves.toBeFalsy();
  });
});

describe("getting a run", () => {
  it.each(["has space", "x".repeat(101), "-dash", "0 9 * * *#1"])(
    "is instance.not_found for an ID no run can have (%s), and leaves nothing behind",
    async (id) => {
      await expect(workflow("orders").get(id)).rejects.toThrow(
        /^instance\.not_found/u
      );
      await expect(tablesOf("orders", id)).resolves.toStrictEqual([]);
    }
  );
});

describe("createBatch with instances", () => {
  it("creates each new ID once, in input order, and reports one in use and one repeated", async () => {
    const taken = newId();
    const [first, second, third] = [newId(), newId(), newId()];
    await workflow("orders").create({ id: taken });

    const result = await workflow("orders").createBatch({
      instances: [
        { id: first, params: { n: 1 } },
        { id: taken },
        { id: second },
        { id: first, params: { n: 2 } },
        { id: third },
      ],
    });

    expect({
      created: idsOf(result.created),
      errors: result.errors,
    }).toStrictEqual({
      created: [first, second, third],
      errors: [
        {
          index: 1,
          id: taken,
          code: batchCodes.alreadyExists,
          message: "An instance with this ID already exists.",
        },
        {
          index: 3,
          id: first,
          code: batchCodes.repeated,
          message: "An earlier entry in the same batch uses this ID.",
        },
      ],
    });
    for (const id of [first, second, third, taken]) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await expect(ended("orders", id)).resolves.toMatchObject({
        status: "complete",
      });
    }
    // The first entry's params, not the repeat's; each run charged once.
    const { run } = await journalOf("orders", first);
    expect(decode(run.params)).toStrictEqual({ n: 1 });
    expect(effectsOf(first, "charge")).toHaveLength(1);
    expect(effectsOf(taken, "charge")).toHaveLength(1);
  });

  it("draws an ID for each entry without one", async () => {
    const result = await workflow("echo").createBatch({
      instances: [{}, { params: { n: 2 } }],
    });

    expect(result.errors).toStrictEqual([]);
    expect(idsOf(result.created)).toHaveLength(2);
    for (const instance of result.created) {
      expect(instance.id).toMatch(uuidPattern);
    }
    await expect(
      ended("echo", result.created[1]?.id ?? "")
    ).resolves.toMatchObject({ output: { payload: { n: 2 } } });
  });

  it("goes on with every other entry when one fails to be created, and reports that one apart", async () => {
    const failing = `${unstartablePrefix}${newId()}`;
    const [before, after] = [newId(), newId()];

    const result = await workflow("orders").createBatch({
      instances: [{ id: before }, { id: failing }, { id: after }],
    });

    expect({
      created: idsOf(result.created),
      errors: result.errors,
    }).toStrictEqual({
      created: [before, after],
      errors: [
        {
          index: 1,
          id: failing,
          code: batchCodes.internal,
          message: "workflows.api.error.internal_server",
        },
      ],
    });
    await expect(ended("orders", after)).resolves.toMatchObject({
      status: "complete",
    });
  });
});

describe("createBatch with a count", () => {
  it("creates that many runs, each with a drawn ID and the params given", async () => {
    const result = await workflow("echo").createBatch({
      count: 3,
      params: { shared: true },
    });

    const ids = idsOf(result.created);
    expect(result.errors).toStrictEqual([]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await expect(ended("echo", id)).resolves.toMatchObject({
        output: { payload: { shared: true }, instanceId: id },
      });
    }
  });
});

/** Two IDs no run has, for a batch that must create neither. */
const freshIds = (): [string, string] => [newId(), newId()];

describe("createBatch refuses the whole call, creating nothing,", () => {
  it.each([
    ["no entries", (): unknown => ({ instances: [] }), /at least 1 instance/u],
    [
      "101 entries",
      ([a, b]: string[]): unknown => ({
        instances: [
          { id: a },
          { id: b },
          ...Array.from({ length: 99 }, () => ({ id: newId() })),
        ],
      }),
      /only supports 100 instances/u,
    ],
    [
      "an entry with an invalid ID",
      ([a, b]: string[]): unknown => ({
        instances: [{ id: a }, { id: b }, { id: "has space" }],
      }),
      /^WorkflowError: Workflow instance has invalid id/u,
    ],
    ["a count of 0", (): unknown => ({ count: 0 }), /from 1 to 100/u],
    ["a count of 101", (): unknown => ({ count: 101 }), /from 1 to 100/u],
    [
      "a count that isn't whole",
      (): unknown => ({ count: 1.5 }),
      /from 1 to 100/u,
    ],
  ])("for %s", async (_, batch, message) => {
    const ids = freshIds();

    const refusal = await refusalOf(
      workflow("orders").createBatch(untyped(batch(ids)))
    );

    expect(refusal).toMatch(/^WorkflowError: /u);
    expect(refusal).toMatch(message);
    await expect(existing("orders", ids)).resolves.toBe(0);
  });

  it.each([
    [
      "both instances and a count",
      ([a]: string[]): unknown => ({ instances: [{ id: a }], count: 1 }),
    ],
    [
      "params beside instances",
      ([a]: string[]): unknown => ({ instances: [{ id: a }], params: {} }),
    ],
    [
      "instances that aren't an array",
      ([a]: string[]): unknown => ({ instances: { id: a } }),
    ],
    ["a setting it doesn't know", (): unknown => ({ count: 1, retention: {} })],
    [
      "an entry with params the journal can't keep",
      ([a, b]: string[]): unknown => ({
        instances: [{ id: a }, { id: b, params: { live: () => 1 } }],
      }),
    ],
    [
      "an entry that isn't an object",
      ([a]: string[]): unknown => ({ instances: [{ id: a }, "b"] }),
    ],
    ["no options", (): unknown => null],
  ])("for %s", async (_, batch) => {
    const ids = freshIds();

    await expect(
      workflow("orders").createBatch(untyped(batch(ids)))
    ).rejects.toThrow(TypeError);
    await expect(existing("orders", ids)).resolves.toBe(0);
  });
});

describe("createBatch with an array, the older form", () => {
  it("skips an ID in use and one repeated without a word, and returns the runs it created", async () => {
    const taken = newId();
    const [first, second] = [newId(), newId()];
    await workflow("orders").create({ id: taken });

    const created = await workflow("orders").createBatch([
      { id: first },
      { id: taken },
      { id: first },
      { id: second },
    ]);

    expect(idsOf(created)).toStrictEqual([first, second]);
    await expect(ended("orders", second)).resolves.toMatchObject({
      status: "complete",
    });
    await ended("orders", taken);
    expect(effectsOf(taken, "charge")).toHaveLength(1);
  });

  it("throws another failure once every entry has settled, the others created", async () => {
    const failing = `${unstartablePrefix}${newId()}`;
    const other = newId();

    await expect(
      workflow("orders").createBatch([{ id: failing }, { id: other }])
    ).rejects.toThrow("storage failed as the run was created");
    await expect(ended("orders", other)).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("refuses no entries and more than 100, creating nothing", async () => {
    const ids = Array.from({ length: 101 }, newId);

    await expect(refusalOf(workflow("orders").createBatch([]))).resolves.toBe(
      "WorkflowError: batchCreate should have at least 1 instance"
    );
    await expect(
      refusalOf(workflow("orders").createBatch(ids.map((id) => ({ id }))))
    ).resolves.toBe(
      "WorkflowError: batchCreate only supports 100 instances at a time"
    );
    await expect(existing("orders", ids.slice(0, 2))).resolves.toBe(0);
  });
});

describe("deleteBatch", () => {
  it("deletes each ID once, answers for every position, and reports one that doesn't exist", async () => {
    const [midStep, finished, missing] = [newId(), newId(), newId()];
    const charge = hold(midStep, "charge");
    await workflow("orders").create({ id: midStep });
    await charge.held;
    await workflow("orders").create({ id: finished });
    await ended("orders", finished);
    const object = runObject("orders", midStep).id.toString();
    const handledBefore = handled.filter((entry) => entry === object).length;

    const result = await workflow("orders").deleteBatch([
      midStep,
      missing,
      midStep,
      finished,
    ]);
    charge.release();
    // The deleted run's activation, its step answered, has gone as far as
    // it can: its alarm handler has returned.
    await until("the deleted run's activation to end", () =>
      handled.filter((entry) => entry === object).length > handledBefore
        ? true
        : undefined
    );

    expect(result).toStrictEqual({
      deleted: [{ id: midStep }, { id: midStep }, { id: finished }],
      errors: [
        {
          id: missing,
          code: batchCodes.notFound,
          message: "workflows.api.error.instance.not_found",
        },
      ],
    });
    await expect(
      existing("orders", [midStep, finished, missing])
    ).resolves.toBe(0);
    // The run deleted mid-step went no further.
    expect(effectsOf(midStep, "ship")).toStrictEqual([]);
  });

  it("reports an ID only a schedule could address as not found, not as invalid", async () => {
    const id = "0 9 * * 1-5#1760000000000";

    await expect(workflow("orders").deleteBatch([id])).resolves.toStrictEqual({
      deleted: [],
      errors: [
        {
          id,
          code: batchCodes.notFound,
          message: "workflows.api.error.instance.not_found",
        },
      ],
    });
  });

  it("goes on with every other ID when one fails to be deleted, and reports that one apart", async () => {
    const failing = `${undeletablePrefix}${newId()}`;
    const other = newId();
    await workflow("orders").createBatch({
      instances: [{ id: failing }, { id: other }],
    });

    const result = await workflow("orders").deleteBatch([failing, other]);

    expect(result).toStrictEqual({
      deleted: [{ id: other }],
      errors: [
        {
          id: failing,
          code: batchCodes.internal,
          message: "workflows.api.error.internal_server",
        },
      ],
    });
    await expect(exists("orders", failing)).resolves.toBeTruthy();
  });

  it.each([
    [
      "no IDs",
      (): unknown => [],
      "WorkflowError: (body) batchDeleteInstances should have at least 1 instance",
    ],
    [
      "101 IDs",
      (id: string): unknown => [id, ...Array.from({ length: 100 }, newId)],
      "WorkflowError: (body) batchDeleteInstances only supports 100 instances at a time",
    ],
    [
      "an invalid ID",
      (id: string): unknown => [id, "bad!id"],
      "WorkflowError: (instance.invalid_id) Instance ID is invalid",
    ],
    [
      "an ID too long",
      (id: string): unknown => [id, "x".repeat(272)],
      "WorkflowError: (instance.invalid_id) Instance ID is invalid",
    ],
    [
      "an ID that isn't a string",
      (id: string): unknown => [id, 7],
      "WorkflowError: (instance.invalid_id) Instance ID is invalid",
    ],
    [
      "IDs that aren't an array",
      (id: string): unknown => id,
      "WorkflowError: (body) Provided argument is invalid",
    ],
  ])("refuses %s, deleting nothing", async (_, ids, refusal) => {
    const id = newId();
    await workflow("orders").create({ id });

    await expect(
      refusalOf(workflow("orders").deleteBatch(untyped(ids(id))))
    ).resolves.toBe(refusal);
    await expect(exists("orders", id)).resolves.toBeTruthy();
  });
});

describe("a start's tombstone", () => {
  it("keeps a start delivered again after its run was deleted from creating it again", async () => {
    const id = newId();
    const admission = { id, key: `trigger-${newId()}`, params: { order: 7 } };
    await workflow("orders").admit(admission);
    await ended("orders", id);
    const run = await workflow("orders").get(id);
    await run.delete();

    const again = await workflow("orders").admit(admission);

    expect(again.created).toBeFalsy();
    await expect(exists("orders", id)).resolves.toBeFalsy();
    expect(effectsOf(id, "charge")).toHaveLength(1);
  });

  it("holds the start key and nothing else of the run", async () => {
    const id = newId();
    const key = `trigger-${newId()}`;
    await workflow("orders").admit({ id, key, params: { secret: "s3cret" } });
    await ended("orders", id);

    await workflow("orders").deleteBatch([id]);

    await expect(tablesOf("orders", id)).resolves.toStrictEqual(["tombstones"]);
    const rows = await runInDurableObject(runObject("orders", id), (_, state) =>
      state.storage.sql
        .exec<{ start_key: string; removed_at: number }>(
          "SELECT * FROM tombstones"
        )
        .toArray()
        .map((row) => ({ ...row, removed_at: typeof row.removed_at }))
    );
    expect(rows).toStrictEqual([{ start_key: key, removed_at: "number" }]);
  });

  it("leaves the ID free for another start, and still holds once another run has it", async () => {
    const id = newId();
    const first = { id, key: `trigger-${newId()}` };
    await workflow("orders").admit(first);
    await ended("orders", id);
    await workflow("orders").deleteBatch([id]);

    const second = await workflow("orders").admit({
      id,
      key: `trigger-${newId()}`,
    });
    const firstAgain = await workflow("orders").admit(first);
    await ended("orders", id);

    expect([second.created, firstAgain.created]).toStrictEqual([true, false]);
    // Two runs, one after the other, each charging once.
    expect(effectsOf(id, "charge")).toHaveLength(2);
    await expect(workflow("orders").create({ id })).rejects.toThrow(
      /^instance\.already_exists/u
    );
  });
});

describe("a run's removal", () => {
  it("empties the object of a run create made: no tombstone, no alarm", async () => {
    const id = newId();
    await workflow("orders").create({ id });
    await ended("orders", id);

    await workflow("orders").deleteBatch([id]);

    await expect(emptied("orders", id)).resolves.toStrictEqual({
      tables: [],
      alarm: null,
    });
  });

  it("keeps an earlier start's tombstone when a run create made under the ID is deleted", async () => {
    const id = newId();
    const admission = { id, key: `trigger-${newId()}` };
    await workflow("orders").admit(admission);
    await ended("orders", id);
    await workflow("orders").deleteBatch([id]);
    await workflow("orders").create({ id });
    await ended("orders", id);

    await workflow("orders").deleteBatch([id]);
    const again = await workflow("orders").admit(admission);

    await expect(tablesOf("orders", id)).resolves.toStrictEqual(["tombstones"]);
    expect(again.created).toBeFalsy();
  });

  it("expires a tombstone after its horizon: the object empties, and the same start then creates a run", async () => {
    const runs = env.SHORT_TOMBSTONES;
    const id = newId();
    const admission = { id, key: `trigger-${newId()}` };
    await workflow("orders", runs).admit(admission);
    await ended("orders", id, runs);
    const removedAt = Date.now();
    await workflow("orders", runs).deleteBatch([id]);
    const within = await workflow("orders", runs).admit(admission);

    // Its alarm drops it once the horizon has passed, with no request.
    const left = await until("the tombstone to expire", async () => {
      const now = await emptied("orders", id, runs);
      return now.tables.length === 0 ? now : undefined;
    });
    const after = await workflow("orders", runs).admit(admission);
    await ended("orders", id, runs);

    expect(within.created).toBeFalsy();
    expect(left).toStrictEqual({ tables: [], alarm: null });
    expect(Date.now() - removedAt).toBeGreaterThanOrEqual(shortTombstoneMs);
    expect(after.created).toBeTruthy();
    expect(effectsOf(id, "charge")).toHaveLength(2);
  });
});

describe("a tombstone past its horizon", () => {
  it("no longer holds, though its alarm hasn't come to drop it yet", async () => {
    const runs = env.SHORT_TOMBSTONES;
    const id = newId();
    const admission = { id, key: `trigger-${newId()}` };
    await workflow("orders", runs).admit(admission);
    await ended("orders", id, runs);
    await workflow("orders", runs).deleteBatch([id]);
    const removedAt = Date.now();
    // As a host that delivers the expiry late would.
    await runInDurableObject(
      runObject("orders", id, runs),
      async (_, state) => {
        await state.storage.setAlarm(Date.now() + 60 * 60_000);
      }
    );

    await pastTime(removedAt + shortTombstoneMs);
    const after = await workflow("orders", runs).admit(admission);

    expect(after.created).toBeTruthy();
    await ended("orders", id, runs);
  });
});

describe("a batch's bounds", () => {
  /** Params of a little under a megabyte, encoded. */
  const large = { blob: "x".repeat(1_000_000) };

  it("refuses entries whose params pass the cap together, creating nothing", async () => {
    const entries = Math.ceil(maxBatchBytes / 1_000_000) + 1;
    const ids = Array.from({ length: entries }, newId);

    const refusal = await refusalOf(
      workflow("orders").createBatch({
        instances: ids.map((id) => ({ id, params: large })),
      })
    );

    expect(refusal).toMatch(/^WorkflowError: batchCreate params take at most/u);
    await expect(existing("orders", ids.slice(0, 3))).resolves.toBe(0);
  });

  it("refuses a count whose shared params pass the cap once per run", async () => {
    const count = Math.ceil(maxBatchBytes / 1_000_000) + 1;

    await expect(
      refusalOf(workflow("orders").createBatch({ count, params: large }))
    ).resolves.toMatch(/^WorkflowError: batchCreate params take at most/u);
  });

  it("starts at most a bounded number of runs at once", async () => {
    startsOut.most = 0;
    const ids = Array.from(
      { length: 3 * batchConcurrency },
      () => `${countedPrefix}${newId()}`
    );

    const result = await workflow("orders").createBatch({
      instances: ids.map((id) => ({ id })),
    });

    expect(result.created).toHaveLength(ids.length);
    expect(startsOut.most).toBeLessThanOrEqual(batchConcurrency);
    expect(startsOut.most).toBeGreaterThan(1);
  });
});

describe("an ID that starts with the schedule's prefix", () => {
  const id = "schedule-0123456789abcdef0123456789abcdef-1";

  it.each([
    [
      "create",
      async (): Promise<unknown> => await workflow("orders").create({ id }),
    ],
    [
      "admit",
      async (): Promise<unknown> =>
        await workflow("orders").admit({ id, key: "k" }),
    ],
    [
      "createBatch",
      async (): Promise<unknown> =>
        await workflow("orders").createBatch({ instances: [{ id }] }),
    ],
  ])("is refused by %s, creating nothing", async (_, call) => {
    await expect(refusalOf(call())).resolves.toMatch(
      /^WorkflowError: Workflow instance has invalid id: .*the schedule's own/u
    );
    await expect(exists("orders", id)).resolves.toBeFalsy();
  });
});

describe("a schedule's occurrence", () => {
  const cron = "0 9 * * 1-5";
  const scheduledTime = Date.UTC(2026, 9, 9, 9);

  it("starts a run whose definition gets the cron and the time it fired for", async () => {
    const { instance, created } = await workflow("echo").schedule({
      cron,
      scheduledTime,
      params: { report: "daily" },
    });

    const status = await ended("echo", instance.id);

    expect(created).toBeTruthy();
    expect(status).toMatchObject({
      status: "complete",
      output: {
        payload: { report: "daily" },
        workflowName: "echo",
        scheduled: true,
        schedule: { cron, scheduledTime },
      },
    });
  });

  it("finds the run the first delivery started when the same occurrence comes again", async () => {
    const time = scheduledTime + 1;
    const first = await workflow("orders").schedule({
      cron,
      scheduledTime: time,
    });
    const again = await workflow("orders").schedule({
      cron,
      scheduledTime: time,
    });
    const next = await workflow("orders").schedule({
      cron,
      scheduledTime: time + 60_000,
    });
    const other = await workflow("orders").schedule({
      cron: "*/5 * * * *",
      scheduledTime: time,
    });
    await ended("orders", first.instance.id);

    expect([
      first.created,
      again.created,
      next.created,
      other.created,
    ]).toStrictEqual([true, false, true, true]);
    expect(again.instance.id).toBe(first.instance.id);
    expect(
      new Set([first.instance.id, next.instance.id, other.instance.id]).size
    ).toBe(3);
    expect(effectsOf(first.instance.id, "charge")).toHaveLength(1);
  });

  it("is an ID within what create takes, however long the cron", async () => {
    const long = await workflow("echo").schedule({
      cron: `${"1,".repeat(127)}2`,
      scheduledTime: Number.MAX_SAFE_INTEGER,
    });

    // Within the reference's rule for an ID, and the schedule's own.
    expect(long.instance.id).toMatch(/^schedule-[\da-f]{32}-\d+$/u);
    expect(long.instance.id.length).toBeLessThanOrEqual(100);
    await until("the run to end", async () => {
      const status = await long.instance.status();
      return status.status === "complete" ? status : undefined;
    });
  });

  it.each([
    ["an empty cron", { cron: "", scheduledTime }],
    ["a cron of 257 characters", { cron: "*".repeat(257), scheduledTime }],
    ["a cron with a control character", { cron: "0 9 * * *\n", scheduledTime }],
    ["a cron that isn't a string", { cron: 5, scheduledTime }],
    ["a negative time", { cron, scheduledTime: -1 }],
    ["a time that isn't whole", { cron, scheduledTime: 1.5 }],
    ["a time that isn't a number", { cron, scheduledTime: "now" }],
    ["a setting it doesn't know", { cron, scheduledTime, id: "mine" }],
  ])("refuses %s before any run exists", async (_, occurrence) => {
    await expect(
      workflow("echo").schedule(untyped(occurrence))
    ).rejects.toThrow(TypeError);
  });
});

describe("a run's steps", () => {
  it("aren't capped at a managed engine's step limit", async () => {
    const id = newId();
    // Past the reference's 1,024 steps for a free plan's instance.
    await workflow("many-steps").create({ id, params: { steps: 1100 } });

    await expect(ended("many-steps", id)).resolves.toStrictEqual({
      status: "complete",
      output: 1100,
    });
  });
});
