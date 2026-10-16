import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { BindingTargetInput } from "@grasp-os/shared/resource-bindings";
import {
  statisticLimitsOf,
  statisticMaxApps,
  statisticRowsPerDay,
} from "@grasp-os/shared/statistics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { requestPermission } from "../src/permissions.ts";
import {
  readStatistics,
  recordStatistic,
  sweepStatistics,
} from "../src/statistics.ts";
import { release, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { failure, person } from "./sealed-apps.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// Statistics (src/statistics.ts) through an App's sealed functions: a
// statistics resource its actions declare (`resource.statistics`), which
// reaches nothing until an admin binds it (resource-statistics.ts). An
// App records measures of its own and reads them back added up, and reads
// the measures the platform publishes it declares, under a permission the
// binding names. These tests start from the ways it can fail: a
// declaration that grants itself, or a binding that serves a version
// declaring more than was approved; an App reading another App's
// measures, or the platform's without a binding naming a live grant, or
// of an App whose runs the person it acts for may not see; a read or a
// point past its bounds (names, dimensions, days, groups, rows a day, a
// call's or a minute's uses); a point outside the window counted; a run's
// step counting its points more than once, or for an attempt that didn't
// complete it; a platform read that isn't audited; and a read or the
// sweep reading a table whole.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * An App whose actions record and read statistics through `stats`, its
 * own measures with `operations`, and read the platform's runs and
 * signals through `platform`; each answers what it got, or the error's
 * code and details, as JSON text.
 */
const statsFiles = (
  operations = '["record", "read"]'
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ marks: defineTable({ at: v.number() }) });
`,
  "operations/stats.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

// A mark a run's step leaves, once per call key, and how many there are:
// how a step's attempt tells whether one ran before it.
export const mark = mutation({
  args: {},
  returns: v.id("marks"),
  handler: async (ctx) => await ctx.db.insert("marks", { at: 1 }),
});

export const marks = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("marks").take(100)).length,
});

export const stats = resource.statistics("stats", { operations: ${operations} });

export const platform = resource.statistics("platform", {
  operations: ["read"],
  platform: ["platform.workflow_runs", "platform.improvement_signals"],
});

// The runs only: no other platform measure.
export const runs = resource.statistics("runs", {
  operations: ["read"],
  platform: ["platform.workflow_runs"],
});

const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    return JSON.stringify({ ok: (await run()) ?? null });
  } catch (error) {
    const details = Reflect.get(Object(error), "details");
    return JSON.stringify({
      error: String(Reflect.get(Object(error), "code") ?? "failed"),
      ...(details === undefined ? {} : { details }),
    });
  }
};

const json = { json: v.string() };
const many = { json: v.string(), count: v.number() };

export const record = action({
  args: json,
  returns: v.string(),
  uses: [stats],
  handler: async (ctx, args) =>
    await outcome(async () => {
      for (const point of JSON.parse(args.json)) {
        await ctx.resources.stats.record(point);
      }
    }),
});

export const read = action({
  args: json,
  returns: v.string(),
  uses: [stats],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.stats.read(JSON.parse(args.json))),
});

export const readMany = action({
  args: many,
  returns: v.string(),
  uses: [stats],
  handler: async (ctx, args) =>
    await outcome(async () => {
      for (let read = 0; read < args.count; read += 1) {
        await ctx.resources.stats.read(JSON.parse(args.json));
      }
    }),
});

export const runsRead = action({
  args: json,
  returns: v.string(),
  uses: [runs],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.runs.read(JSON.parse(args.json))),
});

// \`count\` reads of its own measures at once.
export const readBurst = action({
  args: many,
  returns: v.string(),
  uses: [stats],
  handler: async (ctx, args) =>
    await outcome(async () => {
      await Promise.all(
        Array.from({ length: args.count }, async () => await ctx.resources.stats.read(JSON.parse(args.json)))
      );
    }),
});

export const platformRead = action({
  args: json,
  returns: v.string(),
  uses: [platform],
  handler: async (ctx, args) => await outcome(async () => await ctx.resources.platform.read(JSON.parse(args.json))),
});

export const platformReadMany = action({
  args: many,
  returns: v.string(),
  uses: [platform],
  handler: async (ctx, args) =>
    await outcome(async () => {
      for (let read = 0; read < args.count; read += 1) {
        await ctx.resources.platform.read(JSON.parse(args.json));
      }
    }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import { mark, marks, platform, platformRead, platformReadMany, read, readBurst, readMany, record, runs, runsRead, stats } from "./operations/stats.ts";
import schema from "./schema.ts";

export default app({
  name: "Stats",
  schema,
  access: { tables: { marks: { read: "owner", write: "owner" } } },
  operations: { stats: { record, read, readMany, readBurst, platformRead, platformReadMany, runsRead, mark, marks } },
  internalOperations: {},
  screens: [],
  uses: [stats, platform, runs],
});
`,
});

/** A new App of `owner`'s with `files`, current: its ID. */
const statsApp = async (
  owner: Person,
  files = statsFiles()
): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: `Stats ${unique()}` });
  await release(owner, id, files);
  return appIdSchema.parse(id);
};

/** A new App of `owner`'s with no code: one whose runs a read counts. */
const countedApp = async (owner: Person): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: `Counted ${unique()}` });
  return appIdSchema.parse(id);
};

/** The App's current version, as an admin reviews it. */
const currentVersion = async (app: AppId): Promise<number> => {
  const found = await env.DB.prepare(
    "SELECT current_version AS version FROM apps WHERE id = ?"
  )
    .bind(app)
    .first<{ version: number }>();
  return found?.version ?? 0;
};

/** Statistics of the App's own measures, as a binding targets them. */
const ownStatistics: BindingTargetInput = { kind: "statistics" };

/** `admin`'s binding of the App's `alias` to `target`, for its current version. */
const bind = async (
  admin: Person,
  app: AppId,
  alias = "stats",
  target = ownStatistics
) =>
  await admin.api.resourceBindings.approve({
    app,
    alias,
    target,
    reviewed: { version: await currentVersion(app) },
  });

/** A new App of `owner`'s, its own statistics bound by an admin. */
const boundApp = async (owner: Person): Promise<AppId> => {
  const app = await statsApp(owner);
  const admin = await signedInApi(idp, "admin");
  await bind(admin, app);
  return app;
};

/**
 * `app`'s permission to read the platform's statistics, asked for by
 * `builder` and granted, and its `platform` and `runs` resources bound to it: the
 * permission's ID.
 */
const grantPlatform = async (builder: Person, app: AppId): Promise<string> => {
  const permissionId = await requestGranted(idp, builder, {
    subject: { type: "app", appId: app },
    object: { type: "platform" },
    actions: ["statistics"],
    binding: "PLATFORM",
  });
  const admin = await signedInApi(idp, "admin");
  for (const alias of ["platform", "runs"]) {
    // oxlint-disable-next-line no-await-in-loop -- one approval after another
    await bind(admin, app, alias, { kind: "statistics", permissionId });
  }
  return permissionId;
};

/** Who `someone` is to a call: their ID, role and teams. */
const callerOf = async (userId: string) => {
  const member = await env.DB.prepare(
    "SELECT role FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ role: "admin" | "builder" | "user" }>();
  return { userId, role: member?.role ?? "user", teams: [] };
};

/**
 * Calls `path` of `app`'s current release as `userId`, with `input` as
 * JSON text, as a screen would: what the action answered, read back, or
 * the call's own refusal.
 */
const callAs = async (
  app: AppId,
  userId: string,
  path: string,
  input: Record<string, unknown>
): Promise<unknown> => {
  const sealed = await loadRelease(env, app, await currentVersion(app));
  const operation = sealed.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  const answered = await callAppFunction(
    env,
    await callerOf(userId),
    app,
    JSON.stringify({
      reference: {
        resourceId: sealed.manifest.resourceId,
        resourceVersion: sealed.manifest.resourceVersion,
        contractId: path,
        fingerprint: sealed.fingerprints[path] ?? "",
        kind: operation.kind,
      },
      input,
    })
  );
  const { result } = answered;
  if (result.ok && typeof result.value === "string") {
    const parsed: unknown = JSON.parse(result.value);
    return parsed;
  }
  return { refused: result.ok ? result.value : result.error.code };
};

/** Records `points` through `app`'s `stats`, as `userId`. */
const record = async (app: AppId, userId: string, points: unknown[]) =>
  await callAs(app, userId, "stats.record", { json: JSON.stringify(points) });

/** Reads `query` through `app`'s `stats`, as `userId`. */
const read = async (app: AppId, userId: string, query: unknown) =>
  await callAs(app, userId, "stats.read", { json: JSON.stringify(query) });

/** Reads `query` through `app`'s `platform`, as `userId`. */
const platformRead = async (app: AppId, userId: string, query: unknown) =>
  await callAs(app, userId, "stats.platformRead", {
    json: JSON.stringify(query),
  });

const groupSchema = z.object({
  dimensions: z.record(z.string(), z.string().nullable()),
  count: z.number(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
});

const answerSchema = z.object({
  ok: z.object({
    measure: z.string(),
    from: z.string(),
    to: z.string(),
    groups: z.array(groupSchema),
    truncated: z.boolean(),
  }),
});

/** `count` points of the measure `ticks`. */
const ticks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    measure: "ticks",
    value: index,
  }));

/** What a refused use of a resource answers: its code, and which bound. */
const limited = (limit: "call" | "minute" | "day", at?: number) => ({
  error: "resource.limit_reached",
  details: {
    limit,
    ...(limit === "minute" && at !== undefined
      ? { retryAfterSeconds: 60 - Math.floor((at % 60_000) / 1000) }
      : {}),
  },
});

/** A run of `app`'s workflow `workflow`, started `ago` milliseconds back. */
const seedRun = async (app: string, workflow: string, ago = 0) => {
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?)"
  )
    .bind(crypto.randomUUID(), app, workflow, Date.now() - ago, Date.now())
    .run();
};

/**
 * Holds the clock from here to the end of the test, as it reads now: core
 * and the App's host read the same `Date`, so the test's points, reads,
 * runs and windows never cross a minute (the rate bounds' counters) or a
 * UTC day, however slow the machine. A test moves it on only on purpose.
 * Held once a test's setup is done: signing in and building an App wait
 * on time passing.
 */
const holdClock = (): number => {
  const at = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return at;
};

describe("an App's own statistics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reach nothing until an admin binds them, and nothing more than was approved", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    // Recording only, as version 1 declares it: bound.
    const app = await statsApp(builder, statsFiles('["record"]'));
    const point = [{ measure: "seen", value: 1 }];
    const unbound = await record(app, admin.userId, point);
    // What an admin reviews: what each declares, and what it may be bound
    // to: nothing to choose for its own measures, a permission for the
    // platform's, of which it has none yet.
    const { resources } = await admin.api.resourceBindings.review(app);
    const reviewed = resources.map(
      ({ alias, kind, operations, measures, state, choices }) => ({
        alias,
        kind,
        operations,
        measures,
        state,
        choices,
      })
    );
    const binding = await bind(admin, app);
    const bound = await record(app, admin.userId, point);
    // A binding of its own measures names no permission, and the platform's
    // resource none without one.
    const withPermission = await failure(
      async () =>
        await bind(admin, app, "stats", {
          kind: "statistics",
          permissionId: crypto.randomUUID(),
        })
    );
    const platformUnnamed = await failure(
      async () => await bind(admin, app, "platform")
    );
    // A builder may not approve one.
    const byBuilder = await failure(async () => await bind(builder, app));
    // Version 2 reads too: what was approved serves it no more.
    await release(builder, app, statsFiles());
    const widened = await record(app, admin.userId, point);
    await bind(admin, app);
    const approvedAgain = await read(app, admin.userId, {
      measure: "seen",
      days: 1,
    });
    // Revoked: the next request is refused.
    const listed = await admin.api.resourceBindings.list(app);
    const active = listed.find(
      ({ alias, status }) => alias === "stats" && status === "active"
    );
    await admin.api.resourceBindings.revoke(active?.id ?? binding.id);
    const revoked = await record(app, admin.userId, point);
    const seen = await env.DB.prepare(
      "SELECT sum(count) AS count FROM app_statistics WHERE app_id = ? AND measure = 'seen'"
    )
      .bind(app)
      .first<{ count: number }>();
    expect({
      reviewed,
      unbound,
      bound,
      withPermission,
      platformUnnamed,
      byBuilder,
      widened,
      approvedAgain: answerSchema.parse(approvedAgain).ok.groups,
      revoked,
      seen: seen?.count,
    }).toStrictEqual({
      reviewed: [
        {
          alias: "platform",
          kind: "statistics",
          operations: ["read"],
          measures: ["platform.workflow_runs", "platform.improvement_signals"],
          state: "unbound",
          choices: {
            kind: "statistics",
            platform: true,
            permissions: [],
            truncated: false,
          },
        },
        {
          alias: "runs",
          kind: "statistics",
          operations: ["read"],
          measures: ["platform.workflow_runs"],
          state: "unbound",
          choices: {
            kind: "statistics",
            platform: true,
            permissions: [],
            truncated: false,
          },
        },
        {
          alias: "stats",
          kind: "statistics",
          operations: ["record"],
          measures: [],
          state: "unbound",
          choices: {
            kind: "statistics",
            platform: false,
            permissions: [],
            truncated: false,
          },
        },
      ],
      unbound: { error: "resource.unavailable" },
      bound: { ok: null },
      withPermission: "resource.target_invalid",
      platformUnnamed: "resource.target_invalid",
      byBuilder: "role.forbidden",
      widened: { error: "resource.unavailable" },
      approvedAgain: [{ dimensions: {}, count: 1, sum: 1, min: 1, max: 1 }],
      revoked: { error: "resource.unavailable" },
      // Only the point recorded while a binding served it.
      seen: 1,
    });
  });

  it("are recorded as they come and read back added up, by the dimensions asked, over the days asked", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    const other = await boundApp(admin);
    holdClock();
    const recorded = await record(app, admin.userId, [
      { measure: "invoices", value: 120, dimensions: { supplier: "acme" } },
      { measure: "invoices", value: 80, dimensions: { supplier: "acme" } },
      { measure: "invoices", value: 40, dimensions: { supplier: "globex" } },
      { measure: "invoices", value: 5 },
    ]);
    // Eight days ago: outside a week, inside a month.
    await recordStatistic(
      env,
      app,
      { measure: "invoices", value: 1000, dimensions: { supplier: "acme" } },
      { now: new Date(Date.now() - 8 * dayMs) }
    );
    const bySupplier = answerSchema.parse(
      await read(app, admin.userId, {
        measure: "invoices",
        days: 7,
        groupBy: ["supplier"],
      })
    );
    const month = answerSchema.parse(
      await read(app, admin.userId, {
        measure: "invoices",
        days: 30,
        where: { supplier: "acme" },
      })
    );
    const theirs = answerSchema.parse(
      await read(other, admin.userId, { measure: "invoices", days: 30 })
    );
    expect({
      recorded,
      // Most points first; `globex` and none tie, so by name here.
      bySupplier: bySupplier.ok.groups.toSorted(
        (a, b) =>
          b.count - a.count ||
          String(a.dimensions.supplier).localeCompare(
            String(b.dimensions.supplier)
          )
      ),
      truncated: bySupplier.ok.truncated,
      days: bySupplier.ok.to > bySupplier.ok.from,
      month: month.ok.groups,
      theirs: theirs.ok.groups,
    }).toStrictEqual({
      recorded: { ok: null },
      bySupplier: [
        {
          dimensions: { supplier: "acme" },
          count: 2,
          sum: 200,
          min: 80,
          max: 120,
        },
        {
          dimensions: { supplier: "globex" },
          count: 1,
          sum: 40,
          min: 40,
          max: 40,
        },
        {
          dimensions: { supplier: null },
          count: 1,
          sum: 5,
          min: 5,
          max: 5,
        },
      ],
      truncated: false,
      days: true,
      month: [
        {
          dimensions: {},
          count: 3,
          sum: 1200,
          min: 80,
          max: 1000,
        },
      ],
      theirs: [],
    });
  });

  it("stay within their bounds, refused in the host's words before anything is written", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    holdClock();
    const one = async (point: unknown) =>
      await record(app, admin.userId, [point]);
    const query = async (input: unknown) =>
      await read(app, admin.userId, input);
    // A day's rows filled, but for one, by another App's points as much.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.batch(
      Array.from({ length: statisticRowsPerDay - 1 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max) VALUES (?, 'filled', ?, ?, 1, 1, 1, 1)"
        ).bind(app, day, JSON.stringify({ n: String(index) }))
      )
    );
    const last = await one({ measure: "late", value: 1 });
    const pastBound = await one({ measure: "later", value: 1 });
    const existing = await one({ measure: "late", value: 2 });
    expect({
      last,
      pastBound,
      existing,
      name: await one({ measure: "Invoices!", value: 1 }),
      platformName: await one({
        measure: "platform.workflow_runs",
        value: 1,
      }),
      dimensions: await one({
        measure: "m",
        value: 1,
        dimensions: { a: "1", b: "2", c: "3", d: "4" },
      }),
      value: await one({ measure: "m", value: 1e13 }),
      tooManyDays: await query({ measure: "m", days: 367 }),
      noDays: await query({ measure: "m", days: 0 }),
      groupTwice: await query({ measure: "m", days: 1, groupBy: ["a", "a"] }),
      // A platform measure its own measures' resource doesn't declare.
      platform: await query({
        measure: "platform.workflow_runs",
        days: 1,
        where: { app },
      }),
    }).toStrictEqual({
      last: { ok: null },
      pastBound: limited("day"),
      existing: { ok: null },
      name: { error: "resource.invalid_args" },
      platformName: { error: "resource.invalid_args" },
      dimensions: { error: "resource.invalid_args" },
      value: { error: "resource.invalid_args" },
      tooManyDays: { error: "resource.invalid_args" },
      noDays: { error: "resource.invalid_args" },
      groupTwice: { error: "resource.invalid_args" },
      platform: { error: "resource.not_allowed" },
    });
  });

  it("are recorded no faster than a call or a minute allows", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    const at = holdClock();
    // Lowered for tests (vite.config.ts).
    const {
      perCall: statisticPointsPerCall,
      perMinute: statisticPointsPerMinute,
    } = statisticLimitsOf("point", env.STATISTICS_POINT_LIMITS);
    const call = async (count: number) =>
      await record(app, admin.userId, ticks(count));
    const tooManyInOneCall = await call(statisticPointsPerCall + 1);
    // The rest of the minute's points: that call's first ones count too.
    const calls: unknown[] = [];
    for (
      let recorded = statisticPointsPerCall;
      recorded < statisticPointsPerMinute;
      recorded += statisticPointsPerCall
    ) {
      const count = Math.min(
        statisticPointsPerCall,
        statisticPointsPerMinute - recorded
      );
      // oxlint-disable-next-line no-await-in-loop -- one call after another, as they count
      calls.push(await call(count));
    }
    const overTheMinute = await call(1);
    const counted = answerSchema.parse(
      await read(app, admin.userId, { measure: "ticks", days: 1 })
    );
    expect({
      tooManyInOneCall,
      calls: new Set(calls.map((answer) => JSON.stringify(answer))),
      overTheMinute,
      counted: counted.ok.groups[0]?.count,
    }).toStrictEqual({
      tooManyInOneCall: limited("call"),
      calls: new Set([JSON.stringify({ ok: null })]),
      overTheMinute: limited("minute", at),
      counted: statisticPointsPerMinute,
    });
  });

  it("are read no more often than a call or a minute allows", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    const at = holdClock();
    // Lowered for tests (vite.config.ts).
    const { perCall, perMinute } = statisticLimitsOf(
      "read",
      env.STATISTICS_READ_LIMITS
    );
    const query = JSON.stringify({ measure: "ticks", days: 1 });
    const readMany = async (count: number) =>
      await callAs(app, admin.userId, "stats.readMany", { json: query, count });
    const tooManyInOneCall = await readMany(perCall + 1);
    const calls: unknown[] = [];
    for (let reads = perCall; reads < perMinute; reads += perCall) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another, as they count
      calls.push(await readMany(Math.min(perCall, perMinute - reads)));
    }
    expect({
      tooManyInOneCall,
      calls: new Set(calls.map((answer) => JSON.stringify(answer))),
      overTheMinute: await readMany(1),
    }).toStrictEqual({
      tooManyInOneCall: limited("call"),
      calls: new Set([JSON.stringify({ ok: null })]),
      overTheMinute: limited("minute", at),
    });
  });

  it("are read no more often than a call allows, however many of its reads run at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    holdClock();
    const { perCall } = statisticLimitsOf("read", env.STATISTICS_READ_LIMITS);
    await expect(
      callAs(app, admin.userId, "stats.readBurst", {
        json: JSON.stringify({ measure: "ticks", days: 1 }),
        count: perCall + 1,
      })
    ).resolves.toStrictEqual(limited("call"));
  });

  it("are swept past their retention, however many rows, in one run", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await countedApp(admin);
    holdClock();
    const old = new Date(Date.now() - 500 * dayMs).toISOString().slice(0, 10);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
       INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max)
       SELECT ?, 'old', ?, json_object('n', CAST(i AS TEXT)), 1, 1, 1, 1 FROM n`
    )
      .bind(app, old)
      .run();
    await sweepStatistics(env);
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM app_statistics WHERE app_id = ?"
    )
      .bind(app)
      .first<{ count: number }>();
    expect(left?.count).toBe(0);
  });

  it("are read, bounded and swept by their indexes, never a table whole", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await boundApp(admin);
    holdClock();
    // Past the retention: swept.
    await recordStatistic(
      env,
      app,
      { measure: "old", value: 1 },
      { now: new Date(Date.now() - 500 * dayMs) }
    );
    const recorded = await recordedQueries(async () => {
      await record(app, admin.userId, [
        { measure: "plan", value: 1, dimensions: { kind: "a" } },
      ]);
      await read(app, admin.userId, {
        measure: "plan",
        days: 366,
        where: { kind: "a" },
        groupBy: ["kind"],
      });
      await sweepStatistics(env);
    });
    const statements = recorded.filter(({ query }) =>
      query.includes("app_statistics")
    );
    const plans = await Promise.all(statements.map(planOf));
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM app_statistics WHERE app_id = ? AND measure = 'old'"
    )
      .bind(app)
      .first<{ count: number }>();
    expect({
      statements: statements.length,
      // The bound's `SELECT` of the point's values is one constant row.
      scans: plans
        .flat()
        .filter((step) => fullScan.test(step) && step !== "SCAN CONSTANT ROW"),
      left: left?.count,
    }).toStrictEqual({ statements: 3, scans: [], left: 0 });
  });
});

describe("the platform's statistics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are read at the platform only under a live permission, refused and audited otherwise", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await boundApp(builder);
    const watched = await countedApp(admin);
    const permissionId = await grantPlatform(builder, reader);
    await admin.api.permissions.revoke(permissionId);
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    // The platform's own check, past every binding's: the permission as it
    // stands when it reads.
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await failure(
        async () =>
          await readStatistics(
            env,
            {
              subject: { type: "app", appId: reader },
              onBehalfOf: admin.userId,
              mode: "interactive",
              appVersion: await currentVersion(reader),
            },
            query,
            permissionIdSchema.parse(permissionId)
          )
      );
    });
    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ target, detail }) => ({ target, refused: detail.refused })),
    }).toStrictEqual({
      refused: "permission.denied",
      audited: [
        { target: { type: "app", id: watched }, refused: "permission.denied" },
      ],
    });
  });

  it("count an App's runs and signals for whoever may see its runs, under a binding naming a live grant, audited, and nobody else", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await boundApp(builder);
    const watched = await countedApp(admin);
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
      groupBy: ["workflow"],
    };
    // Before an admin binds the platform's statistics: refused.
    const unbound = await platformRead(reader, admin.userId, query);
    // The stub every App's v1 server has is never a permission's name.
    const reservedName = await failure(
      async () =>
        await requestPermission(
          env,
          await person("builder"),
          {
            subject: { type: "app", appId: reader },
            object: { type: "platform" },
            actions: ["statistics"],
            binding: "STATISTICS",
          },
          {
            app: async (app, role) =>
              await appFor(env, await callerOf(builder.userId), app, role),
            resource: async () =>
              await Promise.reject(new Error("No resource is named here")),
          }
        )
    );
    const permissionId = await grantPlatform(builder, reader);
    // Another App's permission to read them serves this one nothing.
    const another = await boundApp(builder);
    const theirs = await grantPlatform(builder, another);
    const othersGrant = await failure(
      async () =>
        await bind(admin, reader, "platform", {
          kind: "statistics",
          permissionId: theirs,
        })
    );
    holdClock();
    await seedRun(watched, "pay");
    await seedRun(watched, "pay");
    await seedRun(watched, "remind");
    // Before the window of a week.
    await seedRun(watched, "pay", 10 * dayMs);
    const runs = async (userId: string, change: Record<string, unknown> = {}) =>
      await platformRead(reader, userId, { ...query, ...change });
    let byWorkflow: unknown;
    const events = await auditedDuring(async () => {
      byWorkflow = await runs(admin.userId);
    });
    // Through the resource that declares the runs only: the signals are
    // refused before anything is read, and nothing is audited.
    let narrowSignals: unknown;
    const narrowEvents = await auditedDuring(async () => {
      narrowSignals = await callAs(reader, admin.userId, "stats.runsRead", {
        json: JSON.stringify({
          measure: "platform.improvement_signals",
          days: 7,
          where: { app: watched },
        }),
      });
    });
    const narrowRuns = answerSchema.parse(
      await callAs(reader, admin.userId, "stats.runsRead", {
        json: JSON.stringify({ ...query, groupBy: [] }),
      })
    ).ok.groups;
    const answers = {
      byWorkflow: answerSchema.parse(byWorkflow).ok.groups,
      one: answerSchema.parse(
        await runs(admin.userId, {
          where: { app: watched, workflow: "pay" },
          groupBy: [],
        })
      ).ok.groups,
      // A builder of the reading App, with no role in the one it counts.
      builder: await runs(builder.userId),
      noApp: await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 7,
      }),
      unbound,
      reservedName,
      // Its own statistics' resource reads no platform measure.
      ownResource: await read(reader, admin.userId, query),
      unknownDimension: await runs(admin.userId, { groupBy: ["startedBy"] }),
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
      narrowSignals,
      narrowAudited: narrowEvents.filter(
        ({ action }) => action === "statistics.read"
      ).length,
      narrowRuns,
    };
    // The permission the binding names, revoked: the next read is refused.
    await admin.api.permissions.revoke(permissionId);
    const revoked = await runs(admin.userId);
    expect({ ...answers, othersGrant, revoked }).toStrictEqual({
      byWorkflow: [
        {
          dimensions: { workflow: "pay" },
          count: 2,
          sum: 2,
          min: 1,
          max: 1,
        },
        {
          dimensions: { workflow: "remind" },
          count: 1,
          sum: 1,
          min: 1,
          max: 1,
        },
      ],
      one: [{ dimensions: {}, count: 2, sum: 2, min: 1, max: 1 }],
      builder: { error: "resource.item_not_found" },
      noApp: { error: "resource.invalid_args" },
      unbound: { error: "resource.unavailable" },
      reservedName: "permission.invalid",
      ownResource: { error: "resource.not_allowed" },
      unknownDimension: { error: "resource.invalid_args" },
      audited: [
        {
          actor: { type: "app", appId: reader, part: "server" },
          target: { type: "app", id: watched },
          detail: {
            measure: "platform.workflow_runs",
            days: 7,
            onBehalfOf: admin.userId,
          },
        },
      ],
      narrowSignals: { error: "resource.not_allowed" },
      narrowAudited: 0,
      narrowRuns: [{ dimensions: {}, count: 3, sum: 3, min: 1, max: 1 }],
      othersGrant: "resource.target_invalid",
      revoked: { error: "resource.unavailable" },
    });
  });

  it("count many Apps' runs in one read, grouped by App, the ones it can't read listed unavailable, audited once with every App asked for", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await boundApp(builder);
    await grantPlatform(builder, reader);
    // The builder builds `theirs`, not `watched`; `gone` is no App at all.
    const watched = await countedApp(admin);
    const theirs = await countedApp(builder);
    holdClock();
    const gone = crypto.randomUUID();
    await seedRun(watched, "pay");
    await seedRun(watched, "pay");
    await seedRun(theirs, "remind");
    const all = {
      measure: "platform.workflow_runs",
      days: 7,
      apps: [watched, gone, theirs],
      groupBy: ["app", "workflow"],
    };
    const answerOf = (answer: unknown) => {
      const parsed = z
        .object({
          ok: answerSchema.shape.ok.extend({
            unavailable: z.array(z.string()),
          }),
        })
        .parse(answer).ok;
      return {
        groups: parsed.groups.map(({ dimensions, count }) => ({
          ...dimensions,
          count,
        })),
        unavailable: parsed.unavailable,
      };
    };
    let byAdmin: unknown;
    const events = await auditedDuring(async () => {
      byAdmin = await platformRead(reader, admin.userId, all);
    });
    // Ordered by the groups' values: by App ID, then workflow.
    const expected = [
      { app: watched, workflow: "pay", count: 2 },
      { app: theirs, workflow: "remind", count: 1 },
    ].toSorted((one, other) => one.app.localeCompare(other.app));
    expect({
      byAdmin: answerOf(byAdmin),
      // An App the builder may not see is unavailable too, and the rest
      // still counted.
      byBuilder: answerOf(await platformRead(reader, builder.userId, all)),
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ target, provenance, detail }) => ({
          target,
          provenance,
          apps: detail.apps,
          unavailable: detail.unavailable,
        })),
      ownWithApps: await read(reader, admin.userId, {
        measure: "ticks",
        days: 1,
        apps: [watched],
      }),
      oneAndApps: await platformRead(reader, admin.userId, {
        ...all,
        where: { app: watched },
      }),
      // One App, as `where.app`, is still refused when it can't be read.
      oneGone: await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 7,
        where: { app: gone },
      }),
    }).toStrictEqual({
      byAdmin: { groups: expected, unavailable: [gone] },
      byBuilder: {
        groups: [{ app: theirs, workflow: "remind", count: 1 }],
        unavailable: [watched, gone],
      },
      // Every App asked for: those it counted, then the unavailable one.
      audited: [
        {
          target: undefined,
          provenance: [watched, theirs, gone],
          apps: 3,
          unavailable: 1,
        },
      ],
      ownWithApps: { error: "resource.invalid_args" },
      oneAndApps: { error: "resource.invalid_args" },
      oneGone: { error: "resource.item_not_found" },
    });
  });

  it("count the runs and signals of as many Apps as one read takes, by index", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await boundApp(admin);
    await grantPlatform(admin, reader);
    holdClock();
    // As many Apps as a read names, none of them built: only counted.
    const apps = Array.from({ length: statisticMaxApps }, () =>
      crypto.randomUUID()
    ).toSorted();
    await env.DB.batch(
      apps.map((id) =>
        env.DB.prepare(
          "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Counted', '', ?, ?)"
        ).bind(id, admin.userId, Date.now())
      )
    );
    const [first, last] = [apps.at(0) ?? "", apps.at(-1) ?? ""];
    await seedRun(first, "pay");
    await seedRun(last, "pay");
    await seedRun(last, "pay");
    await seedRun(last, "remind");
    const computation = `computation-${unique()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
      ).bind(
        computation,
        new Date().toISOString().slice(0, 10),
        Date.now() - 120_000,
        Date.now() - 60_000
      ),
      ...[first, last].map((app) =>
        env.DB.prepare(
          "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, 'pay', 'failing_step', 'match', 3, '{}')"
        ).bind(computation, app)
      ),
    ]);
    // Every filter a read takes, with every App it takes.
    const query = { days: 7, apps, groupBy: ["app"] };
    const counts = (answer: unknown) =>
      answerSchema
        .parse(answer)
        .ok.groups.map(({ dimensions, count }) => ({ ...dimensions, count }));
    let runs: unknown;
    let signals: unknown;
    const recorded = await recordedQueries(async () => {
      runs = await platformRead(reader, admin.userId, {
        ...query,
        measure: "platform.workflow_runs",
        where: { workflow: "pay" },
      });
      signals = await platformRead(reader, admin.userId, {
        ...query,
        measure: "platform.improvement_signals",
        where: { workflow: "pay", kind: "failing_step" },
      });
    });
    const plans = await Promise.all(
      recorded
        .filter(({ query: sql }) =>
          /from "(?:apps|improvement_signals|workflow_runs)"/u.test(sql)
        )
        .map(planOf)
    );
    expect({
      runs: counts(runs),
      signals: counts(signals),
      // But for the few computations, as every read of the signals reads.
      scans: plans
        .flat()
        .filter(
          (step) =>
            fullScan.test(step) &&
            step !== "SCAN improvement_signal_computations"
        ),
    }).toStrictEqual({
      runs: [
        { app: first, count: 1 },
        { app: last, count: 2 },
      ],
      signals: [
        { app: first, count: 1 },
        { app: last, count: 1 },
      ],
      scans: [],
    });
  });

  it("page by the groups' values over a window held at `until`, so runs starting between pages neither repeat nor skip a group", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await boundApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    holdClock();
    // 101 workflows ran a minute ago: two pages of groups.
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101) INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) SELECT ?1 || i, ?2, 'w' || i, 1, NULL, 'completed', ?3, ?3 FROM n"
    )
      .bind(`bulk-${unique()}-`, watched, Date.now() - 60_000)
      .run();
    const until = new Date(Date.now() - 1000).toISOString();
    const page = async (offset: number, held = true) =>
      answerSchema.parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.workflow_runs",
          days: 7,
          apps: [watched],
          groupBy: ["workflow"],
          offset,
          ...(held ? { until } : {}),
        })
      ).ok;
    const first = await page(0);
    // Between the pages: a workflow that sorts first starts, and another
    // run of one on the first page.
    await seedRun(watched, "a-first");
    await seedRun(watched, "w1");
    const second = await page(100);
    const groups = [...first.groups, ...second.groups];
    const workflows = groups.map(({ dimensions }) => dimensions.workflow);
    // Without `until`, the new workflow moves every group a place.
    const unheld = await page(100, false);
    expect({
      pages: [first.truncated, second.truncated],
      read: workflows.length,
      distinct: new Set(workflows).size,
      w1: groups.find(({ dimensions }) => dimensions.workflow === "w1")?.count,
      unheldFirst: unheld.groups[0]?.dimensions.workflow,
    }).toStrictEqual({
      pages: [true, false],
      read: 101,
      distinct: 101,
      w1: 1,
      // What the first page ended with, read again.
      unheldFirst: first.groups.at(-1)?.dimensions.workflow,
    });
  });

  it("give the latest improvement signals of an App's workflows by kind, and plan their reads by index", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await boundApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    holdClock();
    /** A finished computation, started `ago` and finished `took` later, with `signals`. */
    const seedComputation = async (
      ago: number,
      took: number,
      signals: readonly (readonly [string, string, string, number])[]
    ) => {
      const id = `computation-${unique()}`;
      const startedAt = Date.now() - ago;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
        ).bind(
          id,
          new Date(startedAt).toISOString().slice(0, 10),
          startedAt,
          startedAt + took
        ),
        ...signals.map(([workflow, kind, subject, value]) =>
          env.DB.prepare(
            "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, ?, ?, ?, ?, '{}')"
          ).bind(id, watched, workflow, kind, subject, value)
        ),
      ]);
    };
    // The latest computation, within the day read: two minutes ago.
    await seedComputation(120_000, 10_000, [
      ["pay", "failing_step", "match", 4],
      ["pay", "failing_step", "book", 2],
      ["pay", "cost_per_run", "", 0.5],
      ["remind", "failing_step", "send", 1],
    ]);
    // A snapshot's time, after it finished.
    const until = new Date(Date.now() - 60_000).toISOString();
    const signalsRead = async (held: boolean) =>
      answerSchema.parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.improvement_signals",
          days: 1,
          where: { app: watched, workflow: "pay" },
          groupBy: ["kind"],
          ...(held ? { until } : {}),
        })
      ).ok.groups;
    let answer: unknown;
    const recorded = await recordedQueries(async () => {
      answer = await platformRead(reader, admin.userId, {
        measure: "platform.improvement_signals",
        days: 1,
        where: { app: watched, workflow: "pay" },
        groupBy: ["kind"],
      });
      await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 30,
        where: { app: watched },
        groupBy: ["workflow"],
      });
    });
    const heldBefore = await signalsRead(true);
    // Then one finishes after the snapshot's time, as between its pages,
    // and another is dated after now.
    await seedComputation(30_000, 10_000, [
      ["pay", "failing_step", "later", 9],
    ]);
    await seedComputation(-1000 * dayMs, 0, [
      ["pay", "failing_step", "future", 99],
    ]);
    const heldAfter = await signalsRead(true);
    const current = await signalsRead(false);
    const measured = recorded.filter(({ query }) =>
      /from "(?:improvement_signals|workflow_runs)"/u.test(query)
    );
    const plans = await Promise.all(measured.map(planOf));
    expect({
      groups: answerSchema.parse(answer).ok.groups,
      // Held at the snapshot's time: the same computation before and after
      // another finished.
      held: heldAfter,
      same: JSON.stringify(heldAfter) === JSON.stringify(heldBefore),
      // Not held: the latest finished by now, never one dated later.
      current,
      reads: measured.length,
      // Which computation is the latest reads the computations, as every
      // read of the signals does: a finished one deletes those before it,
      // so there are only ever a few.
      scans: plans
        .flat()
        .filter(
          (step) =>
            fullScan.test(step) &&
            step !== "SCAN improvement_signal_computations"
        ),
    }).toStrictEqual({
      // By kind: the groups' values.
      groups: [
        {
          dimensions: { kind: "cost_per_run" },
          count: 1,
          sum: 0.5,
          min: 0.5,
          max: 0.5,
        },
        {
          dimensions: { kind: "failing_step" },
          count: 2,
          sum: 6,
          min: 2,
          max: 4,
        },
      ],
      held: [
        {
          dimensions: { kind: "cost_per_run" },
          count: 1,
          sum: 0.5,
          min: 0.5,
          max: 0.5,
        },
        {
          dimensions: { kind: "failing_step" },
          count: 2,
          sum: 6,
          min: 2,
          max: 4,
        },
      ],
      same: true,
      current: [
        {
          dimensions: { kind: "failing_step" },
          count: 1,
          sum: 9,
          min: 9,
          max: 9,
        },
      ],
      reads: 2,
      scans: [],
    });
  });

  it("read one signal computation on every page held at `until`, kept while a newer one finishes, and say which", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await boundApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    const held = holdClock();
    const days = (count: number) => new Date(Date.now() + count * dayMs);
    // The production computation: today's, finished before the snapshot.
    await refreshDailySignals(env, days(0));
    const until = new Date(held).toISOString();
    // Past the snapshot's time before anything else finishes.
    vi.setSystemTime(held + 1000);
    const computationRead = async () =>
      z.object({ ok: z.object({ computation: z.string().nullable() }) }).parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.improvement_signals",
          days: 7,
          apps: [watched],
          groupBy: ["kind"],
          until,
        })
      ).ok.computation;
    const first = await computationRead();
    // A newer computation finishes between two pages: the one the first
    // page read is kept, and the next page reads it too.
    await refreshDailySignals(env, days(1));
    const second = await computationRead();
    // Another one: now the first is older than the latest two finished,
    // and goes. A page reading it now says so.
    await refreshDailySignals(env, days(2));
    const third = await computationRead();
    const kept = await env.DB.prepare(
      "SELECT count(*) AS kept FROM improvement_signal_computations WHERE id = ?"
    )
      .bind(first)
      .first<{ kept: number }>();
    expect({
      read: typeof first,
      second: second === first,
      third: third === first,
      kept: kept?.kept,
    }).toStrictEqual({
      read: "string",
      second: true,
      third: false,
      kept: 0,
    });
  });

  it("audit every platform read refused once it reaches the platform, and why: invalid, or past their bounds, those once a minute", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await boundApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    const held = holdClock();
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    const { perCall } = statisticLimitsOf("read", env.STATISTICS_READ_LIMITS);
    const readMany = async () =>
      await callAs(reader, admin.userId, "stats.platformReadMany", {
        json: JSON.stringify(query),
        count: perCall + 1,
      });
    const results: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      results.invalid = await platformRead(reader, admin.userId, {
        ...query,
        days: 0,
      });
      results.unknown = await platformRead(reader, admin.userId, {
        measure: "platform.everything",
        days: 7,
      });
      // Two calls past the bound of one in the same minute, audited once;
      // one in the next minute, audited again.
      const minute = Math.floor(held / 60_000) * 60_000;
      vi.setSystemTime(minute + 10_000);
      results.limited = await readMany();
      vi.setSystemTime(minute + 50_000);
      results.limitedAgain = await readMany();
      vi.setSystemTime(minute + 70_000);
      results.nextMinute = await readMany();
    });
    expect({
      results,
      refused: events
        .filter(
          ({ action, detail }) =>
            action === "statistics.read" && detail.refused !== undefined
        )
        .map(({ target, detail }) => ({
          app: target?.id,
          measure: detail.measure,
          refused: detail.refused,
        })),
    }).toStrictEqual({
      results: {
        invalid: { error: "resource.invalid_args" },
        // A platform measure the resource doesn't declare: refused by the
        // host before anything is read.
        unknown: { error: "resource.not_allowed" },
        limited: limited("call"),
        limitedAgain: limited("call"),
        nextMinute: limited("call"),
      },
      refused: [
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.invalid",
        },
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.rate_limited",
        },
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.rate_limited",
        },
      ],
    });
  });
});

/** A function of the Stats App, as a step names it. */
const statsFunction = (name: string, kind = "action") =>
  JSON.stringify({ contractId: `stats.${name}`, kind });

/** The input of `stats.record` or `stats.read`, as a step passes it. */
const statsInput = (value: unknown) =>
  JSON.stringify({ json: JSON.stringify(value) });

/**
 * A workflow `id` whose step `count` reads how many marks there are
 * (`seen`) and leaves one, its receipt the same on every attempt, records
 * a point of `measure` and reads it back in the same step, then runs
 * `afterwards`, under `options`; and whose next step `after` reads it
 * again. Its test mocks every step.
 */
const countingWorkflow = (
  id: string,
  measure: string,
  { afterwards = "", options = "retries: { limit: 0 }" } = {}
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env }) => {
  const during = await step.do("count", { description: "Count", sideEffect: true, input: null, ${options} }, async () => {
    const seen = await env.APP.callFunction(${statsFunction("marks", "query")}, {});
    await env.APP.callFunction(${statsFunction("mark", "mutation")}, {});
    await env.APP.callFunction(${statsFunction("record")}, ${statsInput([{ measure, value: 1 }])});
    const read = await env.APP.callFunction(${statsFunction("read")}, ${statsInput({ measure, days: 2 })});
    ${afterwards}
    return read;
  });
  const after = await step.do("after", { description: "Read", input: null, retries: { limit: 0 } }, async () =>
    await env.APP.callFunction(${statsFunction("read")}, ${statsInput({ measure, days: 2 })})
  );
  return { during, after };
});
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: { count: null, after: null }, expect: {} },
]);
`,
});

/** How many points of `measure` a read as `userId` counts now. */
const pointsOf = async (
  app: AppId,
  userId: string,
  measure: string
): Promise<number> =>
  answerSchema.parse(await read(app, userId, { measure, days: 2 })).ok.groups[0]
    ?.count ?? 0;

/** The count a function's answer, as a step got it, holds. */
const countIn = (answer: Json | undefined): number => {
  const parsed = z
    .object({ ok: z.literal(true), value: z.string() })
    .safeParse(answer);
  return parsed.success
    ? (answerSchema.parse(JSON.parse(parsed.data.value)).ok.groups[0]?.count ??
        0)
    : -1;
};

describe("a run's statistics", { timeout: 90_000 }, () => {
  afterEach(async () => {
    await endLiveRuns();
  });

  it("read the platform's measures for a run as the run, for the person it acts for", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const watched = await countedApp(admin);
    await seedRun(watched, "pay");
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    const reader = await statsApp(builder, {
      ...statsFiles(),
      "workflows/reads.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("reads", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("read", { description: "Read", input: null, retries: { limit: 0 } }, async () =>
    await env.APP.callFunction(${statsFunction("platformRead")}, ${statsInput(query)})
  )
);
`,
      "workflows/reads.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./reads.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { read: null }, expect: {} }]);
`,
    });
    await grantPlatform(builder, reader);
    /** A run of `reads` started by `starter`: its ID, and what it read. */
    const runBy = async (starter: Person) => {
      const run = await starter.api.workflows.start(reader, "reads");
      await finished(run.id);
      const ended = await starter.api.workflows.status(run.id);
      const parsed = z
        .object({ ok: z.literal(true), value: z.string() })
        .safeParse(ended.output);
      const answer: unknown = parsed.success
        ? JSON.parse(parsed.data.value)
        : ended.output;
      return { id: run.id, read: answer };
    };
    const started: { id: string; read: unknown }[] = [];
    const events = await auditedDuring(async () => {
      started.push(await runBy(admin));
    });
    const [byAdmin = { id: "", read: null }] = started;
    // A builder of the reading App, with no role in the one it counts.
    const byBuilder = await runBy(builder);
    expect({
      byAdmin: answerSchema.parse(byAdmin.read).ok.groups,
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ actor, detail }) => ({
          actor,
          onBehalfOf: detail.onBehalfOf,
        })),
      byBuilder: byBuilder.read,
    }).toStrictEqual({
      byAdmin: [{ dimensions: {}, count: 1, sum: 1, min: 1, max: 1 }],
      // As the run, for the person it acts for: whoever started it.
      audited: [
        {
          actor: {
            type: "workflow",
            appId: reader,
            workflowId: "reads",
            runId: byAdmin.id,
          },
          onBehalfOf: admin.userId,
        },
      ],
      byBuilder: { error: "resource.item_not_found" },
    });
  });

  it("count a step's points once it completes, once however often it ran, and never for an attempt that didn't", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const app = await statsApp(builder, {
      ...statsFiles(),
      ...countingWorkflow("counts", "counted"),
      // Its first attempt fails after its point; the second completes.
      ...countingWorkflow("retried", "retried", {
        afterwards: `if (seen.ok && seen.value === 0) { throw new Error("Once more"); }`,
        options: `retries: { limit: 1, delay: "1 second" }`,
      }),
      // Every attempt runs out of time after its point.
      ...countingWorkflow("failing", "failed", {
        afterwards:
          "await new Promise((resolve) => setTimeout(resolve, 3000));",
        options: `timeout: "1 second", retries: { limit: 1, delay: "1 second" }`,
      }),
    });
    await bind(admin, app);
    const outcomes: Record<string, unknown> = {};
    for (const workflow of ["counts", "retried", "failing"]) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const run = await builder.api.workflows.start(app, workflow);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await finished(run.id);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const ended = await builder.api.workflows.status(run.id);
      const output = z
        .object({ during: z.json(), after: z.json() })
        .safeParse(ended.output);
      outcomes[workflow] = {
        status: ended.status,
        ...(output.success
          ? {
              during: countIn(output.data.during),
              after: countIn(output.data.after),
            }
          : {}),
      };
    }
    expect({
      outcomes,
      counted: await pointsOf(app, admin.userId, "counted"),
      retried: await pointsOf(app, admin.userId, "retried"),
      failed: await pointsOf(app, admin.userId, "failed"),
    }).toStrictEqual({
      outcomes: {
        // Not added up while the step runs; added up once it completed.
        counts: { status: "completed", during: 0, after: 1 },
        retried: { status: "completed", during: 0, after: 1 },
        failing: { status: "failed" },
      },
      counted: 1,
      // Two attempts recorded a point each: the one that completed counts.
      retried: 1,
      failed: 0,
    });
  });
});
