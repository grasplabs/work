/**
 * What the tests of grasp-workflow/2 workflows' calls share
 * (workflow-calls.test.ts and the workflow-*.test.ts beside it): people,
 * permissions and published workflows of their own, their runs, and what
 * those runs' calls left behind.
 */
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type {
  ConnectorContract,
  PendingAction,
} from "@grasp-os/shared/connect";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { personOf } from "../src/connections.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { appWorkflowStarts } from "../src/workflow-start-intents.ts";
import type { CallingAgent } from "../src/workflow-start-intents.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { connectModels, fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { liveStatus } from "./runs.ts";
import { unique } from "./sign-in.ts";

/** The model the organization chose, the one a binding may name. */
export const allowedModel = "mistral/mistral-large-latest";

// Chosen before any binding to it is approved; each test's provider
// answers for the same model.
export const chooseModel = async (): Promise<void> => {
  await connectModels(`test-model-key-${crypto.randomUUID()}`, [allowedModel]);
};

export const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
export const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return identityOf(userId, role);
};

/** A descriptor's text, as the host catalog holds it. */
export const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

/** A descriptor's exact JSON Schema, as connect and exports state one. */
export const shapeOf = (descriptor: string) =>
  jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, { exact: true });

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

/** A permission `by` asks for and `admin` grants. */
export const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

export interface Draft {
  permissions?: Record<string, unknown>;
  params?: Record<string, unknown>;
  steps: readonly unknown[];
  /** What the run's `status` ends as: an expression, the text `done` if none. */
  status?: string;
  /** The workflow's own code modules, by path. */
  modules?: Record<string, string>;
}

/** A definition: its input `{ who }`, its output `{ status }`. */
export const definitionOf = ({
  permissions = {},
  params = {},
  steps,
  status,
}: Draft): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: status === undefined ? "done" : { $expr: status } },
    params,
    permissions,
    steps,
  });

/** A workflow of `by`'s, published once from `draft`. */
export const published = async (by: Identity, draft: Draft) => {
  const workflow = await createWorkflowResource(env, by, `calls-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(draft),
    basedOn: null,
    ...(draft.modules === undefined ? {} : { modules: draft.modules }),
  });
  const [version] = await workflowVersions(env, by, workflow.id);
  return { workflow, executable: version?.build?.hash !== undefined };
};

/** Starts version 1 of workflow `id` for `by`, on `startEnv`: its run's ID. */
export const started = async (
  by: Identity,
  id: string,
  startEnv: Env = env
): Promise<string> => {
  const { runId } = await startWorkflow(
    startEnv,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    const [version] = await workflowVersions(env, by, id);
    throw new Error(
      `The start admitted no run: ${JSON.stringify(version?.build)}`
    );
  }
  return runId;
};

/** Run `runId` of workflow `id` once it has ended. */
export const ended = async (
  by: Identity,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** What a run ended with: its status, and its output or error code. */
export const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The audit events of run `runId`'s calls, each as its receipt says. */
export const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" && event.target?.id === runId
    )
    .map(({ detail }) => ({
      call: detail?.call,
      binding: detail?.binding,
      person: detail?.person,
      outcome: detail?.outcome,
    }));
};

/**
 * The events of run `runId`'s calls that connect and the model gateway
 * kept, by action, as their details name the run's workflow and person.
 */
export const callEventsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        (action === "connection.call" || action === "model.call") &&
        detail?.run === runId
    )
    .map(({ action, detail }) => ({
      action,
      workflow: detail?.subjectId ?? detail?.workflow,
      person: detail?.onBehalfOf ?? detail?.person,
    }));
};

/** Suspends a run: the next activation replays from the start. */
export const pause = { id: "pause", type: "wait", for: "1 second" };

/** Holds a run before its call: long enough to revoke what it needs. */
export const hold = { id: "hold", type: "wait", for: "1 second" };

/** What mail.send takes: `{ to, subject }`. */
export const mailInput = v.object({ to: v.string(), subject: v.string() });

/**
 * What a mail.send of its own takes that also names `attachments`, as a
 * native write that takes files does, though it takes none (GRA-887).
 */
export const mailInputWithAttachments = v.object({
  to: v.string(),
  subject: v.string(),
  attachments: v.array(
    v.object({
      name: v.string(),
      type: v.string(),
      size: v.number(),
      sha256: v.string(),
    })
  ),
});

/** A catalog contract of mail.send: `input` in, `{ messageId }` out. */
export const mailContract = async (
  admin: Identity,
  input: { descriptor: unknown } = mailInput
): Promise<string> => {
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptorOf(input),
        output: descriptorOf(v.object({ messageId: v.string() })),
      },
    },
  });
  return key;
};

/** `env`, its connect serving `contract` as that connection's contract. */
export const servingMail = (
  input: { descriptor: unknown } = mailInput
): Env => {
  const contract: ConnectorContract = {
    contract: "composio.mail@1",
    actions: {
      send: {
        tool: "mail.send",
        readOnly: false,
        input: JSON.stringify(shapeOf(descriptorOf(input))),
        output: JSON.stringify(
          shapeOf(descriptorOf(v.object({ messageId: v.string() })))
        ),
      },
    },
  };
  return {
    ...env,
    CONNECT: new Proxy(env.CONNECT, {
      get: (target, name): unknown =>
        name === "connectorContract"
          ? async () => await Promise.resolve(contract)
          : Reflect.get(target, name),
    }),
  };
};

/**
 * A workflow of `by`'s sending mail through binding `mail` (a connection
 * of its own, approved by `admin`) to its input's `who`, the subject its
 * sensitive `token` parameter (set to `token`) as a connector argument;
 * `before` its steps before the send, `to` whom it sends,
 * `plan` how the mail server answers. Answers what serves it.
 */
export const mailingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    before = [],
    to = { $expr: "args.who" },
    plan = [],
    sharing,
    plain = false,
    retry,
    attachments,
    token = "none",
  }: {
    before?: unknown[];
    to?: unknown;
    plan?: Parameters<typeof mailConnection>[0];
    /** Another alias, sorted first, approved for the same permission. */
    sharing?: string;
    /** It ends with its send: nothing after the send is admitted. */
    plain?: boolean;
    /** A retry policy of a try's catch around the send. */
    retry?: Record<string, unknown>;
    /** Files it names to attach, to an operation that takes none. */
    attachments?: unknown[];
    /** Its sensitive parameter's value, as people set it. */
    token?: string;
  } = {}
) => {
  const input =
    attachments === undefined ? mailInput : mailInputWithAttachments;
  const key = await mailContract(admin, input);
  const send = {
    id: "send",
    type: "call",
    connection: "mail",
    action: "mail.send",
    args: {
      to,
      subject: { $expr: "params.token" },
      ...(attachments === undefined ? {} : { attachments }),
    },
  };
  const { workflow, executable } = await published(by, {
    permissions: {
      connections: {
        mail: { contract: key },
        ...(sharing === undefined ? {} : { [sharing]: { contract: key } }),
      },
    },
    params: { token: { label: "Token", type: { kind: "string" } } },
    steps: [
      ...before,
      // The other alias, called by a step that never runs.
      ...(sharing === undefined
        ? []
        : [
            {
              id: "skipped",
              type: "call",
              if: { $expr: "false" },
              connection: sharing,
              action: "mail.send",
              args: { to: "Nobody", subject: "Never" },
            },
          ]),
      retry === undefined
        ? send
        : { id: "guard", type: "try", try: [send], catch: { retry } },
      ...(plain ? [] : [pause]),
    ],
    // A step in a try is read by nothing after it: a catch may take it.
    status: retry === undefined ? "send.messageId" : '"sent"',
  });
  await setWorkflowParams(env, by, workflow.id, {
    values: { token },
    expectedRevision: 0,
  });
  const mail = await mailConnection(plan);
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  const serving = servingMail(input);
  const approval = await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  if (sharing !== undefined) {
    await approveWorkflowBinding(serving, admin, workflow.id, {
      alias: sharing,
      target: { kind: "connector", permissionId, contract: "composio.mail@1" },
      reviewed: { version: 1 },
    });
  }
  return { workflow, executable, mail, permissionId, approval, serving };
};

/** A start request of Ada's, with a key of its own. */
export const adaStart = () => ({
  version: 1,
  input: { who: "Ada" },
  key: unique(),
});

/** The provider of the chosen model answering `replies` in turn. */
export const providerAnswering = async (...replies: ProviderReply[]) =>
  await fakeProviderFor([allowedModel], ...replies);

/** An agent step asking binding `summary` to greet the run's `who`. */
export const greetStep = (id = "greet", timeout?: string) => ({
  id,
  type: "generate",
  instructions: "Greet them.",
  input: { who: { $expr: "args.who" } },
  returns: objectSchema({ line: { kind: "string" } }),
  ...(timeout === undefined ? {} : { timeout }),
});

/**
 * A workflow of `by`'s asking binding `summary` (the allowed model,
 * approved by `admin`) to greet its input's `who`, `before` its steps
 * before the call.
 */
export const greetingWorkflow = async (
  by: Identity,
  admin: Identity,
  { before = [] }: { before?: unknown[] } = {}
) => {
  const key = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "model" });
  const { workflow, executable } = await published(by, {
    permissions: { ai: { contract: key } },
    steps: [...before, greetStep(), pause],
    status: "greet.line",
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "ai",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  return { workflow, executable, approval };
};

export const answer = (text: string) => ({
  text,
  inputTokens: 100,
  outputTokens: 20,
});

/**
 * An App of `by`'s, version 1 approved, binding version 1 of workflow
 * `workflowId` as `flow`, with a `start` grant of its own from `admin`; in
 * restricted mode when `restricted`. `start` starts it as App code does
 * (an action's `ctx.workflows.<alias>.start`), for `by`, made by `agent`'s call
 * when given: its run's ID.
 */
export const startingApp = async (
  by: Identity,
  admin: Identity,
  workflowId: string,
  { restricted }: { restricted: boolean }
) => {
  const app = appIdSchema.parse(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Starter', '', ?, ?)"
    ).bind(app, by.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
    ).bind(app, by.userId, Date.now()),
  ]);
  await bindWorkflowToApp(env, by, workflowId, {
    app,
    alias: "flow",
    version: 1,
  });
  await granted(by, admin, {
    subject: { type: "app", appId: app },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(workflowId),
    },
    actions: ["start"],
    binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  if (restricted) {
    await appHost(env, app).restrict();
  }
  const authority: Authority = {
    subject: { type: "app", appId: app },
    onBehalfOf: by.userId,
    mode: "interactive",
    appVersion: 1,
  };
  const start = async (
    startEnv: Env = env,
    agent: CallingAgent | null = null
  ): Promise<string> => {
    const { runId } = await appWorkflowStarts(startEnv, authority, agent).start(
      "flow",
      { who: "Ada" },
      unique()
    );
    if (runId === null) {
      throw new Error("The start admitted no run");
    }
    return runId;
  };
  return { app, start };
};

/** The action connect holds for `by` from run `runId`, once it holds it. */
export const heldFor = async (
  by: Identity,
  runId: string
): Promise<PendingAction> =>
  await vi.waitFor(
    async () => {
      const waiting = await env.CONNECT.listPendingActions(
        await personOf(env, by)
      );
      const ours = waiting.filter(
        ({ context }) =>
          context.type === "workflowRun" && context.runId === runId
      );
      expect(ours).toHaveLength(1);
      const [held] = ours;
      if (held === undefined) {
        throw new Error("Nothing held");
      }
      return held;
    },
    { timeout: 30_000, interval: 100 }
  );

/** What became of `promise`: its value, or the code it threw. */
export const settledCode = async (
  promise: Promise<unknown>
): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

/** Once the engine has run `runId` waiting: on its held call's wake. */
export const waiting = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 20_000, interval: 100 }
  );
};
