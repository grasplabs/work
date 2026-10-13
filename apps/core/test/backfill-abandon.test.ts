import { v } from "@grasp-os/sdk";
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
// - Someone abandons who shouldn't: "is for the organization's admins".
// - It goes unaudited, or audited twice: "audits it once".

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
    const still = await storeBackfill(env, admin, store.id);

    expect({ builder, staff, unknown, still: still?.state }).toStrictEqual({
      builder: "role.forbidden",
      staff: "role.forbidden",
      unknown: "data.store_unavailable",
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
    // Its alarm: run here, in the test's own request.
    await runInDurableObject(objectOf(store), async (_instance, state) => {
      await new StoreHost(state, env).runAlarm({});
    });
    // Core asked again: the same abandonment, recorded once.
    const again = await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });

    const logged = await allEvents();
    const events = logged.filter(
      ({ action, target: of }) =>
        action === "store.backfill_abandoned" && of?.id === store.id
    );
    expect({
      again: again.abandonedAt,
      events: events.map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
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
});
