import { app, defineSchema, defineTable, v } from "@grasp-os/sdk";
import { inspectApp, manifestText } from "@grasp-os/sdk/host";
import { runFunction } from "@grasp-os/sdk/runner";
import { serverModule } from "@grasp-os/sdk/server";
import type { AppId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { operationRoles } from "../src/app-access.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { callOperation } from "../src/operations.ts";
import type { Runner } from "../src/operations.ts";

// The App's roles, as the operation host applies them to tables its
// members share (`appMembers`) and tables only its builders reach
// (`appBuilders`): through the host and the store together, with roles
// read from the App's real sharing, including a builder demoted while
// their mutation runs.

const schema = defineSchema({
  shared: defineTable({ title: v.string() }),
  staff: defineTable({ title: v.string() }),
});

const { mutation, query } = serverModule(schema);

const addShared = mutation({
  args: { title: v.string() },
  returns: v.id("shared"),
  handler: async (ctx, args) => await ctx.db.insert("shared", args),
});

const addStaff = mutation({
  args: { title: v.string() },
  returns: v.id("staff"),
  handler: async (ctx, args) => await ctx.db.insert("staff", args),
});

const countShared = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.db.query("shared").count(),
});

const countStaff = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.db.query("staff").count(),
});

/** Counts the staff table, and records that it did in the shared one. */
const auditStaff = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const staff = await ctx.db.query("staff").count();
    await ctx.db.insert("shared", { title: `staff: ${staff}` });
    return staff;
  },
});

const teamApp = app({
  name: "Team",
  schema,
  access: {
    tables: {
      shared: { read: "appMembers", write: "appMembers" },
      staff: { read: "appBuilders", write: "appBuilders" },
    },
  },
  operations: { addShared, addStaff, countShared, countStaff, auditStaff },
  screens: [],
  uses: [],
});

const { manifest } = inspectApp(teamApp);

const defaultRun: Runner = async (path, args, channel) =>
  await runFunction(teamApp, path, args, channel);

/** A person of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff: false };
};

interface Team {
  readonly owner: Acting;
  readonly appId: AppId;
  readonly store: OpenStore;
}

const team = async (): Promise<Team> => {
  const owner = await person("builder");
  const { id: appId } = await createApp(env, owner, { name: "Team" });
  const store = await openStore(env, await createStore(env, owner));
  await store.defineTables(manifestText(manifest.schema));
  return { owner, appId, store };
};

/** Shares the App with `by` in App role `role`. */
const share = async (
  { appId, owner }: Team,
  by: Acting,
  role: "user" | "builder"
) => {
  await drizzle(env.DB).insert(appMembers).values({
    appId,
    memberType: "person",
    memberId: by.userId,
    role,
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** Gives `by` App role `role` in the team's App. */
const reshare = async (
  { appId }: Team,
  by: Acting,
  role: "user" | "builder"
) => {
  await drizzle(env.DB)
    .update(appMembers)
    .set({ role })
    .where(
      and(eq(appMembers.appId, appId), eq(appMembers.memberId, by.userId))
    );
};

const call = async (
  { appId, store }: Team,
  by: Acting,
  kind: string,
  path: string,
  run: Runner = defaultRun
): Promise<OperationResult> =>
  await callOperation(
    { manifest, run },
    {
      principal: by.userId,
      consumer: { resourceId: appId, resourceVersion: 1 },
      store,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 60_000,
      runId: null,
      authorize: async () => await operationRoles(env, by, appId),
    },
    { path, kind },
    kind === "mutation" && path.startsWith("add") ? { title: "a" } : {}
  );

const outcome = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

describe("tables the App's members share", () => {
  it("are read and written by every member, whoever wrote the records", async () => {
    const fixture = await team();
    const member = await person("user");
    await share(fixture, member, "user");
    await call(fixture, fixture.owner, "mutation", "addShared");
    expect({
      write: typeof outcome(
        await call(fixture, member, "mutation", "addShared")
      ),
      read: outcome(await call(fixture, member, "query", "countShared")),
      outsider: outcome(
        await call(fixture, await person("user"), "query", "countShared")
      ),
    }).toStrictEqual({ write: "string", read: 2, outsider: "app.not_found" });
  });
});

describe("tables only the App's builders reach", () => {
  it("refuse a member's reads and writes, and take a builder's", async () => {
    const fixture = await team();
    const member = await person("user");
    const builder = await person("builder");
    await share(fixture, member, "user");
    await share(fixture, builder, "builder");
    expect({
      memberWrite: outcome(await call(fixture, member, "mutation", "addStaff")),
      memberRead: outcome(await call(fixture, member, "query", "countStaff")),
      builderWrite: typeof outcome(
        await call(fixture, builder, "mutation", "addStaff")
      ),
      builderRead: outcome(await call(fixture, builder, "query", "countStaff")),
    }).toStrictEqual({
      memberWrite: "data.write_denied",
      memberRead: "data.access_denied",
      builderWrite: "string",
      builderRead: 1,
    });
  });

  it("aren't read for a builder demoted while their mutation runs: it runs again under the role they have", async () => {
    const fixture = await team();
    const builder = await person("builder");
    await share(fixture, builder, "builder");
    await call(fixture, builder, "mutation", "addStaff");
    let runs = 0;
    const run: Runner = async (path, args, channel) => {
      runs += 1;
      const answer = await runFunction(teamApp, path, args, channel);
      if (runs === 1) {
        await reshare(fixture, builder, "user");
      }
      return answer;
    };
    const result = await call(fixture, builder, "mutation", "auditStaff", run);
    expect({ result: outcome(result), runs }).toStrictEqual({
      result: "data.access_denied",
      runs: 2,
    });
    // Nothing it read as a builder was committed.
    expect(
      outcome(await call(fixture, fixture.owner, "query", "countShared"))
    ).toBe(0);
  });
});
