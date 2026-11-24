import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditEventTypeOf } from "@grasp-os/shared/audit-log";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { recordPlatformUpdate } from "../src/platform-updates.ts";
import { allEvents } from "./audit-events.ts";
import { runMinuteTasks } from "./maintenance.ts";

// Platform updates: the clock records, every minute, each version of core it
// hasn't seen running as `platform.updated`, with the change the admin
// set on it, once per version ever, however many clock runs see it and
// however often versions alternate.

/** A version's metadata as the binding gives it, with an ID of its own. */
const newVersion = (): WorkerVersionMetadata => ({
  id: crypto.randomUUID(),
  tag: "",
  timestamp: "2031-01-02T03:04:05.000Z",
});

const change: PlatformChange = {
  by: "staff@grasp.test",
  what: "release",
  release: "26.01.123",
  at: "2031-01-02T03:04:00.000Z",
};

/**
 * Core's database, with `first` run just before each batch lands: another
 * clock run's write landing between this run's start and its batch.
 */
const racingDb = (first: (db: D1Database) => unknown): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await Promise.resolve(first(target));
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** One structured log line, by its event name. */
const logSchema = z.looseObject({ event: z.string() });

/** The `platform.updated` events recorded for `version`, oldest first. */
const updatesOf = async ({
  id,
}: WorkerVersionMetadata): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === "platform.updated" && event.target?.id === id
  );
};

describe("platform updates", () => {
  it("are recorded once per new version, with the change that made it", async () => {
    const version = newVersion();
    await runMinuteTasks({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: change,
    });
    await runMinuteTasks({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: change,
    });

    const updates = await updatesOf(version);
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update?.actor).toStrictEqual({ type: "system" });
    expect(update?.target).toStrictEqual({ type: "version", id: version.id });
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: change.by,
      what: change.what,
      release: change.release,
      changedAt: change.at,
    });
    expect(update && auditEventTypeOf(update)).toBe("platform_update");
  });

  it("take the change from a var set as text, as local dev sets it", async () => {
    const version = newVersion();
    await runMinuteTasks({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: JSON.stringify(change),
    });

    const [update] = await updatesOf(version);
    expect(update?.detail).toMatchObject({ by: change.by });
  });

  it.each([
    ["missing", undefined],
    ["invalid", { ...change, at: "yesterday" }],
  ])("name an unknown change when the var is %s", async (_case, value) => {
    const version = newVersion();
    await runMinuteTasks({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: value,
    });

    const [update] = await updatesOf(version);
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: "unknown",
      what: "unknown",
      release: "unknown",
      changedAt: null,
    });
  });

  it("are recorded once per version while two versions alternate, as in a gradual rollout", async () => {
    const earlier = newVersion();
    const later = newVersion();
    await runMinuteTasks({ CF_VERSION_METADATA: earlier });
    await runMinuteTasks({ CF_VERSION_METADATA: later });
    await runMinuteTasks({ CF_VERSION_METADATA: earlier });
    await runMinuteTasks({ CF_VERSION_METADATA: later });

    await expect(updatesOf(earlier)).resolves.toHaveLength(1);
    await expect(updatesOf(later)).resolves.toHaveLength(1);

    const next = newVersion();
    await runMinuteTasks({ CF_VERSION_METADATA: next });
    await runMinuteTasks({ CF_VERSION_METADATA: next });
    await runMinuteTasks({ CF_VERSION_METADATA: earlier });

    await expect(updatesOf(next)).resolves.toHaveLength(1);
    // A rollback to a version already recorded isn't recorded again here:
    // the admin tells core of it instead (a notice, below).
    await expect(updatesOf(earlier)).resolves.toHaveLength(1);
  });

  it("are recorded once when clock runs see a new version at the same time", async () => {
    const version = newVersion();
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await runMinuteTasks({ CF_VERSION_METADATA: version });
      })
    );

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });

  it("are recorded once when another run records the version just before this one's write lands", async () => {
    const version = newVersion();
    const racing = racingDb(async (db) => {
      await recordPlatformUpdate({
        ...env,
        DB: db,
        CF_VERSION_METADATA: version,
      });
    });
    await recordPlatformUpdate({
      ...env,
      DB: racing,
      CF_VERSION_METADATA: version,
    });
    // Drains both runs' outbox into the log.
    await runMinuteTasks({ CF_VERSION_METADATA: version });

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });

  it("are not recorded without version metadata, as on plain workerd", async () => {
    const before = await allEvents();
    await runMinuteTasks({ CF_VERSION_METADATA: undefined });

    const after = await allEvents();
    expect(
      after
        .slice(before.length)
        .filter((event) => event.action === "platform.updated")
    ).toStrictEqual([]);
  });

  // The isolate warns once in its life (`warnedMissingTable`), and other
  // files share it (`isolate: false` in vite.config.ts): only this test
  // may take the table away, or the warning here was spent already.
  it("wait for their table, warning once, and record the running version once it exists", async () => {
    const version = newVersion();
    // As before the migration that adds it ran.
    await env.DB.exec(
      "ALTER TABLE platform_versions RENAME TO platform_versions_away"
    );
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    const error = vi.spyOn(console, "error").mockReturnValue();
    const events = (spy: typeof warn): string[] =>
      spy.mock.calls.flatMap(([fields]: unknown[]) => {
        const parsed = logSchema.safeParse(fields);
        return parsed.success ? [parsed.data.event] : [];
      });
    try {
      await runMinuteTasks({ CF_VERSION_METADATA: version });
      await runMinuteTasks({ CF_VERSION_METADATA: version });
      expect({
        warned: events(warn).filter(
          (event) => event === "platform.update.table_missing"
        ),
        failed: events(error).filter((event) => event === "clock.task_failed"),
      }).toStrictEqual({
        warned: ["platform.update.table_missing"],
        failed: [],
      });
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await env.DB.exec(
        "ALTER TABLE platform_versions_away RENAME TO platform_versions"
      );
    }
    await expect(updatesOf(version)).resolves.toHaveLength(0);

    await runMinuteTasks({ CF_VERSION_METADATA: version });

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });
});
