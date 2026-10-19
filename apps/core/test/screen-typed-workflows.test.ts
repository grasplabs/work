/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  declaredWorkflows,
  GraspClient,
  readWorkflowReference,
  workflowChannel,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { mockIdp } from "./idp.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// A screen's typed `useWorkflow` through the real host (spec 10.4,
// screen-workflows.ts; the threat model is on GRA-626): its starts and
// cancels as the page relays a screen's calls, over core's function
// route, and its run and binding snapshots as the page follows a live
// query, through `screens.watchQuery`. The SDK's own channel speaks to
// both, so each answer and push passes the validators the hook reads them
// with.

const idp = mockIdp();

const files = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";

export const followUp = resource.workflow("followUp", {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { followUp } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: {},
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

/** A greeting workflow's definition: it waits `hold`, if any, then greets. */
const definitionOf = (
  name: string,
  hold: string | undefined,
  semver = "1.0.0"
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: semver,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...(hold === undefined ? [] : [{ hold: { wait: hold } }]),
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

type Person = Awaited<ReturnType<typeof signedIn>>;

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

/** The reference to `alias` as `#grasp` generates it from `release`. */
const workflowReference = async (release: Release, alias: string) => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  if (declared === undefined) {
    throw new Error(`No workflow ${alias}`);
  }
  return {
    kind: "workflow",
    visibility: "public",
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    alias,
    contractId: `workflows.${alias}`,
    fingerprint: await workflowFingerprint(declared),
    input: declared.input,
    output: declared.output,
    events: {},
    listens: {},
    decisions: {},
  };
};

/** A reference as the SDK sends it. */
const wireOf = (reference: Awaited<ReturnType<typeof workflowReference>>) => ({
  resourceId: reference.resourceId,
  resourceVersion: reference.resourceVersion,
  contractId: reference.contractId,
  fingerprint: reference.fingerprint,
  kind: "workflow",
});

/**
 * The Requests App sealed and current, its screen approved, `followUp`
 * bound to a greeting workflow that waits `hold` first, with the App's
 * `start` grant.
 */
const requestsApp = async (hold?: string) => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const workflow = await createWorkflowResource(
    env,
    builder.acting,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, builder.acting, workflow.id, {
    definition: definitionOf(workflow.name, hold),
    basedOn: null,
  });
  const fixture = await appWith(files(), "Requests", builder.acting);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  await setCurrentVersion(env, builder.acting, fixture.app, 1);
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
  const release = await loadRelease(env, fixture.app, 1);
  return {
    admin,
    builder,
    app: fixture.app,
    workflow: workflow.id,
    workflowName: workflow.name,
    grant: asked.id,
    reference: await workflowReference(release, "followUp"),
  };
};

/** A screen of `person`'s on the App, presented: its lease. */
const screenOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await person.api.screens.open(app, "desk");
  await person.api.screens.present(app, lease);
  return lease;
};

/** A call of the page's, relayed to core's function route: its answer. */
const called = async (
  person: Person,
  app: string,
  lease: string,
  request: string
): Promise<unknown> => {
  const response = await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: person.session,
      [screenLeaseHeader]: lease,
      [screenPersonHeader]: person.userId,
    },
    body: request,
  });
  const answer: unknown = await response.json();
  if (response.ok) {
    return answer;
  }
  const payload = errorPayloadSchema.parse(answer);
  throw Object.assign(new Error(payload.message), { code: payload.code });
};

/**
 * A session client of `person`'s screen, as the frame's own: its calls
 * over core's function route, its live queries over `screens.watchQuery`.
 */
const screenClient = (
  person: Person,
  app: string,
  lease: string
): GraspClient => {
  const transport: ClientTransport = {
    call: async (request) => await called(person, app, lease, request),
    watch: async (request, onSnapshot, onLost) => {
      const callback = Object.assign(
        (push: unknown): void => {
          onSnapshot(push);
        },
        {
          [Symbol.dispose]: (): void => {
            onLost();
          },
        }
      );
      const subscription = await person.api.screens.watchQuery(
        app,
        lease,
        request,
        callback
      );
      return {
        release: () => {
          void subscription.release();
        },
      };
    },
  };
  return new GraspClient(transport);
};

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a raw call answered: its value, or its refusal's code. */
const outcomeOf = (answer: unknown): unknown => {
  const { result } = z.object({ result: resultSchema }).parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** Follows `request` raw on `person`'s screen: what reached the page. */
const following = async (
  person: Person,
  app: string,
  lease: string,
  request: unknown
) => {
  const received: { revision: number; outcome: unknown }[] = [];
  const callback = Object.assign(
    (push: unknown): void => {
      const { revision, result } = z
        .object({ revision: z.number(), result: resultSchema })
        .parse(push);
      received.push({
        revision,
        outcome: result.ok ? result.value : result.error.code,
      });
    },
    {
      [Symbol.dispose]: (): void => {
        // Let go of: nothing more arrives.
      },
    }
  );
  const subscription = await person.api.screens.watchQuery(
    app,
    lease,
    JSON.stringify(request),
    callback
  );
  return { received, subscription };
};

/** How long a push or a run's change may take, and how often to look. */
const settles = { timeout: 30_000, interval: 50 };

/** A fresh command key, as the SDK makes one. */
const keyOf = (): string => crypto.randomUUID().replaceAll("-", "");

/** The code `work` was refused with, or "ok". */
const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : error;
    return code;
  }
};

describe(
  "a screen's typed workflow through the real host",
  { timeout: 120_000 },
  () => {
    it("starts a run once per key, follows it to its end with its output, and tells the person they may start one", async () => {
      const fixture = await requestsApp();
      const { builder, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const stopBinding = channel.followBinding(read, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding(read).value).toStrictEqual({ canRun: true });
      }, settles);

      // The same start sent twice under one key, as a lost answer's resend:
      // one run.
      const start = JSON.stringify({
        workflow: wireOf(reference),
        command: "start",
        input: { who: "Ada" },
        idempotencyKey: keyOf(),
      });
      const first = outcomeOf(await called(builder, app, lease, start));
      const again = outcomeOf(await called(builder, app, lease, start));
      const handle = z
        .object({
          runId: z.string(),
          workflowId: z.string(),
          workflowVersion: z.number(),
        })
        .parse(first);
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "completed"
        );
      }, settles);
      const shown = channel.peekRun(read, handle.runId);
      stopRun();
      stopBinding();

      expect({
        again,
        handle: {
          workflowId: handle.workflowId,
          workflowVersion: handle.workflowVersion,
        },
        shown: {
          revision: shown.revision,
          output: shown.value?.output,
          control: shown.value?.control,
          waits: shown.value?.waits,
        },
      }).toStrictEqual({
        again: first,
        handle: { workflowId: fixture.workflow, workflowVersion: 1 },
        shown: {
          revision: 4,
          output: { status: "Hello, Ada" },
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
          waits: [],
        },
      });
    });

    it("cancels a run with a receipt answered again under its key, and refuses its pause", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "running"
        );
      }, settles);
      const running = channel.peekRun(read, handle.runId).value?.control;
      const pause = await refusalOf(
        channel.control(read, handle.runId, "pause", () => {
          // Never recovering.
        })
      );
      // The cancel, then sent again under its key, as its resend.
      const cancel = JSON.stringify({
        workflow: wireOf(reference),
        command: "cancel",
        runId: handle.runId,
        idempotencyKey: keyOf(),
      });
      const receipt = outcomeOf(await called(builder, app, lease, cancel));
      const resent = outcomeOf(await called(builder, app, lease, cancel));
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "cancelled"
        );
      }, settles);
      const ended = channel.peekRun(read, handle.runId);
      stopRun();

      expect({
        running,
        pause,
        receipt,
        resent,
        ended: { revision: ended.revision, control: ended.value?.control },
      }).toStrictEqual({
        running: {
          canPause: false,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        pause: "workflow.control_refused",
        receipt: { kind: "cancel", state: "applied", revision: 4 },
        resent: { kind: "cancel", state: "applied", revision: 4 },
        ended: {
          revision: 4,
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
        },
      });
    });

    it("refuses a cancel of a run that completed", async () => {
      const { builder, app, reference } = await requestsApp();
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "completed"
        );
      }, settles);
      stopRun();
      await expect(
        refusalOf(
          channel.control(read, handle.runId, "cancel", () => {
            // Never recovering.
          })
        )
      ).resolves.toBe("workflow.control_refused");
    });

    it("shows a run only to the person the App started it for: another member of the App, an admin and a made-up ID see none", async () => {
      const { builder, admin, app, reference } = await requestsApp("PT1H");
      const colleague = await signedIn("builder");
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, colleague.userId, builder.userId, Date.now())
        .run();
      const lease = await screenOf(builder, app);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(readWorkflowReference(reference), { who: "Ada" });
      const seenBy = async (person: Person, runId: string) => {
        const watched = await following(
          person,
          app,
          await screenOf(person, app),
          { workflow: wireOf(reference), watch: "run", runId }
        );
        await vi.waitFor(() => {
          expect(watched.received.length).toBeGreaterThan(0);
        }, settles);
        await watched.subscription.release();
        return watched.received[0]?.outcome;
      };
      const cancelBy = async (person: Person) =>
        outcomeOf(
          await called(
            person,
            app,
            await screenOf(person, app),
            JSON.stringify({
              workflow: wireOf(reference),
              command: "cancel",
              runId: handle.runId,
              idempotencyKey: keyOf(),
            })
          )
        );

      expect({
        colleague: await seenBy(colleague, handle.runId),
        admin: await seenBy(admin, handle.runId),
        madeUp: await seenBy(builder, crypto.randomUUID()),
        colleagueCancels: await cancelBy(colleague),
        adminCancels: await cancelBy(admin),
      }).toStrictEqual({
        colleague: "workflow.run_unavailable",
        admin: "workflow.run_unavailable",
        madeUp: "workflow.run_unavailable",
        colleagueCancels: "workflow.run_unavailable",
        adminCancels: "workflow.run_unavailable",
      });
    });

    it("refuses a reference of another contract or release, input the declaration doesn't take, a watch sent as a call and a command sent as a watch, starting nothing", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const wire = wireOf(reference);
      const start = (workflow: unknown, input?: unknown) =>
        JSON.stringify({
          workflow,
          command: "start",
          input: input ?? { who: "Ada" },
          idempotencyKey: keyOf(),
        });
      const commandWatched = await following(builder, app, lease, {
        workflow: wire,
        command: "start",
        input: { who: "Ada" },
        idempotencyKey: keyOf(),
      });
      await vi.waitFor(() => {
        expect(commandWatched.received.length).toBeGreaterThan(0);
      }, settles);
      await commandWatched.subscription.release();
      const startOf = async (request: string) =>
        outcomeOf(await called(builder, app, lease, request));

      expect({
        otherContract: await startOf(
          start({ ...wire, fingerprint: "0".repeat(64) })
        ),
        otherRelease: await startOf(
          start({ ...wire, resourceVersion: wire.resourceVersion + 1 })
        ),
        unknownAlias: await startOf(
          start({ ...wire, contractId: "workflows.other" })
        ),
        badInput: await startOf(start(wire, { who: " " })),
        watchAsCall: await startOf(
          JSON.stringify({ workflow: wire, watch: "binding" })
        ),
        commandAsWatch: commandWatched.received[0]?.outcome,
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        otherContract: "version.mismatch",
        otherRelease: "version.mismatch",
        unknownAlias: "operation.not_found",
        badInput: "contract.invalid_args",
        watchAsCall: "contract.invalid_request",
        commandAsWatch: "contract.invalid_request",
        runs: 0,
      });
    });

    it("offers nothing once the App's start grant is revoked, and refuses its starts and cancels then", async () => {
      const { builder, admin, app, grant, reference } =
        await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const read = readWorkflowReference(reference);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(read, { who: "Ada" });
      await revokePermission(env, admin.acting, grant);
      // A screen that follows them now: a fresh client, as a new tab's.
      const channel = workflowChannel(screenClient(builder, app, lease));
      const stopBinding = channel.followBinding(read, () => {
        // Read below.
      });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding(read).value).toBeDefined();
        expect(channel.peekRun(read, handle.runId).value).toBeDefined();
      }, settles);
      const offered = {
        canRun: channel.peekBinding(read).value?.canRun,
        canCancel: channel.peekRun(read, handle.runId).value?.control.canCancel,
      };
      stopBinding();
      stopRun();

      expect({
        offered,
        start: await refusalOf(channel.start(read, { who: "Ada" })),
        cancel: await refusalOf(
          channel.control(read, handle.runId, "cancel", () => {
            // Never recovering.
          })
        ),
      }).toStrictEqual({
        offered: { canRun: false, canCancel: false },
        start: "workflow.start_denied",
        cancel: "workflow.start_denied",
      });
    });

    it("starts and shows nothing of another version the alias was bound to since the seal", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const read = readWorkflowReference(reference);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(read, { who: "Ada" });
      // Version 2, bound with no seal: the release's references were made
      // for version 1.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: definitionOf(fixture.workflowName, undefined, "2.0.0"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      const channel = workflowChannel(screenClient(builder, app, lease));
      const stopBinding = channel.followBinding(read, () => {
        // Read below.
      });
      const watched = await following(builder, app, lease, {
        workflow: wireOf(reference),
        watch: "run",
        runId: handle.runId,
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding(read).value).toBeDefined();
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      const { canRun } = channel.peekBinding(read).value ?? {};
      stopBinding();
      await watched.subscription.release();

      expect({
        canRun,
        run: watched.received[0]?.outcome,
        start: await refusalOf(channel.start(read, { who: "Ada" })),
      }).toStrictEqual({
        canRun: false,
        run: "workflow.run_unavailable",
        start: "workflow.start_denied",
      });
    });

    it("gives a second subscription to a run the revision the first already has", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(readWorkflowReference(reference), { who: "Ada" });
      const watch = {
        workflow: wireOf(reference),
        watch: "run",
        runId: handle.runId,
      };
      const first = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(first.received.at(-1)?.revision).toBe(2);
      }, settles);
      // The same run on the same connection: one reading, shared.
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect(second.received.map(({ revision }) => revision)).toStrictEqual([
        2,
      ]);
    });
  }
);
