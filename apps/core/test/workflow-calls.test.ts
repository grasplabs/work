import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type {
  ConnectorContract,
  EndedRuns,
  PendingAction,
} from "@grasp-os/shared/connect";
import {
  agentIdSchema,
  appIdSchema,
  chatIdSchema,
  connectionIdSchema,
  permissionIdSchema,
  runIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import {
  maxAttemptTimeoutMs,
  stepIdempotencyKey,
} from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appFor } from "../src/apps.ts";
import { callConnection } from "../src/bindings.ts";
import { personOf } from "../src/connections.ts";
import { appHost, workspace } from "../src/durable-objects.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  createTriggerResource,
  updateTriggerVersion,
} from "../src/trigger-resources.ts";
import { resolveUnknownOutcome } from "../src/unknown-outcomes.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowDefinition,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { appWorkflowStarts } from "../src/workflow-start-intents.ts";
import type { CallingAgent } from "../src/workflow-start-intents.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import {
  startDetailsPerSweep,
  sweepRunDetails,
} from "../src/workflows/retention.ts";
import { repairWakes } from "../src/workflows/wakes.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveResourceRuns, objectSchema } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { mailControlUrl } from "./mail-server.ts";
import {
  answeringProvider,
  connectModels,
  fakeProviderFor,
} from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { withQuotas } from "./quota-limits.ts";
import {
  liveStatus,
  resumed,
  runInstance,
  runObject,
  stopped,
  whileEngineRefuses,
  woken,
} from "./runs.ts";
import {
  openRpc,
  outcome as resultOf,
  refusal,
  signedInApi,
  signedInWithRole,
  unique,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The calls of grasp-workflow/1 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

const idp = mockIdp();

/** The model the organization chose, the one a binding may name. */
const allowedModel = "mistral/mistral-large-latest";

// Chosen before any binding to it is approved; each test's provider
// answers for the same model.
const chooseModel = async (): Promise<void> => {
  await connectModels(`test-model-key-${crypto.randomUUID()}`, [allowedModel]);
};

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
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

/**
 * The read of the organization's chosen models, as the gateway routes a
 * call, after the call was authorized and before the ledger admits its
 * request (ai-model-choice.ts, `readModelChoice`).
 */
const modelChoiceRead = /from "org_settings"/iu;

/** A call's read of its run's authority (resource-authority.ts). */
const authorityRead = /approval\.alias/iu;

/** A descriptor's text, as the host catalog holds it. */
const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

/** A descriptor's exact JSON Schema, as connect and exports state one. */
const shapeOf = (descriptor: string) =>
  jsonSchemaOf(schemaFromDescriptor(descriptor).descriptor, { exact: true });

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

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

interface Draft {
  bindings?: Record<string, { kind: string; contract: string }>;
  params?: Record<string, unknown>;
  steps: readonly unknown[];
  /** What the run's `status` ends as: an expression, the text `done` if none. */
  status?: string;
  /** The workflow's own code modules, by path. */
  modules?: Record<string, string>;
}

/** A definition: its input `{ who }`, its output `{ status }`. */
const definitionOf = ({
  bindings = {},
  params = {},
  steps,
  status,
}: Draft): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: {
      schema: objectSchema({ status: { type: "string" } }),
      value: { status: status === undefined ? "done" : { $expr: status } },
    },
    params,
    bindings,
    steps,
  });

/** A workflow of `by`'s, published once from `draft`. */
const published = async (by: Identity, draft: Draft) => {
  const workflow = await createWorkflowResource(env, by, `calls-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(draft),
    basedOn: null,
    ...(draft.modules === undefined ? {} : { modules: draft.modules }),
  });
  const [version] = await workflowVersions(env, by, workflow.id);
  return { workflow, executable: version?.build.hash !== undefined };
};

/** Starts version 1 of workflow `id` for `by`, on `startEnv`: its run's ID. */
const started = async (
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
const ended = async (
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
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** The audit events of run `runId`'s calls, each as its receipt says. */
const receiptsOf = async (runId: string) => {
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
const callEventsOf = async (runId: string) => {
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
const pause = { id: "pause", type: "wait", for: "1 second" };

/** Holds a run before its call: long enough to revoke what it needs. */
const hold = { id: "hold", type: "wait", for: "1 second" };

/** Holds a run asleep for longer than any test takes. */
const longHold = { id: "asleep", type: "wait", for: "1 hour" };

/** What mail.send takes: `{ to, subject }`. */
const mailInput = v.object({ to: v.string(), subject: v.string() });

/**
 * What a mail.send of its own takes that also names `attachments`, as a
 * native write that takes files does, though it takes none (GRA-887).
 */
const mailInputWithAttachments = v.object({
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
const mailContract = async (
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
const servingMail = (input: { descriptor: unknown } = mailInput): Env => {
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
const mailingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    before = [],
    to = { $expr: "input.who" },
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
    type: "do",
    binding: "mail",
    operation: "mail.send",
    arguments: {
      to,
      subject: { $expr: "params.token" },
      ...(attachments === undefined ? {} : { attachments }),
    },
  };
  const { workflow, executable } = await published(by, {
    bindings: {
      mail: { kind: "connector", contract: key },
      ...(sharing === undefined
        ? {}
        : { [sharing]: { kind: "connector", contract: key } }),
    },
    params: { token: { kind: "text", label: "Token" } },
    steps: [
      ...before,
      // The other alias, called by a step that never runs.
      ...(sharing === undefined
        ? []
        : [
            {
              id: "skipped",
              type: "do",
              if: { $expr: "false" },
              binding: sharing,
              operation: "mail.send",
              arguments: { to: "Nobody", subject: "Never" },
            },
          ]),
      retry === undefined
        ? send
        : { id: "guard", type: "try", try: [send], catch: { retry } },
      ...(plain ? [] : [pause]),
    ],
    // A step in a try is read by nothing after it: a catch may take it.
    status: retry === undefined ? "steps.send.output.messageId" : '"sent"',
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

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** A start request of Ada's, with a key of its own. */
const adaStart = () => ({ version: 1, input: { who: "Ada" }, key: unique() });

/**
 * Makes the mail server of connection `id` answer `mail.send` with
 * `messageId` its `echo`, as a server returning what it was sent does.
 */
const echoingMail = async (id: string, echo: string): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const answered = { messageId: echo };
  await providers.fetch(mailControlUrl(id.slice("connection-".length)), {
    method: "POST",
    body: JSON.stringify({
      answers: {
        "mail.send": {
          content: [{ type: "text", text: JSON.stringify(answered) }],
          structuredContent: answered,
        },
      },
    }),
  });
};

describe("connector calls", () => {
  beforeAll(chooseModel);

  it("sends once through connect, its sensitive parameter only as a binding argument, and a replay sends nothing again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const secret = `secret-${unique()}`;
    const { workflow, executable, mail, serving } = await mailingWorkflow(
      ada,
      admin,
      { token: secret }
    );
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    const events = JSON.stringify(await allEvents());
    expect({
      executable,
      end: endOf(run),
      // The mail server got the call once, its subject the secret: the
      // value reached connect, through the call's binding argument.
      sent: sent.sent,
      calls: sent.calls,
      receipts: await receiptsOf(runId),
      // Connect's own record names the workflow, the run and the person.
      callEvents: await callEventsOf(runId),
      // Nothing the run or the audit log keeps holds it.
      inOutput: JSON.stringify(run).includes(secret),
      inAudit: events.includes(secret),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "message-1" } },
      sent: [{ to: "Ada", subject: secret }],
      calls: 1,
      // Started before it went out, done once it answered.
      receipts: ["started", "done"].map((outcome) => ({
        call: "grasp.connector",
        binding: "mail",
        person: ada.userId,
        outcome,
      })),
      callEvents: [
        {
          action: "connection.call",
          workflow: workflow.id,
          person: ada.userId,
        },
      ],
      inOutput: false,
      inAudit: false,
    });
  });

  it("refuses files named to attach to an operation whose contract takes none, sending nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      attachments: [
        {
          name: "a.txt",
          type: "text/plain",
          size: 1,
          sha256: "0".repeat(64),
        },
      ],
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    expect({
      end: endOf(run),
      calls: sent.calls,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      calls: 0,
    });
  });

  it("refuses a connector's answer that echoes a binding argument, so its value is never recorded", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const secret = `secret-${unique()}`;
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      token: secret,
    });
    // The server answers with the subject it was sent, in a field the
    // contract takes.
    await echoingMail(mail.id, secret);
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    expect({
      end: endOf(run),
      inRun: JSON.stringify(run).includes(secret),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      inRun: false,
    });
  });

  it("refuses the next call of a running run once its approval or permission is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const byApproval = await mailingWorkflow(ada, admin, { before: [hold] });
    const byPermission = await mailingWorkflow(ada, admin, { before: [hold] });
    const approvalRun = await started(
      ada,
      byApproval.workflow.id,
      byApproval.serving
    );
    const permissionRun = await started(
      ada,
      byPermission.workflow.id,
      byPermission.serving
    );
    // Both runs sleep before their call: their starts stand.
    await revokeWorkflowBinding(
      env,
      admin,
      byApproval.workflow.id,
      byApproval.approval.id
    );
    await revokePermission(env, admin, byPermission.permissionId);
    const approvalEnd = await ended(ada, byApproval.workflow.id, approvalRun);
    const permissionEnd = await ended(
      ada,
      byPermission.workflow.id,
      permissionRun
    );
    const approvalMail = await byApproval.mail.did();
    const permissionMail = await byPermission.mail.did();
    expect({
      approval: endOf(approvalEnd),
      permission: endOf(permissionEnd),
      calls: [approvalMail.calls, permissionMail.calls],
      receipts: await receiptsOf(approvalRun),
    }).toStrictEqual({
      approval: { status: "failed", code: "workflow.call_denied" },
      permission: { status: "failed", code: "workflow.call_denied" },
      calls: [0, 0],
      receipts: [
        {
          call: "grasp.connector",
          binding: "mail",
          person: ada.userId,
          outcome: "workflow.call_denied",
        },
      ],
    });
  });

  it("refuses the next call of a running run once its person loses their role in the workflow", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    // Bob's run sleeps before its call; he's unshared, still a member.
    const runId = await started(bob, workflow.id, serving);
    await unshareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
    });
    // An admin reads why it failed: its details are its person's and theirs.
    const run = await ended(admin, workflow.id, runId);
    const sent = await mail.did();
    expect({ end: endOf(run), calls: sent.calls }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      calls: 0,
    });
  });

  it("never sends again under the same key, whatever its step's retries, once a send's outcome is lost, nor keeps its sensitive argument", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The server sends the mail, and its answer is lost on the way back.
    const secret = `secret-${unique()}`;
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      plan: ["lost"],
      token: secret,
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    // The call's person lists it as of unknown outcome, never its secret.
    const listed = await env.CONNECT.listUnknownOutcomes(
      await personOf(env, ada)
    );
    const ours = listed.filter(({ key }) => key.subject.type === "workflow");
    // Its person says it didn't happen, then that it did: whatever connect
    // makes of each, what it records of the call holds no hash of its input.
    for (const choice of ["not_happened", "happened"]) {
      for (const unknown of ours) {
        // oxlint-disable-next-line no-await-in-loop -- one decision after the other
        await resultOf(
          resolveUnknownOutcome(env, ada, unknown.key, choice, unknown.claim)
        );
      }
    }
    const events = await allEvents();
    const resolutions = events.filter(
      ({ action, detail }) =>
        action.startsWith("connection.call.resolve") &&
        detail?.subjectId === workflow.id
    );
    expect({
      resolutions: resolutions.length > 0,
      inputHashes: resolutions.filter(({ detail }) => "inputHash" in detail),
    }).toStrictEqual({ resolutions: true, inputHashes: [] });
    expect({
      status: run.status,
      calls: sent.calls,
      listed: ours.length,
      input: ours.map(({ input }) => input),
      secretShown: JSON.stringify(listed).includes(secret),
    }).toStrictEqual({
      status: "failed",
      calls: 1,
      listed: 1,
      input: [null],
      secretShown: false,
    });
  });

  it("checks a call's arguments against its contract before anything is sent", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // `to` is text in the contract; this one is a number.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: { $expr: "input.who.length" },
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    expect({ end: endOf(run), calls: sent.calls }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      calls: 0,
    });
  });
});

/** The provider of the chosen model answering `replies` in turn. */
const providerAnswering = async (...replies: ProviderReply[]) =>
  await fakeProviderFor([allowedModel], ...replies);

/** The name of the sleep run `run` is in, once it sleeps. */
const sleepOf = async (run: string): Promise<string> =>
  await vi.waitFor(
    async () => {
      const [step] = await runInDurableObject(
        runObject(run),
        (_object, state) =>
          state.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM steps WHERE type = 'sleep' AND state = 'waiting'"
            )
            .toArray()
      );
      if (step === undefined) {
        throw new Error(`Run ${run} isn't asleep yet`);
      }
      return step.name;
    },
    { timeout: 10_000, interval: 50 }
  );

/** An agent step asking binding `summary` to greet the run's `who`. */
const greetStep = (id = "greet", timeout?: string) => ({
  id,
  type: "agent",
  binding: "summary",
  instructions: "Greet them.",
  input: { who: { $expr: "input.who" } },
  output: objectSchema({ line: { type: "string" } }),
  ...(timeout === undefined ? {} : { timeout }),
});

/**
 * A workflow of `by`'s asking binding `summary` (the allowed model,
 * approved by `admin`) to greet its input's `who`, `before` its steps
 * before the call.
 */
const greetingWorkflow = async (
  by: Identity,
  admin: Identity,
  { before = [] }: { before?: unknown[] } = {}
) => {
  const key = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "model" });
  const { workflow, executable } = await published(by, {
    bindings: { summary: { kind: "model", contract: key } },
    steps: [...before, greetStep(), pause],
    status: "steps.greet.output.line",
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "summary",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  return { workflow, executable, approval };
};

const answer = (text: string) => ({ text, inputTokens: 100, outputTokens: 20 });

/** What run `runId` of workflow `id` says it waits for, once it waits for its AI provider. */
const providerWaitOf = async (by: Identity, id: string, runId: string) =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      if (run.aiProvider === undefined) {
        throw new Error(`Run ${runId} isn't waiting for its provider yet`);
      }
      const { provider, trouble } = run.aiProvider;
      return { provider, trouble };
    },
    { timeout: 20_000, interval: 100 }
  );

describe("model calls", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the gateway once for the task's structured output, and a replay asks nothing again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, executable } = await greetingWorkflow(ada, admin);
    const provider = await providerAnswering(answer('{"line":"Hello Ada"}'));
    const runId = await started(ada, workflow.id);
    const run = await ended(ada, workflow.id, runId);
    expect({
      executable,
      end: endOf(run),
      requests: provider.requests.length,
      receipts: await receiptsOf(runId),
      callEvents: await callEventsOf(runId),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "Hello Ada" } },
      requests: 1,
      receipts: ["started", "done"].map((outcome) => ({
        call: "grasp.model",
        binding: "summary",
        person: ada.userId,
        outcome,
      })),
      // The gateway's own record names the workflow, the run and the person.
      callEvents: [
        { action: "model.call", workflow: workflow.id, person: ada.userId },
      ],
    });
  });

  it("sends one request per model call, so the limit of calls bounds requests: an answer off its schema fails, never asked again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    const provider = await providerAnswering(
      answer("Hello, Ada!"),
      answer('{"line":"Never sent"}')
    );
    const run = await ended(ada, workflow.id, await started(ada, workflow.id));
    expect({
      status: run.status,
      requests: provider.requests.length,
    }).toStrictEqual({ status: "failed", requests: 1 });
  });

  it("waits while the provider refuses the key, provably billing nothing, and goes on once an admin replaces it, its call made again in a step of its own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    // Timed tries a minute apart: only the replacement's wake can resume
    // the run within the test.
    const before = env.WORKFLOW_OFF_WAIT_MS;
    env.WORKFLOW_OFF_WAIT_MS = "59000";
    try {
      const provider = { working: false };
      const fake = await answeringProvider(
        () =>
          provider.working
            ? answer('{"line":"Hello Ada"}')
            : { status: 401, errorType: "authentication_error" },
        { models: [allowedModel] }
      );
      const runId = await started(ada, workflow.id);
      const held = await providerWaitOf(ada, workflow.id, runId);
      // Its trace says so too, for what follows it (the run sheet).
      const tracedHeld = await resourceRunTrace(env, ada, workflow.id, runId);
      provider.working = true;
      const { api } = await signedInApi(idp, "admin");
      // The admin replaces the key (the provider's fake knows it by its
      // value, so it stays the same).
      await api.aiProviders.add({ provider: "mistral", key: fake.key });
      const run = await ended(ada, workflow.id, runId);
      const tracedEnd = await resourceRunTrace(env, ada, workflow.id, runId);
      expect({
        held,
        traced: [tracedHeld.aiProvider?.trouble, tracedEnd.aiProvider],
        end: endOf(run),
        shown: run.aiProvider,
        requests: fake.requests.length,
      }).toStrictEqual({
        held: { provider: "mistral", trouble: "refused" },
        traced: ["refused", undefined],
        end: { status: "completed", output: { status: "Hello Ada" } },
        shown: undefined,
        requests: 2,
      });
    } finally {
      env.WORKFLOW_OFF_WAIT_MS = before;
    }
  });

  it("shows a call waiting for its AI provider in its run's trace as its task's step waiting, then each run again an attempt more: reached, or failed", async () => {
    const admin = await person("admin");
    const signedIn = await signedInApi(idp, "builder");
    const ada = identityOf(signedIn.userId, "builder");
    const before = env.WORKFLOW_OFF_WAIT_MS;
    env.WORKFLOW_OFF_WAIT_MS = "59000";
    try {
      const provider: { answers: "refused" | "greets" | "off-schema" } = {
        answers: "refused",
      };
      const fake = await answeringProvider(
        () => {
          if (provider.answers === "greets") {
            return answer('{"line":"Hello Ada"}');
          }
          return provider.answers === "off-schema"
            ? answer("Hello, Ada!")
            : { status: 401, errorType: "authentication_error" };
        },
        { models: [allowedModel] }
      );
      /** The greeting's steps in the run's trace, as the builder reads it. */
      const greetOf = async (id: string, runId: string) => {
        const { steps } = await signedIn.api.workflowResources.runTrace(
          id,
          runId
        );
        return steps
          .filter(({ task }) => task === "greet")
          .map(
            ({ state, attempts, endedAt }) =>
              `${state} ${attempts} ${endedAt === null ? "open" : "ended"}`
          );
      };
      /** A run of a greeting that waits for its provider, then goes on once `answers`. */
      const waitedThen = async (answers: "greets" | "off-schema") => {
        const { workflow } = await greetingWorkflow(ada, admin);
        provider.answers = "refused";
        const runId = await started(ada, workflow.id);
        await providerWaitOf(ada, workflow.id, runId);
        const waiting = await greetOf(workflow.id, runId);
        provider.answers = answers;
        // The admin replaces the key (the provider's fake knows it by its
        // value, so it stays the same).
        const { api } = await signedInApi(idp, "admin");
        await api.aiProviders.add({ provider: "mistral", key: fake.key });
        const run = await ended(ada, workflow.id, runId);
        return {
          status: run.status,
          waiting,
          after: await greetOf(workflow.id, runId),
        };
      };

      expect({
        greets: await waitedThen("greets"),
        offSchema: await waitedThen("off-schema"),
      }).toStrictEqual({
        greets: {
          status: "completed",
          // One step: its first attempt refused, then waiting.
          waiting: ["waiting 1 open"],
          // Run again once the key works: an attempt more.
          after: ["reached 2 ended"],
        },
        offSchema: {
          status: "failed",
          waiting: ["waiting 1 open"],
          after: ["failed 2 ended"],
        },
      });
    } finally {
      env.WORKFLOW_OFF_WAIT_MS = before;
    }
  });

  it("shows a call whose AI provider never came back, once its wait ran out, in its run's trace as its task's step failed with the provider's code", async () => {
    const admin = await person("admin");
    const signedIn = await signedInApi(idp, "builder");
    const ada = identityOf(signedIn.userId, "builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await answeringProvider(
      () => ({ status: 401, errorType: "authentication_error" }),
      { models: [allowedModel] }
    );
    const keyHold = env.WORKFLOW_AI_KEY_HOLD_MS;
    env.WORKFLOW_AI_KEY_HOLD_MS = "1500";
    let run: WorkflowResourceRun;
    let runId: string;
    try {
      runId = await started(ada, workflow.id);
      run = await ended(ada, workflow.id, runId);
    } finally {
      env.WORKFLOW_AI_KEY_HOLD_MS = keyHold;
    }
    const { steps, tasks } = await signedIn.api.workflowResources.runTrace(
      workflow.id,
      runId
    );
    const greet = steps.filter(({ task }) => task === "greet");

    expect({
      end: endOf(run),
      steps: greet.map(({ state, errorCode, endedAt }) => ({
        state,
        errorCode,
        ended: endedAt !== null,
      })),
      task: tasks.find(({ task }) => task === "greet")?.state,
    }).toStrictEqual({
      end: { status: "failed", code: "model.provider_key_failed" },
      steps: [
        {
          state: "failed",
          errorCode: "model.provider_key_failed",
          ended: true,
        },
      ],
      task: "failed",
    });
  });

  it("waits while the provider fails its call with a 5xx and no answer, and goes on by itself once calls work again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    const provider = { working: false };
    const fake = await answeringProvider(
      () =>
        provider.working
          ? answer('{"line":"Hello Ada"}')
          : { status: 503, errorType: "overloaded_error" },
      { models: [allowedModel] }
    );
    const runId = await started(ada, workflow.id);
    const held = await providerWaitOf(ada, workflow.id, runId);
    // The outage ends: nobody touches Grasp.
    provider.working = true;
    const run = await ended(ada, workflow.id, runId);
    expect({
      held,
      end: endOf(run),
      // One request per try, each sent once.
      tries: fake.requests.length >= 2,
    }).toStrictEqual({
      held: { provider: "mistral", trouble: "not_answering" },
      end: { status: "completed", output: { status: "Hello Ada" } },
      tries: true,
    });
  });

  it("fails with the clear code, never sending again, once the provider's answer broke off partway", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    const provider = await providerAnswering(
      { ...answer('{"line":"Hello Ada"}'), cut: 5 },
      answer('{"line":"Never sent"}')
    );
    const run = await ended(ada, workflow.id, await started(ada, workflow.id));
    expect({
      end: endOf(run),
      requests: provider.requests.length,
    }).toStrictEqual({
      end: { status: "failed", code: "model.provider_unavailable" },
      requests: 1,
    });
  });

  it("refuses the next call once the grant its start was admitted on is revoked: a trigger's, an App's or an agent's", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const provider = await providerAnswering(answer('{"line":"Never sent"}'));
    const startOf = async (
      subject: PermissionRequest["subject"],
      id: string
    ): Promise<string> =>
      await granted(ada, admin, {
        subject,
        object: {
          type: "workflow",
          workflowId: workflowResourceIdSchema.parse(id),
        },
        actions: ["start"],
        binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
      });
    // A trigger's start.
    const byTrigger = await greetingWorkflow(ada, admin, { before: [hold] });
    const trigger = await createTriggerResource(env, ada, {
      kind: "webhook",
      workflowId: byTrigger.workflow.id,
      version: 1,
      config: {},
    });
    const triggerGrant = await startOf(
      { type: "trigger", triggerId: triggerIdSchema.parse(trigger.id) },
      byTrigger.workflow.id
    );
    const triggerRun = await startWorkflow(
      env,
      { type: "trigger", triggerId: trigger.id },
      byTrigger.workflow.id,
      adaStart()
    );
    // An App's, from a version an admin approved.
    const byApp = await greetingWorkflow(ada, admin, { before: [hold] });
    const app = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
      ).bind(app, ada.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
      ).bind(app, ada.userId, Date.now()),
    ]);
    const appGrant = await startOf(
      { type: "app", appId: appIdSchema.parse(app) },
      byApp.workflow.id
    );
    const appRun = await startWorkflow(
      env,
      {
        type: "app",
        authority: {
          subject: { type: "app", appId: appIdSchema.parse(app) },
          onBehalfOf: ada.userId,
          mode: "interactive",
          appVersion: 1,
        },
      },
      byApp.workflow.id,
      adaStart()
    );
    // An agent's.
    const byAgent = await greetingWorkflow(ada, admin, { before: [hold] });
    const agent = agentIdSchema.parse(`agent-${unique()}`);
    const agentGrant = await startOf(
      { type: "agent", agentId: agent },
      byAgent.workflow.id
    );
    const agentRun = await startWorkflow(
      env,
      {
        type: "agent",
        authority: {
          subject: { type: "agent", agentId: agent },
          onBehalfOf: ada.userId,
          mode: "interactive",
        },
      },
      byAgent.workflow.id,
      adaStart()
    );
    // Another person's grant to the agent, in a chat of theirs: it never
    // holds for Ada's run.
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, resource, actions, binding, status, requested_by, requested_at, granted_by, granted_at, chat_id, personal) SELECT ?, subject_type, subject_id, object_type, object_id, resource, actions, binding || '_CHAT', 'active', ?, requested_at, granted_by, granted_at, ?, personal FROM permissions WHERE id = ?"
    )
      .bind(crypto.randomUUID(), admin.userId, crypto.randomUUID(), agentGrant)
      .run();
    // Each run sleeps before its call: each start stands.
    for (const grant of [triggerGrant, appGrant, agentGrant]) {
      // oxlint-disable-next-line no-await-in-loop -- one revocation at a time
      await revokePermission(env, admin, grant);
    }
    const ends = [];
    for (const [workflow, run] of [
      [byTrigger.workflow.id, triggerRun.runId],
      [byApp.workflow.id, appRun.runId],
      [byAgent.workflow.id, agentRun.runId],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      ends.push(endOf(await ended(ada, workflow, run ?? "")));
    }
    expect({ ends, requests: provider.requests.length }).toStrictEqual({
      ends: Array.from({ length: 3 }, () => ({
        status: "failed",
        code: "workflow.call_denied",
      })),
      requests: 0,
    });
  });

  it("refuses the next call of a trigger's run once the trigger is moved off its version, and goes on while it still targets it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Each run's call answered, if it is made.
    const hello = answer('{"line":"Hello Ada"}');
    await providerAnswering(hello, hello, hello, hello);
    // A wait before its call that only the test ends, once the trigger
    // moved: the call can't come before the move.
    const waits = { id: "hold", type: "wait", for: "1 day" };
    const runOf = async (move: (trigger: string) => Promise<void>) => {
      const { workflow } = await greetingWorkflow(ada, admin, {
        before: [waits],
      });
      // A version 2 to move the trigger to: a step's title alone changed.
      const first = z
        .looseObject({ steps: z.array(z.looseObject({})) })
        .parse(JSON.parse(await workflowDefinition(env, ada, workflow.id, 1)));
      await publishWorkflowVersion(env, ada, workflow.id, {
        definition: JSON.stringify({
          ...first,
          steps: first.steps.map((step, index) =>
            index === 0 ? { ...step, title: "Wait a day" } : step
          ),
        }),
        basedOn: 1,
      });
      const trigger = await createTriggerResource(env, ada, {
        kind: "webhook",
        workflowId: workflow.id,
        version: 1,
        config: {},
      });
      await granted(ada, admin, {
        subject: {
          type: "trigger",
          triggerId: triggerIdSchema.parse(trigger.id),
        },
        object: {
          type: "workflow",
          workflowId: workflowResourceIdSchema.parse(workflow.id),
        },
        actions: ["start"],
        binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
      });
      const { runId } = await startWorkflow(
        env,
        { type: "trigger", triggerId: trigger.id },
        workflow.id,
        adaStart()
      );
      const run = runId ?? "";
      // Asleep before its call; moved meanwhile; then woken.
      const sleep = await sleepOf(run);
      await move(trigger.id);
      await woken(run, sleep);
      return endOf(await ended(ada, workflow.id, run));
    };
    const moved = await runOf(async (trigger) => {
      await updateTriggerVersion(env, ada, trigger, 2);
    });
    // A new trigger version with the same target, and a move away and
    // back: it targets the run's workflow and version as the call is made.
    const sameTarget = await runOf(async (trigger) => {
      await updateTriggerVersion(env, ada, trigger, 1);
    });
    const movedBack = await runOf(async (trigger) => {
      await updateTriggerVersion(env, ada, trigger, 2);
      await updateTriggerVersion(env, ada, trigger, 1);
    });
    // Aimed at another workflow (no call does this today: a trigger keeps
    // its workflow, so the database is written as one would).
    const elsewhere = await runOf(async (trigger) => {
      const other = await greetingWorkflow(ada, admin);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO trigger_resource_versions (trigger_id, version, workflow_resource_id, workflow_resource_version, config_hash, principal_binding, created_at) SELECT trigger_id, version + 1, ?, 1, config_hash, principal_binding, ? FROM trigger_resource_versions WHERE trigger_id = ? AND version = (SELECT current_version FROM trigger_resources WHERE id = ?)"
        ).bind(other.workflow.id, Date.now(), trigger, trigger),
        env.DB.prepare(
          "UPDATE trigger_resources SET current_version = current_version + 1 WHERE id = ?"
        ).bind(trigger),
      ]);
    });
    expect({ moved, elsewhere, sameTarget, movedBack }).toStrictEqual({
      moved: { status: "failed", code: "workflow.call_denied" },
      elsewhere: { status: "failed", code: "workflow.call_denied" },
      sameTarget: { status: "completed", output: { status: "Hello Ada" } },
      movedBack: { status: "completed", output: { status: "Hello Ada" } },
    });
  });

  it("sends a model call's request only while its run's authority holds once the ledger admitted it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, approval } = await greetingWorkflow(ada, admin, {
      before: [hold],
    });
    const provider = await providerAnswering(answer('{"line":"Never sent"}'));
    const run = await started(ada, workflow.id);
    // The approval is revoked as the gateway routes the call, after the
    // call was authorized.
    const db = env.DB;
    const prepare = db.prepare.bind(db);
    const revoking: Promise<unknown>[] = [];
    const authorized = { once: false };
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      authorized.once ||= authorityRead.test(statement);
      if (
        authorized.once &&
        revoking.length === 0 &&
        modelChoiceRead.test(statement)
      ) {
        revoking.push(
          prepare(
            "UPDATE workflow_binding_approvals SET status = 'revoked' WHERE id = ?"
          )
            .bind(approval.id)
            .run()
        );
      }
      return prepare(statement);
    });
    const end = endOf(await ended(ada, workflow.id, run));
    await Promise.all(revoking);
    expect({
      raced: revoking.length,
      end,
      requests: provider.requests.length,
    }).toStrictEqual({
      raced: 1,
      end: { status: "failed", code: "workflow.call_denied" },
      requests: 0,
    });
  });

  it("refuses a model's answer past what a step records before reading it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(
      answer(
        JSON.stringify({ line: "x".repeat(platformLimits.stepPayloadBytes) })
      )
    );
    const run = await started(ada, workflow.id);
    expect(endOf(await ended(ada, workflow.id, run))).toStrictEqual({
      status: "failed",
      code: "workflow.call_invalid",
    });
  });

  it("refuses the next model call once its approval is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const revoked = await greetingWorkflow(ada, admin, { before: [hold] });
    const provider = await providerAnswering(answer('{"line":"Never sent"}'));
    const revokedRun = await started(ada, revoked.workflow.id);
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    expect({
      revoked: endOf(revokedEnd),
      requests: provider.requests.length,
    }).toStrictEqual({
      revoked: { status: "failed", code: "workflow.call_denied" },
      requests: 0,
    });
  });
});

/** This month, as admins read spend in it, such as `2026-11`. */
const thisMonth = (): string =>
  new Date().toISOString().slice(0, "yyyy-mm".length);

/** What the models settings say an independent workflow spent this month. */
const workflowSpend = async (workflowId: string) => {
  const { session } = await signedInWithRole(idp, "admin");
  const { core } = await openRpc(session, {
    coreEnv: { ...env, SPEND_MONTH: thisMonth() },
  });
  const spend = await core.authenticate().models.spend();
  return spend.workflows.filter((each) => each.workflowId === workflowId);
};

describe("an independent workflow's model spend", () => {
  beforeAll(chooseModel);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts every run of it, as admins read it with its name and runs", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hello again"}')
    );
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ended(ada, workflow.id, await started(ada, workflow.id));
    }
    const read = await workflowSpend(workflow.id);
    const amount = read[0]?.amount ?? 0;
    expect(amount).toBeGreaterThan(0);
    expect(read).toStrictEqual([
      {
        appId: null,
        appName: null,
        workflowId: workflow.id,
        name: workflow.name,
        amount,
        runs: 2,
      },
    ]);
  });

  it("keeps a deleted workflow's spend for admins, by its ID, with no name to link it by", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(answer('{"line":"Hello Ada"}'));
    await ended(ada, workflow.id, await started(ada, workflow.id));
    // Deleted since: its row stays, marked.
    await env.DB.prepare(
      "UPDATE workflow_resources SET deleted_at = ? WHERE id = ?"
    )
      .bind(Date.now(), workflow.id)
      .run();
    const read = await workflowSpend(workflow.id);
    expect(
      read.map(({ name, amount, runs }) => ({
        name,
        spent: amount > 0,
        runs,
      }))
    ).toStrictEqual([{ name: null, spent: true, runs: 1 }]);
  });
});

/**
 * An App of `by`'s, version 1 approved, binding version 1 of workflow
 * `workflowId` as `flow`, with a `start` grant of its own from `admin`; in
 * restricted mode when `restricted`. `start` starts it as App code does
 * (an action's `ctx.workflows.<alias>.start`), for `by`, made by `agent`'s call
 * when given: its run's ID.
 */
const startingApp = async (
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

/** What run `runId`'s receipt and row pin of its restricted mode. */
const pinnedRestricted = async (runId: string) =>
  await env.DB.prepare(
    "SELECT receipt.restricted AS receipt, run.restricted AS run FROM workflow_start_receipts AS receipt JOIN workflow_resource_runs AS run ON run.id = receipt.id WHERE receipt.id = ?"
  )
    .bind(runId)
    .first<{ receipt: number; run: number }>();

/** The action connect holds for `by` from run `runId`, once it holds it. */
const heldFor = async (by: Identity, runId: string): Promise<PendingAction> =>
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
const settledCode = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

describe("runs started by a restricted App", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are restricted for good: a side effect waits for its person across replays, is sent once they confirm, and the workflow's later runs aren't restricted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The send runs in a later activation than the start, and a replay
    // after it walks past the send again.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    const mailWhileHeld = await mail.did();
    const runWhileHeld = await resourceRunFor(env, ada, workflow.id, runId);
    const whileHeld = {
      calls: mailWhileHeld.calls,
      status: runWhileHeld.status,
      // Pinned once, never changed: the database refuses it, whatever
      // asks, retention's removal of its details included.
      unpinReceipt: await settledCode(
        env.DB.prepare(
          "UPDATE workflow_start_receipts SET restricted = 0, input = NULL, params = NULL, details_removed_at = ? WHERE id = ?"
        )
          .bind(Date.now(), runId)
          .run()
      ),
      unpinRun: await settledCode(
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET restricted = 0 WHERE id = ?"
        )
          .bind(runId)
          .run()
      ),
    };
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    // A later run of the same workflow, Ada's own start: not restricted.
    const later = await started(ada, workflow.id, serving);
    const laterRun = await ended(ada, workflow.id, later);
    const sent = await mail.did();
    expect({
      pinned: await pinnedRestricted(runId),
      held: {
        subject: held.subject.type,
        mode: held.mode,
        restricted: held.restricted,
      },
      calls: whileHeld.calls,
      status: whileHeld.status,
      unpinned: [
        String(whileHeld.unpinReceipt).includes("immutable"),
        String(whileHeld.unpinRun).includes("pin what they run"),
      ],
      end: endOf(run),
      laterPinned: await pinnedRestricted(later),
      laterEnd: endOf(laterRun),
      // Once for the confirmed run, its replays sending nothing again, and
      // once for the later run, never held.
      sent: sent.calls,
    }).toStrictEqual({
      pinned: { receipt: 1, run: 1 },
      held: { subject: "workflow", mode: "workflow", restricted: true },
      calls: 0,
      status: "running",
      unpinned: [true, true],
      end: { status: "completed", output: { status: "message-1" } },
      laterPinned: { receipt: 0, run: 0 },
      laterEnd: { status: "completed", output: { status: "message-2" } },
      sent: 2,
    });
  });

  it("refuse confirming a side effect while its run is paused, then send it once and complete once resumed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Paused while it waits for its person, as a page's pause asks it.
    await runEngine(env).pause(runId, 1);
    await vi.waitFor(
      async () => {
        await expect(
          resourceRunFor(env, ada, workflow.id, runId)
        ).resolves.toMatchObject({ status: "paused" });
      },
      { timeout: 30_000, interval: 50 }
    );
    const whilePaused = await settledCode(
      confirmPendingAction(env, ada, held.id, held.inputHash)
    );
    const { calls: sentWhilePaused } = await mail.did();
    // Resumed: its next activation may read its row before it hears of the
    // resume, and goes on all the same.
    await runEngine(env).resume(runId, 2);
    await vi.waitFor(
      async () => {
        await expect(
          resourceRunFor(env, ada, workflow.id, runId)
        ).resolves.not.toMatchObject({ status: "paused" });
      },
      { timeout: 30_000, interval: 50 }
    );
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    const { calls: sent } = await mail.did();
    expect({
      whilePaused,
      sentWhilePaused,
      end: endOf(run),
      sent,
    }).toStrictEqual({
      whilePaused: "workflow.run_paused",
      sentWhilePaused: 0,
      end: { status: "completed", output: { status: "message-1" } },
      sent: 1,
    });
  });

  it("send nothing their person declines, nor anything confirmed once the run's own authority for its alias is gone, whatever other alias shares its permission", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const declined = await mailingWorkflow(ada, admin);
    // Another alias shares its permission, and stays approved: it never
    // stands in for the alias its call went through.
    const revoked = await mailingWorkflow(ada, admin, { sharing: "draft" });
    const declinedStarter = await startingApp(
      ada,
      admin,
      declined.workflow.id,
      {
        restricted: true,
      }
    );
    const revokedStarter = await startingApp(ada, admin, revoked.workflow.id, {
      restricted: true,
    });
    const declinedRun = await declinedStarter.start(declined.serving);
    const revokedRun = await revokedStarter.start(revoked.serving);
    const adaPerson = await personOf(env, ada);
    const declinedHeld = await heldFor(ada, declinedRun);
    await env.CONNECT.declineAction({ person: adaPerson, id: declinedHeld.id });
    const revokedHeld = await heldFor(ada, revokedRun);
    // Its approval revoked as it waits: confirming sends nothing.
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const confirmed = await settledCode(
      confirmPendingAction(env, ada, revokedHeld.id, revokedHeld.inputHash)
    );
    const stillHeld = await heldFor(ada, revokedRun);
    // Its person declines it after all: the run ends.
    await env.CONNECT.declineAction({ person: adaPerson, id: stillHeld.id });
    const declinedEnd = await ended(ada, declined.workflow.id, declinedRun);
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    const declinedMail = await declined.mail.did();
    const revokedMail = await revoked.mail.did();
    expect({
      declined: endOf(declinedEnd),
      confirmed,
      revoked: endOf(revokedEnd),
      calls: [declinedMail.calls, revokedMail.calls],
    }).toStrictEqual({
      declined: { status: "failed", code: "connect.declined" },
      confirmed: "workflow.call_denied",
      // Its next run of the call is refused before connect is asked.
      revoked: { status: "failed", code: "workflow.call_denied" },
      calls: [0, 0],
    });
  });

  it("leave nothing held in connect once they end: confirming one refused, and the rest swept with their details", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const confirmed = await mailingWorkflow(ada, admin);
    const swept = await mailingWorkflow(ada, admin);
    const confirmedStarter = await startingApp(
      ada,
      admin,
      confirmed.workflow.id,
      { restricted: true }
    );
    const sweptStarter = await startingApp(ada, admin, swept.workflow.id, {
      restricted: true,
    });
    const confirmedRun = await confirmedStarter.start(confirmed.serving);
    const sweptRun = await sweptStarter.start(swept.serving);
    const confirmedHeld = await heldFor(ada, confirmedRun);
    await heldFor(ada, sweptRun);
    // Both cancelled while their send waits for Ada.
    await terminateResourceRun(env, ada, confirmed.workflow.id, confirmedRun);
    await terminateResourceRun(env, ada, swept.workflow.id, sweptRun);
    await ended(ada, confirmed.workflow.id, confirmedRun);
    await ended(ada, swept.workflow.id, sweptRun);
    const confirming = await settledCode(
      confirmPendingAction(env, ada, confirmedHeld.id, confirmedHeld.inputHash)
    );
    const adaPerson = await personOf(env, ada);
    const heldOf = async (runId: string) => {
      const waiting = await env.CONNECT.listPendingActions(adaPerson);
      return waiting.filter(
        ({ context }) =>
          context.type === "workflowRun" && context.runId === runId
      ).length;
    };
    const beforeSweep = await heldOf(sweptRun);
    // An unrestricted run, Ada's own: an App its calls reached may hold
    // under its key too (one entering restricted mode as it ran), so the
    // sweep asks connect to drop what it holds of it as well.
    const ownRun = await started(ada, confirmed.workflow.id, confirmed.serving);
    await ended(ada, confirmed.workflow.id, ownRun);
    const asked: string[] = [];
    const recording: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: (target, name): unknown =>
          name === "dropForEndedRuns"
            ? async (request: EndedRuns) => {
                asked.push(...request.runs.map(({ runId }) => runId));
                await target.dropForEndedRuns(request);
              }
            : Reflect.get(target, name),
      }),
    };
    // Past the run's retention, the sweep removes what connect holds of it.
    await sweepRunDetails(recording, new Date(Date.now() + 31 * 86_400_000));
    const confirmedMail = await confirmed.mail.did();
    const sweptMail = await swept.mail.did();
    expect({
      confirming,
      confirmedHeld: await heldOf(confirmedRun),
      beforeSweep,
      afterSweep: await heldOf(sweptRun),
      sweptOwn: asked.includes(ownRun),
      calls: [confirmedMail.calls, sweptMail.calls],
    }).toStrictEqual({
      confirming: "connect.run_ended",
      confirmedHeld: 0,
      beforeSweep: 1,
      afterSweep: 0,
      sweptOwn: true,
      // Ada's own run's send; the cancelled ones sent nothing.
      calls: [1, 0],
    });
  });

  it("leave nothing held of runs a sweep marks, when two sweeps overlap", async () => {
    const ada = await person("builder");
    const { workflow } = await published(ada, { steps: [] });
    // More ended runs due than one sweep takes, long ago.
    const longAgo = Date.now() - 400 * 86_400_000;
    const prefix = `overlap-${unique()}`;
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, created_at, restricted)
        SELECT ? || '-' || i, 'person', ?, ? || '-' || i, ?, 1, 'manifest', ?, 0, '{}', 'hash', '{}', 0, '[]', '', ?, 1 FROM n`
      ).bind(
        startDetailsPerSweep + 1,
        prefix,
        ada.userId,
        prefix,
        workflow.id,
        ada.userId,
        longAgo
      ),
      env.DB.prepare(
        `INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at, restricted)
        SELECT id, workflow_resource_id, 1, 'manifest', 'build', principal_id, 'completed', created_at, created_at, 1
        FROM workflow_start_receipts WHERE id LIKE ? || '-%'`
      ).bind(prefix),
    ]);
    const asked = new Set<string>();
    const later = new Date(Date.now() + 31 * 86_400_000);
    const recording = (onFirstDrop?: () => Promise<void>): Env => {
      let onDrop = onFirstDrop;
      return {
        ...env,
        CONNECT: new Proxy(env.CONNECT, {
          get: (target, name): unknown =>
            name === "dropForEndedRuns"
              ? async (request: EndedRuns) => {
                  for (const { runId } of request.runs) {
                    asked.add(runId);
                  }
                  await target.dropForEndedRuns(request);
                  const then = onDrop;
                  onDrop = undefined;
                  await then?.();
                }
              : Reflect.get(target, name),
        }),
      };
    };
    // A second sweep runs whole as the first asks connect to drop.
    await sweepRunDetails(
      recording(async () => {
        await sweepRunDetails(recording(), later);
      }),
      later
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM workflow_start_receipts WHERE id LIKE ? || '-%' AND details_removed_at IS NOT NULL"
    )
      .bind(prefix)
      .all<{ id: string }>();
    expect({
      marked: results.length > 0,
      markedUnasked: results.filter(({ id }) => !asked.has(id)).length,
    }).toStrictEqual({ marked: true, markedUnasked: 0 });
  });

  it("collect a held send's outcome once confirmed, though their lineage has no host calls left", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: "Ada",
      plain: true,
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    // Two host calls: the send's own, which the attempt that was held
    // takes, and one more. The rerun that collects what Ada decided takes
    // none: it repeats the held attempt's work, sending nothing new. So
    // the lineage still has one as the run's output step is admitted
    // (a step past the lineage's host calls is admitted no more).
    const { runId, run } = await withQuotas(
      { lineageHostCalls: 2 },
      async () => {
        const id = await starter.start(serving);
        const held = await heldFor(ada, id);
        await confirmPendingAction(env, ada, held.id, held.inputHash);
        return { runId: id, run: await ended(ada, workflow.id, id) };
      }
    );
    const lineage = await env.DB.prepare(
      "SELECT host_calls AS hostCalls FROM run_lineages WHERE root_run_id = ?"
    )
      .bind(runId)
      .first<{ hostCalls: number }>();
    const sent = await mail.did();
    expect({
      end: endOf(run),
      calls: sent.calls,
      hostCalls: lineage?.hostCalls,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "message-1" } },
      calls: 1,
      hostCalls: 1,
    });
  });

  it("wait for their person when a send that failed for a moment is held on its retry, then send it once confirmed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Its first round can't reach the mail server for a moment, through
    // its step's own attempts (connect lists the server's tools before it
    // holds anything), so the try's retry calls again under the send's
    // key, which connect holds for Ada.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: "Ada",
      plain: true,
      plan: ["unavailable", "unavailable", "unavailable"],
      retry: { attempts: 2, delay: "1 second", backoff: "constant" },
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Long enough for a host that rerun the held call at once to spend
    // the run's steps on it.
    await scheduler.wait(3000);
    const runWhileHeld = await resourceRunFor(env, ada, workflow.id, runId);
    const mailWhileHeld = await mail.did();
    const whileHeld = {
      status: runWhileHeld.status,
      calls: mailWhileHeld.calls,
    };
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    // The steps the run started: one rerun of the held call, once Ada
    // decided, never one for each check while she hadn't.
    using events = await runInstance(runId).subscribe({
      filter: ["attempt_started"],
    });
    const steps: string[] = [];
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one event at a time, in order
      const { done, value } = await events.next();
      if (done === true) {
        break;
      }
      if (value.type === "attempt_started") {
        steps.push(value.stepName);
      }
    }
    const sent = await mail.did();
    expect({
      whileHeld,
      end: endOf(run),
      calls: sent.calls,
      // The retry's round, as the run host names it after the send's key.
      retried: steps.some((name) =>
        /^\$grasp:wait:[0-9a-f]{16}:retry:2:run-1$/u.test(name)
      ),
      heldReruns: steps.filter((name) =>
        /^\$grasp:wait:[0-9a-f]{16}:held:\d+:run-/u.test(name)
      ).length,
    }).toStrictEqual({
      whileHeld: { status: "running", calls: 0 },
      end: { status: "completed", output: { status: "sent" } },
      calls: 1,
      retried: true,
      heldReruns: 1,
    });
  });

  it("start restricted from an agent's restricted chat, or one that names none, and not from an open chat", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await published(ada, { steps: [] });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: false,
    });
    const workspaceId = workspaceIdSchema.parse(crypto.randomUUID());
    const stub = workspace(env, workspaceId);
    // The workspace's agent: its id is the workspace's.
    const open = await stub.createChat("Questions", ada.userId, workspaceId);
    const shut = await stub.createChat("Questions", ada.userId, workspaceId);
    await stub.restrictChat(shut.id);
    await granted(ada, admin, {
      subject: { type: "agent", agentId: agentIdSchema.parse(workspaceId) },
      object: { type: "app", appId: starter.app },
      actions: ["write"],
      binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const agentIn = (chatId: string): CallingAgent => ({
      agentId: workspaceId,
      workspaceId,
      chatId: chatIdSchema.parse(chatId),
    });
    const fromOpen = await starter.start(env, agentIn(open.id));
    const fromShut = await starter.start(env, agentIn(shut.id));
    // An agent's own start that names no chat: nothing to read, so
    // restricted.
    const agent = agentIdSchema.parse(workspaceId);
    await granted(ada, admin, {
      subject: { type: "agent", agentId: agent },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const { runId: unnamed } = await startWorkflow(
      env,
      {
        type: "agent",
        authority: {
          subject: { type: "agent", agentId: agent },
          onBehalfOf: ada.userId,
          mode: "interactive",
        },
      },
      workflow.id,
      adaStart()
    );
    expect({
      open: await pinnedRestricted(fromOpen),
      shut: await pinnedRestricted(fromShut),
      unnamed: await pinnedRestricted(unnamed ?? ""),
      appRestricted: await appHost(env, starter.app).isRestricted(),
    }).toStrictEqual({
      open: { receipt: 0, run: 0 },
      shut: { receipt: 1, run: 1 },
      unnamed: { receipt: 1, run: 1 },
      appRestricted: false,
    });
  });
});

describe("a step's own timeout", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends an attempt that runs past its step's timeout, long before the host's", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const { workflow } = await published(by, {
      bindings: { summary: { kind: "model", contract: key } },
      steps: [greetStep("greet", "2 seconds")],
      status: "steps.greet.output.line",
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "summary",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    // The model never answers: only the attempt's timeout ends the call.
    const provider = await providerAnswering({ hang: true });
    const startedAt = Date.now();
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    // Its request cut off with its attempt, never left running past it.
    const cutOff = await vi.waitFor(
      () => {
        expect(provider.requests[0]?.signal.aborted).toBeTruthy();
        return true;
      },
      { timeout: 5000, interval: 100 }
    );
    expect({
      // Sent and never answered: it fails as past its step's time, and is
      // never sent again.
      end: endOf(run),
      requests: provider.requests.length,
      // Its step's two seconds, not the host's minute.
      early:
        Date.parse(run.endedAt ?? "") - startedAt < maxAttemptTimeoutMs / 2,
      cutOff,
    }).toStrictEqual({
      end: { status: "failed", code: "operation.deadline_exceeded" },
      requests: 1,
      early: true,
      cutOff: true,
    });
  });
});

/**
 * The module of action `greet`: `writer` asked twice (or `asks` times) for
 * a line of the declared shape, its answer the lines joined.
 */
const greetModule = (
  asks = 2
) => `import { action, resource, v } from "@grasp-os/sdk/action";

const writer = resource.model("writer", {
  output: v.object({ line: v.string() }),
});

export const greet = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [writer],
  handler: async (ctx, args) => {
    const lines: string[] = [];
    for (let ask = 0; ask < ${asks}; ask += 1) {
      const { line } = await ctx.resources.writer.generate({
        instructions: "Greet them.",
        input: { who: args.who, ask },
      });
      lines.push(line);
    }
    return { status: lines.join(" / ") };
  },
});
`;

/** The step calling action `greet` with the run's `who`. */
const greetTask = {
  id: "greet",
  type: "do",
  binding: "greet",
  arguments: { who: { $expr: "input.who" } },
};

/**
 * A workflow of `by`'s whose action `greet` asks `writer` (the allowed
 * model, approved by `admin`) for lines, running `steps`, ending with the
 * action's status. Its runs' model calls are held to `maxModelCalls`
 * (`quotas`, as `withQuotas` sets the run's ceiling).
 */
const writingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    steps,
    maxModelCalls,
    asks,
  }: { steps: unknown[]; maxModelCalls: number; asks?: number }
) => {
  const key = `writer-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "model" });
  const { workflow, executable } = await published(by, {
    bindings: {
      greet: { kind: "action", contract: "local:code/greet.ts#greet" },
      writer: { kind: "model", contract: key },
    },
    steps,
    status: "steps.greet.output.status",
    modules: { "code/greet.ts": greetModule(asks) },
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "writer",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  return {
    workflow,
    executable,
    approval,
    quotas: { lineageModelRequests: maxModelCalls },
  };
};

/** An agent step asking `writer` once more, as a step of the run's own. */
const writeAgain = {
  id: "again",
  type: "agent",
  binding: "writer",
  instructions: "Greet them again.",
  input: { who: { $expr: "input.who" } },
  output: objectSchema({ line: { type: "string" } }),
};

describe("model resources of a workflow's own actions", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the binding's model for the declared shape, each call an effect of its own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, executable } = await writingWorkflow(ada, admin, {
      steps: [greetTask, pause],
      maxModelCalls: 2,
    });
    const provider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hi again"}')
    );
    const runId = await started(ada, workflow.id);
    const run = await ended(ada, workflow.id, runId);
    const receipts = await receiptsOf(runId);
    const [version] = await workflowVersions(env, ada, workflow.id);
    expect({
      // The version's review shows the action's model use with the shape
      // its calls may answer, as sealed.
      listed: version?.actions.map(({ binding, uses }) => ({
        binding,
        uses: uses.map((use) => ({
          ...use,
          ...("output" in use
            ? {
                output: z
                  .record(z.string(), z.unknown())
                  .parse(JSON.parse(use.output)).kind,
              }
            : {}),
        })),
      })),
      executable,
      end: endOf(run),
      // Two requests, though the run replayed after its pause.
      requests: provider.requests.length,
      receipts: receipts.map(({ call, binding, outcome }) => ({
        call,
        binding,
        outcome,
      })),
    }).toStrictEqual({
      listed: [
        {
          binding: "greet",
          uses: [{ alias: "writer", kind: "model", output: "object" }],
        },
      ],
      executable: true,
      end: { status: "completed", output: { status: "Hello Ada / Hi again" } },
      requests: 2,
      receipts: ["started", "done", "started", "done"].map((outcome) => ({
        call: "grasp.model",
        binding: "writer",
        outcome,
      })),
    });
  });

  it("counts an action's model calls against the run's limit, within its attempt and across a replay", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The action spends the run's two calls; the step after its replay
    // asks for a third.
    const replayed = await writingWorkflow(ada, admin, {
      steps: [greetTask, pause, writeAgain],
      maxModelCalls: 2,
    });
    const replayProvider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hi again"}'),
      answer('{"line":"Never sent"}')
    );
    const replayedEnd = await withQuotas(
      replayed.quotas,
      async () =>
        await ended(
          ada,
          replayed.workflow.id,
          await started(ada, replayed.workflow.id)
        )
    );
    const replayRequests = replayProvider.requests.length;
    vi.restoreAllMocks();
    // One call left for an action that asks twice: the second is never sent.
    const within = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 1,
    });
    const withinProvider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Never sent"}')
    );
    const { withinRun, withinEnd } = await withQuotas(
      within.quotas,
      async () => {
        const id = await started(ada, within.workflow.id);
        return {
          withinRun: id,
          withinEnd: await ended(ada, within.workflow.id, id),
        };
      }
    );
    // The call refused at the limit leaves its evidence, naming its binding.
    const events = await allEvents();
    const refusedAtLimit = events
      .filter(
        (event) =>
          event.action === "workflow.call.refused" &&
          event.target?.id === withinRun
      )
      .map(({ detail }) => ({
        call: detail?.call,
        reason: detail?.reason,
        errorCode: detail?.errorCode,
      }));
    expect({
      replayed: endOf(replayedEnd),
      replayRequests,
      within: endOf(withinEnd),
      withinRequests: withinProvider.requests.length,
      refusedAtLimit,
    }).toStrictEqual({
      replayed: { status: "failed", code: "workflow.model_call_limit" },
      replayRequests: 2,
      within: { status: "failed", code: "workflow.model_call_limit" },
      withinRequests: 1,
      refusedAtLimit: [
        {
          call: "writer",
          reason: "model_call_limit",
          errorCode: "workflow.model_call_limit",
        },
      ],
    });
  });

  it("takes the run's last model call against the count the run keeps, whichever activation made the others", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, quotas } = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 2,
    });
    const runIdOf = Promise.withResolvers<string>();
    // While the action's first request is out, another activation of the
    // run keeps a model call of its own: the action's second finds none
    // left.
    const provider = await answeringProvider(
      async (requests) => {
        if (requests.length === 1) {
          await runInDurableObject(
            runObject(await runIdOf.promise),
            (_object, state) => {
              state.storage.sql.exec(
                "INSERT INTO grasp_action_model_calls (key) VALUES ('elsewhere')"
              );
            }
          );
        }
        return answer('{"line":"Hello Ada"}');
      },
      { models: [allowedModel] }
    );
    const end = await withQuotas(quotas, async () => {
      const runId = await started(ada, workflow.id);
      runIdOf.resolve(runId);
      return await ended(ada, workflow.id, runId);
    });
    expect({
      end: endOf(end),
      requests: provider.requests.length,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.model_call_limit" },
      requests: 1,
    });
  });

  it("refuses a version whose actions' model output shapes are past what it may hold, pointing at the action", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `writer-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const workflow = await createWorkflowResource(env, ada, `big-${unique()}`);
    // One output shape of some 80 KB: within what a module's contract may
    // take, past what the version's manifest holds.
    const big = `import { action, resource, v } from "@grasp-os/sdk/action";

const values = Array.from({ length: 400 }, (_, index) => \`\${"x".repeat(190)}\${index}\`);
const writer = resource.model("writer", {
  output: v.object({ pick: v.enum(values as [string, ...string[]]) }),
});

export const greet = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [writer],
  handler: async () => ({ status: "never" }),
});
`;
    const error = await refusal(
      publishWorkflowVersion(env, ada, workflow.id, {
        definition: definitionOf({
          bindings: {
            greet: { kind: "action", contract: "local:code/greet.ts#greet" },
            writer: { kind: "model", contract: key },
          },
          steps: [greetTask],
        }),
        basedOn: null,
        modules: { "code/greet.ts": big },
      })
    );
    const parsed = z
      .object({
        code: z.string(),
        details: z.object({
          problems: z.array(
            z.looseObject({ code: z.string(), pointer: z.string() })
          ),
        }),
      })
      .parse(error);
    expect({
      code: parsed.code,
      problems: parsed.details.problems.map(({ code, pointer }) => ({
        code,
        pointer,
      })),
    }).toStrictEqual({
      code: "workflow.definition_invalid",
      problems: [
        {
          code: "manifest.too_large",
          pointer: "/bindings/greet",
        },
      ],
    });
  });

  it("fails on an answer outside the declared shape, and refuses the next call once its approval is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const shaped = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 2,
      asks: 1,
    });
    const shapedProvider = await providerAnswering(
      answer('{"other":"Hello Ada"}')
    );
    const shapedEnd = await ended(
      ada,
      shaped.workflow.id,
      await started(ada, shaped.workflow.id)
    );
    const shapedRequests = shapedProvider.requests.length;
    vi.restoreAllMocks();
    const revoked = await writingWorkflow(ada, admin, {
      steps: [hold, greetTask],
      maxModelCalls: 2,
      asks: 1,
    });
    const revokedProvider = await providerAnswering(
      answer('{"line":"Never sent"}')
    );
    const revokedRun = await started(ada, revoked.workflow.id);
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    expect({
      shaped: endOf(shapedEnd),
      shapedRequests,
      revoked: endOf(revokedEnd),
      revokedRequests: revokedProvider.requests.length,
    }).toStrictEqual({
      // The gateway's refusal of an answer outside the declared shape.
      shaped: { status: "failed", code: "model.invalid_output" },
      shapedRequests: 1,
      revoked: { status: "failed", code: "workflow.call_denied" },
      revokedRequests: 0,
    });
  });
});

/**
 * Runs `test` with a held call's timed checks a long way apart: its first
 * wait outlasts how long a test waits for a run to end, so only a wake
 * (workflows/wakes.ts) lets a run go on within it.
 */
const withSlowChecks = async (test: () => Promise<void>): Promise<void> => {
  const wait = env.WORKFLOW_OFF_WAIT_MS;
  env.WORKFLOW_OFF_WAIT_MS = "120000";
  try {
    await test();
  } finally {
    env.WORKFLOW_OFF_WAIT_MS = wait;
  }
};

/** The wakes owed to independent run `runId`, still waiting to be sent. */
const wakesOwed = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_run_wakes WHERE resource_run_id = ?"
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** Once the engine has run `runId` waiting: on its held call's wake. */
const waiting = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 20_000, interval: 100 }
  );
};

describe("runs started by a restricted App, waiting on a held call", () => {
  beforeAll(chooseModel);
  afterEach(async () => {
    vi.restoreAllMocks();
    // A test that times out leaves its run waiting on its held call.
    await endLiveResourceRuns();
  });

  it("go on as soon as their person decides it, long before the next timed check: confirmed, it is sent once; declined, the run ends", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const confirmed = await mailingWorkflow(ada, admin);
      const declined = await mailingWorkflow(ada, admin);
      const confirmedStarter = await startingApp(
        ada,
        admin,
        confirmed.workflow.id,
        { restricted: true }
      );
      const declinedStarter = await startingApp(
        ada,
        admin,
        declined.workflow.id,
        { restricted: true }
      );
      const confirmedRun = await confirmedStarter.start(confirmed.serving);
      const declinedRun = await declinedStarter.start(declined.serving);
      const toConfirm = await heldFor(ada, confirmedRun);
      const toDecline = await heldFor(ada, declinedRun);
      await waiting(confirmedRun);
      await waiting(declinedRun);

      await signedIn.api.pendingActions.confirm(
        toConfirm.id,
        toConfirm.inputHash
      );
      await signedIn.api.pendingActions.decline(toDecline.id);
      const confirmedEnd = await ended(
        ada,
        confirmed.workflow.id,
        confirmedRun
      );
      const declinedEnd = await ended(ada, declined.workflow.id, declinedRun);
      const confirmedMail = await confirmed.mail.did();
      const declinedMail = await declined.mail.did();

      expect({
        confirmed: endOf(confirmedEnd),
        declined: endOf(declinedEnd),
        sent: [confirmedMail.calls, declinedMail.calls],
      }).toStrictEqual({
        confirmed: { status: "completed", output: { status: "message-1" } },
        declined: { status: "failed", code: "connect.declined" },
        sent: [1, 0],
      });
    });
  });

  it("go on once their person confirms, though the run was stopped and replayed while it waited", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const ada = await person("builder");
      const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      // A crash or a deploy while it waits: resumed, it replays its held
      // step and its first check from the journal, asking nobody again.
      await stopped(runId);
      await resumed(runId);
      await waiting(runId);

      await confirmPendingAction(env, ada, held.id, held.inputHash);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();

      expect({
        end: endOf(run),
        sent: sent.calls,
      }).toStrictEqual({
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    });
  });

  it("go on once their person confirms, though the engine refused the wake: the repair sends it", async () => {
    // Who sent the wake is on the record, so this holds however the run's
    // own timed checks fall: the repair's `workflow.wake.repaired` names
    // the wake the refused request owed.
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    await waiting(runId);
    // Confirmed while the engine takes no event: the wake stays owed.
    await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => {
        await confirmPendingAction(env, ada, held.id, held.inputHash);
      }
    );
    const owed = await env.DB.prepare(
      "SELECT id FROM workflow_run_wakes WHERE resource_run_id = ?"
    )
      .bind(runId)
      .all<{ id: string }>();
    await repairWakes(env, new Date(Date.now() + 60_000));
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    const events = await allEvents();
    const repaired = events
      .filter(
        ({ action, target }) =>
          action === "workflow.wake.repaired" && target?.id === runId
      )
      .map(({ actor, detail }) => ({ actor, wake: detail.wake }));

    expect({
      owed: owed.results.length,
      repaired,
      left: await wakesOwed(runId),
      end: endOf(run),
      sent: sent.calls,
    }).toStrictEqual({
      owed: 1,
      repaired: [{ actor: { type: "system" }, wake: owed.results[0]?.id }],
      left: 0,
      end: { status: "completed", output: { status: "message-1" } },
      sent: 1,
    });
  });

  it("shows a held call in its run's trace as its task's step waiting for its person, then reached once confirmed or failed once declined", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const confirmed = await mailingWorkflow(ada, admin);
      const declined = await mailingWorkflow(ada, admin);
      const confirmedStarter = await startingApp(
        ada,
        admin,
        confirmed.workflow.id,
        { restricted: true }
      );
      const confirmedRun = await confirmedStarter.start(confirmed.serving);
      const declinedStarter = await startingApp(
        ada,
        admin,
        declined.workflow.id,
        { restricted: true }
      );
      const declinedRun = await declinedStarter.start(declined.serving);
      const toConfirm = await heldFor(ada, confirmedRun);
      const toDecline = await heldFor(ada, declinedRun);
      await waiting(confirmedRun);
      await waiting(declinedRun);
      /** The send's steps in the run's trace, as the builder reads it. */
      const sendOf = async (id: string, runId: string) => {
        const { steps } = await signedIn.api.workflowResources.runTrace(
          id,
          runId
        );
        return steps
          .filter(({ task }) => task === "send")
          .map(
            ({ state, attempts, endedAt, errorCode }) =>
              `${state} ${attempts} ${endedAt === null ? "open" : "ended"} ${errorCode ?? "-"}`
          );
      };
      const whileHeld = await sendOf(confirmed.workflow.id, confirmedRun);

      await signedIn.api.pendingActions.confirm(
        toConfirm.id,
        toConfirm.inputHash
      );
      await signedIn.api.pendingActions.decline(toDecline.id);
      await ended(ada, confirmed.workflow.id, confirmedRun);
      await ended(ada, declined.workflow.id, declinedRun);

      expect({
        whileHeld,
        confirmed: await sendOf(confirmed.workflow.id, confirmedRun),
        declined: await sendOf(declined.workflow.id, declinedRun),
      }).toStrictEqual({
        // One step: its first attempt held, then waiting for its person.
        whileHeld: ["waiting 1 open -"],
        // Run again once they decided: an attempt more.
        confirmed: ["reached 2 ended -"],
        declined: ["failed 2 ended connect.declined"],
      });
    });
  });

  it("go on once their person confirms, though connect couldn't say for a moment whether it still waited", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Connect fails the run's first question of whether it still waits:
    // the check is asked again, never taken as an answer.
    const { CONNECT: connect } = env;
    let failures = 1;
    env.CONNECT = new Proxy(connect, {
      get: (target, name) => {
        if (name === "anyPending" && failures > 0) {
          failures -= 1;
          return async () => {
            await Promise.resolve();
            throw new Error("Connect didn't answer");
          };
        }
        const real: unknown = Reflect.get(target, name);
        return real;
      },
    });
    try {
      await waiting(runId);
      await confirmPendingAction(env, ada, held.id, held.inputHash);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();
      expect({ failures, end: endOf(run), sent: sent.calls }).toStrictEqual({
        failures: 0,
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    } finally {
      env.CONNECT = connect;
    }
  });

  it("go on as soon as connect decided their person's confirmation, though its answer was lost", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      // Connect confirms and sends, and its answer never reaches core.
      const { CONNECT: connect } = env;
      env.CONNECT = new Proxy(connect, {
        get: (target, name) => {
          const real: unknown = Reflect.get(target, name);
          if (name !== "confirmAction" || typeof real !== "function") {
            return real;
          }
          return async (...args: unknown[]): Promise<never> => {
            await Reflect.apply(real, target, args);
            throw new Error("Connect's answer was lost");
          };
        },
      });
      let confirmed: unknown;
      try {
        confirmed = await settledCode(
          signedIn.api.pendingActions.confirm(held.id, held.inputHash)
        );
      } finally {
        env.CONNECT = connect;
      }
      // Only the wake core owed before it asked connect ends the wait
      // within the test: its next timed check is minutes away.
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();
      expect({ confirmed, end: endOf(run), sent: sent.calls }).toStrictEqual({
        confirmed: "internal.unexpected",
        end: { status: "completed", output: { status: "message-1" } },
        sent: 1,
      });
    });
  });

  it("wake nothing on a confirmation that is refused, however often it is asked, so the run keeps its steps", async () => {
    await withSlowChecks(async () => {
      const admin = await person("admin");
      const signedIn = await signedInApi(idp, "builder");
      const ada = identityOf(signedIn.userId, "builder");
      const { workflow, mail, serving, permissionId } = await mailingWorkflow(
        ada,
        admin
      );
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted: true,
      });
      const runId = await starter.start(serving);
      const held = await heldFor(ada, runId);
      await waiting(runId);
      await revokePermission(env, admin, permissionId);
      // Enough confirmations, each refused, that the run's steps (60 in
      // tests) would run out did each wake it: none of them is a decision,
      // so none wakes the step.
      const confirmations = 40;
      const refused = new Set<unknown>();
      for (let tries = 0; tries < confirmations; tries += 1) {
        refused.add(
          // oxlint-disable-next-line no-await-in-loop -- one at a time
          await settledCode(
            signedIn.api.pendingActions.confirm(held.id, held.inputHash)
          )
        );
      }
      const stillWaiting = await liveStatus(runId);
      const owed = await wakesOwed(runId);
      await signedIn.api.pendingActions.decline(held.id);
      const run = await ended(ada, workflow.id, runId);
      const sent = await mail.did();

      expect({
        refused,
        stillWaiting,
        owed,
        end: endOf(run),
        sent: sent.calls,
      }).toStrictEqual({
        refused: new Set(["workflow.call_denied"]),
        stillWaiting: "waiting",
        owed: 0,
        // Its step runs again once declined, and its call is refused.
        end: { status: "failed", code: "workflow.call_denied" },
        sent: 0,
      });
    });
  });
});

/**
 * Holds `by`'s send through workflow `workflowId`'s mail binding, made in
 * its run `runId` (restricted, so connect holds it), under the key of
 * step `send:task` of run `keyRun`: a held call whose key names whichever
 * run the test says.
 */
const heldSend = async (
  by: Identity,
  sending: { workflowId: string; mailId: string; permissionId: string },
  runId: string,
  keyRun: string
): Promise<PendingAction> => {
  const workflowId = workflowResourceIdSchema.parse(sending.workflowId);
  const refused = await settledCode(
    callConnection(
      env,
      {
        subject: { type: "workflow", workflowId },
        onBehalfOf: by.userId,
        mode: "workflow",
      },
      { type: "workflowRun", workflowId, runId: runIdSchema.parse(runId) },
      {
        type: "connection",
        connectionId: connectionIdSchema.parse(sending.mailId),
      },
      {
        action: "mail.send",
        input: { to: "Ada", subject: "Hello" },
        idempotencyKey: stepIdempotencyKey(keyRun, "send:task"),
      },
      permissionIdSchema.parse(sending.permissionId)
    )
  );
  expect(refused).toBe("connect.held");
  const waitingFor = await env.CONNECT.listPendingActions(
    await personOf(env, by)
  );
  const held = waitingFor.find(
    ({ idempotencyKey }) =>
      idempotencyKey === stepIdempotencyKey(keyRun, "send:task")
  );
  if (held === undefined) {
    throw new Error("Nothing held");
  }
  return held;
};

describe("the wakes a held call's decision owes", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("go to the run its key names only if that run is of the held call's own workflow and hasn't ended", async () => {
    const admin = await person("admin");
    const signedIn = await signedInApi(idp, "builder");
    const ada = identityOf(signedIn.userId, "builder");
    const own = await mailingWorkflow(ada, admin, { before: [longHold] });
    const other = await mailingWorkflow(ada, admin, { before: [longHold] });
    const ownStarter = await startingApp(ada, admin, own.workflow.id, {
      restricted: true,
    });
    const otherStarter = await startingApp(ada, admin, other.workflow.id, {
      restricted: true,
    });
    // Runs asleep before their sends: going, not yet held.
    const ownRun = await ownStarter.start(own.serving);
    const endedRun = await ownStarter.start(own.serving);
    const otherRun = await otherStarter.start(other.serving);
    const sending = {
      workflowId: own.workflow.id,
      mailId: own.mail.id,
      permissionId: own.permissionId,
    };
    const forOwn = await heldSend(ada, sending, ownRun, ownRun);
    // The own workflow's call, under a key naming another workflow's run.
    const forOther = await heldSend(ada, sending, ownRun, otherRun);
    const forEnded = await heldSend(ada, sending, endedRun, endedRun);
    await terminateResourceRun(env, ada, own.workflow.id, endedRun);

    // Decided while the engine takes no event: what was owed stays owed.
    await whileEngineRefuses(
      (method) => method === "sendEvent",
      async () => {
        for (const held of [forOwn, forOther, forEnded]) {
          // oxlint-disable-next-line no-await-in-loop -- one decision at a time
          await signedIn.api.pendingActions.decline(held.id);
        }
      }
    );

    expect({
      own: await wakesOwed(ownRun),
      otherWorkflowsRun: await wakesOwed(otherRun),
      ended: await wakesOwed(endedRun),
    }).toStrictEqual({ own: 1, otherWorkflowsRun: 0, ended: 0 });
  });
});
