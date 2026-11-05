import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { BindingTargetInput } from "@grasp-os/shared/resource-bindings";
import {
  statisticMaxApps,
  statisticReadLimitsOf,
} from "@grasp-os/shared/statistics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { appFor } from "../src/apps.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { requestPermission } from "../src/permissions.ts";
import { readPlatformStatistics } from "../src/statistics.ts";
import { release, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { seedResourceRun } from "./runs.ts";
import { failure, person } from "./sealed-apps.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// The platform's statistics (src/statistics.ts) through an App's sealed
// functions: the platform's own read-only functions its actions declare
// (`permission.grasp`, `ctx.apps.grasp`), which reach nothing until an
// admin binds them to the App's permission to read the platform's
// statistics (resource-grasp.ts). These tests start from the ways it can
// fail: a declaration that grants itself, or a binding that serves
// without a live grant, or names another App's; a read of an App whose
// runs the person it acts for may not see; a read past its bounds (days,
// groups, Apps, a call's or a minute's reads); a read that isn't
// audited; and a read reading a table whole.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * An App whose actions read the platform's runs and signals through
 * `grasp`; each answers what it got, or the error's code and details, as
 * JSON text.
 */
const statsFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ marks: defineTable({ at: v.number() }) });
`,
  "server/stats.ts": `import { permission, v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const grasp = permission.grasp();

// What the declaration may leave out, called past its types on purpose:
// the call is what refuses it.
const loose = (client: object) =>
  client as unknown as Record<string, (...input: unknown[]) => Promise<unknown>>;

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

export const platformRead = action({
  args: json,
  returns: v.string(),
  uses: [grasp],
  handler: async (ctx, args) =>
    await outcome(async () => await loose(ctx.apps.grasp).call("statistics.read", JSON.parse(args.json))),
});

// A function the platform doesn't serve, called past the types.
export const platformWrite = action({
  args: json,
  returns: v.string(),
  uses: [grasp],
  handler: async (ctx, args) =>
    await outcome(async () => await loose(ctx.apps.grasp).call("statistics.write", JSON.parse(args.json))),
});

export const platformReadMany = action({
  args: many,
  returns: v.string(),
  uses: [grasp],
  handler: async (ctx, args) =>
    await outcome(async () => {
      for (let read = 0; read < args.count; read += 1) {
        await loose(ctx.apps.grasp).call("statistics.read", JSON.parse(args.json));
      }
    }),
});

// \`count\` reads at once.
export const platformReadBurst = action({
  args: many,
  returns: v.string(),
  uses: [grasp],
  handler: async (ctx, args) =>
    await outcome(async () => {
      await Promise.all(
        Array.from({ length: args.count }, async () => await loose(ctx.apps.grasp).call("statistics.read", JSON.parse(args.json)))
      );
    }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import { grasp } from "./server/stats.ts";
import schema from "./schema.ts";

export default app({
  name: "Stats",
  schema,
  access: { tables: { marks: { read: "owner", write: "owner" } } },
  screens: [],
  permissions: { apps: [grasp] },
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

/** `admin`'s binding of the App's `grasp` to `target`, for its current version. */
const bind = async (admin: Person, app: AppId, target: BindingTargetInput) =>
  await admin.api.resourceBindings.approve({
    app,
    alias: "grasp",
    target,
    reviewed: { version: await currentVersion(app) },
  });

/** `app`'s permission to read the platform's statistics, asked for by `builder` and granted: its ID. */
const grantedPlatform = async (builder: Person, app: AppId): Promise<string> =>
  await requestGranted(idp, builder, {
    subject: { type: "app", appId: app },
    object: { type: "platform" },
    actions: ["statistics"],
    binding: "PLATFORM",
  });

/**
 * `app`'s permission to read the platform's statistics, asked for by
 * `builder` and granted, and its `grasp` bound to it: the permission's ID.
 */
const grantPlatform = async (builder: Person, app: AppId): Promise<string> => {
  const permissionId = await grantedPlatform(builder, app);
  await bind(await signedInApi(idp, "admin"), app, {
    kind: "grasp",
    permissionId,
  });
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
      reference: { name: path, kind: operation.kind },
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

/** Reads `query` through `app`'s `grasp`, as `userId`. */
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

/**
 * A run of the independent workflow `app` binds as `alias`, started `ago`
 * milliseconds back: bound to a new workflow of the App's owner the first
 * time.
 */
const seedRun = async (app: string, alias: string, ago = 0) => {
  const bound = await env.DB.prepare(
    "SELECT workflow_resource_id AS workflow FROM app_workflow_bindings WHERE app_id = ? AND alias = ? AND status = 'active'"
  )
    .bind(app, alias)
    .first<{ workflow: string }>();
  const owner = await env.DB.prepare("SELECT owner_id FROM apps WHERE id = ?")
    .bind(app)
    .first<string>("owner_id");
  const principal = owner ?? "";
  let workflow = bound?.workflow;
  if (workflow === undefined) {
    workflow = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(workflow, `${alias}-${unique()}`, principal, Date.now()),
      env.DB.prepare(
        "INSERT INTO app_workflow_bindings (id, app_id, alias, workflow_resource_id, workflow_resource_version, status, bound_by, bound_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)"
      ).bind(crypto.randomUUID(), app, alias, workflow, principal, Date.now()),
    ]);
  }
  await seedResourceRun({
    workflow,
    principal,
    status: "completed",
    createdAt: Date.now() - ago,
  });
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

describe("the platform's functions", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reach nothing until an admin binds them to a live grant of the App's own, and serve only the platform's read", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const app = await statsApp(builder);
    const watched = await countedApp(admin);
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    const unbound = await platformRead(app, admin.userId, query);
    const permissionId = await grantedPlatform(builder, app);
    // What an admin reviews: what it declares, and the App's grants it may
    // be bound to.
    const { resources } = await admin.api.resourceBindings.review(app);
    const reviewed = resources.map(
      ({ alias, kind, operations, state, choices }) => ({
        alias,
        kind,
        operations,
        state,
        choices,
      })
    );
    // No binding without a permission, nor with one that isn't the App's.
    const unnamed = await failure(
      async () =>
        await bind(admin, app, {
          kind: "grasp",
          permissionId: permissionIdSchema.parse(crypto.randomUUID()),
        })
    );
    // As another App: the target of another kind serves it nothing.
    const asApp = await failure(
      async () => await bind(admin, app, { kind: "app", appId: watched })
    );
    // A builder may not approve one.
    const byBuilder = await failure(
      async () => await bind(builder, app, { kind: "grasp", permissionId })
    );
    await bind(admin, app, { kind: "grasp", permissionId });
    const bound = await platformRead(app, admin.userId, query);
    // A function the platform doesn't serve: refused before it reaches it.
    const write = await callAs(app, admin.userId, "stats.platformWrite", {
      json: JSON.stringify(query),
    });
    // Revoked: the next request is refused.
    const listed = await admin.api.resourceBindings.list(app);
    const active = listed.find(
      ({ alias, status }) => alias === "grasp" && status === "active"
    );
    await admin.api.resourceBindings.revoke(active?.id ?? "");
    const revoked = await platformRead(app, admin.userId, query);
    expect({
      reviewed,
      unbound,
      unnamed,
      asApp,
      byBuilder,
      bound: answerSchema.parse(bound).ok.groups,
      write,
      revoked,
    }).toStrictEqual({
      reviewed: [
        {
          alias: "grasp",
          kind: "grasp",
          operations: ["statistics.read"],
          state: "unbound",
          choices: {
            kind: "grasp",
            permissions: [{ permissionId }],
            truncated: false,
          },
        },
      ],
      unbound: { error: "resource.unavailable" },
      unnamed: "resource.target_invalid",
      asApp: "resource.undeclared",
      byBuilder: "role.forbidden",
      bound: [],
      write: { error: "resource.not_allowed" },
      revoked: { error: "resource.unavailable" },
    });
  });

  it("are read no more often than a call or a minute allows", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    await grantPlatform(admin, app);
    const watched = await countedApp(admin);
    const at = holdClock();
    // Lowered for tests (vite.config.ts).
    const { perCall, perMinute } = statisticReadLimitsOf(
      env.STATISTICS_READ_LIMITS
    );
    const query = JSON.stringify({
      measure: "platform.workflow_runs",
      days: 1,
      where: { app: watched },
    });
    const readMany = async (count: number) =>
      await callAs(app, admin.userId, "stats.platformReadMany", {
        json: query,
        count,
      });
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
    const app = await statsApp(admin);
    await grantPlatform(admin, app);
    const watched = await countedApp(admin);
    holdClock();
    const { perCall } = statisticReadLimitsOf(env.STATISTICS_READ_LIMITS);
    await expect(
      callAs(app, admin.userId, "stats.platformReadBurst", {
        json: JSON.stringify({
          measure: "platform.workflow_runs",
          days: 1,
          where: { app: watched },
        }),
        count: perCall + 1,
      })
    ).resolves.toStrictEqual(limited("call"));
  });
});

describe("the platform's statistics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are read at the platform only under a live permission, refused and audited otherwise", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await statsApp(builder);
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
          await readPlatformStatistics(
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
    const reader = await statsApp(builder);
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
    const another = await statsApp(builder);
    const theirs = await grantPlatform(builder, another);
    const othersGrant = await failure(
      async () =>
        await bind(admin, reader, {
          kind: "grasp",
          permissionId: permissionIdSchema.parse(theirs),
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
      unknownDimension: await runs(admin.userId, { groupBy: ["startedBy"] }),
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
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
      othersGrant: "resource.target_invalid",
      revoked: { error: "resource.unavailable" },
    });
  });

  it("count an independent workflow's runs under each App's alias for it, never through a binding removed", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await statsApp(builder);
    await grantPlatform(builder, reader);
    const watched = await countedApp(admin);
    // Two independent workflows: `intake` bound to the App now, `old` once.
    const workflowOf = async (name: string): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO workflow_resources (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(id, `${name}-${unique()}`, admin.userId, Date.now())
        .run();
      return id;
    };
    const [intake, old] = await Promise.all([
      workflowOf("intake"),
      workflowOf("old"),
    ]);
    const boundAs = async (
      workflow: string,
      alias: string,
      status: "active" | "removed"
    ) => {
      await env.DB.prepare(
        "INSERT INTO app_workflow_bindings (id, app_id, alias, workflow_resource_id, workflow_resource_version, status, bound_by, bound_at, removed_by, removed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          watched,
          alias,
          workflow,
          status,
          admin.userId,
          Date.now(),
          status === "removed" ? admin.userId : null,
          status === "removed" ? Date.now() : null
        )
        .run();
    };
    await boundAs(intake, "intake", "active");
    await boundAs(old, "old", "removed");
    const at = holdClock();
    await seedRun(watched, "pay");
    for (const workflow of [intake, intake, old]) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await seedResourceRun({
        workflow,
        principal: admin.userId,
        status: "completed",
        createdAt: at,
      });
    }
    const runs = async (change: Record<string, unknown>) =>
      answerSchema
        .parse(
          await platformRead(reader, admin.userId, {
            measure: "platform.workflow_runs",
            days: 7,
            where: { app: watched },
            ...change,
          })
        )
        .ok.groups.map(({ dimensions, count: n }) => ({ dimensions, n }));

    expect({
      byWorkflow: await runs({ groupBy: ["workflow"] }),
      byAlias: await runs({
        where: { app: watched, workflow: "intake" },
        groupBy: [],
      }),
      removed: await runs({
        where: { app: watched, workflow: "old" },
        groupBy: [],
      }),
    }).toStrictEqual({
      byWorkflow: [
        { dimensions: { workflow: "intake" }, n: 2 },
        { dimensions: { workflow: "pay" }, n: 1 },
      ],
      byAlias: [{ dimensions: {}, n: 2 }],
      removed: [],
    });
  });

  it("count many Apps' runs in one read, grouped by App, the ones it can't read listed unavailable, audited once with every App asked for", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await statsApp(builder);
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
      oneAndApps: { error: "resource.invalid_args" },
      oneGone: { error: "resource.item_not_found" },
    });
  });

  it("count the runs and signals of as many Apps as one read takes, by index", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
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
          /from "(?:apps|improvement_signals|workflow_resource_runs|app_workflow_bindings)"/u.test(
            sql
          )
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
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    holdClock();
    // 101 workflows ran a minute ago: two pages of groups.
    for (let i = 1; i <= 101; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one workflow after another
      await seedRun(watched, `w${i}`, 60_000);
    }
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
    const reader = await statsApp(admin);
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
    const reader = await statsApp(admin);
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
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await countedApp(admin);
    const held = holdClock();
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    const { perCall } = statisticReadLimitsOf(env.STATISTICS_READ_LIMITS);
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
      // No platform measure at all: audited all the same, never with the
      // App's own text. No query object at all is the host's to refuse,
      // before it reaches the platform.
      results.notPlatform = await platformRead(reader, admin.userId, {
        measure: "secret plans",
        days: 7,
      });
      results.notAQuery = await platformRead(reader, admin.userId, "secret");
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
        // A measure the platform doesn't publish: refused as it is read,
        // and audited as every refused read is.
        unknown: { error: "resource.invalid_args" },
        notPlatform: { error: "resource.invalid_args" },
        notAQuery: { error: "resource.not_allowed" },
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
        ...Array.from({ length: 2 }, () => ({
          app: undefined,
          measure: "platform.unknown",
          refused: "statistics.invalid",
        })),
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
