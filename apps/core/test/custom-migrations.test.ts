import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import type { ValueShape } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { StoreFields } from "@grasp-os/shared/stores";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Member } from "../src/auth/identity.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { abandonStoreBackfill, storeBackfill } from "../src/store-abandon.ts";
import type { BackfillOutcome, TransformedBatch } from "../src/store-host.ts";
import {
  codeOf,
  commit,
  contractHash,
  migrationBatch,
  newStore,
  notesOf,
  objectOf,
  retry,
} from "./pending-stores.ts";
import { manifestHash, newRecordId } from "./store-schemas.ts";

// An explicit migration as the store runs it (store-migrations.ts): the
// store hands core a batch of records with their revisions, core's
// transform answers their fields (here the test answers for it, as
// store-backfill's tests drive fills; the sandboxed transform is
// migration-transform.test.ts, and the whole run custom-migration-runs.test.ts),
// and the store commits them. Through the store's own way in and its
// Durable Object. What can go wrong, and the test that shows it doesn't:
//
// - A migration a store can't vouch for runs: "refuses a migration that
//   doesn't fit the store".
// - The contract moves while a record doesn't fit it yet: "keeps the
//   contract until it is ready", "waits for work a concurrent write left".
// - The version still current can't write between the migration's end
//   and its release being made current: "queues the current version's
//   writes after its scan instead of refusing them".
// - An invalid output is written, or papered over: "fails on an output
//   that doesn't fit, writing nothing of its batch".
// - A concurrent edit is lost to a transform of the record as it was:
//   "never overwrites an edit made while a batch was transformed".
// - A crash, a lost answer or a run moved past writes twice or skips:
//   "resumes from its receipt and cursor, transforming each record once".
// - One owner's records reach another's in one transform: "hands over one
//   owner's records a batch on an owner table".
// - What a transform threw reaches another App: "shows what a transform
//   threw only to its App and to admins".
// - A writer the migration left behind writes after it took over:
//   "queues the current version's writes after its scan …" (its last
//   writes).
// - An abandoned migration leaves records the contract doesn't describe,
//   or loses its reservations: "can be abandoned once failed".

const admin: Member = {
  userId: "grace",
  role: "admin",
  teams: [],
  staff: false,
};

/** A notes schema of `fields`, each person's own notes. */
const notes = (fields: ValueShape): string =>
  manifestText(
    schemaManifest(defineSchema({ notes: defineTable(fields) }), {
      tables: { notes: { read: "owner", write: "owner" } },
    })
  );

const title = v.string().min(1).max(200);
const v1 = notes({ title });
/** A category without a default, and a longer title: only a migration adds either. */
const v2 = notes({
  title: v.string().min(1).max(500),
  category: v.enum(["launch", "general"]),
});

/** The derivation the tests' transform makes. */
const derived = (fields: StoreFields): StoreFields => ({
  ...fields,
  category:
    typeof fields.title === "string" && fields.title.includes("launch")
      ? "launch"
      : "general",
});

/** A store holding `count` notes of each of `owners`, interleaved. */
const migratingStore = async (
  count: number,
  owners: readonly string[] = ["ada"]
) => {
  const app = appIdSchema.parse(crypto.randomUUID());
  const store = await newStore();
  const first = await store.defineTables(v1, {
    resourceId: app,
    resourceVersion: 1,
  });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    for (const owner of owners) {
      const id = newRecordId();
      ids.push(id);
      // One commit after the other, interleaving owners.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await commit(
        store,
        first.schemaHash,
        [
          {
            op: "insert",
            table: "notes",
            id,
            fields: { title: `Note ${index}` },
          },
        ],
        owner
      );
    }
  }
  const migration = {
    name: "derive-category",
    table: "notes",
    fromSchema: first.schemaHash,
    toSchema: await manifestHash(v2),
  };
  const second = await store.defineTables(
    v2,
    { resourceId: app, resourceVersion: 2 },
    [migration]
  );
  return {
    app,
    store,
    first,
    second,
    target: second.contract.hash,
    ids,
    migration,
  };
};

type Migrating = Awaited<ReturnType<typeof migratingStore>>;

/** Commits a migration's batch, as core does once it transformed it. */
const commitBatch = async (
  store: OpenStore,
  batch: TransformedBatch
): Promise<BackfillOutcome> =>
  await objectOf(store).commitTransformed(store.id, JSON.stringify(batch));

/**
 * Runs batches from `from` until the backfill stops running, transforming
 * each record with `transform`: every outcome, and every batch's owners.
 */
const migrateAll = async (
  { store, target }: Pick<Migrating, "store" | "target">,
  transform: (fields: StoreFields) => StoreFields = derived,
  { from = 1, attempt = 1 } = {}
) => {
  const outcomes: BackfillOutcome[] = [];
  const owners: string[][] = [];
  for (let batch = from; ; batch += 1) {
    // One batch after the other, as the backfill's run takes them.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const read = await migrationBatch(store, target, batch, attempt);
    if (read.state !== "transform") {
      outcomes.push(read);
      return { outcomes, owners };
    }
    owners.push([...new Set(read.rows.map(({ owner }) => owner))]);
    // oxlint-disable-next-line no-await-in-loop -- see above
    const outcome = await commitBatch(store, {
      target,
      attempt,
      batch,
      phase: read.phase,
      table: read.table,
      through: read.through,
      rows: read.rows.map(({ id, revision, fields }) => ({
        id,
        revision,
        fields: transform(fields),
      })),
    });
    outcomes.push(outcome);
    if (outcome.state !== "running") {
      return { outcomes, owners };
    }
  }
};

/** Activates the store's ready migration, as its release is made current. */
const activate = async ({ store, app }: Pick<Migrating, "store" | "app">) =>
  await objectOf(store).activateReady(store.id, await manifestHash(v2), {
    resourceId: app,
    resourceVersion: 2,
  });

const statusOf = async (store: OpenStore, schema: string, app?: string) =>
  await objectOf(store).schemaStatus(
    store.id,
    await manifestHash(schema),
    app === undefined ? undefined : { resourceId: app, resourceVersion: 2 }
  );

/** The notes' categories, and the revisions they are at. */
const categoriesOf = async (store: OpenStore) => {
  const records = await notesOf(store);
  return {
    categories: new Set(
      [...records.values()].map(({ fields }) => fields.category)
    ),
    revisions: new Set([...records.values()].map(({ revision }) => revision)),
  };
};

/** The `code` of what was thrown. */
const codeIn = (error: object): unknown => {
  const code: unknown = Reflect.get(error, "code");
  return code;
};

/** One note's fields and revision. */
const noteOf = async (store: OpenStore, id: string) => {
  const records = await notesOf(store);
  return records.get(id);
};

/** The `reason` of a refusal's details, if it has one. */
const reasonOf = (details: unknown): unknown =>
  typeof details === "object" && details !== null
    ? Reflect.get(details, "reason")
    : undefined;

/** How many records of `target` are queued as work. */
const workOf = async (store: OpenStore): Promise<number> =>
  await runInDurableObject(
    objectOf(store),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM sdk_migration_work"
        )
        .one().count
  );

describe("an explicit migration on a store", () => {
  it("refuses a migration that doesn't fit the store", async () => {
    const store = await newStore();
    const first = await store.defineTables(v1, {
      resourceId: "a",
      resourceVersion: 1,
    });
    const consumer = { resourceId: "a", resourceVersion: 2 };
    const toSchema = await manifestHash(v2);
    const migration = {
      name: "derive-category",
      table: "notes",
      fromSchema: first.schemaHash,
      toSchema,
    };
    const refused = async (migrations: (typeof migration)[], by = consumer) => {
      try {
        await store.defineTables(v2, by, migrations);
        return "ok";
      } catch (error) {
        return typeof error === "object" && error !== null
          ? {
              code: codeIn(error),
              reason: reasonOf(Reflect.get(error, "details")),
            }
          : error;
      }
    };

    expect({
      none: await refused([]),
      unknownSource: await refused([
        { ...migration, fromSchema: "e".repeat(64) },
      ]),
      wrongTarget: await refused([{ ...migration, toSchema: "e".repeat(64) }]),
      sharedTable: await refused([
        migration,
        { ...migration, name: "another" },
      ]),
      noConsumer: await codeOf(store.defineTables(v2, undefined, [migration])),
    }).toStrictEqual({
      none: { code: "migration.required", reason: undefined },
      unknownSource: { code: "migration.invalid", reason: "unknown_source" },
      wrongTarget: { code: "migration.invalid", reason: "wrong_target" },
      sharedTable: { code: "migration.invalid", reason: "shared_table" },
      noConsumer: "migration.invalid",
    });
  });

  it("keeps the contract until it is ready, then activates it as its release is made current", async () => {
    const migrating = await migratingStore(230);
    const { store, first, second, target } = migrating;

    const pending = {
      receipt: second.contract,
      contract: await contractHash(store),
      old: await statusOf(store, v1),
    };
    const { outcomes } = await migrateAll(migrating);
    const ready = {
      contract: await contractHash(store),
      status: await statusOf(store, v2),
      old: await statusOf(store, v1),
    };

    const activated = await activate(migrating);

    expect({
      pending,
      outcomes: outcomes.map(({ state, scanned, filled }) => ({
        state,
        scanned,
        filled,
      })),
      ready,
      activated,
      contract: await contractHash(store),
      notes: await categoriesOf(store),
    }).toMatchObject({
      pending: {
        receipt: { changed: true, pending: true },
        contract: first.contract.hash,
        old: { state: "active" },
      },
      outcomes: [
        { state: "running", scanned: 100, filled: 100 },
        { state: "running", scanned: 200, filled: 200 },
        { state: "running", scanned: 230, filled: 230 },
        { state: "ready", scanned: 230, filled: 230 },
      ],
      // Ready, the contract and the version still current stay as they were.
      ready: {
        contract: first.contract.hash,
        status: { state: "ready" },
        old: { state: "active" },
      },
      activated: { state: "active" },
      contract: target,
      notes: { categories: new Set(["general"]), revisions: new Set([2]) },
    });
  });

  it("queues the current version's writes after its scan instead of refusing them, ready again only once they're transformed", async () => {
    const migrating = await migratingStore(3);
    const { store, first, second } = migrating;
    const scanned = await migrateAll(migrating);
    const late = newRecordId();

    const write = await codeOf(
      commit(store, first.schemaHash, [
        {
          op: "insert",
          table: "notes",
          id: late,
          fields: { title: "Late launch" },
        },
      ])
    );
    const afterWrite = {
      status: await statusOf(store, v2),
      work: await workOf(store),
      // Asked to activate now, it finds the work and stays pending.
      activated: await activate(migrating),
      contract: await contractHash(store),
    };
    const rest = await migrateAll(migrating, derived, {
      from: (scanned.outcomes.at(-1)?.batch ?? 0) + 1,
    });
    const activated = await activate(migrating);

    expect({
      scanned: scanned.outcomes.at(-1)?.state,
      write,
      afterWrite,
      rest: rest.outcomes.map(({ state }) => state),
      activated,
      late: await noteOf(store, late),
      oldWrite: await codeOf(
        commit(store, first.schemaHash, [
          {
            op: "insert",
            table: "notes",
            id: newRecordId(),
            fields: { title: "Later" },
          },
        ])
      ),
      newWrite: await codeOf(
        commit(store, second.schemaHash, [
          {
            op: "insert",
            table: "notes",
            id: newRecordId(),
            fields: { title: "New", category: "launch" },
          },
        ])
      ),
    }).toMatchObject({
      scanned: "ready",
      write: "ok",
      afterWrite: {
        status: { state: "pending" },
        work: 1,
        activated: { state: "pending" },
        contract: first.contract.hash,
      },
      rest: ["running", "ready"],
      activated: { state: "active" },
      late: { fields: { title: "Late launch", category: "launch" } },
      // Once it took over, the schema it left behind writes no more.
      oldWrite: "migration.incompatible_write",
      newWrite: "ok",
    });
  });

  it("fails on an output that doesn't fit, writing nothing of its batch, and goes on once its record changed", async () => {
    const migrating = await migratingStore(5);
    const { store, first, target, ids } = migrating;
    const odd = ids[2] ?? "";
    const before = await notesOf(store);

    const failed = await migrateAll(migrating, (fields) =>
      fields.title === "Note 2"
        ? { ...derived(fields), title: "x".repeat(300) }
        : derived(fields)
    );

    expect({
      outcome: failed.outcomes.at(-1),
      unchanged: await notesOf(store),
      contract: await contractHash(store),
      // Nothing changed for the record: retrying leaves it failed.
      retried: await retry(store, target),
    }).toMatchObject({
      outcome: {
        state: "failed",
        failure: {
          table: "notes",
          id: odd,
          migration: "derive-category",
          reason: "outside_contract",
        },
      },
      unchanged: before,
      contract: first.contract.hash,
      retried: { state: "failed" },
    });

    await commit(store, first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: odd,
        fields: { title: "Fixed" },
        expectedRevision: 1,
      },
    ]);
    const retried = await retry(store, target);
    const done = await migrateAll(migrating, derived, { attempt: 2 });
    await activate(migrating);

    expect({
      retried,
      done: done.outcomes.at(-1),
      contract: await contractHash(store),
    }).toMatchObject({
      retried: { state: "running", attempt: 2 },
      done: { state: "ready" },
      contract: target,
    });
  });

  it("never overwrites an edit made while a batch was transformed, and transforms the edit before activating", async () => {
    const migrating = await migratingStore(3);
    const { store, first, target, ids } = migrating;
    const edited = ids[1] ?? "";
    const read = await migrationBatch(store, target, 1);
    if (read.state !== "transform") {
      throw new Error("Expected a batch to transform");
    }
    // Edited by the version still current, after the batch was read.
    await commit(store, first.schemaHash, [
      {
        op: "patch",
        table: "notes",
        id: edited,
        fields: { title: "launch day" },
        expectedRevision: 1,
      },
    ]);
    await commitBatch(store, {
      target,
      attempt: 1,
      batch: 1,
      phase: read.phase,
      table: read.table,
      through: read.through,
      rows: read.rows.map(({ id, revision, fields }) => ({
        id,
        revision,
        fields: derived(fields),
      })),
    });

    const afterBatch = {
      edited: await noteOf(store, edited),
      work: await workOf(store),
    };

    const rest = await migrateAll(migrating, derived, { from: 2 });
    const records = await notesOf(store);

    expect({
      afterBatch,
      states: rest.outcomes.map(({ state }) => state),
      edited: records.get(edited),
      work: await workOf(store),
    }).toStrictEqual({
      afterBatch: {
        edited: { fields: { title: "launch day" }, revision: 2 },
        work: 1,
      },
      states: ["running", "ready"],
      edited: {
        fields: { title: "launch day", category: "launch" },
        revision: 3,
      },
      work: 0,
    });
  });

  it("waits for work a concurrent write left before activating", async () => {
    const other = await migratingStore(2);
    const firstBatch = await migrationBatch(other.store, other.target, 1);
    if (firstBatch.state !== "transform") {
      throw new Error("Expected a batch to transform");
    }
    await commitBatch(other.store, {
      target: other.target,
      attempt: 1,
      batch: 1,
      phase: firstBatch.phase,
      table: firstBatch.table,
      through: firstBatch.through,
      rows: firstBatch.rows.map(({ id, revision, fields }) => ({
        id,
        revision,
        fields: derived(fields),
      })),
    });
    // The version still current inserts a note the target doesn't fit.
    const late = newRecordId();
    await commit(other.store, other.first.schemaHash, [
      {
        op: "insert",
        table: "notes",
        id: late,
        fields: { title: "Late launch" },
      },
    ]);
    // The scan is through, yet the next batch is that note, not activation.
    const next = await migrationBatch(other.store, other.target, 2);
    expect({
      work: await workOf(other.store),
      next,
      contract: await contractHash(other.store),
    }).toMatchObject({
      work: 1,
      next: { state: "transform", phase: "work", rows: [{ id: late }] },
      contract: other.first.contract.hash,
    });
    if (next.state !== "transform") {
      throw new Error("Expected a batch to transform");
    }
    await commitBatch(other.store, {
      target: other.target,
      attempt: 1,
      batch: 2,
      phase: "work",
      table: "notes",
      through: null,
      rows: next.rows.map(({ id, revision, fields }) => ({
        id,
        revision,
        fields: derived(fields),
      })),
    });
    const end = await migrationBatch(other.store, other.target, 3);
    const records = await notesOf(other.store);

    expect({ end, late: records.get(late)?.fields }).toMatchObject({
      end: { state: "ready" },
      late: { title: "Late launch", category: "launch" },
    });
  });

  it("resumes from its receipt and cursor, transforming each record once", async () => {
    const migrating = await migratingStore(150);
    const { store, target } = migrating;
    const read = await migrationBatch(store, target, 1);
    if (read.state !== "transform") {
      throw new Error("Expected a batch to transform");
    }
    const batch = (
      fields: (f: StoreFields) => StoreFields
    ): TransformedBatch => ({
      target,
      attempt: 1,
      batch: 1,
      phase: read.phase,
      table: read.table,
      through: read.through,
      rows: read.rows.map(({ id, revision, fields: f }) => ({
        id,
        revision,
        fields: fields(f),
      })),
    });
    const first = await commitBatch(store, batch(derived));
    // The answer was lost; the step retries, its transform answering
    // otherwise this time: answered from the receipt, nothing compared.
    const again = await commitBatch(
      store,
      batch((f) => ({ ...f, category: "launch" }))
    );
    const replayed = { again, notes: await categoriesOf(store) };

    // The run stops; a new one takes over once its lease ran out.
    await runInDurableObject(objectOf(store), (_instance, state) => {
      state.storage.sql.exec("UPDATE sdk_schema_backfills SET lease_until = 0");
    });
    const next = await objectOf(store).restartBackfill(store.id, {
      target,
      attempt: 1,
    });
    const stale = await codeOf(
      commitBatch(store, { ...batch(derived), batch: 2 })
    );

    const { outcomes } = await migrateAll(migrating, derived, { attempt: 2 });

    expect({
      replayed,
      next,
      stale,
      outcome: outcomes.at(-1),
      notes: await categoriesOf(store),
    }).toMatchObject({
      replayed: {
        again: first,
        notes: { categories: new Set(["general", undefined]) },
      },
      next: 2,
      stale: "migration.superseded",
      outcome: { state: "ready", scanned: 150, filled: 150 },
      notes: { categories: new Set(["general"]), revisions: new Set([2]) },
    });
  });

  it("hands over one owner's records a batch on an owner table", async () => {
    const migrating = await migratingStore(60, ["ada", "bo"]);

    const { outcomes, owners } = await migrateAll(migrating);

    expect(outcomes.at(-1)).toMatchObject({ state: "ready", filled: 120 });
    expect(owners.every((batch) => batch.length === 1)).toBeTruthy();
    expect(new Set(owners.flat())).toStrictEqual(new Set(["ada", "bo"]));
  });

  it("shows what a transform threw only to its App and to admins", async () => {
    const migrating = await migratingStore(2);
    const { app, store, target, ids } = migrating;
    const read = await migrationBatch(store, target, 1);
    if (read.state !== "transform") {
      throw new Error("Expected a batch to transform");
    }
    await commitBatch(store, {
      target,
      attempt: 1,
      batch: 1,
      phase: read.phase,
      table: read.table,
      through: read.through,
      rows: [],
      failure: {
        table: "notes",
        id: ids[0] ?? "",
        migration: "derive-category",
        reason: "threw",
        issues: ["Note 1 says: the launch is secret"],
      },
    });

    expect({
      own: await statusOf(store, v2, app),
      other: await statusOf(store, v2, "another-app"),
      admin: await storeBackfill(env, admin, store.id),
    }).toMatchObject({
      own: {
        state: "failed",
        failure: {
          reason: "threw",
          issues: ["Note 1 says: the launch is secret"],
        },
      },
      other: { state: "failed", failure: { reason: "threw", issues: [] } },
      admin: { failure: { issues: ["Note 1 says: the launch is secret"] } },
    });
  });

  it("can be abandoned once failed: the contract and the version still current stay, and its field is reserved", async () => {
    const migrating = await migratingStore(120);
    const { store, first, target } = migrating;
    const failed = await migrateAll(migrating, (fields) =>
      fields.title === "Note 110"
        ? { ...fields, category: "unknown" }
        : derived(fields)
    );
    expect(failed.outcomes.at(-1)?.state).toBe("failed");

    const abandoned = await abandonStoreBackfill(env, admin, {
      store: store.id,
      target,
      attempt: 1,
    });

    expect({
      reserved: abandoned.reserved,
      contract: await contractHash(store),
      work: await workOf(store),
      // The records the first batch transformed keep their category, which
      // the contract in force still reads; the version still current writes.
      notes: await categoriesOf(store),
      write: await codeOf(
        commit(store, first.schemaHash, [
          {
            op: "insert",
            table: "notes",
            id: newRecordId(),
            fields: { title: "Still" },
          },
        ])
      ),
      redefined: await codeOf(
        store.defineTables(notes({ title, category: v.string().optional() }), {
          resourceId: "later",
          resourceVersion: 1,
        })
      ),
    }).toMatchObject({
      reserved: [{ table: "notes", field: "category" }],
      contract: first.contract.hash,
      work: 0,
      notes: { categories: new Set(["general", undefined]) },
      write: "ok",
      redefined: "migration.required",
    });
  });
});
