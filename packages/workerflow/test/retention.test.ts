// How long an ended run is kept, through the binding and the run object:
// per-run and default retention, their limits, when the clock starts, the
// purge, and the work it never touches.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { Workflow } from "../src/binding.ts";
import type { WorkflowOptions } from "../src/binding.ts";
import { defaultTombstoneMs } from "../src/run.ts";
import {
  deliverAlarm,
  ended,
  journalOf,
  newId,
  pastTime,
  runObject,
  suspendedOn,
  until,
  wakeOf,
} from "./helpers.ts";
import { effectsOf, hold } from "./outside.ts";

/** Limits that let a test see a purge in milliseconds, not days. */
const shortLimits = { minMs: 1, maxMs: 10 * 60_000 };

/**
 * Long enough that the run is read back before its purge on any machine,
 * short enough to wait out.
 */
const purgeAfterMs = 2000;

const binding = (definition: string, options: WorkflowOptions = {}): Workflow =>
  new Workflow(env.RUNS, definition, {
    retentionLimits: shortLimits,
    retention: { successRetention: 60_000, errorRetention: 60_000 },
    ...options,
  });

/** The tables the run's object holds, the host's own left out. */
const tablesOf = async (definition: string, id: string): Promise<string[]> =>
  await runInDurableObject(runObject(definition, id), (_, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .toArray()
      .map((table) => table.name)
  );

const alarmOf = async (
  definition: string,
  id: string
): Promise<number | null> =>
  await runInDurableObject(
    runObject(definition, id),
    async (_, state) => await state.storage.getAlarm()
  );

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

/** Whether `get` finds a run under `id`. */
const exists = async (definition: string, id: string): Promise<boolean> => {
  try {
    await binding(definition).get(id);
    return true;
  } catch {
    return false;
  }
};

describe("an ended run's retention", () => {
  it("starts when it completes: it is purged then, its tombstone kept, and its start delivered again creates nothing", async () => {
    const id = newId();
    const admission = {
      id,
      key: `trigger-${newId()}`,
      retention: { successRetention: purgeAfterMs },
    };
    await binding("orders").admit(admission);
    await ended("orders", id);
    const { run } = await journalOf("orders", id);

    await until("the run to be purged", async () =>
      (await exists("orders", id)) ? undefined : true
    );
    const again = await binding("orders").admit(admission);

    expect(run.purge_at).toBe((run.ended_at ?? 0) + purgeAfterMs);
    await expect(tablesOf("orders", id)).resolves.toStrictEqual(["tombstones"]);
    // What is left is the tombstone, its expiry the alarm.
    const tombstones = await runInDurableObject(
      runObject("orders", id),
      (_, state) =>
        state.storage.sql
          .exec<{ removed_at: number }>("SELECT removed_at FROM tombstones")
          .one().removed_at
    );
    await expect(alarmOf("orders", id)).resolves.toBe(
      tombstones + defaultTombstoneMs
    );
    expect(again.created).toBeFalsy();
    expect(effectsOf(id, "charge")).toHaveLength(1);
  });

  it("empties the object of a run create made once it is purged: no tombstone, no alarm", async () => {
    const id = newId();
    await binding("orders").create({
      id,
      retention: { successRetention: purgeAfterMs },
    });
    await ended("orders", id);

    await until("the run to be purged", async () =>
      (await exists("orders", id)) ? undefined : true
    );

    await expect(tablesOf("orders", id)).resolves.toStrictEqual([]);
    await expect(alarmOf("orders", id)).resolves.toBeNull();
  });

  it("is the success retention after a run completes or is terminated, the error retention after it errors", async () => {
    const retention = { successRetention: 120_000, errorRetention: 240_000 };
    const [completed, errored, terminated] = [newId(), newId(), newId()];
    await binding("orders").create({ id: completed, retention });
    await binding("uncaught").create({ id: errored, retention });
    const held = hold(terminated, "charge");
    await binding("orders").create({ id: terminated, retention });
    await held.held;
    const toTerminate = await binding("orders").get(terminated);
    await toTerminate.terminate();
    held.release();
    await ended("orders", completed);
    await ended("uncaught", errored);

    const purgeDelay = async (
      definition: string,
      id: string
    ): Promise<unknown> => {
      const { run } = await journalOf(definition, id);
      return {
        status: run.status,
        after: (run.purge_at ?? 0) - (run.ended_at ?? 0),
        alarm: (await alarmOf(definition, id)) === run.purge_at,
      };
    };

    await expect(purgeDelay("orders", completed)).resolves.toStrictEqual({
      status: "complete",
      after: 120_000,
      alarm: true,
    });
    await expect(purgeDelay("uncaught", errored)).resolves.toStrictEqual({
      status: "errored",
      after: 240_000,
      alarm: true,
    });
    await expect(purgeDelay("orders", terminated)).resolves.toStrictEqual({
      status: "terminated",
      after: 120_000,
      alarm: true,
    });
  });

  it("starts when a rolled-back run ends, not when its rolling back began", async () => {
    const id = newId();
    await binding("compensated").create({
      id,
      params: { fail: true },
      retention: { errorRetention: 240_000 },
    });

    await ended("compensated", id);

    const { run } = await journalOf("compensated", id);
    expect(run.status).toBe("errored");
    expect(run.purge_at).toBe((run.ended_at ?? 0) + 240_000);
  });

  it("takes what a run's own leaves out from the binding's default", async () => {
    const id = newId();
    const workflow = binding("uncaught", {
      retention: { successRetention: "1 minute", errorRetention: "2 minutes" },
    });
    await workflow.create({ id, retention: { successRetention: 1000 } });
    await ended("uncaught", id);

    const { run } = await journalOf("uncaught", id);

    expect(run).toMatchObject({
      success_retention_ms: 1000,
      error_retention_ms: 120_000,
    });
  });

  it("keeps a run an early alarm reaches before its retention is up, and leaves its purge set", async () => {
    const id = newId();
    await binding("orders").create({ id });
    await ended("orders", id);
    const { run } = await journalOf("orders", id);

    // As a duplicate delivery, or the activation's own watchdog, would.
    await deliverAlarm("orders", id);

    await expect(exists("orders", id)).resolves.toBeTruthy();
    await expect(alarmOf("orders", id)).resolves.toBe(run.purge_at);
  });
});

describe("a purge alarm that can't be set", () => {
  it("is set by a terminate sent again, which finds the run ended", async () => {
    const id = newId();
    const workflow = binding("approval");
    await workflow.create({ id });
    await suspendedOn("approval", id, "approval");
    const run = await workflow.get(id);
    await run.pause();
    // The end is written, then setting its purge alarm fails, as storage
    // that fails would: the caller hears an error.
    const restore = await runInDurableObject(
      runObject("approval", id),
      (_, state) => {
        const { storage } = state;
        const hadOwn = Object.hasOwn(storage, "setAlarm");
        const original: unknown = Reflect.get(storage, "setAlarm");
        Reflect.set(storage, "setAlarm", async () => {
          await Promise.resolve();
          throw new Error("injected storage failure");
        });
        return { hadOwn, original };
      }
    );
    const first = await refusalOf(run.terminate());
    await runInDurableObject(runObject("approval", id), (_, state) => {
      if (restore.hadOwn) {
        Reflect.set(state.storage, "setAlarm", restore.original);
      } else {
        Reflect.deleteProperty(state.storage, "setAlarm");
      }
    });
    const alarmLost = await alarmOf("approval", id);

    const again = await refusalOf(run.terminate());

    const { run: terminated } = await journalOf("approval", id);
    expect(first).toMatch(/injected storage failure/u);
    expect(alarmLost).toBeNull();
    expect(again).toMatch(/instance\.cannot_terminate/u);
    expect(terminated.status).toBe("terminated");
    await expect(alarmOf("approval", id)).resolves.toBe(terminated.purge_at);
  });
});

describe("a start delivered again", () => {
  it("with another retention is another start: a conflict, not taken without a word", async () => {
    const id = newId();
    const key = `trigger-${newId()}`;
    await binding("orders").admit({
      id,
      key,
      retention: { successRetention: 60_000 },
    });

    await expect(
      binding("orders").admit({
        id,
        key,
        retention: { successRetention: 120_000 },
      })
    ).rejects.toThrow(/made with other params/u);
    await expect(
      binding("orders").admit({
        id,
        key,
        retention: { successRetention: 60_000, errorRetention: 120_000 },
      })
    ).rejects.toThrow(/made with other params/u);
    await expect(
      binding("orders").admit({
        id,
        key,
        retention: { successRetention: 60_000 },
      })
    ).resolves.toMatchObject({ created: false });
  });
});

describe("retention never purges a run still to end", () => {
  it("restarted after it ended: its purge time is cleared, and it waits on past it", async () => {
    const id = newId();
    const workflow = binding("approval");
    await workflow.create({ id, retention: { successRetention: 200 } });
    await suspendedOn("approval", id, "approval");
    const run = await workflow.get(id);
    await run.terminate();
    const { run: terminated } = await journalOf("approval", id);

    await run.restart();
    await until("the run to wait again", async () => {
      const status = await run.status();
      return status.status === "waiting" ? status : undefined;
    });
    await pastTime((terminated.purge_at ?? 0) + 50);
    await deliverAlarm("approval", id);

    const { run: restarted } = await journalOf("approval", id);
    expect({
      status: restarted.status,
      purgeAt: restarted.purge_at,
      endedAt: restarted.ended_at,
    }).toStrictEqual({ status: "waiting", purgeAt: null, endedAt: null });
    await expect(wakeOf("approval", id)).resolves.not.toBeNull();
  });

  it("paused, however long past its retention", async () => {
    const id = newId();
    const workflow = binding("approval");
    await workflow.create({ id, retention: { successRetention: 1 } });
    await suspendedOn("approval", id, "approval");
    const run = await workflow.get(id);
    await run.pause();

    await pastTime(Date.now() + 20);
    await deliverAlarm("approval", id);

    await expect(run.status()).resolves.toStrictEqual({ status: "paused" });
    const { run: paused } = await journalOf("approval", id);
    expect(paused.purge_at).toBeNull();
  });
});

describe("a retention outside the limits", () => {
  it.each([
    ["under a day", { successRetention: "1 hour" }],
    ["over 30 days", { errorRetention: "31 days" }],
    ["0", { successRetention: 0 }],
    ["not a duration", { successRetention: "forever" }],
    ["a setting it doesn't know", { retain: "1 day" }],
    ["not an object", "1 day"],
  ])(
    "is refused by Grasp's default limits, creating nothing: %s",
    async (_, retention) => {
      const id = newId();

      await expect(
        new Workflow(env.RUNS, "orders").create({
          id,
          // SAFETY: what a caller with no types could pass; the binding
          // checks it.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          retention: retention as never,
        })
      ).rejects.toThrow(TypeError);
      await expect(exists("orders", id)).resolves.toBeFalsy();
    }
  );

  it("is refused by the run object itself, its own boundary, creating nothing", async () => {
    const id = newId();
    const start = async (successMs: number): Promise<unknown> =>
      await runObject("orders", id).start({
        definition: "orders",
        version: null,
        instanceId: id,
        params: "{}",
        key: `start-${id}`,
        schedule: null,
        redeliverable: true,
        retention: { successMs, errorMs: 60_000 },
      });

    await expect(start(0)).rejects.toThrow(/retention/u);
    await expect(start(1.5)).rejects.toThrow(/retention/u);
    await expect(exists("orders", id)).resolves.toBeFalsy();
  });

  it("takes 1 and 30 days under Grasp's default limits", async () => {
    const id = newId();

    await new Workflow(env.RUNS, "orders").create({
      id,
      retention: { successRetention: "1 day", errorRetention: "30 days" },
    });
    await ended("orders", id);

    const { run } = await journalOf("orders", id);
    expect(run).toMatchObject({
      success_retention_ms: 86_400_000,
      error_retention_ms: 2_592_000_000,
    });
  });

  it("is refused in a batch, which creates nothing", async () => {
    const ids = [newId(), newId()];

    await expect(
      new Workflow(env.RUNS, "orders").createBatch({
        instances: [
          { id: ids[0] },
          { id: ids[1], retention: { successRetention: "1 hour" } },
        ],
      })
    ).rejects.toThrow(TypeError);
    await expect(exists("orders", ids[0] ?? "")).resolves.toBeFalsy();
  });

  const misconfigured: [string, WorkflowOptions][] = [
    [
      "a default outside them",
      {
        retentionLimits: shortLimits,
        retention: { successRetention: "1 day" },
      },
    ],
    [
      "Grasp's 30 days left outside them by the host's limits",
      { retentionLimits: shortLimits },
    ],
    ["limits from 0", { retentionLimits: { minMs: 0, maxMs: 2_592_000_000 } }],
    [
      "a least limit that isn't whole",
      { retentionLimits: { minMs: 1.5, maxMs: 2_592_000_000 } },
    ],
    [
      "a greatest limit that isn't whole",
      { retentionLimits: { minMs: 1, maxMs: 2_592_000_000.5 } },
    ],
    [
      "a greatest limit past 365 days",
      { retentionLimits: { minMs: 1, maxMs: 366 * 86_400_000 } },
    ],
  ];

  it("refuses limits the wrong way round, saying so", () => {
    expect(
      () =>
        new Workflow(env.RUNS, "orders", {
          retentionLimits: { minMs: 10, maxMs: 1 },
          retention: { successRetention: 5, errorRetention: 5 },
        })
    ).toThrow("Retention limits run from the least to the greatest: 10 to 1");
  });

  it.each(misconfigured)(
    "is refused when the binding is made: %s",
    (_, options) => {
      expect(() => new Workflow(env.RUNS, "orders", options)).toThrow(
        TypeError
      );
    }
  );
});
