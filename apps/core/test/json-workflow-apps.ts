import { v } from "@grasp-os/runtime/app";
import { declaredWorkflows, workflowReferenceOf } from "@grasp-os/runtime/host";
import type { WorkflowEventContract } from "@grasp-os/runtime/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { signedInSession } from "../src/auth/identity.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { grantReviewed, release } from "./apps.ts";
import type { Idp } from "./idp.ts";
import { liveStatus, runObject } from "./runs.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// Independent JSON workflows as run tests drive them, through the public
// paths people and Apps take, each over a real session's RPC: a workflow
// created and published as its builder does it, bound to an App under an
// alias the App's app.ts declares, the App's version made current, its
// `start` grant asked for by its builder and granted by an admin, and
// its runs started, followed and controlled by a
// person or by the App's page over core's function route:
//
//   const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);
//   const { builder, app, workflow, reference } = await boundApp({ hold: "1 hour" });
//   const lease = await pageOf(builder, app);
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

/** A value's schema: an object of exactly `fields`, each required. */
export const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** What a greeting ends with: `{ status: "Hello, <who>" }`. */
const greeting = { $expr: '"Hello, " + args.who' };

/**
 * A step `id` that runs and ends at once: a wait of a second (a raise,
 * an `if` or a loop has no step of its own to show).
 */
export const passing = (id: string, title?: string) => ({
  id,
  ...(title === undefined ? {} : { title }),
  type: "wait",
  for: "1 second",
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
 * A grasp-workflow/2 definition running `steps`, args `{ who }` and
 * result `{ status }` (`status`, a greeting unless said), with the
 * catalog `permissions` it declares (a model's, say).
 */
export const definitionOf = (
  steps: unknown[],
  {
    permissions,
    status = greeting,
  }: { permissions?: Record<string, unknown>; status?: unknown } = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    ...(permissions === undefined ? {} : { permissions }),
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
  await publishOverRpc(
    by.api,
    workflow.id,
    typeof tasks === "function" ? tasks(workflow.name) : definitionOf(tasks)
  );
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
    args: input ?? { who: "Ada" },
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
const decided = "ask";

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
    type: "decide",
    decision: "approval",
    recipients: [recipient],
    prompt: "Greet them?",
    input: { who: { $expr: "args.who" } },
    ...(timeout === undefined ? {} : { timeout: `${timeout} seconds` }),
  },
  {
    id: "unanswered",
    type: "raise",
    if: { $expr: `${decided}.timedOut` },
    error: { code: "test.unanswered", message: "Failed." },
  },
];

const completedJob = "grasp.job.completed";

/**
 * An event contract `admin` published through their session: a job's
 * completion, which a page sends, and its timeout, which it doesn't, each
 * of `{ jobId }`. Its key.
 */
export const jobEventsContract = async (
  admin: Pick<Person, "api">
): Promise<string> => {
  const key = `job-events-${unique()}`;
  const data = JSON.stringify(v.object({ jobId: v.string() }).descriptor);
  await admin.api.workflowResources.publishContract({
    key,
    kind: "event",
    events: {
      [completedJob]: { data, browser: true },
      "grasp.job.timeout": { data, browser: false },
    },
  });
  return key;
};

/**
 * A greeting workflow's definition that waits, in task `task`, for a
 * job's completion through its `jobEvents` binding to event contract
 * `contract`; and in a task of each of `more`'s names, through a binding
 * of that name to the same contract; asking its `approval` (decision
 * contract `decision`) first, when given. `label` titles its greeting, so
 * one version's document differs from another's.
 */
export const jobWaitingOf = (
  contract: string,
  {
    task = "job",
    more = [],
    decision,
    label,
  }: {
    task?: string;
    more?: readonly string[];
    decision?: string;
    label?: string;
  } = {}
): string =>
  definitionOf(
    [
      ...(decision === undefined ? [] : decisionTasks("role:admin")),
      ...[["jobEvents", task], ...more.map((alias) => [alias, alias])].map(
        ([events, id]) => ({
          id,
          type: "waitForEvent",
          events,
          eventType: completedJob,
          timeout: "1 hour",
        })
      ),
      passing("greet", label),
    ],
    {
      permissions: {
        events: Object.fromEntries(
          ["jobEvents", ...more].map((alias) => [alias, { contract }])
        ),
        ...(decision === undefined
          ? {}
          : { decisions: { approval: { contract: decision } } }),
      },
    }
  );

/** A workflow's contract of `parts`, none of the rest. */
export const contractOf = (
  parts: Partial<WorkflowEventContract>
): WorkflowEventContract => ({
  events: {},
  listens: {},
  decisions: {},
  ...parts,
});

/**
 * The contract of a workflow asking its `approval` decision of a comment
 * on who to greet (`decisionTasks`, its contract's input `{ who }` and
 * response `{ comment }`), as an App binding it declares it.
 */
export const approvalDeclared = contractOf({
  decisions: {
    approval: {
      value: v.object({ comment: v.string() }).descriptor,
      context: v.object({ who: v.string() }).descriptor,
    },
  },
});

/**
 * The contract of a workflow `jobWaitingOf` makes with its defaults, as
 * an App binding it declares it: its `jobEvents`, and the task `job`
 * waiting on it.
 */
export const jobEventsDeclared = contractOf({
  events: {
    jobEvents: {
      type: completedJob,
      data: v.object({ jobId: v.string() }).descriptor,
    },
  },
  listens: { job: ["jobEvents"] },
});

/**
 * What a decision workflow ends with: how it was answered and by whom,
 * with the comment the answer carried, if any.
 */
const answeredStatus = {
  $expr: `${decided}.timedOut ? "unanswered" : (${decided}.approved ? "approved" : "declined") + " by " + ${decided}.by + (${decided}.payload === null ? "" : ": " + ${decided}.payload.comment)`,
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
      permissions: { decisions: { approval: { contract } } },
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
 * an hour would go on in the background of whatever test file runs next.
 * A run the engine has no record of has nothing to end.
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

/**
 * The App every bound workflow here is bound to: one page, one alias,
 * declaring `declares` of the workflow besides its args and returns (its
 * events, listen tasks and decisions, as the version bound has them), and
 * recording `bound` as the version it binds, as a draft's `bindWorkflow`
 * does.
 */
export const requestsApp = (
  alias: string,
  declares?: WorkflowEventContract,
  bound?: { readonly workflowId: string; readonly version: number }
): TestApp =>
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
        `permission.workflow(${JSON.stringify(alias)}, { args: v.object({ who: v.string().trim().min(1) }), returns: v.object({ status: v.string() }) })`,
      ],
      ...(declares === undefined ? {} : { contracts: { [alias]: declares } }),
      ...(bound === undefined ? {} : { bound: { [alias]: bound } }),
    },
    {
      "server/requests.ts": `import { permissions } from "../grasp.config.ts";

export const { ${alias} } = permissions;
`,
      // As the draft's lint takes it: a draft of it is proposed as it is.
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Desk = () => <main>Requests</main>;

export const Route = createFileRoute("/")({ component: Desk });
`,
    }
  );

/**
 * The reference to `alias` that the `@server/_generated/api` generator writes into the
 * pages' references of version 1 of `app`, from its sealed release.
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
  return workflowReferenceOf(declared);
};

/** A workflow reference, as `@server/_generated/api` generates it for a page. */
export type WorkflowReference = Awaited<ReturnType<typeof workflowReference>>;

/** A fresh command key, as the SDK makes one. */
export const keyOf = (): string => crypto.randomUUID().replaceAll("-", "");

/** What names a workflow reference's functions: its name. */
interface Named {
  readonly name: string;
}

/**
 * A page's call of the mutation `name` of the workflow `reference` names,
 * with `args`, under `key`: as `useWorkflow` and `useMutation` send it.
 */
export const mutationCall = (
  reference: Named,
  name: "start" | "pause" | "resume" | "cancel" | "send",
  args: unknown,
  key = keyOf()
): string =>
  JSON.stringify({
    reference: {
      name: `${reference.name}.mutations.${name}`,
      kind: "mutation",
    },
    args,
    idempotencyKey: key,
  });

/**
 * A page's read of the query `name` of the workflow `reference` names,
 * with `args`: as `useQuery` reads it, as data (`following` takes it) or
 * as a call's text (`queryCall`).
 */
export const workflowQuery = (
  reference: Named,
  name: "run" | "canStart" | "runs" | "history" | "decisions" | "decision",
  args: unknown
) => ({
  reference: {
    name: `${reference.name}.queries.${name}`,
    kind: "query",
  },
  args,
});

/** `workflowQuery` as a call's text. */
export const queryCall = (...args: Parameters<typeof workflowQuery>): string =>
  JSON.stringify(workflowQuery(...args));

/** A page's start of the workflow `reference` names, under `key`. */
export const startCommand = (
  reference: Named,
  args?: unknown,
  key = keyOf()
): string =>
  mutationCall(reference, "start", { args: args ?? { who: "Ada" } }, key);

/** A page's pause, resume or cancel of run `runId`, under `key`. */
export const controlCommand = (
  reference: Named,
  command: "pause" | "resume" | "cancel",
  runId: string,
  key = keyOf()
): string => mutationCall(reference, command, { runId }, key);

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a raw call answered: its value, or its refusal's code. */
export const outcomeOf = (answer: unknown): unknown => {
  const { result } = z.object({ result: resultSchema }).parse(answer);
  return result.ok ? result.value : result.error.code;
};

/** The run a page's start answered with. */
export const startedOf = (answer: unknown) =>
  z
    .object({
      runId: z.string(),
      workflowId: z.string(),
      workflowVersion: z.number(),
    })
    .parse(outcomeOf(answer));

/** A control's receipt as a page's call answered it. */
export const staged = (receipt: unknown) =>
  z.strictObject({ kind: z.string(), state: z.string() }).parse(receipt);

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
   * An App sealed and current, its page approved, with `alias` bound to
   * version 1 of a workflow and the App's `start` grant on it: a greeting
   * that waits `hold` first, or the definition `definition` makes of its
   * name; or, `sharing` another fixture's people and workflow, that one.
   * The App declares `declares` of it besides its args and returns: the
   * events, listen tasks and decisions the bound version has.
   */
  const boundApp = async ({
    hold,
    sharing,
    definition,
    alias = "followUp",
    declares,
  }: {
    hold?: string;
    sharing?: {
      readonly admin: Person;
      readonly builder: Person;
      readonly workflow: { readonly id: string; readonly name: string };
    };
    definition?: (name: string) => string;
    alias?: string;
    declares?: WorkflowEventContract;
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
    });
    // Committed, sealed as it is made current, and published.
    await release(builder, app, requestsApp(alias, declares));
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

/** A page of `person`'s on the App, opened: its frame's lease. */
export const pageOf = async (person: Person, app: string): Promise<string> => {
  const { lease } = await person.api.pages.open(app);
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
      [pageLeaseHeader]: lease,
      [pagePersonHeader]: person.userId,
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

/** Follows `request` raw on `person`'s page: what reached the page. */
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
  const subscription = await person.api.pages
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
  type: "generate",
  instructions: "Greet them.",
  input: { who: { $expr: "args.who" } },
  returns: objectSchema({ line: { kind: "string" } }),
};

/** What a workflow that asks its model ends with: the line it answered. */
export const askedLine = { $expr: "ask.line" };

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
      permissions: { ai: { contract } },
      status,
    })
  );
  await admin.api.workflowResources.approveBinding(workflow.id, {
    alias: "ai",
    target: { kind: "model", model },
    reviewed: { version: 1 },
  });
  return { ...workflow, contract };
};
