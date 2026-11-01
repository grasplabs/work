/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import {
  decisionFingerprint,
  declaredWorkflows,
  GraspClient,
  readWorkflowReference,
  workflowChannel,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema, expectedMessageOf } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import {
  appTokenPath,
  portableFunctionPath,
  portableLivePath,
} from "@grasp-os/shared/portable";
import type { PortableLiveApi } from "@grasp-os/shared/portable";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { newWebSocketRpcSession } from "capnweb";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  answerWorkflowCommand,
  failureOf,
  readWorkflowRequest,
  readWorkflowWatch,
} from "../src/screen-workflows.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  repairResourceTerminations,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { tellQueryFollowers } from "../src/workflows/run-changes.ts";
import { WorkflowRuns } from "../src/workflows/run-object.ts";
import { published } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { hostOrigin } from "./host-sockets.ts";
import { mockIdp } from "./idp.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import { gate, heldEnd, rollingBackRun, withRollbacks } from "./rollbacks.ts";
import { runInstance, sleeping, woken } from "./runs.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  outcome,
  routed,
  signedInApi,
  unique,
} from "./sign-in.ts";

// A screen's typed `useWorkflow` through the real host (spec 10.4,
// screen-workflows.ts; the threat model is on GRA-626): its starts and
// cancels as the page relays a screen's calls, over core's function
// route, and its run and binding snapshots as the page follows a live
// query through the frame's own capability (`screens.frame`). The SDK's
// own channel speaks to both, so each answer and push passes the
// validators the hook reads them with.

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

/**
 * A definition of `name` whose expression fails on its input, in words
 * that quote what it read.
 */
const failingOf = (name: string): string =>
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
      {
        greet: {
          set: { status: "${ $workflow.input.who | tonumber | tostring }" },
        },
      },
    ],
  });

/**
 * A definition of `name` answering more than the App declares: its status,
 * and a field the App's output doesn't have.
 */
const widerOf = (name: string): string =>
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
    output: {
      schema: objectSchema({
        status: { type: "string" },
        secret: { type: "string" },
      }),
    },
    do: [{ greet: { set: { status: "hello", secret: "ultramarine" } } }],
  });

/**
 * Core's database for `runEnv`, `before` run once, just before the first
 * read of a workflow's policy generation is sent: a grant or revocation
 * landing while a snapshot is being read.
 */
const racingGeneration = (before: () => Promise<void>): Env => {
  let pending: Promise<void> | undefined;
  const raced = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...args: unknown[]) => {
            const bound: unknown = Reflect.apply(value, target, args);
            // SAFETY: a prepared statement's bind answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            return raced(bound as D1PreparedStatement);
          };
        }
        return async (...args: unknown[]): Promise<unknown> => {
          pending ??= before();
          await pending;
          const answer: unknown = await Reflect.apply(value, target, args);
          return answer;
        };
      },
    });
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare" && typeof value === "function") {
          return (query: string) => {
            const statement: unknown = Reflect.apply(value, target, [query]);
            // SAFETY: prepare answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const prepared = statement as D1PreparedStatement;
            return pending === undefined &&
              query.includes('"policy_generation"') &&
              query.includes('from "workflow_resources"')
              ? raced(prepared)
              : prepared;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    }),
  };
};

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
  const fingerprint = await workflowFingerprint(declared);
  // Its decisions as the generator writes them (generate.ts).
  const decisions: Record<string, unknown> = {};
  for (const [key, decision] of Object.entries(declared.decisions)) {
    decisions[key] = {
      kind: "workflowDecision",
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      workflow: `workflows.${alias}`,
      workflowFingerprint: fingerprint,
      key,
      // oxlint-disable-next-line no-await-in-loop -- one digest at a time
      fingerprint: await decisionFingerprint(decision),
      valueSchema: { kind: "descriptor", descriptor: decision.value },
      context: decision.context,
    };
  }
  return {
    kind: "workflow",
    visibility: "public",
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    alias,
    contractId: `workflows.${alias}`,
    fingerprint,
    input: declared.input,
    output: declared.output,
    events: {},
    listens: {},
    decisions,
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
const requestsApp = async (
  hold?: string,
  /** The people and workflow of another App's fixture, bound here too. */
  sharing?: {
    readonly admin: Person;
    readonly builder: Person;
    readonly workflow: { readonly id: string; readonly name: string };
  },
  /** The workflow's definition, if not a greeting that waits `hold`. */
  definition?: (name: string) => string
) => {
  const admin = sharing?.admin ?? (await signedIn("admin"));
  const builder = sharing?.builder ?? (await signedIn("builder"));
  const workflow =
    sharing?.workflow ??
    (await createWorkflowResource(env, builder.acting, `greet-${unique()}`));
  if (sharing === undefined) {
    await publishWorkflowVersion(env, builder.acting, workflow.id, {
      definition:
        definition?.(workflow.name) ?? definitionOf(workflow.name, hold),
      basedOn: null,
    });
  }
  const fixture = await appWith(files(), "Requests", builder.acting);
  await bindWorkflowToApp(env, builder.acting, workflow.id, {
    app: fixture.app,
    alias: "followUp",
    version: 1,
  });
  await seal(fixture);
  await setCurrentVersion(env, builder.acting, fixture.app, 1);
  await published(fixture.app);
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
    sharing: { admin, builder, workflow },
    grant: asked.id,
    reference: await workflowReference(release, "followUp"),
  };
};

/** A screen of `person`'s on the App, opened: its frame's lease. */
const screenOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await person.api.screens.open(app, "desk");
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
 * over core's function route, its live queries over its frame
 * (`screens.frame`).
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
      const subscription = await person.api.screens
        .frame(app, lease)
        .watchQuery(request, callback);
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
  const subscription = await person.api.screens
    .frame(app, lease)
    .watchQuery(JSON.stringify(request), callback);
  return { received, subscription };
};

/** How long a push or a run's change may take, and how often to look. */
const settles = { timeout: 30_000, interval: 50 };

/** A workflow that sleeps a moment, then an hour, then greets. */
const twoSleepsOf = (name: string): string =>
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
      { first: { wait: "PT1S" } },
      { second: { wait: "PT1H" } },
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
    ],
  });

/**
 * A workflow asking `recipient` for decision `contract`, as `approval`, in
 * its task `ask`, then greeting.
 */
const askingOf =
  (contract: string, recipient: string) =>
  (name: string): string =>
    JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name,
        version: "1.0.0",
        title: name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { approval: { kind: "decision", contract } },
          },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        {
          ask: {
            call: "grasp.decision",
            with: {
              binding: "approval",
              recipients: [recipient],
              prompt: "Greet them?",
              input: { who: "${ $workflow.input.who }" },
            },
          },
        },
        { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
      ],
    });

/** What a failed run's snapshot says of `error`: its code and words. */
const failureShown = (error: { code: string | null; message: string }) => {
  const { code, message } = failureOf(error);
  return { code, message };
};

/** The status a push shows, or its refusal's code. */
const shownOf = (pushed: unknown): unknown =>
  typeof pushed === "string"
    ? pushed
    : z.object({ status: z.string() }).safeParse(pushed).data?.status;

/** The waits a snapshot lists: kind, ID, key, task and `canRespond`. */
const waitsListed = (snapshot: unknown) =>
  z
    .object({
      waits: z.array(
        z.object({
          kind: z.string(),
          id: z.string(),
          key: z.string(),
          taskId: z.string(),
          canRespond: z.boolean().optional(),
        })
      ),
    })
    .parse(snapshot).waits;

/** How many waits a pushed snapshot lists. */
const waitsShown = (pushed: unknown): number | undefined =>
  z.object({ waits: z.array(z.unknown()) }).safeParse(pushed).data?.waits
    .length;

/** A control's receipt, without its revision. */
const staged = (receipt: unknown) => {
  const { kind, state } = z
    .object({ kind: z.string(), state: z.string(), revision: z.number() })
    .parse(receipt);
  return { kind, state };
};

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
          output: shown.value?.output,
          control: shown.value?.control,
          waits: shown.value?.waits,
        },
      }).toStrictEqual({
        again: first,
        handle: { workflowId: fixture.workflow, workflowVersion: 1 },
        shown: {
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

    it("publishes what a run waits on with its status: its task's sleep while it runs, nothing once it has ended", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      // Running, and asleep in its `hold` task: one snapshot says both.
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.waits).toHaveLength(
          1
        );
      }, settles);
      const asleep = channel.peekRun(read, handle.runId);
      await channel.control(read, handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "cancelled"
        );
      }, settles);
      const ended = channel.peekRun(read, handle.runId);
      stopRun();
      const [wait] = asleep.value?.waits ?? [];

      expect({
        status: asleep.value?.status,
        wait:
          wait === undefined
            ? undefined
            : {
                kind: wait.kind,
                purpose: "purpose" in wait ? wait.purpose : undefined,
                key: wait.key,
                taskId: wait.taskId,
                // An hour's sleep (in seconds), from when it was first reached.
                length:
                  wait.deadline === null
                    ? null
                    : Math.round((wait.deadline - wait.openedAt) / 1000),
              },
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asleep.revision,
        },
      }).toStrictEqual({
        status: "running",
        wait: {
          kind: "timer",
          purpose: "sleep",
          key: "hold",
          taskId: "hold",
          length: 3600,
        },
        ended: { waits: [], later: true },
      });
    });

    it("lists a decision its run waits on as a wait its starter can't answer, and none once the run ended", async () => {
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
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, builder.acting, workflow.id, {
        definition: askingOf(key, "role:admin")(workflow.name),
        basedOn: null,
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const { app, reference } = await requestsApp(undefined, {
        admin,
        builder,
        workflow,
      });
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      // Asking the admins, its run waits on the decision: one snapshot.
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.waits).toHaveLength(
          1
        );
      }, settles);
      const asked = channel.peekRun(read, handle.runId);
      await channel.control(read, handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "cancelled"
        );
      }, settles);
      const ended = channel.peekRun(read, handle.runId);
      stopRun();
      const { decision } = z
        .object({ decision: z.string() })
        .parse(
          await env.DB.prepare(
            "SELECT id AS decision FROM workflow_decisions WHERE resource_run_id = ?"
          )
            .bind(handle.runId)
            .first()
        );
      expect({
        asked: waitsListed(asked.value),
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asked.revision,
        },
      }).toStrictEqual({
        // Metadata only, and never theirs to answer: a run's own person
        // answers none of its decisions (R8).
        asked: [
          {
            kind: "decision",
            id: decision,
            key: "approval",
            taskId: "ask",
            canRespond: false,
          },
        ],
        ended: { waits: [], later: true },
      });
    });

    it("shows a run's next wait at a revision of its own, though it was running all along", async () => {
      const { builder, app, reference } = await requestsApp(
        undefined,
        undefined,
        twoSleepsOf
      );
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const shown: { revision: number; keys: string[] }[] = [];
      const stopRun = channel.followRun(read, handle.runId, () => {
        const now = channel.peekRun(read, handle.runId);
        if (now.value !== undefined) {
          shown.push({
            revision: now.revision,
            keys: now.value.waits.map(({ key }) => key),
          });
        }
      });
      await vi.waitFor(() => {
        expect(shown.at(-1)?.keys).toStrictEqual(["second"]);
      }, settles);
      stopRun();
      const first = shown.find(({ keys }) => keys.includes("first"));
      const second = shown.find(({ keys }) => keys.includes("second"));

      expect({
        sawFirst: first !== undefined,
        later:
          first !== undefined &&
          second !== undefined &&
          second.revision > first.revision,
      }).toStrictEqual({ sawFirst: true, later: true });
    });

    it("cancels a run with a receipt answered again under its key", async () => {
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
        receipt: staged(receipt),
        resent: staged(resent),
        // The receipt names the very revision that shows the run ended.
        settles:
          z.object({ revision: z.number() }).parse(receipt).revision ===
          ended.revision,
        ended: ended.value?.control,
      }).toStrictEqual({
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        receipt: { kind: "cancel", state: "applied" },
        resent: { kind: "cancel", state: "applied" },
        settles: true,
        ended: {
          canPause: false,
          canResume: false,
          canCancel: false,
          pendingControl: null,
        },
      });
    });

    it("pauses and resumes a run, each receipt answered again under its key and audited under the App's screen for the person", async () => {
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
      const commandOf = (command: "pause" | "resume") =>
        JSON.stringify({
          workflow: wireOf(reference),
          command,
          runId: handle.runId,
          idempotencyKey: keyOf(),
        });
      const pauseCommand = commandOf("pause");
      let paused = channel.peekRun(read, handle.runId);
      let pauseAgain: unknown;
      let resumed: unknown;
      let resumedAgain: unknown;
      const events = await auditedDuring(async () => {
        await called(builder, app, lease, pauseCommand);
        await vi.waitFor(() => {
          expect(channel.peekRun(read, handle.runId).value?.status).toBe(
            "paused"
          );
        }, settles);
        paused = channel.peekRun(read, handle.runId);
        // Sent again under its key, as a lost answer's resend: the same.
        pauseAgain = outcomeOf(await called(builder, app, lease, pauseCommand));
        resumed = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
        await vi.waitFor(() => {
          expect(channel.peekRun(read, handle.runId).value?.status).toBe(
            "running"
          );
        }, settles);
        // A resume of a run already running: applied as it is written.
        resumedAgain = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
      });
      const running = channel.peekRun(read, handle.runId);
      stopRun();

      expect({
        paused: paused.value?.control,
        pauseAgain: staged(pauseAgain),
        resumed: staged(resumed),
        resumedAgain: staged(resumedAgain),
        running: running.value?.control,
        later: running.revision > paused.revision,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, actor, detail }) => ({
            action,
            actor: actor.type,
            kind: detail.kind,
            already: detail.already,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        paused: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
        pauseAgain: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        resumedAgain: { kind: "resume", state: "applied" },
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        later: true,
        // Each asked, under the App's screen for the person, and each
        // settled, by the system; the resume already done, asked only.
        audited: [
          {
            action: "workflow.run.pause_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "pause",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "resume",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: true,
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("keeps a stalled pause applying until a snapshot settles it, refuses a resume meanwhile, and lets a cancel supersede it", async () => {
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
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            JSON.stringify({
              workflow: wireOf(reference),
              command,
              runId: handle.runId,
              idempotencyKey: keyOf(),
            })
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(read, handle.runId).value;
      let resume: unknown;
      const refusedEvents = await auditedDuring(async () => {
        resume = await refusalOf(
          channel.control(read, handle.runId, "resume", () => {
            // Never recovering.
          })
        );
      });
      const cancelled = await asked("cancel");
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "cancelled"
        );
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        applying: { status: applying?.status, control: applying?.control },
        resume,
        refused: refusedEvents
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({
            action,
            kind: detail.kind,
            code: detail.code,
          })),
        cancelled: staged(cancelled),
        receipts: receipts.results,
      }).toStrictEqual({
        applying: {
          status: "running",
          control: {
            canPause: false,
            canResume: false,
            canCancel: true,
            pendingControl: { kind: "pause", stage: "applying" },
          },
        },
        resume: "workflow.control_conflict",
        refused: [
          {
            action: "workflow.run.control_refused",
            kind: "resume",
            code: "workflow.control_conflict",
          },
        ],
        cancelled: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("joins a pause still applying when asked again under another key, applying the one receipt", async () => {
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
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            JSON.stringify({
              workflow: wireOf(reference),
              command,
              runId: handle.runId,
              idempotencyKey: keyOf(),
            })
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const joined = await asked("pause");
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "paused"
        );
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("answers a retry of a pause that joined another that pause's receipt, never undoing a resume admitted since", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stopRun = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      const statusIs = async (status: string): Promise<void> => {
        await vi.waitFor(() => {
          expect(channel.peekRun(read, handle.runId).value?.status).toBe(
            status
          );
        }, settles);
      };
      await statusIs("running");
      const asked = async (command: "pause" | "resume", key: string) =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            JSON.stringify({
              workflow: wireOf(reference),
              command,
              runId: handle.runId,
              idempotencyKey: key,
            })
          )
        );
      // Pause A, admitted a while ago and not yet sent: stalled.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);

      // Pause B joins A, which settles; B's answer is lost. Another
      // screen resumes the run; then B is sent again under its key.
      const keyB = keyOf();
      const joined = await asked("pause", keyB);
      await statusIs("paused");
      const resumed = await asked("resume", keyOf());
      await statusIs("running");
      const retried = await asked("pause", keyB);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        resumed: staged(resumed),
        retried: staged(retried),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        retried: { kind: "pause", state: "applied" },
        receipts: [
          { kind: "pause", state: "applied" },
          { kind: "resume", state: "applied" },
        ],
      });
    });

    it("supersedes a stalled pause a newer control overtook, never sending it", async () => {
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
      // A pause admitted, then a newer control's generation taken after it.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation + 1, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 2, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
      ]);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(async () => {
        await expect(
          env.DB.prepare(
            "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(handle.runId)
            .first<string>("state")
        ).resolves.toBe("superseded");
      }, settles);
      // Asked of the run's engine again: still running, never paused.
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.pendingControl
        ).toBeNull();
      }, settles);
      const shown = channel.peekRun(read, handle.runId).value?.status;
      stopRun();
      expect(shown).toBe("running");
    });

    it("lets a cancel that lost its write to a pause admitted at once win all the same", async () => {
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
      // Just before the cancel's write, a pause's: its receipt stalled, and
      // the run's generation taken.
      let raced = false;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (!raced) {
                  raced = true;
                  await target.batch([
                    target
                      .prepare(
                        "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
                      )
                      .bind(handle.runId),
                    target
                      .prepare(
                        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
                      )
                      .bind(
                        crypto.randomUUID(),
                        app,
                        builder.userId,
                        keyOf(),
                        Date.now(),
                        Date.now() + 3_600_000,
                        handle.runId
                      ),
                  ]);
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      const command = readWorkflowRequest(
        JSON.stringify({
          workflow: wireOf(reference),
          command: "cancel",
          runId: handle.runId,
          idempotencyKey: keyOf(),
        })
      );
      if (!("command" in command)) {
        throw new Error("Not a command");
      }
      const { value } = await answerWorkflowCommand(
        racing,
        builder.acting,
        app,
        command
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "cancelled"
        );
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        raced,
        cancel: staged(value),
        receipts: receipts.results,
      }).toStrictEqual({
        raced: true,
        cancel: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("never applies a resume at once over a pause that reached the engine while the resume was being decided", async () => {
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
      // A pause admitted, not yet sent: due at the repair.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      // The resume reads the engine's status; right after, the pause
      // reaches the engine and settles.
      let raced = false;
      const racingStub = <T extends object>(stub: T): T =>
        new Proxy(stub, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "status" && typeof value === "function") {
              return async (...args: unknown[]) => {
                const status: unknown = await Reflect.apply(
                  value,
                  target,
                  args
                );
                if (!raced) {
                  raced = true;
                  await repairResourceTerminations(env, new Date());
                }
                return status;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      type Runs = Env["WORKFLOW_RUNS"];
      const racingRuns = (namespace: Runs): Runs =>
        new Proxy(namespace, {
          get: (target, property) => {
            if (property === "jurisdiction") {
              return (jurisdiction: DurableObjectJurisdiction) =>
                racingRuns(target.jurisdiction(jurisdiction));
            }
            if (property === "get") {
              return (id: DurableObjectId) => racingStub(target.get(id));
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      const racing: Env = {
        ...env,
        WORKFLOW_RUNS: racingRuns(env.WORKFLOW_RUNS),
      };
      const command = readWorkflowRequest(
        JSON.stringify({
          workflow: wireOf(reference),
          command: "resume",
          runId: handle.runId,
          idempotencyKey: keyOf(),
        })
      );
      if (!("command" in command)) {
        throw new Error("Not a command");
      }
      const resume = await refusalOf(
        answerWorkflowCommand(racing, builder.acting, app, command)
      );
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        const shown = channel.peekRun(read, handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      // Refused while the pause was still unresolved as it was decided,
      // to be asked again; never answered as done with the run paused.
      expect({ raced, resume, receipts: receipts.results }).toStrictEqual({
        raced: true,
        resume: "workflow.control_conflict",
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("writes one receipt and one audit event for two overlapping requests under one key of a pause the run is already past", async () => {
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
      const pauseOf = (key: string) => {
        const command = readWorkflowRequest(
          JSON.stringify({
            workflow: wireOf(reference),
            command: "pause",
            runId: handle.runId,
            idempotencyKey: key,
          })
        );
        if (!("command" in command)) {
          throw new Error("Not a command");
        }
        return command;
      };
      await answerWorkflowCommand(env, builder.acting, app, pauseOf(keyOf()));
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "paused"
        );
      }, settles);
      // The same pause, sent twice: the second runs whole just before the
      // first writes, both having found the run paused and no receipt.
      const retried = pauseOf(keyOf());
      let twin: unknown;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (twin === undefined) {
                  ({ value: twin } = await answerWorkflowCommand(
                    env,
                    builder.acting,
                    app,
                    retried
                  ));
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      let first: unknown;
      const events = await auditedDuring(async () => {
        ({ value: first } = await answerWorkflowCommand(
          racing,
          builder.acting,
          app,
          retried
        ));
      });
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? AND key = ?"
      )
        .bind(handle.runId, retried.idempotencyKey)
        .all<{ kind: string; state: string }>();

      expect({
        first: staged(first),
        twin: staged(twin),
        receipts: receipts.results,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({ action, already: detail.already })),
      }).toStrictEqual({
        first: { kind: "pause", state: "applied" },
        twin: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
        audited: [{ action: "workflow.run.pause_requested", already: true }],
      });
    });

    it("applies a stalled pause at the next repair, the run's snapshot moving on from applying to paused", async () => {
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
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(read, handle.runId);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(() => {
        const shown = channel.peekRun(read, handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      const paused = channel.peekRun(read, handle.runId);
      stopRun();

      expect({
        later: paused.revision > applying.revision,
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
      }).toStrictEqual({ later: true, state: "applied" });
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

    it("tells a screen already following a run as the App's start grant is revoked and given again", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, admin, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      const canCancel = () =>
        channel.peekRun(read, handle.runId).value?.control.canCancel;
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      await revokePermission(env, admin.acting, fixture.grant);
      await vi.waitFor(() => {
        expect(canCancel()).toBeFalsy();
      }, settles);
      const asked = await requestPermission(
        env,
        builder.acting,
        {
          subject: { type: "app", appId: appIdSchema.parse(app) },
          object: { type: "workflow", workflowId: fixture.workflow },
          actions: ["start"],
          binding: "FOLLOW_UP",
        },
        rolesOf(builder.acting)
      );
      await grantPermission(env, admin.acting, asked.id, { version: 1 });
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      stop();
    });

    it("never shows a run as cancellable under a revision read after the grant was revoked", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, admin, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.canCancel
        ).toBeTruthy();
      }, settles);
      const watch = readWorkflowRequest(
        JSON.stringify({
          workflow: wireOf(reference),
          watch: "run",
          runId: handle.runId,
        })
      );
      if (!("watch" in watch)) {
        throw new Error("Expected a watch");
      }
      // The revocation lands while a snapshot is being read.
      const inFlight = await readWorkflowWatch(
        racingGeneration(async () => {
          await revokePermission(env, admin.acting, fixture.grant);
        }),
        builder.acting,
        app,
        watch
      );
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.control.canCancel
        ).toBeFalsy();
      }, settles);
      stop();
      expect(
        z
          .object({ control: z.object({ canCancel: z.boolean() }) })
          .parse(inFlight.value).control.canCancel
      ).toBeFalsy();
    });

    it("refuses what a run returned when it is more than the App declares", async () => {
      const { builder, app, reference } = await requestsApp(
        undefined,
        undefined,
        widerOf
      );
      const lease = await screenOf(builder, app);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(readWorkflowReference(reference), { who: "Ada" });
      const watched = await following(builder, app, lease, {
        workflow: wireOf(reference),
        watch: "run",
        runId: handle.runId,
      });
      await vi.waitFor(() => {
        expect(watched.received.at(-1)?.outcome).toBeTypeOf("string");
      }, settles);
      await watched.subscription.release();
      expect({
        shown: watched.received.at(-1)?.outcome,
        leaks: JSON.stringify(watched.received).includes("ultramarine"),
      }).toStrictEqual({ shown: "contract.invalid_return", leaks: false });
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
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
      }, settles);
      // The same run on the same connection: one reading, shared.
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect(second.received.map(({ revision }) => revision)).toStrictEqual([
        first.received.at(-1)?.revision,
      ]);
    });

    it("refuses a run's watch and offers no start once the alias is rebound, then shows both again once rebound back, with nothing else changing", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const watched = await channel.start(read, { who: "Ada" });
      const watch = {
        workflow: wireOf(reference),
        watch: "run",
        runId: watched.runId,
      };
      const first = await following(builder, app, lease, watch);
      const binding = await following(builder, app, lease, {
        workflow: wireOf(reference),
        watch: "binding",
      });
      const canRun = () =>
        z
          .object({ canRun: z.boolean() })
          .safeParse(binding.received.at(-1)?.outcome).data?.canRun;
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
        expect(waitsShown(first.received.at(-1)?.outcome)).toBe(1);
        expect(canRun()).toBeTruthy();
      }, settles);
      // Rebound away: the screen is told at once, nothing else needed.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: definitionOf(fixture.workflowName, "PT1H", "2.0.0"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await vi.waitFor(() => {
        expect(first.received.at(-1)?.outcome).toBe("workflow.run_unavailable");
        expect(canRun()).toBeFalsy();
      }, settles);
      // Bound back: shown again, at the same stage, and startable again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await vi.waitFor(() => {
        expect(first.received.at(-1)?.outcome).toBeTypeOf("object");
        expect(canRun()).toBeTruthy();
      }, settles);
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      await binding.subscription.release();
      expect({
        // What it showed in turn, each read again as the binding changed,
        // from the run running on (it may first have shown it queued).
        first: first.received
          .map(({ outcome: shown }) => shownOf(shown))
          .filter((shown) => shown !== "queued")
          .filter((shown, at, all) => at === 0 || shown !== all[at - 1]),
        // Shown again at the revision the run has now (it may have moved
        // on while refused: a wait opening is a revision), the same to a
        // screen that only now asks.
        sameRevision: new Set([
          first.received.at(-1)?.revision,
          second.received.at(0)?.revision,
        ]).size,
        second: second.received.map(({ outcome: shown }) => shownOf(shown)),
      }).toStrictEqual({
        first: ["running", "workflow.run_unavailable", "running"],
        sameRevision: 1,
        second: ["running"],
      });
    });

    it("answers a screen that subscribes after a run's output passed its retention with no output, whatever another screen still shows", async () => {
      const { builder, app, reference } = await requestsApp();
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
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("completed");
      }, settles);
      // Its details removed, as the retention sweep removes them.
      await env.DB.prepare(
        "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
      )
        .bind(Date.now(), handle.runId)
        .run();
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect({
        second: second.received.map(({ outcome: shown }) => shown),
        leaks: JSON.stringify(second.received).includes("Hello, Ada"),
      }).toStrictEqual({
        second: ["workflow.run_details_removed"],
        leaks: false,
      });
    });

    it("shows nothing of a screen's run but why while its alias is bound elsewhere, and the run again once bound back", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, app, reference } = fixture;
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const watched = await channel.start(read, { who: "Ada" });
      const other = await channel.start(read, { who: "Bo" });
      const stopRun = channel.followRun(read, watched.runId, () => {
        // Read below.
      });
      const shown = () => channel.peekRun(read, watched.runId);
      await vi.waitFor(() => {
        expect(shown()).toMatchObject({
          fresh: true,
          value: { status: "running" },
        });
      }, settles);
      const before = shown();
      // Bound away: the next read, which another run's end causes, refuses.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: definitionOf(fixture.workflowName, "PT1H", "2.0.0"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        other.runId
      );
      await vi.waitFor(() => {
        expect(shown().error?.code).toBe("workflow.run_unavailable");
      }, settles);
      const away = shown();
      // Bound back, and read again as a new run starts: shown again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await channel.start(read, { who: "Cy" });
      await vi.waitFor(() => {
        expect(shown().fresh).toBeTruthy();
      }, settles);
      const back = shown();
      stopRun();

      expect({
        before: { revision: before.revision, control: before.value?.control },
        away: {
          value: away.value,
          fresh: away.fresh,
          error: away.error?.code,
        },
        back: { revision: back.revision, control: back.value?.control },
      }).toStrictEqual({
        before: {
          revision: before.revision,
          control: {
            canPause: true,
            canResume: false,
            canCancel: true,
            pendingControl: null,
          },
        },
        away: {
          value: undefined,
          fresh: false,
          error: "workflow.run_unavailable",
        },
        back: { revision: before.revision, control: before.value?.control },
      });
    });

    it("shows a failed run only a code the platform defines, in its own words, never what the run read", async () => {
      const { builder, app, reference } = await requestsApp(
        undefined,
        undefined,
        failingOf
      );
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "failed"
        );
      }, settles);
      const { error } = channel.peekRun(read, handle.runId).value ?? {};
      stop();
      // A code the platform defines, in the platform's own words: nothing
      // of what the run read.
      expect({
        code: error?.code,
        message: error?.message,
        leaks: JSON.stringify(error).includes("Ada"),
      }).toStrictEqual({
        code: "expression.failed",
        message: expectedMessageOf("expression.failed"),
        leaks: false,
      });
    });

    it("words any failure the platform doesn't define as a step's, whatever the workflow said", () => {
      const stepFailed = {
        code: "workflow.step_failed",
        message: expectedMessageOf("workflow.step_failed"),
      };
      expect({
        ownCode: failureShown({
          code: "test.secret",
          message: "The secret is 42.",
        }),
        inANamespace: failureShown({
          code: "workflow.secret_42",
          message: "The secret is 42.",
        }),
        none: failureShown({ code: null, message: "The secret is 42." }),
        platform: failureShown({
          code: "expression.failed",
          message: "It read Ada's salary.",
        }),
      }).toStrictEqual({
        ownCode: stepFailed,
        inANamespace: stepFailed,
        none: stepFailed,
        platform: {
          code: "expression.failed",
          message: expectedMessageOf("expression.failed"),
        },
      });
    });

    it("shows what a restricted run returned only through an App still in restricted mode", async () => {
      const { builder, app, reference } = await requestsApp();
      // Restricted as the start is decided, so its run is restricted for good.
      await appHost(env, appIdSchema.parse(app)).restrict();
      const lease = await screenOf(builder, app);
      const read = readWorkflowReference(reference);
      const handle = await workflowChannel(
        screenClient(builder, app, lease)
      ).start(read, { who: "Ada" });
      const shownOnce = async () => {
        const watched = await following(builder, app, lease, {
          workflow: wireOf(reference),
          watch: "run",
          runId: handle.runId,
        });
        // Until it shows the run ended, or is refused.
        await vi.waitFor(() => {
          const last = watched.received.at(-1);
          expect(
            typeof last?.outcome === "string" ||
              ["completed", "failed", "cancelled"].includes(
                String(shownOf(last?.outcome))
              )
          ).toBeTruthy();
        }, settles);
        await watched.subscription.release();
        const shown = watched.received.at(-1)?.outcome;
        return typeof shown === "string"
          ? shown
          : z.object({ output: z.unknown() }).parse(shown).output;
      };
      const restricted = await shownOnce();
      // As only a write around the platform could: the App out of it again.
      await runInDurableObject(
        appHost(env, appIdSchema.parse(app)),
        async (_instance, state) => {
          await state.storage.delete("restricted");
        }
      );
      expect({ restricted, unrestricted: await shownOnce() }).toStrictEqual({
        restricted: { status: "Hello, Ada" },
        unrestricted: "permission.restricted",
      });
    });

    it("shows App B nothing of App A's run of the same workflow, and refuses its cancel", async () => {
      const appA = await requestsApp("PT1H");
      const appB = await requestsApp(undefined, appA.sharing);
      const { builder } = appA;
      const leaseA = await screenOf(builder, appA.app);
      const handle = await workflowChannel(
        screenClient(builder, appA.app, leaseA)
      ).start(readWorkflowReference(appA.reference), { who: "Ada" });
      const leaseB = await screenOf(builder, appB.app);
      const watched = await following(builder, appB.app, leaseB, {
        workflow: wireOf(appB.reference),
        watch: "run",
        runId: handle.runId,
      });
      await vi.waitFor(() => {
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      await watched.subscription.release();
      expect({
        seen: watched.received[0]?.outcome,
        cancel: outcomeOf(
          await called(
            builder,
            appB.app,
            leaseB,
            JSON.stringify({
              workflow: wireOf(appB.reference),
              command: "cancel",
              runId: handle.runId,
              idempotencyKey: keyOf(),
            })
          )
        ),
      }).toStrictEqual({
        seen: "workflow.run_unavailable",
        cancel: "workflow.run_unavailable",
      });
    });

    it("refuses an App's workflows to its own server code's callers and to a portable host", async () => {
      const { builder, admin, app, reference } = await requestsApp("PT1H");
      const { generation } = await admin.api.screenTrust.review(app);
      await admin.api.screenTrust.classify(app, "ordinary", generation);
      const start = JSON.stringify({
        workflow: wireOf(reference),
        command: "start",
        input: { who: "Ada" },
        idempotencyKey: keyOf(),
      });
      const issued = await routed(`${appTokenPath}/${app}`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          "content-type": "application/json",
          cookie: builder.session,
        },
        body: "{}",
      });
      const { token } = z
        .object({ token: z.string() })
        .parse(await issued.json());
      const portableCall = await routed(`${portableFunctionPath}/${app}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: start,
      });
      const upgraded = await routed(`${portableLivePath}/${app}`, {
        headers: { Upgrade: "websocket", Origin: hostOrigin },
      });
      const socket = upgraded.webSocket;
      if (!socket) {
        throw new Error(`Expected a WebSocket, got ${upgraded.status}`);
      }
      socket.accept();
      closeWhenTestEnds(socket);
      const live = newWebSocketRpcSession<PortableLiveApi>(socket);
      const portableWatch = await outcome(
        live
          .connect(token)
          .watchQuery(
            JSON.stringify({ workflow: wireOf(reference), watch: "binding" }),
            () => {
              // Never followed.
            }
          )
      );
      expect({
        // An agent's or another App's call of the App, as its server takes it.
        agent: outcomeOf(
          await callAppFunction(env, builder.acting, app, start)
        ),
        portableCall: outcomeOf(await portableCall.json()),
        portableWatch,
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        agent: "contract.invalid_request",
        portableCall: "workflow.portable_unavailable",
        portableWatch: "workflow.portable_unavailable",
        runs: 0,
      });
    });

    it("fences a screen whose build lost its approval at its run's next change", async () => {
      const fixture = await requestsApp("PT1H");
      const { builder, admin, app, reference } = fixture;
      const { lease, artifact } = await builder.api.screens.open(app, "desk");
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "running"
        );
      }, settles);
      await admin.api.screenTrust.revoke(app, artifact);
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        handle.runId
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).error?.code).toBe(
          "screen.revoked"
        );
      }, settles);
      const fenced = channel.peekRun(read, handle.runId);
      stop();
      expect({ value: fenced.value, code: fenced.error?.code }).toStrictEqual({
        value: undefined,
        code: "screen.revoked",
      });
    });

    it("applies a cancel whose stop never went out at the next repair, settling its receipt", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "running"
        );
      }, settles);
      // Admitted a while ago, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
        await vi.waitFor(() => {
          expect(channel.peekRun(read, handle.runId).value?.status).toBe(
            "cancelled"
          );
        }, settles);
        // A repair again, well after: nothing more is stopped or audited.
        await repairResourceTerminations(env, new Date(Date.now() + 3_600_000));
      });
      stop();
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        // The stop audited once, under the App's screen, for the person.
        terminated: events
          .filter(
            ({ action, target }) =>
              action === "workflow.run.terminated" &&
              target?.id === handle.runId
          )
          .map(({ actor, detail }) => ({
            actor,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        state: "applied",
        terminated: [
          {
            actor: { type: "app", appId: app, part: "screen" },
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("settles a cancel as superseded, auditing no stop, when its run completed before the stop went out", async () => {
      const { builder, app, reference } = await requestsApp();
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "completed"
        );
      }, settles);
      stop();
      // Admitted while it ran, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
      });
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        terminated: events.filter(
          ({ action, target }) =>
            action === "workflow.run.terminated" && target?.id === handle.runId
        ).length,
      }).toStrictEqual({ state: "superseded", terminated: 0 });
    });

    it("starts one run for a key sent twice at once, and keeps one cancel receipt for a run however many keys ask, never changed after", async () => {
      const { builder, app, reference } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const start = JSON.stringify({
        workflow: wireOf(reference),
        command: "start",
        input: { who: "Ada" },
        idempotencyKey: keyOf(),
      });
      const [one, two] = await Promise.all([
        called(builder, app, lease, start),
        called(builder, app, lease, start),
      ]);
      const handle = z.object({ runId: z.string() }).parse(outcomeOf(one));
      const cancel = () =>
        JSON.stringify({
          workflow: wireOf(reference),
          command: "cancel",
          runId: handle.runId,
          idempotencyKey: keyOf(),
        });
      const cancels = await Promise.all([
        called(builder, app, lease, cancel()),
        called(builder, app, lease, cancel()),
      ]);
      const receipts = await env.DB.prepare(
        "SELECT id, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ id: string; state: string }>();
      const id = receipts.results[0]?.id ?? "";
      expect({
        same: outcomeOf(two),
        cancels: cancels.map((answer) => staged(outcomeOf(answer))),
        receipts: receipts.results.map(({ state }) => state),
        reopened:
          (await outcome(
            env.DB.prepare(
              "UPDATE workflow_resource_run_controls SET state = 'admitted', settled_at = NULL WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
        deleted:
          (await outcome(
            env.DB.prepare(
              "DELETE FROM workflow_resource_run_controls WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
      }).toStrictEqual({
        same: outcomeOf(one),
        cancels: [
          { kind: "cancel", state: "applied" },
          { kind: "cancel", state: "applied" },
        ],
        receipts: ["applied"],
        reopened: false,
        deleted: false,
      });
    });
  }
);

// A run whose engine rolls its steps back (spec 10.7.3), on the real
// engine with a test's definition (rollbacks.ts): no definition Grasp
// builds registers a rollback yet (GRA-984).
describe(
  "a screen's typed workflow run while it compensates",
  { timeout: 120_000 },
  () => {
    withRollbacks();

    /**
     * A run of the Requests App's `followUp`, its next activation the
     * test's (`compensated`), followed through its compensation: what the
     * screen saw while the engine rolled it back, and as it ended.
     */
    const compensatedRun = async (
      compensated: Omit<Parameters<typeof rollingBackRun>[1], "holds" | "held">,
      end?: (runId: string) => Promise<void>,
      /** What is asked of it while it compensates: answered as `during`. */
      meanwhile?: (asked: {
        channel: ReturnType<typeof workflowChannel>;
        read: ReturnType<typeof readWorkflowReference>;
        runId: string;
        builder: Person;
        workflow: string;
      }) => Promise<unknown>
    ) => {
      const { builder, app, reference, workflow } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const handle = await channel.start(read, { who: "Ada" });
      await sleeping(handle.runId, "task:hold");
      const holds = gate();
      rollingBackRun(handle.runId, {
        ...compensated,
        holds,
        // Its `hold` task's hour.
        held: { name: "task:hold", ms: 3_600_000 },
      });
      const stop = channel.followRun(read, handle.runId, () => {
        // Read below.
      });
      await woken(handle.runId, "task:hold");
      await end?.(handle.runId);
      await vi.waitFor(() => {
        expect(channel.peekRun(read, handle.runId).value?.status).toBe(
          "compensating"
        );
      }, settles);
      const compensating = channel.peekRun(read, handle.runId);
      const during = await meanwhile?.({
        channel,
        read,
        runId: handle.runId,
        builder,
        workflow,
      });
      holds.open();
      await vi.waitFor(() => {
        expect(
          channel.peekRun(read, handle.runId).value?.finishedAt
        ).not.toBeNull();
      }, settles);
      const ended = channel.peekRun(read, handle.runId);
      stop();
      return {
        during,
        compensating: {
          status: compensating.value?.status,
          compensation: compensating.value?.compensation,
          finishedAt: compensating.value?.finishedAt,
          canCancel: compensating.value?.control.canCancel,
          canPause: compensating.value?.control.canPause,
        },
        ended: {
          status: ended.value?.status,
          error: ended.value?.error?.code,
        },
      };
    };

    it("shows a failed run compensating with what it failed with, then failed with that once its compensation is done", async () => {
      await expect(
        compensatedRun({ ends: { fails: "resource.declined" } })
      ).resolves.toStrictEqual({
        during: undefined,
        compensating: {
          status: "compensating",
          compensation: {
            cause: "failure",
            activity: "running",
            originalError: {
              code: "resource.declined",
              message: expectedMessageOf("resource.declined"),
              category: "domain",
              retryable: false,
              requestId: null,
            },
          },
          // Not ended while its compensation runs.
          finishedAt: null,
          canCancel: false,
          canPause: false,
        },
        ended: { status: "failed", error: "resource.declined" },
      });
    });

    it("ends a run whose compensation failed as workflow.compensation_failed", async () => {
      const shown = await compensatedRun({
        ends: { fails: "resource.declined" },
        rollbackFails: true,
      });
      expect(shown.ended).toStrictEqual({
        status: "failed",
        error: "workflow.compensation_failed",
      });
    });

    it("shows a run cancelled with a rollback compensating for its cancellation, then cancelled", async () => {
      const shown = await compensatedRun({ ends: "sleeps" }, async (runId) => {
        await sleeping(runId, "after-charge");
        await runInstance(runId).terminate({ rollback: true });
      });
      expect({
        compensation: shown.compensating.compensation,
        ended: shown.ended,
      }).toStrictEqual({
        compensation: { cause: "cancellation", activity: "running" },
        ended: { status: "cancelled", error: undefined },
      });
    });

    it("ends a cancelled run whose compensation failed as workflow.compensation_failed, though a stop comes before its end is told", async () => {
      const { builder, app, reference, workflow } = await requestsApp("PT1H");
      const lease = await screenOf(builder, app);
      const channel = workflowChannel(screenClient(builder, app, lease));
      const read = readWorkflowReference(reference);
      const { runId } = await channel.start(read, { who: "Ada" });
      await sleeping(runId, "task:hold");
      const holds = gate();
      rollingBackRun(runId, {
        ends: "sleeps",
        rollbackFails: true,
        holds,
        held: { name: "task:hold", ms: 3_600_000 },
      });
      await woken(runId, "task:hold");
      await sleeping(runId, "after-charge");
      const release = heldEnd(runId);
      await runInstance(runId).terminate({ rollback: true });
      holds.open();
      // Ended in the engine, its refund failed; core not told of it yet.
      await vi.waitFor(async () => {
        await expect(runInstance(runId).status()).resolves.toMatchObject({
          status: "terminated",
          rollback: { status: "errored" },
        });
      }, settles);
      const rowOf = async () =>
        await env.DB.prepare(
          "SELECT status, failure_code AS failureCode FROM workflow_resource_runs WHERE id = ?"
        )
          .bind(runId)
          .first<{ status: string; failureCode: string | null }>();
      const before = await rowOf();
      await terminateResourceRun(env, builder.acting, workflow, runId);
      const stopped = await rowOf();
      release();
      expect({ before: before?.status, stopped }).toStrictEqual({
        before: "running",
        // Ended as the engine has it: an ended row never changes again,
        // so the late end can't put a failed compensation right.
        stopped: {
          status: "failed",
          failureCode: "workflow.compensation_failed",
        },
      });
    });

    it("audits a cancel admitted just before its run began to compensate as nothing terminated, and notes no stop", async () => {
      let seen:
        | {
            answered: { kind: string; state: string } | undefined;
            terminated: number;
            runId: string;
          }
        | undefined;
      const shown = await compensatedRun(
        { ends: { fails: "resource.declined" } },
        undefined,
        async ({ channel, read, runId }) => {
          // The engine's word is lost as the cancel is admitted, as when
          // its rollback began right after: the cancel goes ahead, and the
          // engine answers that it rolls back.
          const spy = vi
            .spyOn(WorkflowRuns.prototype, "status")
            .mockImplementationOnce(() => {
              throw new Error("The engine couldn't say");
            });
          let answered: { kind: string; state: string } | undefined;
          const events = await auditedDuring(async () => {
            const { kind, state } = await channel.control(
              read,
              runId,
              "cancel",
              () => {
                // Never recovering.
              }
            );
            answered = { kind, state };
          });
          spy.mockRestore();
          seen = {
            answered,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
            runId,
          };
        }
      );
      const runId = seen?.runId ?? "";
      const receipt = await env.DB.prepare(
        "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(runId)
        .first<string>("state");
      const events = await allEvents();
      const terminated = events.filter(
        ({ action, target }) =>
          action === "workflow.run.terminated" && target?.id === runId
      ).length;
      expect({
        during: {
          answered: seen?.answered,
          terminated: seen?.terminated,
        },
        ended: shown.ended,
        receipt,
        terminated,
      }).toStrictEqual({
        // Admitted, its stop not taken: nothing recorded as terminated.
        during: {
          answered: { kind: "cancel", state: "admitted" },
          terminated: 0,
        },
        // Its compensation ran to its end, never cut short.
        ended: { status: "failed", error: "resource.declined" },
        // Settled by the run's end, which no stop of its brought about.
        receipt: "superseded",
        terminated: 0,
      });
    });

    it("refuses a cancel or a stop while a run compensates, with no receipt and nothing audited as terminated", async () => {
      const shown = await compensatedRun(
        { ends: { fails: "resource.declined" } },
        undefined,
        async ({ channel, read, runId, builder, workflow }) => {
          let cancel: unknown;
          let stop: unknown;
          const events = await auditedDuring(async () => {
            cancel = await refusalOf(
              channel.control(read, runId, "cancel", () => {
                // Never recovering.
              })
            );
            stop = await refusalOf(
              terminateResourceRun(env, builder.acting, workflow, runId)
            );
          });
          const receipts = await env.DB.prepare(
            "SELECT count(*) AS n FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(runId)
            .first<{ n: number }>();
          return {
            cancel,
            stop,
            receipts: receipts?.n,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
          };
        }
      );
      expect({ during: shown.during, ended: shown.ended }).toStrictEqual({
        during: {
          // The engine's own word that it rolls back, as every control's.
          cancel: "workflow.control_rolling_back",
          stop: "workflow.control_refused",
          receipts: 0,
          terminated: 0,
        },
        // Its compensation ran to its end, its failure as it failed.
        ended: { status: "failed", error: "resource.declined" },
      });
    });
  }
);
