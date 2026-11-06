import { v } from "@grasp-os/sdk";
import {
  declaredWorkflows,
  GraspClient,
  workflowReferenceOf,
} from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { signedInSession } from "../src/auth/identity.ts";
import { grantReviewed, release } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { liveStatus, runObject } from "./runs.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";

// Independent JSON workflows as run tests drive them, through the public
// paths people and Apps take, each over a real session's RPC: a workflow
// created and published as its builder does it, bound to an App under an
// alias the App's app.ts declares, the App's version made current, its
// `start` grant asked for by its builder and granted by an admin, and
// its runs started, followed and controlled by a
// person or by the App's screen over core's function route. What replaces
// an App's own workflow (workflow-apps.ts) in a test:
//
//   const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);
//   const { builder, app, workflow, reference } = await boundApp({ hold: "1 hour" });
//   const lease = await screenOf(builder, app);
//   const { runId } = startedOf(await called(builder, app, lease, startCommand(reference)));
//   await called(builder, app, lease, controlCommand(reference, "pause", runId));
//   const run = await runFor(builder, workflow, runId);
//
// or, for a run a person starts without an App:
//
//   const builder = await signedIn("builder");
//   const { id } = await publishedWorkflow(builder, greetingTasks("1 hour"));
//   const runId = await startedBy(builder, id);
//   const run = await endedRun(builder, id, runId);
//
// `person.acting` is who the session is, as core reads it from the
// session's cookie: for a test that must reach past the public paths, as
// a fault it injects does.

/** How long a push or a run's change may take, and how often to look. */
export const settles = { timeout: 30_000, interval: 50 };

/** A JSON object schema of `properties`, each required, and nothing else. */
export const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** What a greeting ends with: `{ status: "Hello, <who>" }`. */
const greeting = { $expr: '"Hello, " + input.who' };

/**
 * A step `id` that runs and ends at once: a raise its `if` skips for
 * anyone with a name, so a run's history has a step of it.
 */
export const passing = (id: string, title?: string) => ({
  id,
  ...(title === undefined ? {} : { title }),
  type: "raise",
  if: { $expr: 'input.who === ""' },
  error: { type: "urn:grasp:error:nameless", status: 422 },
});

/**
 * The steps of a workflow that waits `hold` (`"1 hour"`), if any, then
 * greets (`greet`), titled `title` if given.
 */
export const greetingTasks = (hold?: string, title?: string): unknown[] => [
  ...(hold === undefined ? [] : [{ id: "hold", type: "wait", for: hold }]),
  passing("greet", title),
];

/**
 * A grasp-workflow/1 definition running `steps`, input `{ who }` and
 * output `{ status }` (`status`, a greeting unless said), with the
 * catalog `bindings` it declares (a model's, say).
 */
export const definitionOf = (
  steps: unknown[],
  {
    bindings,
    status = greeting,
  }: { bindings?: Record<string, unknown>; status?: unknown } = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: {
      schema: objectSchema({ status: { type: "string" } }),
      value: { status },
    },
    ...(bindings === undefined ? {} : { bindings }),
    steps,
  });

/**
 * A greeting workflow's definition: it waits `hold`, if any, then greets.
 * `label` titles its greeting, so one version's document differs from
 * another's.
 */
export const greetingOf = (hold?: string, label?: string): string =>
  definitionOf(greetingTasks(hold, label));

/**
 * A workflow of `by`'s, created and published as version 1 through their
 * session: running `tasks`, or the definition `definition` makes of its
 * name.
 */
export const publishedWorkflow = async (
  by: Person,
  tasks: unknown[] | ((name: string) => string)
): Promise<{ id: string; name: string }> => {
  const workflow = await by.api.workflowResources.create(`flow-${unique()}`);
  await by.api.workflowResources.publish(workflow.id, {
    definition:
      typeof tasks === "function" ? tasks(workflow.name) : definitionOf(tasks),
    basedOn: null,
  });
  return { id: workflow.id, name: workflow.name };
};

/**
 * Starts a run of version 1 of workflow `id` through `by`'s session, as a
 * person with a role in it starts one: its ID.
 */
export const startedBy = async (
  by: Person,
  id: string,
  input?: unknown
): Promise<string> => {
  const { runId } = await by.api.workflowResources.start(id, {
    version: 1,
    input: input ?? { who: "Ada" },
    key: unique(),
  });
  return z.string().parse(runId);
};

/** Run `runId` of workflow `id`, as `by`'s session reads it. */
export const runFor = async (
  by: Person,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await by.api.workflowResources.run(id, runId);

/** Run `runId` of workflow `id` once `holds` says so of it, polling. */
export const runOnce = async (
  by: Person,
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
  by: Person,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await runOnce(by, id, runId, ({ endedAt }) => endedAt !== null);

/** What the decision step `ask` answered, as expressions read it. */
const decided = "steps.ask.output";

/**
 * The steps of a workflow that asks `recipient` its `approval` decision
 * about `{ who }`, waiting `timeout` seconds at most if given. One that
 * nobody answered in time fails the run (`urn:grasp:error:unanswered`).
 */
export const decisionTasks = (
  recipient: string,
  timeout?: number
): unknown[] => [
  {
    id: "ask",
    type: "decision",
    binding: "approval",
    recipients: [recipient],
    prompt: "Greet them?",
    input: { who: { $expr: "input.who" } },
    ...(timeout === undefined ? {} : { timeout: `${timeout} seconds` }),
  },
  {
    id: "unanswered",
    type: "raise",
    if: { $expr: `${decided}.timedOut` },
    error: { type: "urn:grasp:error:unanswered", status: 408 },
  },
];

/**
 * What a decision workflow ends with: how it was answered and by whom,
 * with the comment the answer carried, if any.
 */
const answeredStatus = {
  $expr: `(${decided}.approved ? "approved" : "declined") + " by " + ${decided}.by + (${decided}.payload === null ? "" : ": " + ${decided}.payload.comment)`,
};

/**
 * A workflow of `builder`'s that asks `recipient` a decision
 * (`decisionTasks`), its `approval` binding to a decision contract `admin`
 * published, approved by `admin` for `deciders`, all through their
 * sessions. A decision's context is `{ who }`; its answer carries a
 * comment, or nothing.
 */
export const decidingWorkflow = async (
  { admin, builder }: { readonly admin: Person; readonly builder: Person },
  {
    recipient,
    deciders = [recipient],
    timeout,
    around = (steps) => steps,
  }: {
    recipient: string;
    deciders?: string[];
    timeout?: number;
    /** The workflow's steps around the decision's, if not those alone. */
    around?: (steps: unknown[]) => unknown[];
  }
) => {
  const contract = `approval-${unique()}`;
  await admin.api.workflowResources.publishContract({
    key: contract,
    kind: "decision",
    input: JSON.stringify(v.object({ who: v.string() }).descriptor),
    response: JSON.stringify(
      v.union(v.null(), v.object({ comment: v.string() })).descriptor
    ),
  });
  const workflow = await publishedWorkflow(builder, () =>
    definitionOf(around(decisionTasks(recipient, timeout)), {
      bindings: { approval: { kind: "decision", contract } },
      status: answeredStatus,
    })
  );
  const approval = await admin.api.workflowResources.approveBinding(
    workflow.id,
    {
      alias: "approval",
      target: { kind: "decision", deciders },
      reviewed: { version: 1 },
    }
  );
  return { ...workflow, approval: approval.id };
};

/**
 * The decision run `runId` asks `recipient`, once it waits in their inbox
 * (`decisions.waiting`) and the engine has the run waiting on it: its ID,
 * as the decision's link names it. The inbox lists a decision as soon as
 * it is opened, before the run has asked its people or started to wait,
 * so a test that stops, answers or times it out from there would race
 * the ask.
 */
export const decisionOf = async (
  recipient: Person,
  runId: string
): Promise<string> =>
  await vi.waitFor(async () => {
    const waiting = await recipient.api.decisions.waiting();
    const asked = waiting.find(({ run }) => run === runId);
    if (asked === undefined) {
      throw new Error("No decision yet");
    }
    if ((await liveStatus(runId)) !== "waiting") {
      throw new Error("Not waiting on its decision yet");
    }
    return asked.id;
  }, settles);

/**
 * Ends every JSON workflow run a test left live in the engine: a run held
 * an hour would go on in the background of whatever test file runs next
 * (see `endLiveRuns` in runs.ts, which ends App runs). A run the engine
 * has no record of has nothing to end.
 */
export const endLiveResourceRuns = async (): Promise<void> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_resource_runs WHERE status IN ('starting', 'running', 'paused')"
  ).all<{ id: string }>();
  await Promise.all(
    results.map(async ({ id }) => {
      const status = await runObject(id).status();
      if (
        status !== undefined &&
        !["complete", "errored", "terminated"].includes(status.status)
      ) {
        await runObject(id).terminate({ rollback: false });
      }
    })
  );
};

/** The App every bound workflow here is bound to: one screen, one alias. */
const boundAppFiles = (alias: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  requests: defineTable({ who: v.string() }),
});
`,
  "server/requests.ts": `import { permission, v } from "@grasp-os/sdk";

export const ${alias} = permission.workflow(${JSON.stringify(alias)}, {
  input: v.object({ who: v.string().trim().min(1) }),
  output: v.object({ status: v.string() }),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { ${alias} } from "./server/requests.ts";
import schema from "./schema.ts";

export default app({
  name: "Requests",
  schema,
  access: { tables: { requests: { read: "appMembers", write: "appMembers" } } },
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  permissions: { workflows: [${alias}] },
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Requests</main>;
}
`,
});

/**
 * The reference to `alias` that the `@server/_generated/api` generator writes into the
 * screens' references of version 1 of `app`, from its sealed release.
 */
const workflowReference = async (app: string, alias: string) => {
  const sealed = await loadRelease(env, appIdSchema.parse(app), 1);
  // The workflows as `generateModules` reads them for the references.
  const declared = declaredWorkflows(sealed.app, sealed.workflows).find(
    (workflow) => workflow.alias === alias
  );
  if (declared === undefined) {
    throw new Error(`No workflow ${alias}`);
  }
  return await workflowReferenceOf(
    {
      resourceId: sealed.manifest.resourceId,
      resourceVersion: sealed.manifest.resourceVersion,
    },
    declared
  );
};

/** A workflow reference, as `@server/_generated/api` generates it for a screen. */
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

/**
 * Someone of `role` signed in through `idp`, with their session's RPC, and
 * who the session is as core reads it from its cookie (`acting`).
 */
const signedInAs = async (idp: Idp, role: Role) => {
  const session = await signedInApi(idp, role);
  const read = await signedInSession(
    env,
    new Headers({ cookie: session.session })
  );
  if (read === undefined) {
    throw new Error("The session isn't signed in");
  }
  return { ...session, acting: read.person };
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
        builder,
        definition ?? (() => greetingOf(hold))
      ));
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    await builder.api.workflowResources.bindToApp(workflow.id, {
      app,
      alias,
      version: 1,
    });
    // Committed, sealed as it is made current, and published.
    await release(builder, app, boundAppFiles(alias));
    const { id: grant } = await builder.api.permissions.request({
      subject: { type: "app", appId: app },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: "FOLLOW_UP",
    });
    await grantReviewed(admin.api, grant);
    return {
      admin,
      builder,
      app,
      workflow: workflow.id,
      workflowName: workflow.name,
      sharing: { admin, builder, workflow },
      grant,
      reference: await workflowReference(app, alias),
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

/**
 * A run of `by`'s that waits an hour, once the engine has journaled its
 * wait: the root of a lineage of its own, still live, for a test to ask
 * the lineage's quotas as the run's activations ask them (`owner`), and
 * to `end` once done. An ended run's attempts are fenced (quotas.ts).
 */
export const liveLineage = async (by: Person) => {
  const { id } = await publishedWorkflow(by, greetingTasks("1 hour"));
  const run = await startedBy(by, id);
  await vi.waitFor(async () => {
    if ((await liveStatus(run)) !== "waiting") {
      throw new Error("The engine hasn't journaled the wait yet");
    }
  }, settles);
  return {
    workflow: id,
    run,
    owner: {
      run,
      root: run,
      subject: by.userId,
      resource: `workflow-resource:${id}`,
    },
    end: async (): Promise<void> => {
      await by.api.workflowResources.terminateRun(id, run);
    },
  };
};

/**
 * The model the asking workflows here go through: Mistral Large, as a
 * test's fake provider makes it one the organization chose
 * (model-provider.ts).
 */
export const askedModel = "mistral/mistral-large-latest";

/** A step that asks the model binding `reader` for a line to greet `who` with. */
export const askTask = {
  id: "ask",
  type: "agent",
  binding: "reader",
  instructions: "Greet them.",
  input: { who: { $expr: "input.who" } },
  output: objectSchema({ line: { type: "string" } }),
};

/** What a workflow that asks its model ends with: the line it answered. */
export const askedLine = { $expr: "steps.ask.output.line" };

/** The steps of a workflow that asks its model for a line, then ends with it. */
export const askingTasks = (): unknown[] => [askTask];

/**
 * A workflow of `builder`'s, published as version 1, running `tasks`
 * (`askingTasks` unless said, ending with `status`) with a model binding `reader`, which
 * `admin` approves to `model` (`askedModel` unless said): catalog
 * contract, definition and approval each through their session.
 */
export const askingWorkflow = async (
  admin: Person,
  builder: Person,
  tasks: unknown[] = askingTasks(),
  model: string = askedModel,
  status: unknown = askedLine
): Promise<{ id: string; name: string; contract: string }> => {
  const contract = `reader-${unique()}`;
  await admin.api.workflowResources.publishContract({
    key: contract,
    kind: "model",
  });
  const workflow = await publishedWorkflow(builder, () =>
    definitionOf(tasks, {
      bindings: { reader: { kind: "model", contract } },
      status,
    })
  );
  await admin.api.workflowResources.approveBinding(workflow.id, {
    alias: "reader",
    target: { kind: "model", model },
    reviewed: { version: 1 },
  });
  return { ...workflow, contract };
};
