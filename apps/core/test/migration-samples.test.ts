import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { sampleMigration } from "../src/migration-samples.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { allEvents } from "./audit-events.ts";
import { deriving, migrated, notesOf, refusalOf } from "./migrated-apps.ts";
import { person } from "./sealed-apps.ts";

// An explicit migration's dry run on a sample of real records (GRA-545,
// migration-samples.ts), from its threat model: someone other than an
// admin takes one; a record's values reach the receipt, the audit log or
// the logs; the sample writes or moves anything; it samples records the
// migration won't transform. Real seal, store, sandbox and engine.

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
    "SELECT * FROM migration_samples WHERE app_id = ? AND version = 3 ORDER BY sampled_at, rowid"
  )
    .bind(app)
    .all();
  return results;
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
    }).toStrictEqual({
      builder: "role.forbidden",
      user: "role.forbidden",
      staff: "role.forbidden",
      undeclared: "migration.not_declared",
      tooMany: "data.invalid",
      admin: "ok",
    });
  });

  it("passes or fails on real records, keeping counts and codes only, and moves nothing", async () => {
    const { fixture, store } = await migrated(5, failingOnNote4, {
      fixtures: '[{ row: { title: "Note" } }]',
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
    };
    const logged = vi.spyOn(console, "info");
    const admin = await person("admin");
    const asked = {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    };

    // The first three notes (launch 0, Note 1, Note 2), then all five.
    const passed = await sampleMigration(env, admin, { ...asked, rows: 3 });
    const failed = await sampleMigration(env, admin, asked);
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
        issues: [`No category for ${marker}`],
      },
      receipts: [
        { outcome: "passed", rows: 3, owners: 1, reason: null },
        { outcome: "failed", rows: 5, owners: 1, reason: "threw" },
      ],
      events: ["passed", "failed"],
    });
    // A record's values are in the admin's answer alone.
    const kept = JSON.stringify({
      receipts,
      events,
      logs: logged.mock.calls,
    });
    expect({
      marker: kept.includes(marker),
      record: kept.includes(failed.failure?.record ?? "-"),
    }).toStrictEqual({ marker: false, record: false });
    // Nothing moved: the records, their revisions and the backfill.
    expect({
      notes: await notesOf(store),
      backfill: await object.backfillStatus(store.id),
    }).toStrictEqual(before);
  });

  it("finds nothing to sample once no record is left under the schema it transforms", async () => {
    const { fixture } = await migrated(0, deriving);
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
