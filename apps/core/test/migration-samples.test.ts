import type { AppId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { setCurrentVersion } from "../src/apps.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { sampleMigration } from "../src/migration-samples.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import { abandonStoreBackfill } from "../src/store-abandon.ts";
import { requireStoreSchemaActive } from "../src/store-backfill.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { deriving, migrated, notesOf, refusalOf } from "./migrated-apps.ts";
import { commit } from "./pending-stores.ts";
import { person } from "./sealed-apps.ts";
import { newRecordId } from "./store-schemas.ts";

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

/** Notes that may refer to another note: the schema `referencing` migrates to. */
const referencingSchema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().min(1).max(200),
  category: v.enum(["launch", "general"]),
  parent: v.id("notes").optional(),
};

export default defineSchema({ notes: defineTable(noteFields) });
`;

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

/** How many dry-run leases on `app` are held now. */
const leasesOf = async (app: string): Promise<unknown> => {
  const held = await env.DB.prepare(
    "SELECT count(*) AS count FROM migration_sample_leases WHERE app_id = ? AND until > ?"
  )
    .bind(app, Date.now())
    .first();
  return held?.count;
};

/** A lease `id` on `app`'s version 3 migration, granted now, held until `until`. */
const grant = async (app: string, id: string, until: number) => {
  await env.DB.prepare(
    "INSERT INTO migration_sample_leases (id, app_id, version, migration, granted_at, until) VALUES (?, ?, 3, 'derive-category', ?, ?)"
  )
    .bind(id, app, Date.now(), until)
    .run();
};

/** Points the store's pending change at `app`'s version `version`. */
const pendingFor = async (
  store: OpenStore,
  app: string,
  version: number
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_schema_backfills SET migrations = json_set(migrations, '$.consumer', json_array(?, ?)) WHERE state <> 'complete'",
        app,
        version
      );
    }
  );
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

/**
 * Puts the note titled `from` right as `to`, in place: its revision
 * stays, so the failed backfill isn't retried on it and only a sample
 * reads it.
 */
const renameNote = async (
  store: OpenStore,
  from: string,
  to: string
): Promise<void> => {
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sdk_records SET value_json = replace(value_json, ?, ?) WHERE instr(value_json, ?) > 0",
        JSON.stringify(from),
        JSON.stringify(to),
        JSON.stringify(from)
      );
    }
  );
};

/** The version current of `app`. */
const currentOf = async (app: string): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT current_version AS current FROM apps WHERE id = ?"
  )
    .bind(app)
    .first();
  return row?.current;
};

/** Where `app`'s version 3 stands in `store`. */
const stateOf = async (store: OpenStore, app: AppId): Promise<string> => {
  const release = await loadRelease(env, app, 3);
  const status = await env.DATA_STORES.getByName(store.id).schemaStatus(
    store.id,
    release.manifest.schemaHash,
    { resourceId: app, resourceVersion: 3 }
  );
  return status.state;
};

/**
 * Notes whose version 3 migrated three notes and is ready to take over,
 * with what the gate tests ask of it: a failed sample kept for it, and
 * making it current (through `db`).
 */
const readyMigration = async () => {
  const { fixture, store, release } = await migrated(3, deriving);
  // Transformed records keep their writer's schema hash: only the
  // migration's own progress says none is left.
  await vi.waitFor(
    async () => {
      await expect(stateOf(store, fixture.app)).resolves.toBe("ready");
    },
    { timeout: 120_000, interval: 500 }
  );
  const failedSample = async (): Promise<void> => {
    await env.DB.prepare(
      "INSERT INTO migration_samples (id, app_id, version, migration, store_id, outcome, rows, owners, reason, manifest_hash, from_schema, to_schema, sampled_by, sampled_at) VALUES (?, ?, 3, 'derive-category', ?, 'failed', 5, 1, 'threw', ?, ?, ?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        fixture.app,
        store.id,
        release.manifestHash,
        fixture.firstSchema,
        release.manifest.schemaHash,
        fixture.owner.userId,
        Date.now()
      )
      .run();
  };
  const madeCurrent = async (db = env.DB) =>
    await refusalOf(
      async () =>
        await setCurrentVersion(
          { ...env, DB: db },
          fixture.owner,
          fixture.app,
          3
        )
    );
  return {
    fixture,
    store,
    failedSample,
    madeCurrent,
    asked: { app: fixture.app, version: 3, migration: "derive-category" },
  };
};

/**
 * The D1 database, running `first` once just before the first statement
 * matching `reads` runs: something landing between two of the reads an
 * activation makes.
 */
const racingRead = (
  first: () => Promise<unknown>,
  reads: RegExp
): D1Database => {
  let raced = false;
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...values: unknown[]) => racing(target.bind(...values));
        }
        return async (...args: unknown[]): Promise<unknown> => {
          if (!raced) {
            raced = true;
            await first();
          }
          return await Reflect.apply(value, target, args);
        };
      },
    });
  return new Proxy(env.DB, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return raced || !reads.test(query) ? statement : racing(statement);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
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
        await grant(fixture.app, "held", Date.now() + 60_000);
        return await taken(admin, asked);
      })(),
      // One whose lease ran out holds nothing.
      expired: await (async () => {
        await env.DB.prepare(
          "UPDATE migration_sample_leases SET until = ? WHERE id = 'held'"
        )
          .bind(Date.now() - 1)
          .run();
        return await taken(admin, asked);
      })(),
      // Five granted in the last minute, whatever became of them: the
      // next waits.
      sixth: await (async () => {
        await grant(fixture.app, "ended-1", Date.now() - 1);
        await grant(fixture.app, "ended-2", Date.now() - 1);
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

  it("lets go of its lease however it ends, grants it to one at a time, and samples only its own live change", async () => {
    const { fixture, store } = await migrated(5, failingOnNote4, {
      fixtures: '[{ row: { title: "Note" } }]',
    });
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
    const admin = await person("admin");
    const asked = {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    };
    // Another version's change pending on the store: nothing of this
    // one's to sample, and no receipt saying so.
    await pendingFor(store, fixture.app, 4);
    const elsewhere = await taken(admin, asked);
    await pendingFor(store, fixture.app, 3);
    // No sandbox to run it in: refused, the lease let go.
    const unavailable = await sampleMigration(
      {
        ...env,
        RUNTIME_PROFILE: "workerd",
        SANDBOX_HOST: undefined,
        SANDBOX_IN_PROCESS: undefined,
      },
      admin,
      asked
    ).then(
      () => "ok",
      (error: unknown) => error instanceof SandboxUnavailableError
    );
    const heldAfterUnavailable = await leasesOf(fixture.app);
    // Two at once: one runs, the other waits.
    const both = await Promise.all([taken(admin, asked), taken(admin, asked)]);
    // Abandoned by an admin: nothing is left to read, but nothing was
    // transformed either, so no receipt says "nothing left".
    const failedBackfill = await env.DATA_STORES.getByName(
      store.id
    ).backfillStatus(store.id);
    await abandonStoreBackfill(env, admin, {
      store: store.id,
      target: failedBackfill?.target,
      attempt: failedBackfill?.attempt,
    });
    const abandoned = await taken(admin, asked);
    const receipts = await receiptsOf(fixture.app);
    expect({
      elsewhere,
      unavailable,
      heldAfterUnavailable,
      both: both.map(String).toSorted((a, b) => a.localeCompare(b)),
      abandoned,
      receipts: receipts.map(({ outcome }) => outcome),
      held: await leasesOf(fixture.app),
    }).toStrictEqual({
      elsewhere: "migration.not_pending",
      unavailable: true,
      heldAfterUnavailable: 0,
      both: ["migration.sample_busy", "ok"],
      abandoned: "migration.abandoned",
      receipts: ["failed"],
      held: 0,
    });
  });

  it("fails a sample whose output the backfill would refuse, as it would", async () => {
    // The target lets a note refer to another; the transform points every
    // note at one, which the backfill refuses: a migration doesn't change
    // a field that refers to records.
    const pointed = newRecordId();
    const { fixture } = await migrated(
      2,
      `(ctx, row) => ({ ...row, category: "general", parent: ${JSON.stringify(pointed)} as never })`,
      {
        fixtures: '[{ row: { title: "Note" } }]',
        start: referencingSchema.replace(
          '  category: v.enum(["launch", "general"]),\n',
          ""
        ),
        next: referencingSchema,
      }
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
      reason: sample.failure?.reason,
      record: typeof sample.failure?.record,
      receipts: receipts.map(({ outcome, reason }) => [outcome, reason]),
    }).toStrictEqual({
      outcome: "failed",
      reason: "reference_changed",
      record: "string",
      receipts: [["failed", "reference_changed"]],
    });
  });

  it("keeps its version from being made current while its latest sample failed", async () => {
    const { fixture, store } = await migrated(5, failingOnNote4, {
      fixtures: '[{ row: { title: "Note" } }]',
    });
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
    const admin = await person("admin");
    const asked = {
      app: fixture.app,
      version: 3,
      migration: "derive-category",
    };
    const madeCurrent = async () =>
      await refusalOf(
        async () => await setCurrentVersion(env, fixture.owner, fixture.app, 3)
      );

    await sampleMigration(env, admin, asked);
    const afterFailed = await madeCurrent();
    // Three passing don't vouch for the five that failed.
    const smaller = await sampleMigration(env, admin, { ...asked, rows: 3 });
    const afterSmaller = await madeCurrent();
    // Note 4 put right, five pass: the store's own gate is next.
    await renameNote(store, marker, "Note four");
    const same = await sampleMigration(env, admin, asked);
    const afterSame = await madeCurrent();
    // Failing again stands over the passes before it.
    await renameNote(store, "Note four", marker);
    await sampleMigration(env, admin, asked);
    const afterAgain = await madeCurrent();

    expect({
      afterFailed,
      smaller: [smaller.outcome, smaller.rows],
      afterSmaller: afterSmaller.code,
      same: [same.outcome, same.rows],
      afterSame: afterSame.code,
      afterAgain: afterAgain.code,
    }).toStrictEqual({
      afterFailed: {
        code: "version.migration_sample_failed",
        details: { migration: "derive-category", reason: "threw" },
      },
      smaller: ["passed", 3],
      afterSmaller: "version.migration_sample_failed",
      same: ["passed", 5],
      afterSame: "migration.backfill_failed",
      afterAgain: "version.migration_sample_failed",
    });
  });

  it("finds nothing to sample once its migration transformed every record", async () => {
    const { fixture, store, failedSample, madeCurrent, asked } =
      await readyMigration();
    await failedSample();
    const beforeEmpty = await madeCurrent();
    const admin = await person("admin");
    const sample = await sampleMigration(env, admin, asked);
    // The store switched over already, as a batch that kept failing
    // leaves it; failing again between the check and the change: refused
    // by the change.
    await requireStoreSchemaActive(env, fixture.app, 3, { activate: true });
    const raced = await madeCurrent(racingDb(failedSample, /update "apps"/iu));
    await sampleMigration(env, admin, asked);
    const receipts = await receiptsOf(fixture.app);
    const afterEmpty = await madeCurrent();
    expect({
      outcome: sample.outcome,
      rows: sample.rows,
      failure: sample.failure,
      receipts: receipts.map(({ outcome }) => outcome),
      beforeEmpty: beforeEmpty.code,
      raced: raced.code,
      // Nothing left to transform: every record it wrote was validated,
      // so the earlier failure has nothing left to show.
      afterEmpty: afterEmpty.code,
      current: await currentOf(fixture.app),
      store: await stateOf(store, fixture.app),
    }).toStrictEqual({
      outcome: "empty",
      rows: 0,
      failure: null,
      receipts: ["failed", "empty", "failed", "empty"],
      beforeEmpty: "version.migration_sample_failed",
      raced: "version.migration_sample_failed",
      afterEmpty: "ok",
      current: 3,
      store: "active",
    });
  });

  it("switches only a store with nothing left to sample", async () => {
    const { fixture, store, asked } = await readyMigration();
    const admin = await person("admin");
    const ready = await sampleMigration(env, admin, asked);
    // The version still current writes a note the migration has to
    // transform: work again, so the store isn't ready to switch, and a
    // sample has something to read.
    await commit(
      store,
      fixture.firstSchema,
      [
        {
          op: "insert",
          table: "notes",
          id: newRecordId(),
          fields: { title: "Note late" },
        },
      ],
      fixture.owner.userId
    );
    const switching = await refusalOf(async () => {
      await requireStoreSchemaActive(env, fixture.app, 3, { activate: true });
    });
    const queued = await sampleMigration(env, admin, asked);
    expect({
      ready: [ready.outcome, ready.rows],
      switching: switching.code,
      queued: [queued.outcome, queued.rows],
    }).toStrictEqual({
      ready: ["empty", 0],
      switching: "migration.pending",
      queued: ["passed", 1],
    });
  });

  it("decides on a failed sample as the store switches, before it and never after", async () => {
    const { fixture, store, failedSample, madeCurrent } =
      await readyMigration();
    // Failing as the store switches over comes too late, as failing once
    // the version is current would: refusing it then would only lock the
    // version still current out of its superseded schema.
    const raced = await madeCurrent(racingDb(failedSample, /update "apps"/iu));
    expect({
      raced: raced.code,
      current: await currentOf(fixture.app),
      store: await stateOf(store, fixture.app),
    }).toStrictEqual({ raced: "ok", current: 3, store: "active" });

    // Failing after the first look but before the switch: refused, and
    // the store stays as it was.
    const other = await readyMigration();
    const early = await other.madeCurrent(
      racingRead(
        other.failedSample,
        /"schema_hash" from "sdk_resource_bindings"/u
      )
    );
    expect({
      early: early.code,
      current: await currentOf(other.fixture.app),
      store: await stateOf(other.store, other.fixture.app),
    }).toStrictEqual({
      early: "version.migration_sample_failed",
      current: null,
      store: "ready",
    });
  });
});
