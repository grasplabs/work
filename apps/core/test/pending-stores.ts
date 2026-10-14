import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { Commit, StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { backfillBatchSchema } from "../src/store-host.ts";
import type { BackfillOutcome } from "../src/store-host.ts";
import { manifestHash, memberRoles, newRecordId } from "./store-schemas.ts";

// Stores with a defaulted field pending (store-host.ts, `fillMissing`),
// as the backfill's tests make and look into them: through the store's
// own way in and its Durable Object.

export const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

export const noteFields = { title: v.string().min(1).max(200) };

/** A notes schema of `fields`, read and written by the App's members. */
export const notes = (fields: ValueShape): string =>
  manifestText(
    schemaManifest(defineSchema({ notes: defineTable(fields) }), {
      tables: { notes: { read: "appMembers", write: "appMembers" } },
    })
  );

export const v1 = notes(noteFields);
export const withCategory = notes({
  ...noteFields,
  category: v.string().max(20).default("general"),
});

export const consumer = (resourceVersion: number) => ({
  resourceId: "notes-app",
  resourceVersion,
});

export const newStore = async (): Promise<OpenStore> =>
  await openStore(env, await createStore(env, builder));

/** Commits `writes` for `by` (Ada) under a receipt of its own, pinned to `schemaHash`. */
export const commit = async (
  store: OpenStore,
  schemaHash: string,
  writes: Commit["writes"],
  by = "ada"
) => {
  const claimed = await store.claim({
    scope: {
      principal: by,
      resource: "notes-app",
      binding: null,
      contractId: "notes.update",
      contractVersion: 1,
      operationKind: "mutation",
    },
    key: [crypto.randomUUID()],
    inputHash: "c".repeat(64),
    runId: null,
    deadline: Date.now() + 60_000,
  });
  if (!("held" in claimed)) {
    throw new Error("A new key found an outcome");
  }
  return await store.commit({
    principal: { userId: by },
    roles: memberRoles,
    stagedAt: Date.now(),
    schemaHash,
    writes,
    receipt: claimed.held,
  });
};

/** Inserts notes of each of `rows` under `schemaHash`; answers their IDs. */
export const insertAll = async (
  store: OpenStore,
  schemaHash: string,
  rows: readonly StoreFields[]
): Promise<string[]> => {
  const ids = rows.map(() => newRecordId());
  for (let start = 0; start < rows.length; start += 100) {
    // One commit after the other, as callers would.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await commit(
      store,
      schemaHash,
      rows.slice(start, start + 100).map((fields, offset) => ({
        op: "insert",
        table: "notes",
        id: ids[start + offset] ?? "",
        fields,
      }))
    );
  }
  return ids;
};

/** `count` notes titled after their place. */
export const titled = (count: number): StoreFields[] =>
  Array.from({ length: count }, (_, index) => ({ title: `Note ${index}` }));

/** The store's object. */
export const objectOf = (store: OpenStore) =>
  env.DATA_STORES.getByName(store.id);

/** Batch `batch` of the backfill of `target`, for run `attempt`. */
export const fill = async (
  store: OpenStore,
  target: string,
  batch: number,
  attempt = 1
): Promise<BackfillOutcome> => {
  const answered = backfillBatchSchema.parse(
    JSON.parse(
      await objectOf(store).fillMissing(store.id, { target, attempt, batch })
    )
  );
  if (answered.state === "transform") {
    throw new Error("A fill's batch asked for a transform");
  }
  return answered;
};

/** Batch `batch` of a migration's backfill: what the store hands core. */
export const migrationBatch = async (
  store: OpenStore,
  target: string,
  batch: number,
  attempt = 1
) =>
  backfillBatchSchema.parse(
    JSON.parse(
      await objectOf(store).fillMissing(store.id, { target, attempt, batch })
    )
  );

/** Runs batches from `from` until the backfill is no longer running. */
export const fillAll = async (
  store: OpenStore,
  target: string,
  { from = 1, attempt = 1 } = {}
): Promise<BackfillOutcome[]> => {
  const outcomes: BackfillOutcome[] = [];
  for (let batch = from; ; batch += 1) {
    // One batch after the other, as the backfill's run takes them.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const outcome = await fill(store, target, batch, attempt);
    outcomes.push(outcome);
    if (outcome.state !== "running") {
      return outcomes;
    }
  }
};

export const statusOf = async (store: OpenStore, schema: string) =>
  await objectOf(store).schemaStatus(store.id, await manifestHash(schema));

/** The store's contract in force, its hash. */
export const contractHash = async (store: OpenStore): Promise<string | null> =>
  await runInDurableObject(
    objectOf(store),
    (_instance, state) =>
      state.storage.sql
        .exec<{ hash: string | null }>(
          "SELECT contract_hash AS hash FROM sdk_store"
        )
        .one().hash
  );

/** Every note's fields and revision, by ID. */
export const notesOf = async (
  store: OpenStore
): Promise<Map<string, { fields: StoreFields; revision: number }>> =>
  await runInDurableObject(
    objectOf(store),
    (_instance, state) =>
      new Map(
        state.storage.sql
          .exec<{ id: string; value: string; revision: number }>(
            "SELECT record_id AS id, value_json AS value, revision FROM sdk_records"
          )
          .toArray()
          .map(({ id, value, revision }) => [
            id,
            { fields: storedFieldsSchema.parse(JSON.parse(value)), revision },
          ])
      )
  );

/** A store holding `count` notes under v1, handed `withCategory`. */
export const pendingStore = async (
  count: number,
  extra: StoreFields[] = []
) => {
  const store = await newStore();
  const first = await store.defineTables(v1, consumer(1));
  const ids = await insertAll(store, first.schemaHash, [
    ...titled(count),
    ...extra,
  ]);
  const second = await store.defineTables(withCategory, consumer(2));
  return { store, first, second, ids };
};

/** The code of an error a call was refused with. */
export const codeOf = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : error;
  }
};

/** Retries the failed backfill of `target` (`StoreHost.retryBackfill`). */
export const retry = async (store: OpenStore, target: string) =>
  await objectOf(store).retryBackfill(store.id, target);
