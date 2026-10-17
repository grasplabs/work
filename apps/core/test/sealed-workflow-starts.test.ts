/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { OperationResult } from "@grasp-os/shared/operations";
import { roleErrors } from "@grasp-os/shared/roles";
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
import { appFor, commitFiles, setCurrentVersion } from "../src/apps.ts";
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

/** "ok", or a refusal's code and words. */
const refusalOf = (result: OperationResult) =>
  result.ok ? "ok" : { code: result.error.code, message: result.error.message };

/** "ok", or a refusal's code. */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

/** A greeting workflow `owner` publishes at version 1. */
const greetingOf = async (owner: Identity) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf(workflow.name),
    basedOn: null,
  });
  return workflow;
};

/**
 * The Requests App sealed and current, `members` given the user role in
 * it, and `workflowId` bound as `followUp` with the App's `start` grant.
 */
const requestsApp = async (
  admin: Identity,
  members: readonly Identity[],
  workflowId: string,
  owner?: Identity
) => {
  const fixture = await appWith(files(), "Requests", owner);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
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
const startedRuns = async (
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
      // Sealed before the App bound anything, the release pins no
      // workflow version: it reads no run's history, its own included.
      ownHistory: "workflow.run_unavailable",
      othersHistory: "workflow.run_unavailable",
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
      historyWindow: codeOf(
        await ask(bob, references.history, { runId: first }, 10)
      ),
    }).toStrictEqual({
      forged: "version.mismatch",
      unknown: "operation.not_found",
      status: "contract.invalid_args",
      cursor: "data.invalid_cursor",
      historyWindow: "workflow.run_unavailable",
    });

    // A caller no longer allowed to call (an agent whose permission was
    // withdrawn) is refused before anything is read.
    const withdrawn = await callAppFunction(
      env,
      bob,
      app,
      JSON.stringify({ reference: references.runs, input: { pagination: {} } }),
      Date.now() + 30_000,
      async () => {
        await Promise.reject(roleErrors.create("role.forbidden"));
      }
    );
    expect(codeOf(withdrawn.result)).toBe("role.forbidden");

    // Without the binding, nothing is read.
    await unbindWorkflowFromApp(env, owner, binding.id);
    expect(codeOf(await ask(bob, references.runs, { pagination: {} }))).toBe(
      "resource.unavailable"
    );
  });

  it("keep each App's runs its own, answer a window of more than a page, and follow access, revocation and rebinding", async () => {
    const admin = await person("admin");
    const bob = await person("user");
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const first = await requestsApp(admin, [bob], workflow.id, owner);
    const second = await requestsApp(admin, [bob], workflow.id, owner);
    // 150 runs of Bob's through the first App, 3 through the second.
    await startedRuns(first.app, workflow.id, bob.userId, 150);
    await startedRuns(second.app, workflow.id, bob.userId, 3);
    const runs = await queryReference(first.release, "followUp", "runs");
    const ask = async (input: unknown, window?: number) => {
      const request = JSON.stringify({
        reference: runs,
        input,
        ...(window === undefined ? {} : { window: { extent: window } }),
      });
      const { result } =
        window === undefined
          ? await callAppFunction(env, bob, first.app, request)
          : await callScreenFunction(
              env,
              bob,
              first.app,
              request,
              Date.now() + 30_000,
              async () => {
                // A window's pages cost nothing here.
              }
            );
      return result;
    };
    const askSecond = async () => {
      const answer = await callAppFunction(
        env,
        bob,
        second.app,
        JSON.stringify({
          reference: await queryReference(second.release, "followUp", "runs"),
          input: { pagination: {} },
        })
      );
      return answer.result;
    };
    const firstPage = await ask({ pagination: {} });
    const cursor = firstPage.ok
      ? z.object({ nextCursor: z.string() }).parse(firstPage.value).nextCursor
      : "";
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT runs.id FROM workflow_resource_runs AS runs JOIN workflow_start_receipts AS receipts ON receipts.id = runs.id WHERE runs.workflow_resource_id = ? AND receipts.invoker_type = 'app' AND receipts.invoker_id = ? AND receipts.principal_id = ? AND runs.principal_id = ? ORDER BY runs.created_at DESC, runs.id DESC LIMIT 51"
    )
      .bind(workflow.id, first.app, bob.userId, bob.userId)
      .all<{ detail: string }>();
    expect({
      window: runIds(await ask({}, 500)).length,
      firstPage: runIds(firstPage).length,
      secondApp: runIds(await askSecond()).length,
      indexed: plan.results.some(({ detail }) =>
        detail.includes("workflow_resource_runs_principal_idx")
      ),
    }).toStrictEqual({
      window: 150,
      firstPage: 50,
      secondApp: 3,
      indexed: true,
    });

    // The alias bound to another workflow: none of the old one's runs,
    // whatever place in their list a cursor names.
    const other = await greetingOf(owner);
    await bindWorkflowToApp(env, owner, other.id, {
      app: first.app,
      alias: "followUp",
      version: 1,
    });
    const rebound = {
      fresh: runIds(await ask({ pagination: {} })),
      oldCursor: runIds(await ask({ pagination: { cursor } })),
    };

    // A call whose deadline passed while it loaded reads nothing either.
    const lateAnswer = await callAppFunction(
      env,
      bob,
      first.app,
      JSON.stringify({ reference: runs, input: { pagination: {} } }),
      Date.now() - 1
    );
    expect(codeOf(lateAnswer.result)).toBe("operation.deadline_exceeded");
    // Revoked, or the person's role taken away, while the call runs:
    // checked again just before anything is read.
    const during = async (app: string, change: () => Promise<unknown>) => {
      const answer = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({
          reference:
            app === first.app
              ? runs
              : await queryReference(second.release, "followUp", "runs"),
          input: { pagination: {} },
        }),
        Date.now() + 30_000,
        async () => {
          await change();
        }
      );
      return codeOf(answer.result);
    };
    const lateRemoved = await during(
      second.app,
      async () =>
        await env.DB.prepare(
          "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
        )
          .bind(second.app, bob.userId)
          .run()
    );
    const lateRevoked = await during(
      first.app,
      async () =>
        await env.DB.prepare(
          "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
        )
          .bind(Date.now(), first.app)
          .run()
    );
    expect({ lateRemoved, lateRevoked }).toStrictEqual({
      lateRemoved: "app.not_found",
      lateRevoked: "version.revoked",
    });

    // A release revoked while current answers nothing.
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET revoked_at = ? WHERE app_id = ? AND version = 1"
    )
      .bind(Date.now(), first.app)
      .run();
    const revoked = codeOf(await ask({ pagination: {} }));

    // Nor to someone no longer in the App.
    await env.DB.prepare(
      "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
    )
      .bind(second.app, bob.userId)
      .run();
    const removed = codeOf(await askSecond());
    expect({ rebound, revoked, removed }).toStrictEqual({
      rebound: { fresh: [], oldCursor: [] },
      revoked: "version.revoked",
      removed: "app.not_found",
    });
  });
});

/**
 * The Requests App with `workflowId` bound as `followUp` before its seal,
 * so its release pins version 1, current, `members` given the user role,
 * with the App's `start` grant.
 */
const pinnedApp = async (
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
  await setCurrentVersion(env, owner, fixture.app, 1);
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

/** A workflow whose task fails on an expression that reads the input. */
const failingDefinitionOf = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "2.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        greet: {
          set: { status: "${ $workflow.input.who | tonumber | tostring }" },
        },
      },
    ],
  });

const historySchema = z.object({
  items: z.array(z.looseObject({ sequence: z.number(), kind: z.string() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

describe("a workflow reference's run history", { timeout: 180_000 }, () => {
  it("tells the person's own runs of the version the release pins, metadata only, and refuses every other run alike", async () => {
    const admin = await person("admin");
    const [bob, carol] = await Promise.all([person("user"), person("user")]);
    const owner = await person("builder");
    const workflow = await greetingOf(owner);
    const { fixture, release } = await pinnedApp(
      admin,
      [bob, carol],
      workflow.id,
      owner
    );
    const { app } = fixture;
    const kickOff = async (
      who: Identity,
      name: string,
      other?: { app: string; release: typeof release }
    ): Promise<string> => {
      const through = other ?? { app, release };
      const { result } = await callAppFunction(
        env,
        who,
        through.app,
        JSON.stringify({
          reference: {
            resourceId: through.release.manifest.resourceId,
            resourceVersion: through.release.manifest.resourceVersion,
            contractId: "requests.kickOff",
            fingerprint: through.release.fingerprints["requests.kickOff"] ?? "",
            kind: "action",
          },
          input: { who: name },
        })
      );
      if (!result.ok) {
        throw new Error(result.error.code);
      }
      return z.object({ runId: z.string() }).parse(result.value).runId;
    };
    const settled = async (runId: string) =>
      await vi.waitFor(
        async () => {
          const run = await resourceRunFor(env, admin, workflow.id, runId);
          expect(run.endedAt).not.toBeNull();
          return run;
        },
        { timeout: 30_000, interval: 100 }
      );
    const bobs = await kickOff(bob, "Bob");
    const carols = await kickOff(carol, "Carol");
    // Bob's run of the same version, through another App pinning it too.
    const otherApp = await pinnedApp(admin, [bob], workflow.id, owner);
    const throughOther = await kickOff(bob, "Bob", {
      app: otherApp.fixture.app,
      release: otherApp.release,
    });
    await Promise.all([settled(bobs), settled(carols), settled(throughOther)]);
    // The owner's own start, not through the App: never the App's to tell.
    const direct = await startWorkflow(
      env,
      { type: "person", person: owner },
      workflow.id,
      { version: 1, input: { who: "Owner" }, key: `key-${unique()}` }
    );

    const history = await queryReference(release, "followUp", "history");
    const ask = async (
      who: Identity,
      input: unknown,
      window?: number
    ): Promise<OperationResult> => {
      const request = JSON.stringify({
        reference: history,
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
    const pageOf = (result: OperationResult) =>
      historySchema.parse(result.ok ? result.value : result);
    const whole = pageOf(await ask(bob, { runId: bobs, pagination: {} }));
    // Page by page, one entry each, from each page's cursor.
    const paged: unknown[] = [];
    let cursor: string | null = null;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
      const answer = await ask(bob, {
        runId: bobs,
        pagination: { pageSize: 1, cursor },
      });
      const page = pageOf(answer);
      paged.push(...page.items);
      ({ nextCursor: cursor } = page);
    } while (cursor !== null);
    const window = await ask(bob, { runId: bobs }, 50);
    expect({
      told: whole.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(
            ([key]) => key !== "id" && key !== "sequence" && key !== "at"
          )
        )
      ),
      ascending: whole.items.every(
        (item, index) =>
          index === 0 || item.sequence > (whole.items[index - 1]?.sequence ?? 0)
      ),
      paged,
      window: window.ok ? window.value : window.error.code,
    }).toStrictEqual({
      // Metadata only: no input, output or engine step ID; the task named
      // by the ID its sealed build declares.
      told: [
        { taskId: null, kind: "lifecycle", status: "queued" },
        { taskId: null, kind: "lifecycle", status: "running" },
        { taskId: "greet", kind: "step", state: "started", attempt: 1 },
        { taskId: "greet", kind: "step", state: "completed", attempt: 1 },
        { taskId: null, kind: "lifecycle", status: "completed" },
      ],
      ascending: true,
      paged: whole.items,
      window: { items: whole.items, hasMore: false },
    });

    // Anyone else's run, a run started outside the App, and an ID no run
    // has are one refusal, word for word; a cursor tells nothing of them.
    const unknown = refusalOf(
      await ask(bob, { runId: crypto.randomUUID(), pagination: {} })
    );
    expect({
      carols: refusalOf(await ask(bob, { runId: carols, pagination: {} })),
      direct: refusalOf(await ask(owner, { runId: direct.id, pagination: {} })),
      otherApps: refusalOf(
        await ask(bob, { runId: throughOther, pagination: {} })
      ),
      carolsWithBadCursor: refusalOf(
        await ask(bob, { runId: carols, pagination: { cursor: "x" } })
      ),
      carolsWindow: refusalOf(await ask(bob, { runId: carols }, 50)),
      ownBadCursor: codeOf(
        await ask(bob, { runId: bobs, pagination: { cursor: "x" } })
      ),
      carolOwn: pageOf(await ask(carol, { runId: carols, pagination: {} }))
        .items.length,
    }).toStrictEqual({
      carols: unknown,
      direct: unknown,
      otherApps: unknown,
      carolsWithBadCursor: unknown,
      carolsWindow: unknown,
      ownBadCursor: "data.invalid_cursor",
      carolOwn: 5,
    });
    expect(unknown).toMatchObject({ code: "workflow.run_unavailable" });

    // Rebound to version 2, which fails on what it reads: version 1's
    // release tells none of version 2's runs, and a release sealed after
    // the rebind, none of version 1's. A failure's own words never leave.
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: failingDefinitionOf(workflow.name),
      basedOn: 1,
    });
    await bindWorkflowToApp(env, owner, workflow.id, {
      app,
      alias: "followUp",
      version: 2,
    });
    const secret = `Secret-${unique()}`;
    const failed = await kickOff(bob, secret);
    await settled(failed);
    const throughOld = refusalOf(
      await ask(bob, { runId: failed, pagination: {} })
    );
    await commitFiles(
      env,
      owner,
      app,
      {
        ...files(),
        "app.ts": `${files()["app.ts"] ?? ""}// Sealed again.\n`,
      },
      "Seal again"
    );
    const next = await seal(fixture, 2);
    await setCurrentVersion(env, owner, app, 2);
    const nextHistory = await queryReference(next, "followUp", "history");
    const askNext = async (input: unknown) => {
      const answer = await callAppFunction(
        env,
        bob,
        app,
        JSON.stringify({ reference: nextHistory, input })
      );
      return answer.result;
    };
    const failedPage = await askNext({ runId: failed, pagination: {} });
    const failedItems = pageOf(failedPage).items;
    expect({
      throughOld,
      oldRunThroughNext: refusalOf(
        await askNext({ runId: bobs, pagination: {} })
      ),
      failedStep: failedItems.find(
        (item) => item.kind === "step" && item.state === "failed"
      )?.error,
      leaks: JSON.stringify(failedPage).includes(secret),
    }).toStrictEqual({
      throughOld: unknown,
      oldRunThroughNext: unknown,
      // The engine's code and words, never what the expression read.
      failedStep: {
        code: "expression.failed",
        message: "A step of the workflow failed.",
        category: "operational",
        retryable: false,
        requestId: null,
      },
      leaks: false,
    });

    // Once the retention sweep removed the run's details (as it marks
    // its receipt), its history tells nothing.
    await env.DB.prepare(
      "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
    )
      .bind(Date.now(), failed)
      .run();
    expect(
      pageOf(await askNext({ runId: failed, pagination: {} }))
    ).toStrictEqual({ items: [], nextCursor: null, hasMore: false });
  });
});
