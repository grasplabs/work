/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { terminateResourceRun } from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import { appWith, queryReference, seal } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";

// A screen's live workflow queries (`workflows.<alias>.queries.runs`,
// workflow-reference-queries.ts), followed through `screens.watchQuery` as
// a page follows any live query (query-subscriptions.ts). They read no
// store, so no write tells core to read them again: a run the App starts
// for the person, and each change of its status, does instead
// (workflows/run-changes.ts, `tellQueryFollowers`), through the App's host
// to the person's connections, which read it again through the same gate,
// coalescing and budget as a write's.

const idp = mockIdp();

const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
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
import { followUp, kickOff } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: { requests: { kickOff } },
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [followUp],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Requests</main>;
}
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

/** A greeting workflow's definition: it waits an hour, then greets. */
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
      { hold: { wait: "PT1H" } },
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
    ],
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

describe("a screen's live workflow queries", { timeout: 120_000 }, () => {
  it("show a run the App starts for the person, then each change of its status, with no subscribing again", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    const workflow = await createWorkflowResource(
      env,
      builder.acting,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    const fixture = await appWith(files(), "Requests", builder.acting);
    await seal(fixture);
    await setCurrentVersion(env, builder.acting, fixture.app, 1);
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
    const review = await admin.api.screenTrust.review(fixture.app);
    await admin.api.screenTrust.approve(fixture.app, {
      version: review.version,
      generation: review.generation,
      artifacts: builtArtifacts(review.screens),
    });
    const { lease } = await builder.api.screens.open(fixture.app, "desk");
    await builder.api.screens.present(fixture.app, lease);
    const release = await loadRelease(env, fixture.app, 1);

    // The screen follows the person's runs: none yet.
    const follower = pageFollower();
    const subscription = await builder.api.screens.watchQuery(
      fixture.app,
      lease,
      JSON.stringify({
        reference: await queryReference(release, "followUp", "runs"),
        input: { pagination: {} },
      }),
      follower.callback
    );
    await vi.waitFor(
      () => {
        expect(follower.received.length).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 50 }
    );
    const before = latestRuns(follower.received);

    // The App starts one for them: the screen shows it running, pushed to
    // the same subscription.
    const started = await callAppFunction(
      env,
      builder.acting,
      fixture.app,
      JSON.stringify({
        reference: {
          resourceId: release.manifest.resourceId,
          resourceVersion: release.manifest.resourceVersion,
          contractId: "requests.kickOff",
          fingerprint: release.fingerprints["requests.kickOff"] ?? "",
          kind: "action",
        },
        input: { who: "Ada" },
      })
    );
    const runId = started.result.ok
      ? z.object({ runId: z.string() }).parse(started.result.value).runId
      : "";
    await vi.waitFor(
      () => {
        expect(latestRuns(follower.received)).toStrictEqual([
          `${runId}: running`,
        ]);
      },
      { timeout: 30_000, interval: 50 }
    );
    // Cancelled while it waits: the screen shows that too.
    await terminateResourceRun(env, builder.acting, workflow.id, runId);
    await vi.waitFor(
      () => {
        expect(latestRuns(follower.received)).toStrictEqual([
          `${runId}: cancelled`,
        ]);
      },
      { timeout: 30_000, interval: 50 }
    );
    await subscription.release();
    expect(before).toStrictEqual([]);
  });
});
