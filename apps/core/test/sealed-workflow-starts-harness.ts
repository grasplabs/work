import type { OperationResult } from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// What sealed-workflow-starts*.test.ts share: the App that binds a
// workflow, and how they start its runs and read them.

export const files = (): TestApp =>
  testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { who: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1) }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
    },
    {
      "server/requests.ts": `import { v } from "@grasp-os/runtime";
import { action, mutation } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

export const submit = mutation({
  args: { who: v.string() },
  returns: v.id("requests"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("requests", { who: args.who });
    await ctx.workflows.followUp.start({ who: args.who });
    return id;
  },
});

export const kickOff = action({
  args: { who: v.string() },
  returns: v.object({
    startId: v.string(),
    runId: v.string().nullable(),
    version: v.number().integer(),
  }),
  handler: async (ctx, args) => await ctx.workflows.followUp.start({ who: args.who }),
});
`,
    }
  );

export const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/**
 * A step `id` that runs and ends at once: a wait until a deadline long
 * past, whose enter step records it, so the run's history has a step of
 * it.
 */
export const passing = (id: string) => ({
  id,
  type: "wait",
  until: { $expr: "0" },
});

/**
 * A greeting workflow's definition, its one step `greet`; `wait`, if
 * given, a wait first, so one version differs from another.
 */
export const definitionOf = (wait?: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: { $expr: '"Hello, " + args.who' } },
    steps: [
      ...(wait === undefined ? [] : [{ id: "pause", type: "wait", for: wait }]),
      passing("greet"),
    ],
  });

/** What `by` may hand a permission request: their App and resource roles. */
export const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** The run IDs a runs page answered, or its refusal's code alone. */
export const runIds = (result: OperationResult): string[] =>
  result.ok
    ? z
        .object({
          items: z.array(z.object({ run: z.object({ runId: z.string() }) })),
        })
        .parse(result.value)
        .items.map(({ run }) => run.runId)
    : [result.error.code];

/** "ok", or a refusal's code and words. */
export const refusalOf = (result: OperationResult) =>
  result.ok ? "ok" : { code: result.error.code, message: result.error.message };

/** "ok", or a refusal's code. */
export const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

/** A greeting workflow `owner` publishes at version 1. */
export const greetingOf = async (owner: Identity) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf(),
    basedOn: null,
  });
  return workflow;
};

/**
 * The Requests App sealed and current, `members` given the user role in
 * it, and `workflowId` bound as `followUp` with the App's `start` grant.
 */
export const requestsApp = async (
  admin: Identity,
  members: readonly Identity[],
  workflowId: string,
  owner?: Identity
) => {
  const fixture = await appWith(files(), "Requests", owner);
  const release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- a row each
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fixture.app, member.userId, fixture.owner.userId, Date.now())
      .run();
  }
  const binding = await bindWorkflowToApp(env, fixture.owner, workflowId, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  const asked = await requestPermission(
    env,
    fixture.owner,
    {
      subject: { type: "app", appId: fixture.app },
      object: { type: "workflow", workflowId },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    rolesOf(fixture.owner)
  );
  await grantPermission(env, admin, asked.id, { version: 1 });
  return { ...fixture, release, binding: binding.id };
};

/** `count` runs of `workflowId` App `app` started for `principal`, as their rows. */
export const startedRuns = async (
  app: string,
  workflowId: string,
  principal: string,
  count: number
): Promise<void> => {
  const statements = Array.from({ length: count }, (_, index) => {
    const id = crypto.randomUUID();
    const at = Date.UTC(2026, 0, 1) + index * 1000;
    return [
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'app', ?, ?, ?, 1, 'm', ?, 1, 'h', ?)"
      ).bind(id, app, `key-${id}`, workflowId, principal, at),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at) VALUES (?, ?, 1, 'm', 'b', ?, 'completed', ?, ?)"
      ).bind(id, workflowId, principal, at, at + 500),
    ];
  });
  await env.DB.batch(statements.flat());
};

/**
 * The Requests App with `workflowId` bound as `followUp` before its seal,
 * so its release pins version 1, current, `members` given the user role,
 * with the App's `start` grant.
 */
export const pinnedApp = async (
  admin: Identity,
  members: readonly Identity[],
  workflowId: string,
  owner: Identity
) => {
  const fixture = await appWith(files(), "Requests", owner);
  await bindWorkflowToApp(env, owner, workflowId, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  const release = await seal(fixture);
  await publishVersion(env, owner, fixture.app, 1);
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- a row each
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fixture.app, member.userId, owner.userId, Date.now())
      .run();
  }
  const asked = await requestPermission(
    env,
    owner,
    {
      subject: { type: "app", appId: fixture.app },
      object: { type: "workflow", workflowId },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    rolesOf(owner)
  );
  await grantPermission(env, admin, asked.id, { version: 1 });
  return { fixture, release };
};

/** A workflow of `name` running `tasks` steps, one after another. */
export const longDefinitionOf = (tasks: number): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: "done" },
    steps: Array.from({ length: tasks }, (_, index) => passing(`step${index}`)),
  });

/**
 * A workflow whose step `greet` fails on an expression that reads the
 * input: a text has no `toFixed`.
 */
export const failingDefinition = JSON.stringify({
  $schema: workflowSchemaUrl,
  args: objectSchema({ who: { kind: "string" } }),
  returns: objectSchema({ status: { kind: "string" } }),
  result: { status: "done" },
  steps: [
    {
      ...passing("greet"),
      if: { $expr: 'args.who.split("")[9999].toUpperCase() === ""' },
    },
  ],
});

export const historySchema = z.object({
  items: z.array(z.looseObject({ sequence: z.number(), kind: z.string() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
