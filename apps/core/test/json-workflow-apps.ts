/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import {
  decisionFingerprint,
  declaredWorkflows,
  GraspClient,
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
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { published } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { appWith, seal } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// Independent JSON workflows as run tests drive them, through the paths
// people and Apps take: a workflow published as its builder publishes it,
// bound to an App under an alias the App's app.ts declares, the App's
// `start` grant given by an admin, and its runs started, followed and
// controlled by a person or by the App's screen over core's function
// route. What replaces an App's own workflow (workflow-apps.ts) in a test:
//
//   const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);
//   const { builder, app, workflow, reference } = await boundApp({ hold: "PT1H" });
//   const lease = await screenOf(builder, app);
//   const { runId } = startedOf(await called(builder, app, lease, startCommand(reference)));
//   await called(builder, app, lease, controlCommand(reference, "pause", runId));
//   const run = await runFor(builder.acting, workflow, runId);
//
// or, for a run a person starts without an App:
//
//   const builder = await signedIn("builder");
//   const { id } = await publishedWorkflow(builder.acting, greetingTasks("PT1H"));
//   const runId = await startedBy(builder.acting, id);
//   const run = await endedRun(builder.acting, id, runId);

/** How long a push or a run's change may take, and how often to look. */
export const settles = { timeout: 30_000, interval: 50 };

/** A JSON object schema of `properties`, each required, and nothing else. */
export const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The contract every workflow here keeps: input `{ who }`, output `{ status }`. */
const greetingContract = {
  input: { schema: objectSchema({ who: { type: "string" } }) },
  output: { schema: objectSchema({ status: { type: "string" } }) },
};

/** The tasks of a workflow that waits `hold` (an ISO duration), if any, then greets. */
export const greetingTasks = (hold?: string): unknown[] => [
  ...(hold === undefined ? [] : [{ hold: { wait: hold } }]),
  { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
];

/**
 * A definition of `name` running `tasks`, input `{ who }` and output
 * `{ status }`, with the catalog `bindings` it declares (a decision's, a
 * model's), at `semver`.
 */
export const definitionOf = (
  name: string,
  tasks: unknown[],
  {
    bindings = {},
    semver = "1.0.0",
  }: { bindings?: Record<string, unknown>; semver?: string } = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: semver,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    ...greetingContract,
    do: tasks,
  });

/** A greeting workflow's definition: it waits `hold`, if any, then greets. */
export const greetingOf = (
  name: string,
  hold?: string,
  semver = "1.0.0"
): string => definitionOf(name, greetingTasks(hold), { semver });

/**
 * A workflow of `by`'s, created and published as version 1: running
 * `tasks`, or the definition `definition` makes of its name.
 */
export const publishedWorkflow = async (
  by: Acting,
  tasks: unknown[] | ((name: string) => string)
): Promise<{ id: string; name: string }> => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition:
      typeof tasks === "function"
        ? tasks(workflow.name)
        : definitionOf(workflow.name, tasks),
    basedOn: null,
  });
  return { id: workflow.id, name: workflow.name };
};

/**
 * Starts a run of version 1 of workflow `id` as `by`, a person with a role
 * in it: its ID.
 */
export const startedBy = async (
  by: Acting,
  id: string,
  input?: unknown
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: input ?? { who: "Ada" }, key: unique() }
  );
  expect(runId).not.toBeNull();
  return z.string().parse(runId);
};

/** Run `runId` of workflow `id`, as `by` reads it. */
export const runFor = async (
  by: Acting,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> => await resourceRunFor(env, by, id, runId);

/** Run `runId` of workflow `id` once `holds` says so of it, polling. */
export const runOnce = async (
  by: Acting,
  id: string,
  runId: string,
  holds: (run: WorkflowResourceRun) => boolean
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(async () => {
    const run = await runFor(by, id, runId);
    if (!holds(run)) {
      throw new Error(`The run is ${run.status}`);
    }
    return run;
  }, settles);

/** Run `runId` of workflow `id` once it has ended. */
export const endedRun = async (
  by: Acting,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await runOnce(by, id, runId, ({ endedAt }) => endedAt !== null);

/** The App every bound workflow here is bound to: one screen, one alias. */
const boundAppFiles = (alias: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "operations/requests.ts": `import { resource, v } from "@grasp-os/sdk";

export const ${alias} = resource.workflow(${JSON.stringify(alias)}, {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ${alias} } from "./operations/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  operations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  uses: [${alias}],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Requests</main>;
}
`,
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

/** The reference to `alias` as `#grasp` generates it from `release`. */
export const workflowReference = async (release: Release, alias: string) => {
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

/** A workflow reference, as `#grasp` generates it for a screen. */
export type WorkflowReference = Awaited<ReturnType<typeof workflowReference>>;

/** A reference as the SDK sends it. */
export const wireOf = (reference: WorkflowReference) => ({
  resourceId: reference.resourceId,
  resourceVersion: reference.resourceVersion,
  contractId: reference.contractId,
  fingerprint: reference.fingerprint,
  kind: "workflow",
});

/** A fresh command key, as the SDK makes one. */
export const keyOf = (): string => crypto.randomUUID().replaceAll("-", "");

/** A screen's start of the workflow `reference` names, under `key`. */
export const startCommand = (
  reference: WorkflowReference,
  input?: unknown,
  key = keyOf()
): string =>
  JSON.stringify({
    workflow: wireOf(reference),
    command: "start",
    input: input ?? { who: "Ada" },
    idempotencyKey: key,
  });

/** A screen's pause, resume or cancel of run `runId`, under `key`. */
export const controlCommand = (
  reference: WorkflowReference,
  command: "pause" | "resume" | "cancel",
  runId: string,
  key = keyOf()
): string =>
  JSON.stringify({
    workflow: wireOf(reference),
    command,
    runId,
    idempotencyKey: key,
  });

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a raw call answered: its value, or its refusal's code. */
export const outcomeOf = (answer: unknown): unknown => {
  const { result } = z.object({ result: resultSchema }).parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** The run a screen's start answered with. */
export const startedOf = (answer: unknown) =>
  z
    .object({
      runId: z.string(),
      workflowId: z.string(),
      workflowVersion: z.number(),
    })
    .parse(outcomeOf(answer));

/** A control's receipt as a screen's command answered it, without its revision. */
export const staged = (receipt: unknown) => {
  const { kind, state } = z
    .object({ kind: z.string(), state: z.string(), revision: z.number() })
    .parse(receipt);
  return { kind, state };
};

/** Someone signed in through `idp`, and as core's own calls take them. */
const signedInAs = async (idp: Idp, role: Role) => {
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

/** Someone signed in, as `jsonWorkflowAppsOf`'s `signedIn` has them. */
export type Person = Awaited<ReturnType<typeof signedInAs>>;

/**
 * The people, Apps and workflows of the tests that call `jsonWorkflowAppsOf`
 * with their file's identity provider.
 */
export const jsonWorkflowAppsOf = (idp: Idp) => {
  /** Someone of `role` signed in, and as core's own calls take them. */
  const signedIn = async (role: Role): Promise<Person> =>
    await signedInAs(idp, role);

  /**
   * An App sealed and current, its screen approved, with `alias` bound to
   * version 1 of a workflow and the App's `start` grant on it: a greeting
   * that waits `hold` first, or the definition `definition` makes of its
   * name; or, `sharing` another fixture's people and workflow, that one.
   */
  const boundApp = async ({
    hold,
    sharing,
    definition,
    alias = "followUp",
  }: {
    hold?: string;
    sharing?: {
      readonly admin: Person;
      readonly builder: Person;
      readonly workflow: { readonly id: string; readonly name: string };
    };
    definition?: (name: string) => string;
    alias?: string;
  } = {}) => {
    const admin = sharing?.admin ?? (await signedIn("admin"));
    const builder = sharing?.builder ?? (await signedIn("builder"));
    const workflow =
      sharing?.workflow ??
      (await publishedWorkflow(
        builder.acting,
        definition ?? ((name) => greetingOf(name, hold))
      ));
    const fixture = await appWith(
      boundAppFiles(alias),
      "Requests",
      builder.acting
    );
    await bindWorkflowToApp(env, builder.acting, workflow.id, {
      app: fixture.app,
      alias,
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
      reference: await workflowReference(release, alias),
    };
  };

  return { signedIn, boundApp };
};

/** A screen of `person`'s on the App, opened: its frame's lease. */
export const screenOf = async (
  person: Person,
  app: string
): Promise<string> => {
  const { lease } = await person.api.screens.open(app, "desk");
  return lease;
};

/** A call of the page's, relayed to core's function route: its answer. */
export const called = async (
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
 * (`screens.frame`). Hand it to `workflowChannel` for the SDK's view.
 */
export const screenClient = (
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

/** Follows `request` raw on `person`'s screen: what reached the page. */
export const following = async (
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
