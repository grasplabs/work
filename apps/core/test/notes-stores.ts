import { defineSchema, defineTable, v } from "@grasp-os/runtime";
import type { ValueShape } from "@grasp-os/runtime";
import { manifestText, schemaManifest } from "@grasp-os/runtime/host";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { Commit, StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { Acting } from "../src/auth/identity.ts";
import { openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { applied, memberRoles, newRecordId } from "./store-schemas.ts";

// Stores of notes, as the tests of a store's schema changes make and look
// into them: through the store's own way in and its Durable Object.

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
    schemaManifest(
      defineSchema({
        notes: defineTable(fields).access({
          read: "appMembers",
          write: "appMembers",
        }),
      })
    )
  );

export const v1 = notes(noteFields);
export const withCategory = notes({
  ...noteFields,
  category: v.string().max(20).default("general"),
});

export const newStore = async (): Promise<OpenStore> =>
  await openStore(env, await storeOfNewApp(env, builder));

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
    actor: { type: "person", userId: by },
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

/** The store's schema in force, its hash. */
export const schemaHashOf = async (store: OpenStore): Promise<string | null> =>
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

/** A store holding `count` notes, and `extra`, under v1. */
export const storeOfNotes = async (
  count: number,
  extra: StoreFields[] = []
) => {
  const store = await newStore();
  const { schemaHash } = await store.applySchema(applied(v1));
  const ids = await insertAll(store, schemaHash, [...titled(count), ...extra]);
  return { store, schemaHash, ids };
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
