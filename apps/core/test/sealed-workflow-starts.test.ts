/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  callAppFunction,
  callScreenFunction,
  evaluateAppQuery,
} from "../src/app-functions.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { appWith, person, queryReference, seal } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// Starting workflows from a sealed App's functions, as they run in their
// sandbox (spec 7.4, 9.5): the action's start and the mutation's staged
// start cross the isolate as every capability does, and land as runs of
// the workflow version the App binds. The threat model is tested
// against the operation host directly (workflow-app-starts.test.ts);
// this is the same path from the release's own code.

const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, mutation } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});

export const submit = mutation({
  args: { who: v.string() },
  returns: v.id("requests"),
  uses: [followUp],
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("requests", { who: args.who });
    await ctx.afterCommit.start(followUp, { who: args.who });
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
  uses: [followUp],
  handler: async (ctx, args) => await ctx.startWorkflow(followUp, { who: args.who }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp, kickOff, submit } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: { requests: { submit, kickOff } },
  screens: [],
  uses: [followUp],
});
`,
});

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A greeting workflow's definition. */
const definitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
    ],
  });

/** What `by` may hand a permission request: their App and resource roles. */
const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

describe("a sealed App's functions", { timeout: 120_000 }, () => {
  it("start the workflow the App binds, now from an action and after the commit from a mutation, for the person calling", async () => {
    const admin = await person("admin");
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const release = await seal(fixture);
    await setCurrentVersion(env, owner, app, 1);
    const bob = await person("user");
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(app, bob.userId, owner.userId, Date.now())
      .run();
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    await bindWorkflowToApp(env, owner, workflow.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    const asked = await requestPermission(
      env,
      owner,
      {
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["start"],
        binding: "FOLLOW_UP",
      },
      rolesOf(owner)
    );
    await grantPermission(env, admin, asked.id, { version: 1 });

    const call = async (
      path: "requests.submit" | "requests.kickOff",
      input: unknown
    ): Promise<OperationResult> => {
      const operation = release.app.operations[path];
      const { result } = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({
          reference: {
            resourceId: release.manifest.resourceId,
            resourceVersion: release.manifest.resourceVersion,
            contractId: path,
            fingerprint: release.fingerprints[path] ?? "",
            kind: operation?.kind,
          },
          input,
        })
      );
      return result;
    };
    const started = await call("requests.kickOff", { who: "Bob" });
    const submitted = await call("requests.submit", { who: "Ada" });
    if (release.store === null) {
      throw new Error("The release has no store");
    }
    await runDurableObjectAlarm(
      env.DATA_STORES.getByName(release.store.storeId)
    );
    const { results: receipts } = await env.DB.prepare(
      "SELECT id, principal_id FROM workflow_start_receipts WHERE invoker_type = 'app' AND invoker_id = ? ORDER BY created_at, id"
    )
      .bind(app)
      .all<{ id: string; principal_id: string }>();
    const outputs = await vi.waitFor(
      async () => {
        const runs = await Promise.all(
          receipts.map(
            async ({ id }) => await resourceRunFor(env, admin, workflow.id, id)
          )
        );
        expect(runs.every(({ endedAt }) => endedAt !== null)).toBeTruthy();
        return runs.map(({ output }) => output);
      },
      { timeout: 30_000, interval: 100 }
    );
    expect({
      started: started.ok ? started.value : started.error.code,
      submitted: submitted.ok,
      principals: receipts.map(({ principal_id }) => principal_id),
      outputs: outputs.toSorted((a, b) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : 1
      ),
    }).toStrictEqual({
      started: { startId: receipts[0]?.id, runId: receipts[0]?.id, version: 1 },
      submitted: true,
      principals: [bob.userId, bob.userId],
      outputs: [{ status: "Hello, Ada" }, { status: "Hello, Bob" }],
    });
  });
});

/** The run IDs a runs page answered, or its refusal's code alone. */
const runIds = (result: OperationResult): string[] =>
  result.ok
    ? z
        .object({
          items: z.array(z.object({ run: z.object({ runId: z.string() }) })),
        })
        .parse(result.value)
        .items.map(({ run }) => run.runId)
    : [result.error.code];

/** "ok", or a refusal's code. */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

describe("a workflow reference's queries", { timeout: 120_000 }, () => {
  it("list only the runs this App started for the person, of the workflow it binds, newest first, page by page", async () => {
    const admin = await person("admin");
    const fixture = await appWith(files(), "Requests");
    const { owner, app } = fixture;
    const release = await seal(fixture);
    await setCurrentVersion(env, owner, app, 1);
    const [bob, carol] = await Promise.all([person("user"), person("user")]);
    for (const member of [bob, carol]) {
      // oxlint-disable-next-line no-await-in-loop -- two rows, one each
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, member.userId, owner.userId, Date.now())
        .run();
    }
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    const binding = await bindWorkflowToApp(env, owner, workflow.id, {
      app,
      alias: "followUp",
      version: 1,
    });
    const asked = await requestPermission(
      env,
      owner,
      {
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["start"],
        binding: "FOLLOW_UP",
      },
      rolesOf(owner)
    );
    await grantPermission(env, admin, asked.id, { version: 1 });
    const kickOff = async (who: Identity): Promise<string> => {
      const { result } = await callAppFunction(
        env,
        who,
        app,
        JSON.stringify({
          reference: {
            resourceId: release.manifest.resourceId,
            resourceVersion: release.manifest.resourceVersion,
            contractId: "requests.kickOff",
            fingerprint: release.fingerprints["requests.kickOff"] ?? "",
            kind: "action",
          },
          input: { who: "Someone" },
        })
      );
      if (!result.ok) {
        throw new Error(result.error.code);
      }
      return z.object({ runId: z.string() }).parse(result.value).runId;
    };
    const first = await kickOff(bob);
    const second = await kickOff(bob);
    const carols = await kickOff(carol);
    // The owner starts one directly, not through the App: never the App's.
    const direct = await startWorkflow(
      env,
      { type: "person", person: owner },
      workflow.id,
      { version: 1, input: { who: "Owner" }, key: `key-${unique()}` }
    );

    const references = {
      runs: await queryReference(release, "followUp", "runs"),
      history: await queryReference(release, "followUp", "history"),
    };
    const ask = async (
      who: Identity,
      reference: object,
      input: unknown,
      window?: number
    ): Promise<OperationResult> => {
      const request = JSON.stringify({
        reference,
        input,
        ...(window === undefined ? {} : { window: { extent: window } }),
      });
      const { result } =
        window === undefined
          ? await callAppFunction(env, who, app, request)
          : await callScreenFunction(
              env,
              who,
              app,
              request,
              Date.now() + 30_000,
              async () => {
                // A window's pages cost nothing here.
              }
            );
      return result;
    };

    const firstPage = await ask(bob, references.runs, {
      pagination: { pageSize: 1 },
    });
    const cursor = firstPage.ok
      ? z.object({ nextCursor: z.string() }).parse(firstPage.value).nextCursor
      : "";
    const live = await evaluateAppQuery(
      env,
      bob,
      app,
      JSON.stringify({ reference: references.runs, input: { pagination: {} } }),
      Date.now() + 30_000,
      async () => {
        // A window's pages cost nothing here.
      }
    );
    expect({
      liveReads: live.reads,
      none: runIds(
        await ask(bob, references.runs, {
          status: "paused",
          pagination: {},
        })
      ),
      carol: runIds(await ask(carol, references.runs, { pagination: {} })),
      owner: runIds(await ask(owner, references.runs, { pagination: {} })),
      ownHistory: codeOf(
        await ask(bob, references.history, { runId: first, pagination: {} })
      ),
      othersHistory: codeOf(
        await ask(bob, references.history, { runId: carols, pagination: {} })
      ),
    }).toStrictEqual({
      // Read once, pushed once: no store read keeps it fresh yet.
      liveReads: undefined,
      none: [],
      carol: [carols],
      owner: [],
      ownHistory: "workflow.history_unavailable",
      othersHistory: "workflow.history_unavailable",
    });
    const bobs = runIds(await ask(bob, references.runs, { pagination: {} }));
    expect({
      bobs: bobs.toSorted(),
      pages: [
        ...runIds(firstPage),
        ...runIds(
          await ask(bob, references.runs, {
            pagination: { pageSize: 1, cursor },
          })
        ),
      ],
      window: runIds(await ask(bob, references.runs, {}, 10)),
      live: runIds(live.answer.result),
      direct: bobs.includes(direct.id),
    }).toStrictEqual({
      bobs: [first, second].toSorted(),
      pages: bobs,
      window: bobs,
      live: bobs,
      direct: false,
    });

    // References the release doesn't make, or arguments outside them.
    const forged = { ...references.runs, fingerprint: "0".repeat(64) };
    const unknown = {
      ...references.runs,
      contractId: "workflows.other.queries.runs",
    };
    expect({
      forged: codeOf(await ask(bob, forged, { pagination: {} })),
      unknown: codeOf(await ask(bob, unknown, { pagination: {} })),
      status: codeOf(
        await ask(bob, references.runs, { status: "lost", pagination: {} })
      ),
      cursor: codeOf(
        await ask(bob, references.runs, {
          pagination: { cursor: "not a cursor" },
        })
      ),
      notPaginated: codeOf(
        await ask(bob, references.history, { runId: first }, 10)
      ),
    }).toStrictEqual({
      forged: "version.mismatch",
      unknown: "operation.not_found",
      status: "contract.invalid_args",
      cursor: "data.invalid_cursor",
      notPaginated: "contract.not_paginated",
    });

    // Without the binding, nothing is read.
    await unbindWorkflowFromApp(env, owner, binding.id);
    expect(codeOf(await ask(bob, references.runs, { pagination: {} }))).toBe(
      "resource.unavailable"
    );
  });
});
