import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { appIdSchema } from "@grasp-os/shared/ids";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { sdkResourceBindings } from "../src/db/core/schema.ts";
import {
  backfillRunId,
  defineSchemaOnStore,
  keepBackfillGoing,
  requireStoreSchemaActive,
} from "../src/store-backfill.ts";
import { backfillBatchSize, backfillLeaseMs } from "../src/store-host.ts";
import { runEngine } from "../src/workflows/engine.ts";
import {
  codeOf,
  commit,
  consumer,
  contractHash,
  fill,
  noteFields,
  notes,
  notesOf,
  objectOf,
  newStore,
  pendingStore,
  statusOf,
  v1,
  withCategory,
} from "./pending-stores.ts";
import { finished, liveStatus, resumed, stopped } from "./runs.ts";

// A store's backfill as a platform workflow (store-backfill.ts): core's
// own run on the engine, one batch per step, until the store's contract
// takes the defaulted field. Kept going as seals, activations and the
// store's alarm keep it going (`keepBackfillGoing`), and broken as a
// crash, a lost answer, a run that gives up or one the engine's retention
// removed would break it: the store must end with every record filled
// exactly once, and its contract moved only at the end.

/** How many notes each test's store holds: a few batches' worth. */
const notesHeld = backfillBatchSize * 2 + 7;

type PendingStore = Awaited<ReturnType<typeof pendingStore>>;

/** Every note's revision, as a set: filled exactly once leaves only 2. */
const revisionsOf = async (
  store: PendingStore["store"]
): Promise<Set<number>> => {
  const records = await notesOf(store);
  return new Set([...records.values()].map(({ revision }) => revision));
};

/** Ends the current run's lease, as time passing would. */
const leaseRunsOut = async (store: PendingStore["store"]): Promise<void> => {
  await runInDurableObject(objectOf(store), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE sdk_schema_backfills SET lease_until = 0, looked_at = 0"
    );
  });
};

/**
 * A run of attempt 1 that ended without finishing, after batch 1
 * committed: here one asking for a target the store doesn't hold, so it
 * ends at its first batch, whatever the timing.
 */
const stalled = async ({ store, second }: PendingStore): Promise<string> => {
  const target = second.contract.hash;
  await fill(store, target, 1);
  const run = await backfillRunId(store.id, target, 1);
  await runEngine(env).createInternal({
    id: run,
    workflow: "backfill",
    input: { storeId: store.id, target: "0".repeat(64), attempt: 1 },
  });
  await finished(run);
  return run;
};

/** Once the store's contract holds `withCategory`. */
const activated = async (store: PendingStore["store"]): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(statusOf(store, withCategory)).resolves.toStrictEqual({
        state: "active",
      });
    },
    { timeout: 20_000, interval: 200 }
  );
};

/** A schema past the pending target: another field, optional. */
const further = notes({
  ...noteFields,
  category: v.string().max(20).default("general"),
  archived: v.boolean().optional(),
});

describe("a store's backfill run", () => {
  it("fills in the field batch after batch, then the contract takes it", async () => {
    const { store, second } = await pendingStore(notesHeld);

    await keepBackfillGoing(env, store.id);
    const run = await backfillRunId(store.id, second.contract.hash, 1);
    await finished(run);

    expect({
      run: await liveStatus(run),
      status: await statusOf(store, withCategory),
      contract: await contractHash(store),
      revisions: await revisionsOf(store),
    }).toStrictEqual({
      run: "complete",
      status: { state: "active" },
      contract: second.contract.hash,
      revisions: new Set([2]),
    });
  });

  it("hands over to a new run once one that ended without finishing lost its lease", async () => {
    const pending = await pendingStore(notesHeld);
    const { store, second } = pending;
    const killed = await stalled(pending);

    // Its lease still holds: nothing takes over yet.
    await keepBackfillGoing(env, store.id);
    const whileLeased = await objectOf(store).backfillStatus(store.id);
    await leaseRunsOut(store);
    await keepBackfillGoing(env, store.id);
    const next = await backfillRunId(store.id, second.contract.hash, 2);
    await finished(next);

    expect({
      killed: await liveStatus(killed),
      whileLeased: whileLeased?.attempt,
      next: await liveStatus(next),
      status: await statusOf(store, withCategory),
      revisions: await revisionsOf(store),
    }).toStrictEqual({
      killed: "errored",
      whileLeased: 1,
      next: "complete",
      status: { state: "active" },
      revisions: new Set([2]),
    });
  });

  it("hands over past a run the engine's retention removed", async () => {
    const pending = await pendingStore(notesHeld);
    const { store } = pending;
    const removed = await stalled(pending);
    await runEngine(env).remove(removed);
    await leaseRunsOut(store);

    await keepBackfillGoing(env, store.id);
    await activated(store);

    await expect(revisionsOf(store)).resolves.toStrictEqual(new Set([2]));
  });

  it("is kept going by the store's alarm once a run's lease ran out", async () => {
    const pending = await pendingStore(notesHeld);
    const { store } = pending;
    await stalled(pending);
    await leaseRunsOut(store);

    await runDurableObjectAlarm(objectOf(store));
    await activated(store);

    await expect(revisionsOf(store)).resolves.toStrictEqual(new Set([2]));
  });

  it("hands over to a fresh run after its share of batches", async () => {
    const { store, second } = await pendingStore(notesHeld);
    const target = second.contract.hash;

    await runEngine(env).createInternal({
      id: await backfillRunId(store.id, target, 1),
      workflow: "backfill",
      input: { storeId: store.id, target, attempt: 1, batchesPerRun: 1 },
    });
    await activated(store);
    const runs = await Promise.all(
      [1, 2, 3].map(async (attempt) => {
        const run = await backfillRunId(store.id, target, attempt);
        await finished(run);
        return await liveStatus(run);
      })
    );

    expect({ runs, revisions: await revisionsOf(store) }).toStrictEqual({
      runs: ["complete", "complete", "complete"],
      revisions: new Set([2]),
    });
  });
});

describe("a seal while a backfill is pending", () => {
  it("keeps a stalled backfill going, and succeeds once it is done", async () => {
    const pending = await pendingStore(notesHeld);
    const { store } = pending;
    await stalled(pending);
    await leaseRunsOut(store);

    const refused = await codeOf(
      defineSchemaOnStore(env, store, further, consumer(7))
    );
    await activated(store);
    const sealed = await defineSchemaOnStore(env, store, further, consumer(7));

    expect({ refused, changed: sealed.contract.changed }).toStrictEqual({
      refused: "migration.pending",
      changed: true,
    });
  });
});

describe("a failed backfill", () => {
  it("refuses its releases until the record that failed it changes, then retries", async () => {
    // A note whose document fits only without the default.
    const pending = await pendingStore(3, [
      { title: "x".repeat(documentMaxBytes - 22) },
    ]);
    const { store, first, second, ids } = pending;
    const large = ids.at(-1) ?? "";
    const app = appIdSchema.parse(crypto.randomUUID());
    await drizzle(env.DB)
      .insert(sdkResourceBindings)
      .values({
        resourceId: app,
        resourceVersion: 2,
        alias: "default",
        kind: "store",
        targetId: store.id,
        schemaHash: second.schemaHash,
        manifestHash: "m".repeat(64),
      });
    await keepBackfillGoing(env, store.id);
    await finished(await backfillRunId(store.id, second.contract.hash, 1));

    const seal = await codeOf(
      defineSchemaOnStore(env, store, withCategory, consumer(8))
    );
    const activation = await codeOf(requireStoreSchemaActive(env, app, 2));
    // The current version shrinks the record.
    await commit(store, first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: large,
        expectedRevision: 1,
        fields: { title: "Shrunk" },
      },
    ]);
    const retried = await codeOf(requireStoreSchemaActive(env, app, 2));
    await activated(store);

    expect({
      seal,
      activation,
      retried,
      after: await codeOf(requireStoreSchemaActive(env, app, 2)),
    }).toStrictEqual({
      seal: "migration.backfill_failed",
      activation: "migration.backfill_failed",
      retried: "migration.pending",
      after: "ok",
    });
  });
});

describe("the store's alarm", () => {
  it("stops handing over runs a store error ends, as stalled, after a bounded number of runs", async () => {
    const { store, second } = await pendingStore(notesHeld);
    const target = second.contract.hash;
    // A store error no retry mends: its fill names a field it doesn't have.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE sdk_schema_backfills SET fills = '[["notes","nope"]]'`
      );
    });
    await keepBackfillGoing(env, store.id);
    let status = await objectOf(store).backfillStatus(store.id);
    for (let look = 0; look < 8 && status?.state === "running"; look += 1) {
      // Each run, ended at its first batch, then the alarm's next look.
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await finished(await backfillRunId(store.id, target, status.attempt));
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await leaseRunsOut(store);
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await runDurableObjectAlarm(objectOf(store));
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      status = await objectOf(store).backfillStatus(store.id);
    }
    // Another look: nothing more is started.
    await leaseRunsOut(store);
    await runInDurableObject(objectOf(store), async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(objectOf(store));
    const next = await runEngine(env).status(
      await backfillRunId(store.id, target, (status?.attempt ?? 0) + 1)
    );

    expect({
      state: status?.state,
      failure: status?.failure,
      attempt: status?.attempt,
      next,
    }).toStrictEqual({
      state: "failed",
      failure: { reason: "stalled" },
      attempt: 4,
      next: undefined,
    });
  });

  it("looks after a run the engine keeps alive past its lease once a lease, not every second", async () => {
    // Enough batches that the run is still going when it is paused.
    const { store, second } = await pendingStore(backfillBatchSize * 40);
    const target = second.contract.hash;
    await fill(store, target, 1);
    const run = await backfillRunId(store.id, target, 1);
    await runEngine(env).createInternal({
      id: run,
      workflow: "backfill",
      input: { storeId: store.id, target, attempt: 1 },
    });
    // Alive, as the engine has it, but holding its lease no more: paused
    // once it started (a queued run doesn't take a pause).
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run)).resolves.not.toBe("queued");
      },
      { timeout: 10_000, interval: 10 }
    );
    await stopped(run);
    await leaseRunsOut(store);

    await runDurableObjectAlarm(objectOf(store));
    const after = await runInDurableObject(
      objectOf(store),
      async (_instance, state) => await state.storage.getAlarm()
    );
    const status = await objectOf(store).backfillStatus(store.id);
    await resumed(run);
    await activated(store);

    expect({
      attempt: status?.attempt,
      nextLook: (after ?? 0) >= Date.now() + backfillLeaseMs - 60_000,
    }).toStrictEqual({ attempt: 1, nextLook: true });
  });
});

describe("making a release current while a backfill runs", () => {
  it("answers pending until it is done, then passes", async () => {
    const { store, second } = await pendingStore(notesHeld);
    const app = appIdSchema.parse(crypto.randomUUID());
    await drizzle(env.DB)
      .insert(sdkResourceBindings)
      .values({
        resourceId: app,
        resourceVersion: 2,
        alias: "default",
        kind: "store",
        targetId: store.id,
        schemaHash: second.schemaHash,
        manifestHash: "m".repeat(64),
      });

    const first = await codeOf(requireStoreSchemaActive(env, app, 2));
    await activated(store);

    expect({
      first,
      after: await codeOf(requireStoreSchemaActive(env, app, 2)),
    }).toStrictEqual({ first: "migration.pending", after: "ok" });
  });
});

describe("a seal of a defaulted reference", () => {
  it("is refused as needing a migration", async () => {
    const store = await newStore();
    await store.defineTables(v1, consumer(1));
    const referencing = manifestText(
      schemaManifest(
        defineSchema({
          notes: defineTable({
            ...noteFields,
            tag: v.id("tags").nullable().default(null),
          }),
          tags: defineTable({ name: v.string() }),
        }),
        {
          tables: {
            notes: { read: "appMembers", write: "appMembers" },
            tags: { read: "appMembers", write: "appMembers" },
          },
        }
      )
    );

    await expect(
      defineSchemaOnStore(env, store, referencing, consumer(2))
    ).rejects.toMatchObject({
      code: "migration.required",
      details: {
        changes: [
          { table: "notes", field: "tag", reason: "defaulted_reference_added" },
        ],
      },
    });
  });
});
