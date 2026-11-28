import { manifestKey } from "@grasp-os/shared/release";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  leases,
  releaseImportFailures,
  releaseImportProgress,
  releases,
} from "../src/db/schema.ts";
import worker from "../src/server.ts";
import { nextReleaseId, publishRelease } from "./releases.ts";

// What starts an import, as the admin runs it (src/server.ts): its cron
// every minute, the rest of its tick every fifth, and R2's word of a new
// manifest on its queue; one import at a time.

const db = adminDatabase(env.DB);

/**
 * `env` with its database keeping the SQL of each statement prepared on
 * it: what tells which of the tick's jobs ran.
 */
const recording = () => {
  const statements: string[] = [];
  const DB = new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { env: { ...env, DB }, statements };
};

/** Which of the tick's jobs `statements` show ran, by the first thing each reads. */
const jobsIn = (statements: readonly string[]) => ({
  // Records the blobs of kept releases not yet on record, first.
  retention: statements.some((query) => query.includes('"release_blobs"')),
  // The rollout pass: reads the channels' releases once it holds its lease.
  pass: statements.filter(
    (query) => query === 'select "id", "release_id" from "channels"'
  ).length,
  // Reads the clients still being provisioned.
  provisioning: statements.some(
    (query) =>
      query === 'select "id" from "clients" where "clients"."status" = ?'
  ),
});

/** The admin's every-minute cron, at minute `minute` of an hour: every fifth its tick. */
const cronAt = (minute: number) =>
  createScheduledController({
    cron: "* * * * *",
    scheduledTime: Date.UTC(2026, 10, 27, 12, minute),
  });

/** What R2 says on the admin's queue when `key` is written. */
const written = (key: string) =>
  createMessageBatch("grasp-release-manifests", [
    {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body: {
        account: "account",
        action: "PutObject",
        bucket: "grasp-releases",
        object: { key, size: 1, eTag: "etag" },
        eventTime: new Date().toISOString(),
      },
    },
  ]);

const eventsFor = async (action: string, id: string) =>
  await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.target, id)));

/** What an import of release `id` left: its row, its events, and anything of its attempts. */
const traceOf = async (id: string) => {
  const [saved, imports, promotions, failedEvents, failureRows, progressRows] =
    await Promise.all([
      db.select().from(releases).where(eq(releases.id, id)),
      eventsFor("release.import", id),
      eventsFor("channel.promote", id),
      eventsFor("release.import_failed", id),
      db
        .select()
        .from(releaseImportFailures)
        .where(eq(releaseImportFailures.releaseId, id)),
      db
        .select()
        .from(releaseImportProgress)
        .where(eq(releaseImportProgress.releaseId, id)),
    ]);
  return {
    saved: saved.length,
    imports: imports.length,
    promotions: promotions.length,
    failedEvents: failedEvents.length,
    failureRows: failureRows.length,
    progressRows: progressRows.length,
  };
};

/** Keeps the failures the admin logs out of the test output. */
const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Logged; the tests read the state instead.
  });
  try {
    return await run();
  } finally {
    errors.mockRestore();
  }
};

describe("what starts an import", () => {
  it("runs the rollout pass every minute, and retention and provisioning on the fifth minute only", async () => {
    const between = recording();
    await quietly(async () => {
      await worker.scheduled(cronAt(1), between.env);
    });
    const onTick = recording();
    await quietly(async () => {
      await worker.scheduled(cronAt(5), onTick.env);
    });

    expect({
      between: jobsIn(between.statements),
      onTick: jobsIn(onTick.statements),
    }).toStrictEqual({
      between: { retention: false, pass: 1, provisioning: false },
      onTick: { retention: true, pass: 1, provisioning: true },
    });
  });

  it("imports nothing, and runs no retention, while another run holds the import, and takes over a hold that expired", async () => {
    const release = await publishRelease({ notes: "feat(core): held" });
    const holdUntil = async (expiresAt: Date) => {
      await db
        .insert(leases)
        .values({ id: "releases", holder: "another run", expiresAt })
        .onConflictDoUpdate({ target: leases.id, set: { expiresAt } });
    };

    await holdUntil(new Date(Date.now() + 60_000));
    const held = recording();
    await quietly(async () => {
      await worker.scheduled(cronAt(5), held.env);
      await worker.queue(written(manifestKey(release.id)), held.env);
    });
    const whileHeld = await traceOf(release.id);
    // A run that died holding it, its hold expired.
    await holdUntil(new Date(Date.now() - 1000));
    await quietly(async () => {
      await worker.scheduled(cronAt(1), env);
    });
    const afterExpiry = await traceOf(release.id);

    expect({
      whileHeld: whileHeld.saved,
      jobs: jobsIn(held.statements),
      afterExpiry: afterExpiry.saved,
    }).toStrictEqual({
      whileHeld: 0,
      // The rest of the tick runs all the same.
      jobs: { retention: false, pass: 1, provisioning: true },
      afterExpiry: 1,
    });
  });

  it("imports, promotes and deploys a release once when R2's word and two cron runs come at once", async () => {
    const release = await publishRelease({ notes: "feat(core): at once" });
    const { env: recorded, statements } = recording();

    await quietly(async () => {
      await Promise.all([
        worker.queue(written(manifestKey(release.id)), recorded),
        worker.scheduled(cronAt(1), recorded),
        worker.scheduled(cronAt(1), recorded),
      ]);
    });

    expect({
      ...(await traceOf(release.id)),
      // However many of them got the pass's lease, one at a time.
      passed: jobsIn(statements).pass > 0,
    }).toStrictEqual({
      saved: 1,
      imports: 1,
      promotions: 1,
      failedEvents: 0,
      failureRows: 0,
      progressRows: 0,
      passed: true,
    });
  });

  it("imports and promotes a release once when R2's word comes beside the tick", async () => {
    const release = await publishRelease({ notes: "feat(core): beside" });

    await quietly(async () => {
      await Promise.all([
        worker.queue(written(manifestKey(release.id)), env),
        worker.scheduled(cronAt(5), env),
      ]);
    });

    await expect(traceOf(release.id)).resolves.toStrictEqual({
      saved: 1,
      imports: 1,
      promotions: 1,
      failedEvents: 0,
      failureRows: 0,
      progressRows: 0,
    });
  });

  it("imports what the bucket holds when R2 says a manifest was written, whatever its message names", async () => {
    const release = await publishRelease({ notes: "feat(core): told" });
    const unpublished = nextReleaseId();
    const batch = written(manifestKey(unpublished));

    await quietly(async () => {
      await worker.queue(batch, env);
    });
    const { outcome, retryBatch } = await getQueueResult(
      batch,
      createExecutionContext()
    );

    const [published, named] = await Promise.all([
      traceOf(release.id),
      traceOf(unpublished),
    ]);

    expect({
      imported: published.saved,
      named: named.saved,
      // Acknowledged: nothing of it is retried.
      outcome,
      retried: retryBatch.retry,
    }).toStrictEqual({ imported: 1, named: 0, outcome: "ok", retried: false });
  });
});
