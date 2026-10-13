import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import type { Member } from "../src/auth/identity.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { sdkResourceBindings } from "../src/db/core/schema.ts";
import { abandonStoreBackfill, storeBackfill } from "../src/store-abandon.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { StoreHost } from "../src/store-host.ts";
import { allEvents } from "./audit-events.ts";
import {
  codeOf,
  commit,
  contractHash,
  fillAll,
  insertAll,
  newStore,
  noteFields,
  notes,
  notesOf,
  objectOf,
  pendingStore,
  retry,
  statusOf,
  titled,
  v1,
  withCategory,
} from "./pending-stores.ts";
import { memberRoles, newRecordId } from "./store-schemas.ts";

// Abandoning a store's failed backfill (store-abandon.ts, store-host.ts
// `abandonBackfill`), through core's own way in and the store's object,
// from the threat model in store-abandon.ts. What can go wrong, and the
// test that shows it doesn't:
//
// - The store stays blocked, or the abandonment moves the contract or
//   touches records: "keeps the contract and the records".
// - The release that needed the abandoned schema becomes current, now or
//   once a later release adds the field again: "refuses the abandoned
//   release for good".
// - A later schema gives an abandoned field another meaning, which the
//   values the backfill filled in don't fit: "refuses another meaning".
// - A running backfill is abandoned under its run, or a retry is raced:
//   "refuses a backfill still running, and a run a retry moved past".
// - Someone abandons who shouldn't, or on a store that is gone: "is for
//   the organization's admins", "refuses a deleted store".
// - A shared target leaves another App's release runnable: "takes every
//   App's release on a shared target out of force".
// - A reserved field the store can't read back blocks it for good:
//   "reads back a reserved reference".
// - A writer keeps a schema taken out of force: "refuses a write under
//   an abandoned schema".
// - It goes unaudited, or audited twice, or a second abandonment of the
//   same target overwrites the first: "audits it once", "audits each
//   abandonment of a target", "audits it before a deleted store's purge".

const admin: Member = {
  userId: "grace",
  role: "admin",
  teams: [],
  staff: false,
};

/** Release `version` of `app`, as its seal names it to the store. */
const release = (app: AppId, resourceVersion: number) => ({
  resourceId: app,
  resourceVersion,
});

/** Binds release `version` of `app` to the store, as its seal does. */
const bind = async (
  app: AppId,
  version: number,
  store: OpenStore,
  schemaHash: string
): Promise<void> => {
  await drizzle(env.DB)
    .insert(sdkResourceBindings)
    .values({
      resourceId: app,
      resourceVersion: version,
      alias: "default",
      kind: "store",
      targetId: store.id,
      schemaHash,
      manifestHash: "m".repeat(64),
    });
};

/**
 * A store whose backfill of `withCategory` (release 2 of a new App)
 * failed on a note whose `category` is a number, under a key release 1
 * doesn't declare: the case no App can mend.
 */
const failedStore = async (extra?: StoreFields) => {
  const app = appIdSchema.parse(crypto.randomUUID());
  const store = await newStore();
  const first = await store.defineTables(v1, release(app, 1));
  const ids = await insertAll(store, first.schemaHash, [
    ...titled(3),
    { title: "Odd", ...(extra ?? { category: 42 }) },
  ]);
  const second = await store.defineTables(withCategory, release(app, 2));
  const target = second.contract.hash;
  await bind(app, 2, store, second.schemaHash);
  const failed = await fillAll(store, target);
  return {
    app,
    store,
    first,
    second,
    target,
    odd: ids.at(-1) ?? "",
    failure: failed.at(-1)?.failure,
  };
};

/** The error a call was refused with, as its code and details. */
const refusalOf = async (call: Promise<unknown>) => {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (typeof error !== "object" || error === null) {
      return error;
    }
    return {
      code: "code" in error ? error.code : undefined,
      details: "details" in error ? error.details : undefined,
    };
  }
};

/** The `store.backfill_abandoned` events of `store`, in log order. */
const abandonedEvents = async (store: OpenStore) => {
  const logged = await allEvents();
  return logged.filter(
    ({ action, target }) =>
      action === "store.backfill_abandoned" && target?.id === store.id
  );
};

/** Runs the store's alarm here, in the test's own request. */
const runAlarm = async (store: OpenStore): Promise<void> => {
  await runInDurableObject(objectOf(store), async (_instance, state) => {
    await new StoreHost(state, env).runAlarm({});
  });
};

/** Notes with a `category` as `descriptor` declares it. */
const categoryAs = (descriptor: Parameters<typeof notes>[0]["category"]) =>
  notes({ ...noteFields, category: descriptor });

describe("abandoning a failed backfill", () => {
  it("keeps the contract and the records, and the store takes schema changes again", async () => {
    const { app, store, first, target, odd, failure } = await failedStore();
    const archived = notes({ ...noteFields, archived: v.boolean().optional() });
    const blocked = await codeOf(store.defineTables(archived, release(app, 3)));
    const before = await notesOf(store);

    const abandoned = await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });
    const contract = await contractHash(store);
    const after = await store.defineTables(archived, release(app, 3));

    expect({
      failure,
      blocked,
      abandoned: {
        releases: abandoned.releases,
        reserved: abandoned.reserved,
        failure: abandoned.failure,
      },
      contract,
      backfill: await storeBackfill(env, admin, store.id),
      records: await notesOf(store),
      schema: await statusOf(store, withCategory),
      after: after.contract.pending,
    }).toStrictEqual({
      failure: {
        table: "notes",
        field: "category",
        id: odd,
        reason: "invalid_value",
      },
      blocked: "migration.backfill_failed",
      abandoned: {
        releases: [{ app, version: 2 }],
        reserved: [{ table: "notes", field: "category" }],
        failure: {
          table: "notes",
          field: "category",
          id: odd,
          reason: "invalid_value",
        },
      },
      contract: first.schemaHash,
      backfill: null,
      // The values it filled in stay: no reader's schema declares them.
      records: before,
      schema: { state: "abandoned" },
      after: false,
    });
  });

  it("refuses the abandoned release for good, even once a later release adds the field as it was", async () => {
    const { app, store, first, second, target, odd } = await failedStore();
    const failed = await refusalOf(requireStoreSchemaActive(env, app, 2));
    await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });
    const abandoned = await codeOf(requireStoreSchemaActive(env, app, 2));
    const resealed = await codeOf(
      store.defineTables(withCategory, release(app, 2))
    );
    // The record goes; a later release adds the field again, as it was.
    await commit(store, first.schemaHash, [
      { op: "delete", table: "notes", id: odd, expectedRevision: 1 },
    ]);
    const third = await store.defineTables(withCategory, release(app, 3));
    await bind(app, 3, store, third.schemaHash);
    const backfill = await storeBackfill(env, admin, store.id);
    // Its backfill goes on from the run after the abandoned one's.
    const filled = await fillAll(store, target, { attempt: 2 });

    expect({
      failed,
      abandoned,
      resealed,
      third: [third.schemaHash, third.contract.pending],
      backfill: [backfill?.state, backfill?.attempt],
      filled: filled.at(-1)?.state,
      contract: await contractHash(store),
      current: await codeOf(requireStoreSchemaActive(env, app, 3)),
      old: await codeOf(requireStoreSchemaActive(env, app, 2)),
    }).toStrictEqual({
      failed: {
        code: "migration.backfill_failed",
        details: {
          target,
          attempt: 1,
          failure: {
            table: "notes",
            field: "category",
            id: odd,
            reason: "invalid_value",
          },
        },
      },
      abandoned: "migration.abandoned",
      resealed: "migration.abandoned",
      third: [second.schemaHash, true],
      backfill: ["running", 2],
      filled: "complete",
      contract: target,
      current: "ok",
      old: "migration.abandoned",
    });
  });

  it("refuses another meaning for an abandoned field, and takes it again as it was", async () => {
    const { app, store, target } = await failedStore();
    await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });
    const reserved = {
      code: "migration.required",
      details: {
        changes: [
          {
            table: "notes",
            field: "category",
            reason: "reserved_field_changed",
          },
        ],
      },
    };

    const retyped = await refusalOf(
      store.defineTables(categoryAs(v.number().optional()), release(app, 3))
    );
    const undefaulted = await refusalOf(
      store.defineTables(
        categoryAs(v.string().max(20).optional()),
        release(app, 4)
      )
    );
    // As it was: pending again, on the same record, which fails again.
    const same = await store.defineTables(withCategory, release(app, 5));

    expect({
      retyped,
      undefaulted,
      same: same.contract.pending,
    }).toStrictEqual({
      retyped: reserved,
      undefaulted: reserved,
      same: true,
    });
  });

  it("refuses a backfill still running, and a run a retry moved past", async () => {
    const running = await pendingStore(3);
    const target = running.second.contract.hash;
    const whileRunning = await codeOf(
      abandonStoreBackfill(env, admin, {
        store: running.store.id,
        target,
        attempt: 1,
      })
    );
    // A note whose document fits only without the default: it fails, the
    // current version shrinks it, and a retry takes the target on.
    const large = await failedStore({
      title: "x".repeat(documentMaxBytes - 22),
    });
    await commit(large.store, large.first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: large.odd,
        expectedRevision: 1,
        fields: { title: "Shrunk" },
      },
    ]);
    const retried = await retry(large.store, large.target);
    const raced = await codeOf(
      abandonStoreBackfill(env, admin, {
        store: large.store.id,
        target: large.target,
        attempt: 1,
      })
    );
    const rest = await fillAll(large.store, large.target, { attempt: 2 });
    const still = await storeBackfill(env, admin, running.store.id);

    expect({
      whileRunning,
      still: still?.state,
      retried: retried?.attempt,
      raced,
      rest: rest.at(-1)?.state,
      contract: await contractHash(large.store),
    }).toStrictEqual({
      whileRunning: "migration.not_failed",
      still: "running",
      retried: 2,
      raced: "migration.superseded",
      rest: "complete",
      contract: large.target,
    });
  });

  it("is for the organization's admins alone, never Grasp staff", async () => {
    const { store, target } = await failedStore();
    const input = { store: store.id, target, attempt: 1 };
    const builder = await codeOf(
      abandonStoreBackfill(env, { ...admin, role: "builder" }, input)
    );
    const staff = await codeOf(
      abandonStoreBackfill(env, { ...admin, staff: true }, input)
    );
    const unknown = await codeOf(
      abandonStoreBackfill(env, admin, { ...input, store: crypto.randomUUID() })
    );
    const staffRead = await codeOf(
      storeBackfill(env, { ...admin, staff: true }, store.id)
    );
    const still = await storeBackfill(env, admin, store.id);

    expect({
      builder,
      staff,
      unknown,
      staffRead,
      still: still?.state,
    }).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
      unknown: "data.store_unavailable",
      staffRead: "role.forbidden",
      still: "failed",
    });
  });

  it("audits it once, from the store's alarm when core's call stopped short", async () => {
    const { app, store, target, odd } = await failedStore();
    // The store abandons; core's call stops before it records the event.
    const first = await objectOf(store).abandonBackfill(
      store.id,
      { target, attempt: 1 },
      actorOf(admin)
    );
    await runAlarm(store);
    const byAlarm = await abandonedEvents(store);
    // Core asked again: the same abandonment, recorded once.
    const again = await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });

    const events = await abandonedEvents(store);
    expect({
      byAlarm: byAlarm.length,
      again: again.abandonedAt,
      events: events.map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      byAlarm: 1,
      again: new Date(first.abandonedAt).toISOString(),
      events: [
        {
          actor: { type: "person", userId: admin.userId },
          detail: {
            target,
            attempt: 1,
            reason: "invalid_value",
            table: "notes",
            field: "category",
            record: odd,
            scanned: first.scanned,
            filled: first.filled,
            schemas: 1,
            releases: 1,
            "release.0": `${app}@2`,
            reserved: 1,
            "reserved.0": "notes.category",
          },
        },
      ],
    });
  });

  it("reads back a reserved reference, so later schema changes still apply", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    const access = {
      tables: {
        notes: { read: "appMembers", write: "appMembers" },
        people: { read: "appMembers", write: "appMembers" },
      },
    } as const;
    const withPeople = (fields: Parameters<typeof notes>[0]) =>
      manifestText(
        schemaManifest(
          defineSchema({
            notes: defineTable(fields),
            people: defineTable({ name: v.string().min(1) }),
          }),
          access
        )
      );
    const store = await newStore();
    const first = await store.defineTables(
      withPeople(noteFields),
      release(app, 1)
    );
    await insertAll(store, first.schemaHash, [{ title: "Odd", category: 42 }]);
    // The failing defaulted field, and beside it a reference to a table
    // the store held already, which no reserved field names.
    const second = await store.defineTables(
      withPeople({
        ...noteFields,
        category: v.string().max(20).default("general"),
        owner: v.id("people").optional(),
      }),
      release(app, 2)
    );
    const target = second.contract.hash;
    const failed = await fillAll(store, target);
    await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });

    const later = await codeOf(
      store.defineTables(
        withPeople({ ...noteFields, archived: v.boolean().optional() }),
        release(app, 3)
      )
    );
    const retyped = await codeOf(
      store.defineTables(
        withPeople({ ...noteFields, owner: v.string().optional() }),
        release(app, 4)
      )
    );
    expect({ failed: failed.at(-1)?.state, later, retyped }).toStrictEqual({
      failed: "failed",
      later: "ok",
      retyped: "migration.required",
    });
  });

  it("refuses a write under an abandoned schema, whatever a writer cached", async () => {
    const { store, second, target } = await failedStore();
    const outcomes = await runInDurableObject(
      objectOf(store),
      async (_instance, state) => {
        // One host writes, and keeps the schema it read; another abandons,
        // as an abandonment committing while the first read it would.
        const writer = new StoreHost(state, env);
        const write = async () => {
          const claimed = await writer.claim({
            storeId: store.id,
            scope: {
              principal: "ada",
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
          return await writer.commit(
            {
              storeId: store.id,
              principal: { userId: "ada" },
              roles: memberRoles,
              stagedAt: Date.now(),
              schemaHash: second.schemaHash,
              writes: [
                {
                  op: "insert",
                  table: "notes",
                  id: newRecordId(),
                  fields: { title: "Late", category: "news" },
                },
              ],
              receipt: claimed.held,
            },
            {}
          );
        };
        const before = await codeOf(write());
        await new StoreHost(state, env).abandonBackfill(
          store.id,
          { target, attempt: 1 },
          actorOf(admin)
        );
        return { before, after: await codeOf(write()) };
      }
    );

    expect(outcomes).toStrictEqual({
      before: "ok",
      after: "migration.abandoned",
    });
  });

  it("refuses a deleted store", async () => {
    const inventory = await failedStore();
    await env.DB.prepare(
      "UPDATE business_stores SET deleted_at = ? WHERE id = ?"
    )
      .bind(Date.now(), inventory.store.id)
      .run();
    const object = await failedStore();
    await runInDurableObject(objectOf(object.store), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_store SET deleted_at = ?, deleted_by = ?",
        Date.now(),
        JSON.stringify(actorOf(admin))
      );
    });
    const abandon = async ({ store, target }: typeof inventory) =>
      await codeOf(
        abandonStoreBackfill(env, admin, {
          store: store.id,
          target,
          attempt: 1,
        })
      );

    expect({
      inventory: await abandon(inventory),
      object: await abandon(object),
    }).toStrictEqual({
      inventory: "data.store_unavailable",
      object: "data.store_unavailable",
    });
  });

  it("takes every App's release on a shared target out of force", async () => {
    const [one, other] = [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
      appIdSchema.parse(id)
    );
    if (one === undefined || other === undefined) {
      throw new Error("Two Apps");
    }
    const store = await newStore();
    const first = await store.defineTables(v1, release(one, 1));
    await insertAll(store, first.schemaHash, [
      ...titled(2),
      { title: "Odd", category: 42 },
    ]);
    const second = await store.defineTables(withCategory, release(one, 2));
    // Another App's release, taken onto the same pending target.
    const shared = await store.defineTables(withCategory, release(other, 1));
    await bind(one, 2, store, second.schemaHash);
    await bind(other, 1, store, shared.schemaHash);
    const target = second.contract.hash;
    await fillAll(store, target);

    const abandoned = await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });

    expect({
      shared: [shared.contract.hash, shared.contract.pending],
      releases: abandoned.releases,
      one: await codeOf(requireStoreSchemaActive(env, one, 2)),
      other: await codeOf(requireStoreSchemaActive(env, other, 1)),
    }).toStrictEqual({
      shared: [target, true],
      releases: [
        { app: one, version: 2 },
        { app: other, version: 1 },
      ].toSorted((a, b) => a.app.localeCompare(b.app)),
      one: "migration.abandoned",
      other: "migration.abandoned",
    });
  });

  it("audits each abandonment of a target, the second before the first was recorded", async () => {
    const { app, store, target } = await failedStore();
    const object = objectOf(store);
    await object.abandonBackfill(
      store.id,
      { target, attempt: 1 },
      actorOf(admin)
    );
    // Added back as it was; the same record fails it again.
    const again = await store.defineTables(withCategory, release(app, 3));
    const refilled = await fillAll(store, target, { attempt: 2 });
    await object.abandonBackfill(
      store.id,
      { target, attempt: 2 },
      actorOf(admin)
    );
    await runAlarm(store);
    const events = await abandonedEvents(store);

    expect({
      again: again.contract.hash,
      refilled: refilled.at(-1)?.state,
      attempts: events
        .map(({ detail }) => Number(detail.attempt))
        .toSorted((a, b) => a - b),
    }).toStrictEqual({
      again: target,
      refilled: "failed",
      attempts: [1, 2],
    });
  });

  it("audits an abandonment core never recorded before a deleted store's purge", async () => {
    const { store, target } = await failedStore();
    await objectOf(store).abandonBackfill(
      store.id,
      { target, attempt: 1 },
      actorOf(admin)
    );
    const left = await runInDurableObject(
      objectOf(store),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
        state.storage.sql.exec(
          "UPDATE sdk_store SET deleted_at = ?, deleted_by = ?",
          Date.now(),
          JSON.stringify(actorOf(admin))
        );
        await new StoreHost(state, env).runAlarm({});
        return state.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM sdk_abandoned_targets"
          )
          .one().n;
      }
    );
    const events = await abandonedEvents(store);

    expect({ left, events: events.length }).toStrictEqual({
      left: 0,
      events: 1,
    });
  });
});
