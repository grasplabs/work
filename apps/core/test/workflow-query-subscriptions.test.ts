import { v } from "@grasp-os/runtime";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { decisionOutcome, openDecision } from "../src/decisions/decisions.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { mockIdp } from "./idp.ts";
import { appWith, queryReference, seal } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";

// A page's live workflow queries (`workflows.<alias>.queries.runs`,
// workflow-reference-queries.ts), followed through a frame's `watchQuery` as
// a page follows any live query (query-subscriptions.ts). They read no
// store, so no write tells core to read them again: a run the App starts
// for the person, and each change of its status, does instead
// (workflows/run-changes.ts, `tellQueryFollowers`), through the App's host
// to the person's connections, which read it again through the same gate,
// coalescing and budget as a write's.

const idp = mockIdp();

const files = (): TestApp =>
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
import { action } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;

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

      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Desk() {
  return <main>Requests</main>;
}

export const Route = createFileRoute("/")({ component: Desk });
`,
    }
  );

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A definition of `steps`, input `{ who }`, output `{ status }`. */
const documentOf = (
  steps: unknown[],
  status: unknown,
  permissions: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    permissions,
    steps,
  });

/** A greeting workflow's definition: it waits an hour, then greets. */
const definitionOf = (): string =>
  documentOf([{ id: "hold", type: "wait", for: "1 hour" }], {
    $expr: '"Hello, " + args.who',
  });

/** Someone signed in, and as core's own calls take them. */
const signedIn = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const acting: Acting & Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, acting };
};

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

const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** A page's callback: what reached it. */
const pageFollower = () => {
  const received: z.infer<typeof pushSchema>[] = [];
  const callback = Object.assign(
    (push: unknown): void => {
      received.push(pushSchema.parse(push));
    },
    {
      [Symbol.dispose]: (): void => {
        // Let go of: nothing more arrives.
      },
    }
  );
  return { received, callback };
};

const runsPageSchema = z.object({
  items: z.array(
    z.object({ run: z.object({ runId: z.string() }), status: z.string() })
  ),
});

/** The runs the latest push showed, as `id: status`. */
const latestRuns = (
  received: ReturnType<typeof pageFollower>["received"]
): string[] => {
  const latest = received.at(-1)?.result;
  if (latest === undefined || !latest.ok) {
    return [];
  }
  return runsPageSchema
    .parse(latest.value)
    .items.map(({ run, status }) => `${run.runId}: ${status}`);
};

/**
 * The Requests App sealed and current, its page opened by
 * its builder, `followUp` bound with the App's `start` grant; and the
 * builder's page following their runs of it, once its first push came.
 */
const followingRuns = async (
  /** Called with the App's ID before its page follows. */
  beforeFollow?: (app: string) => Promise<void>
) => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const workflow = await createWorkflowResource(
    env,
    builder.acting,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder.acting, workflow.id, {
    definition: definitionOf(),
    basedOn: null,
  });
  const fixture = await appWith(files(), "Requests", builder.acting);
  await seal(fixture);
  await publishVersion(env, builder.acting, fixture.app, 1);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  const asked = await requestPermission(
    env,
    builder.acting,
    {
      subject: { type: "app", appId: fixture.app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    },
    rolesOf(builder.acting)
  );
  await grantPermission(env, admin.acting, asked.id, { version: 1 });
  const { lease } = await builder.api.pages.open(fixture.app);
  const release = await loadRelease(env, fixture.app, 1);

  await beforeFollow?.(fixture.app);
  // The page follows the person's runs: none yet.
  const follower = pageFollower();
  const subscription = await builder.api.pages
    .frame(fixture.app, lease)
    .watchQuery(
      JSON.stringify({
        reference: queryReference(release, "followUp", "runs"),
        args: { pagination: {} },
      }),
      follower.callback
    );
  await vi.waitFor(
    () => {
      expect(follower.received.length).toBeGreaterThan(0);
    },
    { timeout: 30_000, interval: 50 }
  );
  return {
    builder: builder.acting,
    workflow: workflow.id,
    app: fixture.app,
    release,
    follower,
    subscription,
  };
};

/** Starts a run of `followUp` for `by` through the App's action: its ID. */
const kickOff = async (by: Acting & Identity, app: string): Promise<string> => {
  const started = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: { name: "requests.kickOff", kind: "action" },
      args: { who: "Ada" },
    })
  );
  return started.result.ok
    ? z.object({ runId: z.string() }).parse(started.result.value).runId
    : "";
};

/** Once the latest push to `follower` shows exactly `runs`. */
const showing = async (
  follower: ReturnType<typeof pageFollower>,
  runs: string[]
): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(latestRuns(follower.received)).toStrictEqual(runs);
    },
    { timeout: 30_000, interval: 50 }
  );
};

/** A workflow asking decision `contract` as `approval`, in its step `ask`. */
const decidingDefinitionOf = (contract: string): string =>
  documentOf(
    [
      {
        id: "ask",
        type: "decide",
        decision: "approval",
        recipients: ["role:admin"],
        prompt: "Approve this request?",
        input: { who: { $expr: "args.who" } },
      },
    ],
    "done",
    { decisions: { approval: { contract } } }
  );

const decisionsPageSchema = z.object({
  items: z.array(z.object({ wait: z.object({ id: z.string() }) })),
});

/** The decisions the latest push to `follower` listed, by ID. */
const latestDecisions = (
  received: ReturnType<typeof pageFollower>["received"]
): string[] => {
  const latest = received.at(-1)?.result;
  return latest === undefined || !latest.ok
    ? []
    : decisionsPageSchema.parse(latest.value).items.map(({ wait }) => wait.id);
};

describe("a page's live workflow queries", { timeout: 120_000 }, () => {
  it("show a run the App starts for the person, then each change of its status, with no subscribing again", async () => {
    const { builder, workflow, app, follower, subscription } =
      await followingRuns();
    const before = latestRuns(follower.received);

    // The App starts one for them: the page shows it running, pushed to
    // the same subscription.
    const runId = await kickOff(builder, app);
    await showing(follower, [`${runId}: running`]);
    // Cancelled while it waits: the page shows that too.
    await terminateResourceRun(env, builder, workflow, runId);
    await showing(follower, [`${runId}: cancelled`]);
    await subscription.release();
    expect(before).toStrictEqual([]);
  });

  it("reads them again once its connection follows the App again, so a run change made in between isn't missed", async () => {
    // The host takes the connection on as usual, then lets go of it (as a
    // restart does), and holds its following again until the test lets
    // it: the run changes in between, with no connection to tell.
    const ids: string[] = [];
    const gate = {
      open: false,
      ids,
      undo: (): void => {
        // Nothing patched yet.
      },
    };
    let stopFollowing: (() => Promise<void>) | undefined;
    try {
      const following = await followingRuns(async (appId) => {
        await runInDurableObject(
          appHost(env, appIdSchema.parse(appId)),
          (instance) => {
            // SAFETY: an App's object's prototype holds its methods.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const methods = Object.getPrototypeOf(instance) as Record<
              string,
              (...args: unknown[]) => Promise<unknown>
            >;
            const original = methods.followAccess;
            if (original === undefined) {
              throw new Error("An App's object follows access");
            }
            methods.followAccess = async function followAccess(
              this: unknown,
              ...args
            ) {
              if (gate.ids.length > 0) {
                while (!gate.open) {
                  // oxlint-disable-next-line no-await-in-loop -- until the test lets it
                  await scheduler.wait(20);
                }
              }
              const id = z.string().parse(await original.apply(this, args));
              gate.ids.push(id);
              return id;
            };
            gate.undo = () => {
              methods.followAccess = original;
            };
          }
        );
      });
      const { builder, app, follower, subscription } = following;
      stopFollowing = async () => {
        await subscription.release();
      };
      // Let go of by the host: the connection follows again, held.
      await runInDurableObject(
        appHost(env, appIdSchema.parse(app)),
        (instance) => {
          Reflect.apply(Reflect.get(instance, "unfollowAccess"), instance, [
            gate.ids[0],
          ]);
        }
      );
      const runId = await kickOff(builder, app);
      await vi.waitFor(
        async () => {
          const status = await env.DB.prepare(
            "SELECT status FROM workflow_resource_runs WHERE id = ?"
          )
            .bind(runId)
            .first<string>("status");
          expect(status).toBe("running");
        },
        { timeout: 30_000, interval: 50 }
      );
      gate.open = true;
      await showing(follower, [`${runId}: running`]);
    } finally {
      // Whatever failed, nothing stays held or patched for later tests.
      gate.open = true;
      gate.undo();
      await stopFollowing?.();
    }
  });

  it("list a decision of the App's run in a reviewer's live inbox as it opens, and take it out as it closes", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    const key = `approval-${unique()}`;
    await publishCatalogContract(env, admin.acting, {
      key,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `decide-${unique()}`
    );
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: decidingDefinitionOf(key),
      basedOn: null,
    });
    const fixture = await appWith(files(), "Requests", builder.acting);
    await bindWorkflowToApp(env, builder.acting, workflow.id, {
      app: fixture.app,
      alias: "followUp",
      version: 1,
    });
    await seal(fixture);
    await publishVersion(env, builder.acting, fixture.app, 1);
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fixture.app, admin.userId, builder.userId, Date.now())
      .run();
    const { lease } = await admin.api.pages.open(fixture.app);
    const release = await loadRelease(env, fixture.app, 1);
    // The admin's page follows their inbox: nothing in it yet.
    const follower = pageFollower();
    const subscription = await admin.api.pages
      .frame(fixture.app, lease)
      .watchQuery(
        JSON.stringify({
          reference: queryReference(release, "followUp", "decisions"),
          args: { pagination: {} },
        }),
        follower.callback
      );
    const inbox = async (ids: string[]) => {
      await vi.waitFor(
        () => {
          expect(follower.received.length).toBeGreaterThan(0);
          expect(latestDecisions(follower.received)).toStrictEqual(ids);
        },
        { timeout: 30_000, interval: 50 }
      );
    };
    await inbox([]);
    // A run the App started for the builder, which asks the admins: as
    // the run's own call opens it, so does nothing the admin follows.
    const manifest = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ hash: string }>();
    const runId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'app', ?, ?, ?, 1, ?, ?, 1, 'h', ?)"
      ).bind(
        runId,
        fixture.app,
        `key-${runId}`,
        workflow.id,
        manifest?.hash ?? "",
        builder.userId,
        Date.now()
      ),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, ?, 'b', ?, 'running', ?)"
      ).bind(
        runId,
        workflow.id,
        manifest?.hash ?? "",
        builder.userId,
        Date.now()
      ),
    ]);
    const run = {
      kind: "resource",
      runId,
      workflow: workflow.id,
      version: 1,
    } as const;
    const { decision } = await openDecision(env, run, {
      step: "ask:task",
      from: "role:admin",
      description: "Approve this request?",
      timeout: 3_600_000,
      starterExcluded: false,
      input: { who: "Ada" },
    });
    await inbox([decision]);
    // Closed unanswered, as its deadline would: out of the inbox.
    await decisionOutcome(env, run, decision, true);
    await inbox([]);
    await subscription.release();
  });

  it("take a team's decision out of a reviewer's live inbox once they leave the team, their App role unchanged", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    const key = `approval-${unique()}`;
    await publishCatalogContract(env, admin.acting, {
      key,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `decide-${unique()}`
    );
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: decidingDefinitionOf(key),
      basedOn: null,
    });
    const fixture = await appWith(files(), "Requests", builder.acting);
    await bindWorkflowToApp(env, builder.acting, workflow.id, {
      app: fixture.app,
      alias: "followUp",
      version: 1,
    });
    await seal(fixture);
    await publishVersion(env, builder.acting, fixture.app, 1);
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    )
      .bind(fixture.app, admin.userId, builder.userId, Date.now())
      .run();
    // The admin is in the team the decision asks.
    const team = crypto.randomUUID();
    const membership = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Finance', 'organization', ?)"
      ).bind(team, Date.now()),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(membership, team, admin.userId, Date.now()),
    ]);
    const { lease } = await admin.api.pages.open(fixture.app);
    const release = await loadRelease(env, fixture.app, 1);
    // The admin's page follows their inbox: nothing in it yet.
    const follower = pageFollower();
    const subscription = await admin.api.pages
      .frame(fixture.app, lease)
      .watchQuery(
        JSON.stringify({
          reference: queryReference(release, "followUp", "decisions"),
          args: { pagination: {} },
        }),
        follower.callback
      );
    const inbox = async (ids: string[]) => {
      await vi.waitFor(
        () => {
          expect(follower.received.length).toBeGreaterThan(0);
          expect(latestDecisions(follower.received)).toStrictEqual(ids);
        },
        { timeout: 30_000, interval: 50 }
      );
    };
    await inbox([]);
    // A run the App started for the builder, which asks the admins: as
    // the run's own call opens it, so does nothing the admin follows.
    const manifest = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ hash: string }>();
    const runId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'app', ?, ?, ?, 1, ?, ?, 1, 'h', ?)"
      ).bind(
        runId,
        fixture.app,
        `key-${runId}`,
        workflow.id,
        manifest?.hash ?? "",
        builder.userId,
        Date.now()
      ),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, ?, 'b', ?, 'running', ?)"
      ).bind(
        runId,
        workflow.id,
        manifest?.hash ?? "",
        builder.userId,
        Date.now()
      ),
    ]);
    const run = {
      kind: "resource",
      runId,
      workflow: workflow.id,
      version: 1,
    } as const;
    const { decision } = await openDecision(env, run, {
      step: "ask:task",
      from: `team:${team}`,
      description: "Approve this request?",
      timeout: 3_600_000,
      starterExcluded: false,
      input: { who: "Ada" },
    });
    await inbox([decision]);
    // They leave the team, still a user of the App: the App is told, as
    // a revocation tells it, and their inbox reads again.
    await env.DB.prepare("DELETE FROM team_members WHERE id = ?")
      .bind(membership)
      .run();
    await appHost(env, appIdSchema.parse(fixture.app)).accessRevoked([
      admin.userId,
    ]);
    await inbox([]);
    await subscription.release();
  });
});
