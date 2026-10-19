import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { OpenStore } from "../src/data-stores.ts";
import { sampleMigration } from "../src/migration-samples.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { allEvents } from "./audit-events.ts";
import { deriving, migrated, notesOf, refusalOf } from "./migrated-apps.ts";
import { person } from "./sealed-apps.ts";

// An explicit migration's dry run on a sample of real records (GRA-545,
// migration-samples.ts), from its threat model: someone other than an
// admin takes one; a record's values reach the receipt, the audit log,
// the logs or an admin who doesn't own it; the sample writes or moves
// anything, at any point of the backfill; samples pile up; it samples
// records the migration won't transform. Real seal, store, sandbox and
// engine.

/** A transform that throws on "Note 4", naming the record's title. */
const failingOnNote4 = `(ctx, row) => {
  if (row.title === "Note 4") throw new Error("No category for " + row.title);
  return { ...row, category: "general" };
}`;

/** The value only the admin's answer may carry. */
const marker = "Note 4";

/** The receipts kept for `app`'s version 3, oldest first. */
const receiptsOf = async (app: string) => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM migration_samples WHERE app_id = ? AND version = 3 ORDER BY rowid"
  )
    .bind(app)
    .all();
  return results;
};

/** How many dry-run leases `app` holds. */
const leasesOf = async (app: string): Promise<unknown> => {
  const held = await env.DB.prepare(
    "SELECT count(*) AS count FROM migration_sample_leases WHERE app_id = ?"
  )
    .bind(app)
    .first();
  return held?.count;
};

/** Every console channel a Worker's logs go out on, spied on. */
const consoleSpies = () =>
  (["info", "log", "warn", "error"] as const).map((channel) =>
    vi.spyOn(console, channel)
  );

/** The store's backfill and the work it queued, as stored. */
const backfillOf = async (store: OpenStore) =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => ({
      backfills: state.storage.sql
        .exec("SELECT * FROM sdk_schema_backfills")
        .toArray(),
      work: state.storage.sql
        .exec("SELECT * FROM sdk_migration_work ORDER BY record_id")
        .toArray(),
    })
  );

/**
 * Puts the store's stopped backfill where a running one would be: in
 * `scan`, its cursor on the first note it reads, or in `work`, past its
 * scan with every note queued.
 */
const placeBackfill = async (
  store: OpenStore,
  phase: "scan" | "work"
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      const { sql } = state.storage;
      const notes = sql
        .exec<{
          table_id: string;
          record_id: string;
          owner_id: string;
          created_at: number;
        }>(
          "SELECT table_id, record_id, owner_id, created_at FROM sdk_records ORDER BY owner_id, created_at, record_id"
        )
        .toArray();
      const [first] = notes;
      if (first === undefined) {
        throw new Error("No note to place the backfill at");
      }
      if (phase === "scan") {
        sql.exec(
          "UPDATE sdk_schema_backfills SET phase = 'scan', cursor_table = ?, cursor_owner = ?, cursor_created_at = ?, cursor_record = ?",
          first.table_id,
          first.owner_id,
          first.created_at,
          first.record_id
        );
        return;
      }
      sql.exec(
        "UPDATE sdk_schema_backfills SET phase = 'work', cursor_table = NULL, cursor_owner = NULL, cursor_created_at = NULL, cursor_record = NULL"
      );
      for (const note of notes) {
        sql.exec(
          "INSERT INTO sdk_migration_work (target_hash, table_id, record_id, owner_id, queued_at) SELECT target_hash, ?, ?, ?, ? FROM sdk_schema_backfills",
          note.table_id,
          note.record_id,
          note.owner_id,
          Date.now()
        );
      }
    }
  );
};

/** What `by` asking to sample `input` came to: "ok" or its refusal's code. */
const taken = async (
  by: Parameters<typeof sampleMigration>[1],
  input: Record<string, unknown>
): Promise<unknown> => {
  const refused = await refusalOf(
    async () => await sampleMigration(env, by, input)
  );
  return refused.code;
};

describe("a migration's dry run on a sample", { timeout: 180_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is taken by the organization's admins only, of a migration the version declares", async () => {
    const { fixture } = await migrated(0, deriving);
    const [user, staffAdmin, admin] = await Promise.all([
      person("user"),
      person("admin"),
      person("admin"),
    ]);
    const asked = {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    };
    expect({
      builder: await taken(fixture.owner, asked),
      user: await taken(user, asked),
      staff: await taken({ ...staffAdmin, staff: true }, asked),
      undeclared: await taken(admin, { ...asked, migration: "rename-notes" }),
      tooMany: await taken(admin, { ...asked, rows: 101 }),
      admin: await taken(admin, asked),
      // Another dry run of it in flight holds its lease.
      held: await (async () => {
        await env.DB.prepare(
          "INSERT INTO migration_sample_leases (app_id, version, migration, token, until) VALUES (?, 3, 'derive-category', 'held', ?)"
        )
          .bind(fixture.app, Date.now() + 60_000)
          .run();
        return await taken(admin, asked);
      })(),
      // One whose lease ran out holds nothing.
      expired: await (async () => {
        await env.DB.prepare(
          "UPDATE migration_sample_leases SET until = ? WHERE app_id = ?"
        )
          .bind(Date.now() - 1, fixture.app)
          .run();
        return await taken(admin, asked);
      })(),
      // Five in the last minute: the next waits.
      sixth: await (async () => {
        await env.DB.batch(
          [1, 2, 3].map(() =>
            env.DB.prepare(
              "INSERT INTO migration_samples (id, app_id, version, migration, store_id, outcome, rows, owners, reason, manifest_hash, from_schema, to_schema, sampled_by, sampled_at) SELECT ?, app_id, version, migration, store_id, outcome, rows, owners, reason, manifest_hash, from_schema, to_schema, sampled_by, sampled_at FROM migration_samples WHERE app_id = ? LIMIT 1"
            ).bind(crypto.randomUUID(), fixture.app)
          )
        );
        return await taken(admin, asked);
      })(),
      leases: await leasesOf(fixture.app),
    }).toStrictEqual({
      builder: "role.forbidden",
      user: "role.forbidden",
      staff: "role.forbidden",
      undeclared: "migration.not_declared",
      tooMany: "data.invalid",
      admin: "ok",
      held: "migration.sample_busy",
      expired: "ok",
      sixth: "migration.sample_busy",
      // Each dry run let go of its lease as it ended.
      leases: 0,
    });
  });

  it("passes or fails on real records, keeping counts and codes only, and moves nothing", async () => {
    // The notes are an admin's, on a table read and written by owner.
    const owner = await person("admin");
    const { fixture, store } = await migrated(5, failingOnNote4, {
      fixtures: '[{ row: { title: "Note" } }]',
      owner,
    });
    // The backfill fails on Note 4 and writes nothing: the records stay
    // under the schema the migration transforms from.
    await vi.waitFor(
      async () => {
        await expect(
          refusalOf(async () => {
            await requireStoreSchemaActive(env, fixture.app, 3);
          })
        ).resolves.toMatchObject({ code: "migration.backfill_failed" });
      },
      { timeout: 120_000, interval: 500 }
    );
    const object = env.DATA_STORES.getByName(store.id);
    const before = {
      notes: await notesOf(store),
      backfill: await object.backfillStatus(store.id),
      stored: await backfillOf(store),
    };
    const logged = consoleSpies();
    const admin = await person("admin");
    const asked = {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    };

    // The first three notes (launch 0, Note 1, Note 2), then all five, for
    // an admin who doesn't own them and for the one who does.
    const passed = await sampleMigration(env, admin, { ...asked, rows: 3 });
    const failed = await sampleMigration(env, admin, asked);
    const failedForOwner = await sampleMigration(env, owner, asked);
    const receipts = await receiptsOf(fixture.app);
    const logEvents = await allEvents();
    const events = logEvents.filter(
      ({ action, detail }) =>
        action === "store.migration_sampled" && detail.app === fixture.app
    );

    expect({
      passed: {
        outcome: passed.outcome,
        rows: passed.rows,
        owners: passed.owners,
        failure: passed.failure,
      },
      failed: {
        outcome: failed.outcome,
        rows: failed.rows,
        reason: failed.failure?.reason,
        record: typeof failed.failure?.record,
        issues: failed.failure?.issues,
      },
      failedForOwner: {
        record: failedForOwner.failure?.record,
        reason: failedForOwner.failure?.reason,
        issues: failedForOwner.failure?.issues,
      },
      receipts: receipts.map(({ outcome, rows, owners, reason }) => ({
        outcome,
        rows,
        owners,
        reason,
      })),
      events: events.map(({ detail }) => detail.outcome),
    }).toStrictEqual({
      passed: { outcome: "passed", rows: 3, owners: 1, failure: null },
      failed: {
        outcome: "failed",
        rows: 5,
        reason: "threw",
        record: "string",
        // A thrown message can carry the record's values: its owner's.
        issues: [],
      },
      failedForOwner: {
        record: failed.failure?.record,
        reason: "threw",
        issues: [`No category for ${marker}`],
      },
      receipts: [
        { outcome: "passed", rows: 3, owners: 1, reason: null },
        { outcome: "failed", rows: 5, owners: 1, reason: "threw" },
        { outcome: "failed", rows: 5, owners: 1, reason: "threw" },
      ],
      events: ["passed", "failed", "failed"],
    });
    // A record's values are in its owner's answer alone.
    const kept = JSON.stringify({
      receipts,
      events,
      logs: logged.map(({ mock }) => mock.calls),
    });
    expect({
      marker: kept.includes(marker),
      record: kept.includes(failed.failure?.record ?? "-"),
      toOtherAdmin: JSON.stringify(failed).includes(marker),
    }).toStrictEqual({ marker: false, record: false, toOtherAdmin: false });
    // Nothing moved: the records, their revisions and the backfill.
    expect({
      notes: await notesOf(store),
      backfill: await object.backfillStatus(store.id),
      stored: await backfillOf(store),
    }).toStrictEqual(before);

    // Mid-scan, the notes after its cursor; past it, the queued work. Its
    // cursor and its queue stay as they were.
    await placeBackfill(store, "scan");
    const scanning = await backfillOf(store);
    const midScan = await sampleMigration(env, admin, asked);
    const afterScan = await backfillOf(store);
    await placeBackfill(store, "work");
    const working = await backfillOf(store);
    const inWork = await sampleMigration(env, admin, asked);
    expect({
      midScan: [midScan.outcome, midScan.rows],
      inWork: [inWork.outcome, inWork.rows],
      queued: working.work.length,
      scan: afterScan,
      work: await backfillOf(store),
      notes: await notesOf(store),
    }).toStrictEqual({
      midScan: ["failed", 4],
      inWork: ["failed", 5],
      queued: 5,
      scan: scanning,
      work: working,
      notes: before.notes,
    });
  });

  it("finds nothing to sample once its migration transformed every record", async () => {
    const { fixture, store, release } = await migrated(3, deriving);
    // Transformed records keep their writer's schema hash: only the
    // migration's own progress says none is left.
    await vi.waitFor(
      async () => {
        await expect(
          env.DATA_STORES.getByName(store.id).schemaStatus(
            store.id,
            release.manifest.schemaHash,
            { resourceId: fixture.app, resourceVersion: 3 }
          )
        ).resolves.toMatchObject({ state: "ready" });
      },
      { timeout: 120_000, interval: 500 }
    );
    const admin = await person("admin");
    const sample = await sampleMigration(env, admin, {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    });
    const receipts = await receiptsOf(fixture.app);
    expect({
      outcome: sample.outcome,
      rows: sample.rows,
      failure: sample.failure,
      receipts: receipts.map(({ outcome }) => outcome),
    }).toStrictEqual({
      outcome: "empty",
      rows: 0,
      failure: null,
      receipts: ["empty"],
    });
  });
});
