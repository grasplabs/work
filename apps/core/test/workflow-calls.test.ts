/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import {
  releaseFormatVersion,
  releaseManifestSchema,
  sdkProtocolVersion,
} from "@grasp-os/shared/app-releases";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  agentIdSchema,
  appIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { maxAttemptTimeoutMs } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { personOf } from "../src/connections.ts";
import { appHost } from "../src/durable-objects.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { resolveUnknownOutcome } from "../src/unknown-outcomes.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import type { RunStep } from "../src/workflows/host.ts";
import type { FrozenCatalogBinding } from "../src/workflows/resource-authority.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { release, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { mailControlUrl } from "./mail-server.ts";
import { withQuotas } from "./quota-policies.ts";
import { admittedFreely } from "./runs.ts";
import {
  outcome as resultOf,
  refusal,
  signedInApi,
  unique,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The named calls of JSON workflows (@grasp-os/open-workflow's
// generate.ts, the SDK's open-workflow.ts, core's resource-host.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect, and time,
// randomness and deadlines replay as recorded; a sensitive parameter
// reaches connect as a binding argument and nothing the run records; and
// a workflow's limits only ever lower the host's. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server behind connect and AI Gateway are faked.

const idp = mockIdp();

/** The model the test deployment's gateway allows (vite.config.ts). */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A write of the audit outbox, as a receipt is kept. */
const auditWrite = /insert into "audit_outbox"/iu;

/** The read of the quota policy, as the ledger admits a model request. */
const quotaRead = /from "quota_policies"/iu;

/** A call's read of its run's authority (resource-authority.ts). */
const authorityRead = /approval\.alias/iu;

/** The read of an App's current release, as a call makes on its way. */
const currentRelease = /select .*"current_version".* from "apps"/iu;

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
  limits?: Record<string, number>;
  use?: Record<string, unknown>;
  tasks: unknown[];
}

/** A definition of `name`: its input `{ who }`, its output `{ status }`. */
const definitionOf = (
  name: string,
  { bindings = {}, params = {}, limits, use, tasks }: Draft
): string =>
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
          params,
          bindings,
          ...(limits === undefined ? {} : { limits }),
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    ...(use === undefined ? {} : { use }),
    do: tasks,
  });

/** A workflow of `by`'s, published once from `draft`. */
const published = async (by: Identity, draft: Draft) => {
  const workflow = await createWorkflowResource(env, by, `calls-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, draft),
    basedOn: null,
  });
  const [version] = await workflowVersions(env, by, workflow.id);
  return { workflow, executable: version?.build.executable };
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
const pause = { pause: { wait: "PT1S" } };

/** Holds a run before its call: long enough to revoke what it needs. */
const hold = { hold: { wait: "PT1S" } };

describe("time, randomness and deadlines of JSON workflows", () => {
  it("records grasp.now and grasp.random, so a replay after a wait answers the same", async () => {
    const by = await person("builder");
    const { workflow, executable } = await published(by, {
      tasks: [
        { clock: { call: "grasp.now", export: { as: "${ {at: .} }" } } },
        {
          dice: {
            call: "grasp.random",
            with: {},
            export: { as: "${ $context + {r: .} }" },
          },
        },
        pause,
        {
          finish: {
            set: {
              status:
                '${ ($context.at | tostring) + " " + ($context.r | tostring) }',
            },
          },
        },
      ],
    });
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    const [at, r] = z
      .object({ status: z.string() })
      .parse(run.output)
      .status.split(" ")
      .map(Number);
    expect({
      executable,
      status: run.status,
      // Recorded before the wait: read again after it, the time would be
      // at least a second later.
      recorded: Date.parse(run.endedAt ?? "") - (at ?? 0) >= 1000,
      fraction: (r ?? -1) >= 0 && (r ?? 1) < 1,
    }).toStrictEqual({
      executable: true,
      status: "completed",
      recorded: true,
      fraction: true,
    });
  });

  it("resolves an expression wait and grasp.sleepUntil once, to the deadline its step recorded", async () => {
    const by = await person("builder");
    const { workflow, executable } = await published(by, {
      params: {
        seconds: {
          schema: { type: "integer", minimum: 1, maximum: 5 },
          label: "Seconds",
          default: 1,
          sensitive: false,
        },
      },
      tasks: [
        {
          linger: {
            wait: '${ "PT" + ($params.seconds | tostring) + "S" }',
          },
        },
        {
          until: {
            call: "grasp.sleepUntil",
            with: {
              timestamp: "${ $workflow.startedAt.epoch.milliseconds + 2000 }",
            },
          },
        },
        {
          finish: {
            set: {
              status: "${ $workflow.startedAt.epoch.milliseconds | tostring }",
            },
          },
        },
      ],
    });
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    const startedAt = Number(
      z.object({ status: z.string() }).parse(run.output).status
    );
    expect({
      executable,
      status: run.status,
      slept: Date.parse(run.endedAt ?? "") - startedAt >= 2000,
    }).toStrictEqual({ executable: true, status: "completed", slept: true });
  });
});

/** A catalog contract of mail.send: `{ to, subject }` in, `{ messageId }` out. */
const mailContract = async (admin: Identity): Promise<string> => {
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptorOf(v.object({ to: v.string(), subject: v.string() })),
        output: descriptorOf(v.object({ messageId: v.string() })),
      },
    },
  });
  return key;
};

/** `env`, its connect serving `contract` as that connection's contract. */
const servingMail = (): Env => {
  const contract: ConnectorContract = {
    contract: "composio.mail@1",
    actions: {
      send: {
        tool: "mail.send",
        readOnly: false,
        input: JSON.stringify(
          shapeOf(
            descriptorOf(v.object({ to: v.string(), subject: v.string() }))
          )
        ),
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
 * sensitive `token` parameter as a binding argument; `before` its tasks
 * before the send, `to` whom it sends, `plan` how the mail server answers.
 * Answers what serves it.
 */
const mailingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    before = [],
    to = "${ $workflow.input.who }",
    plan = [],
  }: {
    before?: unknown[];
    to?: string;
    plan?: Parameters<typeof mailConnection>[0];
  } = {}
) => {
  const key = await mailContract(admin);
  const { workflow, executable } = await published(by, {
    bindings: { mail: { kind: "connector", contract: key } },
    params: {
      token: {
        schema: { type: "string", maxLength: 64 },
        label: "Token",
        default: "none",
        sensitive: true,
      },
    },
    tasks: [
      ...before,
      {
        send: {
          call: "grasp.connector",
          with: {
            binding: "mail",
            operation: "mail.send",
            arguments: { to, subject: "${ $params.token }" },
          },
          export: { as: "${ {sent: .messageId} }" },
        },
      },
      pause,
      { finish: { set: { status: "${ $context.sent }" } } },
    ],
  });
  const mail = await mailConnection(plan);
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  const serving = servingMail();
  const approval = await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
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

/** A task sending mail to Ada with `subject`, through binding `mail`. */
const send = (subject: string) => ({
  send: {
    call: "grasp.connector",
    with: {
      binding: "mail",
      operation: "mail.send",
      arguments: { to: "Ada", subject },
    },
  },
});

describe("grasp.connector calls of JSON workflows", () => {
  it("sends once through connect, its sensitive parameter only as a binding argument, and a replay sends nothing again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, executable, mail, serving } = await mailingWorkflow(
      ada,
      admin
    );
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      values: { token: secret },
      expectedRevision: 0,
    });
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

  it("refuses a call once its run's lineage has made all the host calls it may, sending nothing for it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Two calls of the clock first, one host call each, then the mail's
    // own: all the lineage may make. Its first argument's evaluation, which
    // would fail if it ran, is refused before it runs: the call took its
    // host call before anything of it was built, and nothing is sent.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [
        { first: { call: "grasp.now" } },
        { second: { call: "grasp.now" } },
      ],
      to: "${ $workflow.input.who | tonumber | tostring }",
    });
    const { runId, run } = await withQuotas(
      { lineageHostCalls: 3 },
      async () => {
        const id = await started(ada, workflow.id, serving);
        return { runId: id, run: await ended(ada, workflow.id, id) };
      }
    );
    const sent = await mail.did();
    const lineage = await env.DB.prepare(
      "SELECT host_calls AS hostCalls FROM run_lineages WHERE root_run_id = ?"
    )
      .bind(runId)
      .first<{ hostCalls: number }>();
    const attempts = await env.DB.prepare(
      "SELECT host_calls AS hostCalls FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at"
    )
      .bind(runId)
      .all<{ hostCalls: number }>();
    expect({
      end: endOf(run),
      calls: sent.calls,
      receipts: await receiptsOf(runId),
      hostCalls: lineage?.hostCalls,
      byAttempt: attempts.results.map(({ hostCalls }) => hostCalls),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.lineage_limit" },
      calls: 0,
      receipts: [],
      hostCalls: 3,
      // Each attempt made its call; the mail's went no further.
      byAttempt: [1, 1, 1],
    });
  });

  it("refuses a connector's answer that echoes a binding argument, so its value is never recorded", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin);
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      values: { token: secret },
      expectedRevision: 0,
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
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      plan: ["lost"],
    });
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      values: { token: secret },
      expectedRevision: 0,
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
      to: "${ $workflow.input.who | length }",
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    expect({ end: endOf(run), calls: sent.calls }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      calls: 0,
    });
  });

  it("refuses at publication a sensitive parameter anywhere but as a whole binding argument of a connector", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await mailContract(admin);
    const workflow = await createWorkflowResource(
      env,
      ada,
      `calls-${unique()}`
    );
    const token = {
      schema: { type: "string", maxLength: 64 },
      label: "Token",
      default: "none",
      sensitive: true,
    };
    // A secret with parts: one of them could come back unseen.
    const keys = {
      schema: {
        type: "object",
        properties: { key: { type: "string", maxLength: 64 } },
        required: ["key"],
        additionalProperties: false,
      },
      label: "Keys",
      default: { key: "none" },
      sensitive: true,
    };
    // A number, which could come back as text unseen.
    const pin = {
      schema: { type: "integer" },
      label: "PIN",
      default: 1234,
      sensitive: true,
    };
    const problems = async (tasks: unknown[], other?: "keys" | "pin") => {
      const error = await refusal(
        publishWorkflowVersion(env, ada, workflow.id, {
          definition: definitionOf(workflow.name, {
            bindings: { mail: { kind: "connector", contract: key } },
            params: { token, ...(other === undefined ? {} : { keys, pin }) },
            tasks: [...tasks, { finish: { set: { status: "done" } } }],
          }),
          basedOn: null,
        })
      );
      return z
        .object({
          details: z.object({
            problems: z.array(
              z
                .object({ code: z.string(), pointer: z.string() })
                .transform(({ code, pointer }) => ({ code, pointer }))
            ),
          }),
        })
        .parse(error).details.problems;
    };
    expect({
      // Transformed, it would pass through jq.
      computed: await problems([send('${ $params.token + "!" }')]),
      // In a set, it would reach the run's output.
      set: await problems([{ leak: { set: { value: "${ $params.token }" } } }]),
      // A whole binding argument, but of a secret with parts.
      compound: await problems([send("${ $params.keys }")], "keys"),
      number: await problems([send("${ $params.pin }")], "pin"),
      // Data shaped like a call is no call.
      lookalike: await problems([
        {
          leak: {
            set: {
              call: "grasp.connector",
              with: { arguments: "${ $params.token }" },
            },
          },
        },
      ]),
    }).toStrictEqual({
      computed: [
        {
          code: "expression.sensitive_param",
          pointer: "/do/0/send/with/arguments/subject",
        },
      ],
      set: [
        {
          code: "expression.sensitive_param",
          pointer: "/do/0/leak/set/value",
        },
      ],
      compound: [
        {
          code: "expression.sensitive_param",
          pointer: "/do/0/send/with/arguments/subject",
        },
      ],
      number: [
        {
          code: "expression.sensitive_param",
          pointer: "/do/0/send/with/arguments/subject",
        },
      ],
      lookalike: [
        {
          code: "expression.sensitive_param",
          pointer: "/do/0/leak/set/with/arguments",
        },
      ],
    });
  });
});

/** AI Gateway answering `replies` in turn, behind the AI binding. */
const gatewayAnswering = (...replies: Parameters<typeof fakeGateway>) => {
  const gateway = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  return gateway;
};

/**
 * A workflow of `by`'s asking binding `summary` (the allowed model,
 * approved by `admin`) to greet its input's `who`, `before` its tasks
 * before the call, and `limits` its own.
 */
const greetingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    before = [],
    limits,
  }: { before?: unknown[]; limits?: Record<string, number> } = {}
) => {
  const key = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "model" });
  const { workflow, executable } = await published(by, {
    bindings: { summary: { kind: "model", contract: key } },
    ...(limits === undefined ? {} : { limits }),
    tasks: [
      ...before,
      {
        greet: {
          call: "grasp.model",
          with: {
            binding: "summary",
            instructions: "Greet them.",
            input: { who: "${ $workflow.input.who }" },
            outputSchema: objectSchema({ line: { type: "string" } }),
          },
          export: { as: "${ {line: .line} }" },
        },
      },
      pause,
      { finish: { set: { status: "${ $context.line }" } } },
    ],
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "summary",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  return { workflow, executable, approval };
};

const answer = (text: string) => ({ text, inputTokens: 100, outputTokens: 20 });

describe("grasp.model calls of JSON workflows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the gateway once for the task's structured output, and a replay asks nothing again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, executable } = await greetingWorkflow(ada, admin);
    const gateway = gatewayAnswering(answer('{"line":"Hello Ada"}'));
    const runId = await started(ada, workflow.id);
    const run = await ended(ada, workflow.id, runId);
    expect({
      executable,
      end: endOf(run),
      requests: gateway.requests.length,
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
    const gateway = gatewayAnswering(
      answer("Hello, Ada!"),
      answer('{"line":"Never sent"}')
    );
    const run = await ended(ada, workflow.id, await started(ada, workflow.id));
    expect({
      status: run.status,
      requests: gateway.requests.length,
    }).toStrictEqual({ status: "failed", requests: 1 });
  });

  it("sends a model call's request once, never again after the provider refuses it for a moment", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    const gateway = gatewayAnswering(
      { status: 503, errorType: "overloaded_error" },
      answer('{"line":"Hello, Ada!"}')
    );
    const run = await ended(ada, workflow.id, await started(ada, workflow.id));
    expect({
      status: run.status,
      requests: gateway.requests.length,
    }).toStrictEqual({ status: "failed", requests: 1 });
  });

  it("refuses the next call once the grant its start was admitted on is revoked: a trigger's, an App's or an agent's", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const gateway = gatewayAnswering(answer('{"line":"Never sent"}'));
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
      kind: "system",
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
    expect({ ends, requests: gateway.requests.length }).toStrictEqual({
      ends: Array.from({ length: 3 }, () => ({
        status: "failed",
        code: "workflow.call_denied",
      })),
      requests: 0,
    });
  });

  it("sends a model call's request only while its run's authority holds once the ledger admitted it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, approval } = await greetingWorkflow(ada, admin, {
      before: [hold],
    });
    const gateway = gatewayAnswering(answer('{"line":"Never sent"}'));
    const run = await started(ada, workflow.id);
    // The approval is revoked as the ledger admits the request, after the
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
        quotaRead.test(statement)
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
      requests: gateway.requests.length,
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
    gatewayAnswering(
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

  it("refuses the next model call once its approval is revoked, and one past the workflow's own limit", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const revoked = await greetingWorkflow(ada, admin, { before: [hold] });
    const gateway = gatewayAnswering(answer('{"line":"Never sent"}'));
    const revokedRun = await started(ada, revoked.workflow.id);
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    const revokedRequests = gateway.requests.length;
    // Two model calls, and a limit of one: the second is never sent.
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const greet = (id: string) => ({
      [id]: {
        call: "grasp.model",
        with: {
          binding: "summary",
          instructions: "Greet them.",
          input: { who: "${ $workflow.input.who }" },
          outputSchema: objectSchema({ line: { type: "string" } }),
        },
      },
    });
    const limited = await published(ada, {
      bindings: { summary: { kind: "model", contract: key } },
      limits: { maxModelCalls: 1 },
      tasks: [
        greet("greet"),
        greet("again"),
        { finish: { set: { status: "done" } } },
      ],
    });
    await approveWorkflowBinding(env, admin, limited.workflow.id, {
      alias: "summary",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    const limitedGateway = gatewayAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Never sent"}')
    );
    const limitedEnd = await ended(
      ada,
      limited.workflow.id,
      await started(ada, limited.workflow.id)
    );
    expect({
      revoked: endOf(revokedEnd),
      revokedRequests,
      limited: endOf(limitedEnd),
      limitedRequests: limitedGateway.requests.length,
    }).toStrictEqual({
      revoked: { status: "failed", code: "workflow.call_denied" },
      revokedRequests: 0,
      limited: { status: "failed", code: "workflow.model_call_limit" },
      limitedRequests: 1,
    });
  });
});

/**
 * Seals version `version` of App `app` with a manifest the release loader
 * reads as intact: what an operation's approval pins.
 */
const sealedRelease = async (app: string, version: number): Promise<void> => {
  const hash = "0".repeat(64);
  const manifest = canonicalText(
    releaseManifestSchema.parse({
      formatVersion: releaseFormatVersion,
      resourceId: app,
      resourceVersion: version,
      sourceTreeHash: hash,
      schemaHash: hash,
      contractHash: hash,
      sdkVersion: "1.0.0",
      sdkProtocolVersion,
      uiVersion: "1.0.0",
      compilerVersion: "1.0.0",
      dependencyLockHash: hash,
      target: "app",
      dataStoreBindings: [],
      artifacts: [{ path: "server.js", sha256: hash, bytes: 0 }],
      bindings: [],
      verificationReportHash: hash,
      migrationEvidence: [],
      artifactTrust: "unreviewed",
    })
  );
  await env.DB.prepare(
    "INSERT INTO sdk_release_manifests (app_id, version, manifest_hash, manifest, sealed_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)"
  )
    .bind(app, version, await sha256Hex(manifest), manifest, Date.now())
    .run();
};

/** One App's server code: an export a workflow calls, counting its calls. */
const appServer = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; idempotencyKey?: string };

export class App extends DurableObject {
  async lookUp(caller: Caller, input: { who: string }): Promise<unknown> {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return { greeting: "Hello " + input.who + " " + count, key: caller.idempotencyKey ?? "" };
  }
}
`;

/** `appServer`, its export taking a moment before it answers. */
const slowServer = appServer.replace(
  "async lookUp(caller: Caller, input: { who: string }): Promise<unknown> {",
  "async lookUp(caller: Caller, input: { who: string }): Promise<unknown> {\n    await new Promise((resolve) => setTimeout(resolve, 500));"
);

/**
 * A workflow of an admin's calling App `server`'s export `lookUp`, sealed
 * and approved, in a task of its own.
 */
const lookingUp = async (server: string) => {
  const signedIn = await signedInApi(idp, "admin");
  const admin = identityOf(signedIn.userId, "admin");
  const input = descriptorOf(v.object({ who: v.string() }));
  const output = descriptorOf(
    v.object({ greeting: v.string(), key: v.string() })
  );
  const key = `lookup-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "operation",
    input,
    output,
  });
  const { id: app } = await signedIn.api.apps.create({
    name: `Desk ${unique()}`,
  });
  const version = await release(signedIn, app, {
    "app/server.ts": server,
    "app/exports.json": JSON.stringify({
      lookUp: {
        access: "read",
        input: shapeOf(input),
        output: shapeOf(output),
      },
    }),
  });
  await serverBuilt(app, version);
  await sealedRelease(app, version);
  const { workflow } = await published(admin, {
    bindings: { lookup: { kind: "operation", contract: key } },
    tasks: [
      {
        look: {
          call: "grasp.operation",
          with: { binding: "lookup", arguments: { who: "Ada" } },
        },
      },
      { finish: { set: { status: "called" } } },
    ],
  });
  const permissionId = await granted(admin, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "app", appId: appIdSchema.parse(app) },
    actions: ["read"],
    binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "lookup",
    target: {
      kind: "operation",
      permissionId,
      appVersion: version,
      export: "lookUp",
    },
    reviewed: { version: 1 },
  });
  return { admin, app, workflowId: workflow.id };
};

/** Whether an App took run `runId`'s call, as the audit log has it. */
const appCalled = async (runId: string): Promise<boolean> => {
  const events = await allEvents();
  return events.some(
    ({ action, target }) => action === "app.called" && target?.id === runId
  );
};

describe("grasp.operation calls of JSON workflows", () => {
  it("calls the approved export once per run, under its step's key, and stops once the permission is revoked", async () => {
    const signedIn = await signedInApi(idp, "admin");
    const admin = identityOf(signedIn.userId, "admin");
    const input = descriptorOf(v.object({ who: v.string() }));
    const output = descriptorOf(
      v.object({ greeting: v.string(), key: v.string() })
    );
    const key = `lookup-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input,
      output,
    });
    const { id: app } = await signedIn.api.apps.create({
      name: `Desk ${unique()}`,
    });
    const version = await release(signedIn, app, {
      "app/server.ts": appServer,
      "app/exports.json": JSON.stringify({
        lookUp: {
          access: "read",
          input: shapeOf(input),
          output: shapeOf(output),
        },
      }),
    });
    await serverBuilt(app, version);
    await sealedRelease(app, version);
    const { workflow, executable } = await published(admin, {
      bindings: { lookup: { kind: "operation", contract: key } },
      tasks: [
        { hold: { wait: "PT1S" } },
        {
          look: {
            call: "grasp.operation",
            with: {
              binding: "lookup",
              arguments: { who: "${ $workflow.input.who }" },
            },
            export: { as: "${ {greeting: .greeting, key: .key} }" },
          },
        },
        pause,
        {
          finish: {
            set: { status: '${ $context.greeting + " " + $context.key }' },
          },
        },
      ],
    });
    const permissionId = await granted(admin, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(app) },
      actions: ["read"],
      binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "operation",
        permissionId,
        appVersion: version,
        export: "lookUp",
      },
      reviewed: { version: 1 },
    });
    const first = await started(admin, workflow.id);
    const firstEnd = await ended(admin, workflow.id, first);
    // A second run: the App counts its second call, never a replay's.
    const second = await started(admin, workflow.id);
    const secondEnd = await ended(admin, workflow.id, second);
    // A third, its permission revoked as it waits before its call.
    const third = await started(admin, workflow.id);
    await revokePermission(env, admin, permissionId);
    const thirdEnd = await ended(admin, workflow.id, third);
    expect({
      executable,
      first: endOf(firstEnd),
      second: endOf(secondEnd),
      third: endOf(thirdEnd),
    }).toStrictEqual({
      executable: true,
      first: {
        status: "completed",
        output: {
          status: `Hello Ada 1 ${encodeURIComponent(first)}:task:look`,
        },
      },
      second: {
        status: "completed",
        output: {
          status: `Hello Ada 2 ${encodeURIComponent(second)}:task:look`,
        },
      },
      third: { status: "failed", code: "workflow.call_denied" },
    });
  });

  it("runs an export only while its run's authority holds as the App takes the call", async () => {
    const signedIn = await signedInApi(idp, "admin");
    const admin = identityOf(signedIn.userId, "admin");
    const input = descriptorOf(v.object({ who: v.string() }));
    const output = descriptorOf(
      v.object({ greeting: v.string(), key: v.string() })
    );
    const key = `lookup-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input,
      output,
    });
    const { id: app } = await signedIn.api.apps.create({
      name: `Desk ${unique()}`,
    });
    const version = await release(signedIn, app, {
      "app/server.ts": appServer,
      "app/exports.json": JSON.stringify({
        lookUp: {
          access: "read",
          input: shapeOf(input),
          output: shapeOf(output),
        },
      }),
    });
    await serverBuilt(app, version);
    await sealedRelease(app, version);
    const { workflow } = await published(admin, {
      bindings: { lookup: { kind: "operation", contract: key } },
      tasks: [
        { hold: { wait: "PT1S" } },
        {
          look: {
            call: "grasp.operation",
            with: { binding: "lookup", arguments: { who: "Ada" } },
          },
        },
        { finish: { set: { status: "called" } } },
      ],
    });
    const permissionId = await granted(admin, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(app) },
      actions: ["read"],
      binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "operation",
        permissionId,
        appVersion: version,
        export: "lookUp",
      },
      reviewed: { version: 1 },
    });
    const run = await started(admin, workflow.id);
    // The permission is revoked as the App's call, authorized and on its
    // way, is recorded as pinned: the last thing awaited before it runs.
    const db = env.DB;
    const prepare = db.prepare.bind(db);
    const raced = { done: false };
    const onItsWay = { read: false };
    const revoking: Promise<unknown>[] = [];
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      onItsWay.read ||= currentRelease.test(statement);
      if (!raced.done && onItsWay.read && auditWrite.test(statement)) {
        raced.done = true;
        revoking.push(
          prepare("UPDATE permissions SET status = 'revoked' WHERE id = ?")
            .bind(permissionId)
            .run()
        );
      }
      return prepare(statement);
    });
    const end = endOf(await ended(admin, workflow.id, run));
    vi.restoreAllMocks();
    await Promise.all(revoking);
    expect({ raced: raced.done, end }).toStrictEqual({
      raced: true,
      end: { status: "failed", code: "workflow.call_denied" },
    });
  });

  it("never calls an App already in restricted mode", async () => {
    const { admin, app, workflowId } = await lookingUp(appServer);
    await appHost(env, app).restrict();
    const runId = await started(admin, workflowId);
    const end = endOf(await ended(admin, workflowId, runId));
    expect({ end, called: await appCalled(runId) }).toStrictEqual({
      end: { status: "failed", code: "permission.restricted" },
      called: false,
    });
  });

  it("withholds the answer of an App that enters restricted mode as it takes the call", async () => {
    // Its method takes long enough that its answer comes back after.
    const { admin, app, workflowId } = await lookingUp(slowServer);
    const db = env.DB;
    const prepare = db.prepare.bind(db);
    const onItsWay = { read: false, restricted: false };
    const restricting: Promise<unknown>[] = [];
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      onItsWay.read ||= currentRelease.test(statement);
      if (!onItsWay.restricted && onItsWay.read && auditWrite.test(statement)) {
        onItsWay.restricted = true;
        restricting.push(appHost(env, app).restrict());
      }
      return prepare(statement);
    });
    const runId = await started(admin, workflowId);
    let end: ReturnType<typeof endOf>;
    try {
      end = endOf(await ended(admin, workflowId, runId));
    } finally {
      vi.restoreAllMocks();
    }
    await Promise.all(restricting);
    expect({
      restricted: onItsWay.restricted,
      end,
      called: await appCalled(runId),
    }).toStrictEqual({
      restricted: true,
      end: { status: "failed", code: "permission.restricted" },
      called: true,
    });
  });

  it("lowers no call whose arguments hold more entries than its build seals, and names where", async () => {
    const admin = await person("admin");
    const key = `bulk-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input: descriptorOf(v.object({ items: v.array(v.number()) })),
      output: descriptorOf(v.object({})),
    });
    const workflow = await createWorkflowResource(
      env,
      admin,
      `calls-${unique()}`
    );
    await publishWorkflowVersion(env, admin, workflow.id, {
      definition: definitionOf(workflow.name, {
        bindings: { bulk: { kind: "operation", contract: key } },
        tasks: [
          {
            send: {
              call: "grasp.operation",
              with: {
                binding: "bulk",
                arguments: {
                  items: ["${ 1 }", ...Array.from({ length: 1024 }, () => 0)],
                },
              },
            },
          },
          { finish: { set: { status: "sent" } } },
        ],
      }),
      basedOn: null,
    });
    const [version] = await workflowVersions(env, admin, workflow.id);
    expect(version?.build).toStrictEqual({
      executable: false,
      unsupported: [
        {
          pointer: "/do/0/send/with/arguments/items",
          taskId: "send",
          feature: "with:too_large",
        },
      ],
    });
  });

  it("refuses a call whose approved release is no longer the App's current version, saying so", async () => {
    const signedIn = await signedInApi(idp, "admin");
    const admin = identityOf(signedIn.userId, "admin");
    const input = descriptorOf(v.object({ who: v.string() }));
    const output = descriptorOf(
      v.object({ greeting: v.string(), key: v.string() })
    );
    const key = `lookup-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "operation",
      input,
      output,
    });
    const { id: app } = await signedIn.api.apps.create({
      name: `Desk ${unique()}`,
    });
    const exports = JSON.stringify({
      lookUp: {
        access: "read",
        input: shapeOf(input),
        output: shapeOf(output),
      },
    });
    const approved = await release(signedIn, app, {
      "app/server.ts": appServer,
      "app/exports.json": exports,
    });
    await sealedRelease(app, approved);
    const { workflow } = await published(admin, {
      bindings: { lookup: { kind: "operation", contract: key } },
      tasks: [
        {
          look: {
            call: "grasp.operation",
            with: { binding: "lookup", arguments: { who: "Ada" } },
          },
        },
        { finish: { set: { status: "called" } } },
      ],
    });
    const permissionId = await granted(admin, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "app", appId: appIdSchema.parse(app) },
      actions: ["read"],
      binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "lookup",
      target: {
        kind: "operation",
        permissionId,
        appVersion: approved,
        export: "lookUp",
      },
      reviewed: { version: 1 },
    });
    // The App moves on to a release the approval doesn't pin.
    await release(signedIn, app, { "app/notes.txt": "A later release" });
    const run = await started(admin, workflow.id);
    expect(endOf(await ended(admin, workflow.id, run))).toStrictEqual({
      status: "failed",
      code: "workflow.call_release_not_current",
    });
  });
});

/**
 * A host of a run of version 1 of workflow `id` for `by`, on steps that
 * run at once, its attempts always holding their lease, its start having
 * frozen `bindings` (none, unless given), on `runEnv`: as the dispatcher
 * makes one for an activation.
 */
const hostOf = async (
  by: Identity,
  id: string,
  {
    runEnv = env,
    bindings = new Map(),
    activationFuel,
    retries = [],
  }: {
    runEnv?: Env;
    bindings?: ReadonlyMap<string, FrozenCatalogBinding>;
    /** The activation's fuel, if not the host's own. */
    activationFuel?: number;
    /** Where the retries each step is run with are told. */
    retries?: number[];
  } = {}
): Promise<ResourceRunHost> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(env, id, 1, manifest?.hash ?? "");
  let count = 0;
  const step: RunStep = {
    do: async (name, config, fn) => {
      count += 1;
      retries.push(config.retries?.limit ?? 0);
      return await fn({ attempt: 1, idempotencyKey: `key:${name}:${count}` });
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
  };
  const runId = crypto.randomUUID();
  return new ResourceRunHost(
    runEnv,
    step,
    {
      runId,
      workflowId: id,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: {},
      createdAt: Date.now(),
      build,
      calling: {
        runId,
        workflowId: id,
        version: 1,
        principal: by.userId,
        invoker: { type: "person", id: by.userId, appVersion: null },
        bindings,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      ...(activationFuel === undefined ? {} : { activationFuel }),
      tampered: () => {},
      admitAttempt: admittedFreely,
    }
  );
};

/** The code `settled` failed with, or "ok". */
const codeOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? "ok" : settled.error.code;

/** What a task's step captures: Ada's input, and no context. */
const adaData = { input: { input: { who: "Ada" }, context: {} } };

/** The transformed input a module passes for a call or a deadline. */
const adaFrame = { input: { who: "Ada" } };

/** A module's step that makes its task's call with `frame`, and records it. */
const called = async (
  attempt: Parameters<Parameters<ResourceRunHost["do"]>[2]>[0],
  frame: unknown = adaFrame
) => {
  const now = await attempt.call(frame);
  return now.ok
    ? { ok: true as const, value: { output: now.value } }
    : { ok: false as const, error: now.error };
};

describe("a run's host, against a forged module's calls", () => {
  it("builds and makes a task's call itself, once, and through a binding its start froze only", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = await mailContract(admin);
    const { workflow } = await published(by, {
      bindings: { mail: { kind: "connector", contract: key } },
      tasks: [
        { clock: { call: "grasp.now" } },
        {
          send: {
            call: "grasp.connector",
            with: {
              binding: "mail",
              operation: "mail.send",
              // Slot 0 of the build's table: its call's to build.
              arguments: { to: "${ $workflow.input.who }", subject: "Hi" },
            },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    const run = async (
      name: string,
      fn: Parameters<ResourceRunHost["do"]>[2]
    ): Promise<unknown> => {
      const host = await hostOf(by, workflow.id);
      return codeOf(await host.do(name, adaData, fn));
    };
    // What the module's own evaluation of its call's template answered.
    let templateRead: unknown;
    await run("task:send", async (attempt) => {
      templateRead = codeOf(
        await attempt.evaluate(0, { input: adaFrame.input, output: null })
      );
      return { ok: true, value: { output: null } };
    });
    expect({
      honest: await run("task:clock", async (attempt) => {
        const now = await attempt.call(adaFrame);
        return { ok: true, value: { output: now.ok ? now.value : null } };
      }),
      templateRead,
      twice: await run("task:clock", async (attempt) => {
        await attempt.call(adaFrame);
        const again = await attempt.call(adaFrame);
        return { ok: true, value: { output: again.ok ? again.value : null } };
      }),
      unmade: await run(
        "task:clock",
        async () => await Promise.resolve({ ok: true, value: { output: 5 } })
      ),
      // The call made, its answer put aside for one of the module's own.
      discarded: await run("task:clock", async (attempt) => {
        await attempt.call(adaFrame);
        return { ok: true, value: { output: 5 } };
      }),
      notACall: await run("task:finish", async (attempt) => {
        await attempt.call(adaFrame);
        return { ok: true, value: { output: null } };
      }),
      // This run's start froze no binding: the call has no target.
      unfrozen: await run("task:send", async (attempt) => {
        const sent = await attempt.call(adaFrame);
        return sent.ok
          ? { ok: true, value: { output: sent.value } }
          : { ok: false, error: sent.error };
      }),
      // The call failed, and the module answers for it all the same.
      afterFailure: await run("task:send", async (attempt) => {
        await attempt.call(adaFrame);
        return { ok: true, value: { output: { messageId: "forged" } } };
      }),
      // The module answers while its call is still on its way.
      beforeAnswer: await run("task:send", async (attempt) => {
        void attempt.call(adaFrame);
        return await Promise.resolve({
          ok: true,
          value: { output: { messageId: "forged" } },
        });
      }),
    }).toStrictEqual({
      honest: "ok",
      templateRead: "workflow.invalid",
      twice: "workflow.invalid",
      unmade: "workflow.invalid",
      discarded: "workflow.invalid",
      notACall: "workflow.invalid",
      unfrozen: "workflow.call_denied",
      afterFailure: "workflow.invalid",
      beforeAnswer: "workflow.invalid",
    });
  });

  it("transforms a call's answer only with the input its call was made on", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          clock: {
            call: "grasp.now",
            output: { as: "${ {at: ., who: $input.who} }" },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    /** The step, its output.as read on `input`. */
    const recorded = async (input: unknown) => {
      const host = await hostOf(by, workflow.id);
      return codeOf(
        await host.do("task:clock", adaData, async (attempt) => {
          const now = await attempt.call(adaFrame);
          const shaped = await attempt.evaluate(0, {
            input,
            output: now.ok ? now.value : null,
          });
          return shaped.ok
            ? { ok: true, value: { output: shaped.value } }
            : { ok: false, error: shaped.error };
        })
      );
    };
    expect({
      honest: await recorded(adaFrame.input),
      otherInput: await recorded({ who: "Mallory" }),
    }).toStrictEqual({ honest: "ok", otherInput: "workflow.invalid" });
  });

  it("makes a call on an input.from of many parts, as the host builds it from its own evaluations", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          clock: {
            call: "grasp.now",
            input: {
              from: {
                who: "${ .who }",
                greeting: "Hello",
                tags: ["a", "${ .who }"],
              },
            },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    expect(endOf(run)).toStrictEqual({
      status: "completed",
      output: { status: "done" },
    });
  });

  it("makes a task's call only once its if held and its input was checked, as the host saw them", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        { skip: { if: "${ false }", call: "grasp.now" } },
        { go: { if: "${ true }", call: "grasp.now" } },
        {
          typed: {
            call: "grasp.now",
            input: { schema: objectSchema({ who: { type: "string" } }) },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    const manifest = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ hash: string }>();
    const build = await loadWorkflowBuild(
      env,
      workflow.id,
      1,
      manifest?.hash ?? ""
    );
    const ifOf = (task: string): number =>
      build.expressions.find(
        ({ taskId, stage }) => taskId === task && stage === "taskIf"
      )?.slot ?? -1;
    const run = async (
      name: string,
      fn: Parameters<ResourceRunHost["do"]>[2]
    ): Promise<unknown> => {
      const host = await hostOf(by, workflow.id);
      return codeOf(await host.do(name, adaData, fn));
    };
    expect({
      // A forged module calls a task its sealed workflow skips, its if
      // never evaluated.
      skipped: await run("task:skip", async (attempt) => await called(attempt)),
      honest: await run("task:go", async (attempt) => {
        await attempt.evaluate(ifOf("go"), {
          input: adaFrame.input,
          output: null,
        });
        return await called(attempt);
      }),
      otherInput: await run("task:go", async (attempt) => {
        await attempt.evaluate(ifOf("go"), {
          input: adaFrame.input,
          output: null,
        });
        return await called(attempt, { input: { who: "Eve" } });
      }),
      unchecked: await run(
        "task:typed",
        async (attempt) => await called(attempt)
      ),
      checked: await run("task:typed", async (attempt) => {
        attempt.check("input", adaFrame.input);
        return await called(attempt);
      }),
    }).toStrictEqual({
      skipped: "workflow.invalid",
      honest: "ok",
      otherInput: "workflow.invalid",
      unchecked: "workflow.invalid",
      checked: "ok",
    });
  });

  it("counts a model call against the run's limit as it is asked for, so steps run at once can't each make one", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const greet = {
      call: "grasp.model",
      with: {
        binding: "summary",
        instructions: "Greet them.",
        input: { who: "Ada" },
        outputSchema: objectSchema({ line: { type: "string" } }),
      },
    };
    const { workflow } = await published(by, {
      bindings: { summary: { kind: "model", contract: key } },
      limits: { maxModelCalls: 1 },
      tasks: [
        { greet },
        { again: greet },
        { finish: { set: { status: "done" } } },
      ],
    });
    // The host's run may make one model call; a forged module asks for two
    // at once. Its start froze no binding, so the one that gets its place
    // is refused next, and goes nowhere.
    const host = await hostOf(by, workflow.id);
    const asked = async (name: string) =>
      codeOf(
        await host.do(name, adaData, async (attempt) => {
          const answered = await attempt.call(adaFrame);
          return answered.ok
            ? { ok: true, value: { output: answered.value } }
            : { ok: false, error: answered.error };
        })
      );
    const codes = await Promise.all([asked("task:greet"), asked("task:again")]);
    expect(
      codes.map(String).toSorted((a, b) => (a < b ? -1 : 1))
    ).toStrictEqual(["workflow.call_denied", "workflow.model_call_limit"]);
  });

  it("keeps a call's outcome when its receipt can't be kept", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = await mailContract(admin);
    const { workflow } = await published(by, {
      bindings: { mail: { kind: "connector", contract: key } },
      tasks: [send("Hi"), { finish: { set: { status: "done" } } }],
    });
    // A binding its start froze, through an approval since gone; the audit
    // log takes nothing.
    const binding: FrozenCatalogBinding = {
      alias: "mail",
      kind: "connector",
      resourceId: null,
      resourceVersion: null,
      contractId: key,
      fingerprint: "0".repeat(64),
      approval: crypto.randomUUID(),
      target: {
        kind: "connector",
        permissionId: crypto.randomUUID(),
        contract: "composio.mail@1",
      },
    };
    const refusingAudit: Env = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, name): unknown => {
          if (name === "batch") {
            return async () =>
              await Promise.reject(new Error("The audit log is down"));
          }
          const value: unknown = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const host = await hostOf(by, workflow.id, {
      runEnv: refusingAudit,
      bindings: new Map([["mail", binding]]),
    });
    const sent = await host.do("task:send", adaData, async (attempt) => {
      const answered = await attempt.call(adaFrame);
      return answered.ok
        ? { ok: true, value: { output: answered.value } }
        : { ok: false, error: answered.error };
    });
    expect(codeOf(sent)).toBe("workflow.call_denied");
  });

  it("resolves a deadline on the input its task's input.from made, as the host built it", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          later: {
            input: { from: '${ {who: .who, late: "yes"} }' },
            call: "grasp.sleepUntil",
            with: {
              timestamp: "${ $workflow.startedAt.epoch.milliseconds + 60000 }",
            },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    const transformed = { who: "Ada", late: "yes" };
    /** The enter step, its deadline resolved on `input`. */
    const entered = async (input: unknown) => {
      const host = await hostOf(by, workflow.id);
      return codeOf(
        await host.do("enter:later", adaData, async (attempt) => {
          await attempt.evaluate(0, { input: adaFrame.input, output: null });
          const until = await attempt.until({ input });
          return until.ok
            ? { ok: true, value: { output: input, until: until.value } }
            : { ok: false, error: until.error };
        })
      );
    };
    expect({
      transformed: await entered(transformed),
      raw: await entered(adaFrame.input),
    }).toStrictEqual({ transformed: "ok", raw: "workflow.invalid" });
  });

  it("waits for a deadline the module left resolving before its attempt ends", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          later: {
            call: "grasp.sleepUntil",
            with: {
              timestamp: "${ $workflow.startedAt.epoch.milliseconds + 60000 }",
            },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    const settledFirst: string[] = [];
    const leftRunning: Promise<unknown>[] = [];
    const host = await hostOf(by, workflow.id);
    await host.do("enter:later", adaData, async (attempt) => {
      leftRunning.push(
        attempt.until(adaFrame).then((until) => {
          settledFirst.push("until");
          return codeOf(until);
        })
      );
      return await Promise.resolve({ ok: true, value: { output: null } });
    });
    settledFirst.push("attempt");
    await Promise.all(leftRunning);
    // Asked twice at once: one deadline, the other refused.
    let twice: unknown[] = [];
    const again = await hostOf(by, workflow.id);
    await again.do("enter:later", adaData, async (attempt) => {
      const both = await Promise.all([
        attempt.until(adaFrame),
        attempt.until(adaFrame),
      ]);
      twice = both.map((until) => codeOf(until));
      return { ok: true, value: { output: null } };
    });
    expect({ settledFirst, twice }).toStrictEqual({
      settledFirst: ["until", "attempt"],
      twice: ["ok", "workflow.invalid"],
    });
  });

  it("resolves a literal deadline once, however many times it is asked at once", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          later: {
            call: "grasp.sleepUntil",
            with: { timestamp: 1_000_000 },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    let twice: unknown[] = [];
    const host = await hostOf(by, workflow.id);
    await host.do("enter:later", adaData, async (attempt) => {
      const both = await Promise.all([
        attempt.until(adaFrame),
        attempt.until(adaFrame),
      ]);
      twice = both.map((until) => codeOf(until));
      return { ok: true, value: { output: null } };
    });
    expect(twice).toStrictEqual(["ok", "workflow.invalid"]);
  });

  it("sleeps only until the deadline its task's enter step resolved and recorded", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      tasks: [
        {
          later: {
            call: "grasp.sleepUntil",
            with: {
              timestamp: "${ $workflow.startedAt.epoch.milliseconds + 60000 }",
            },
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    /** The enter step, its deadline recorded as `forge` makes it. */
    const entered = async (
      host: ResourceRunHost,
      forge: (until: number) => number = (until) => until
    ) =>
      await host.do("enter:later", adaData, async (attempt) => {
        const until = await attempt.until(adaFrame);
        return {
          ok: true,
          value: {
            output: adaFrame.input,
            until: forge(until.ok ? until.value : 0),
          },
        };
      });
    const early = await hostOf(by, workflow.id);
    const beforeEnter = await early.sleepUntil("task:later", Date.now());
    const honestHost = await hostOf(by, workflow.id);
    const honest = await entered(honestHost);
    const { until: recorded } = z
      .object({ until: z.number() })
      .parse(honest.ok ? honest.value : {});
    const otherHost = await hostOf(by, workflow.id);
    await entered(otherHost);
    const forgedHost = await hostOf(by, workflow.id);
    // A deadline built on input other than what the step captured.
    const substitutedHost = await hostOf(by, workflow.id);
    const substituted = await substitutedHost.do(
      "enter:later",
      adaData,
      async (attempt) => {
        const until = await attempt.until({ input: { who: "Mallory" } });
        return until.ok
          ? { ok: true, value: { output: adaFrame.input, until: until.value } }
          : { ok: false, error: until.error };
      }
    );
    expect({
      beforeEnter: codeOf(beforeEnter),
      honest: codeOf(honest),
      // A minute after the run started, as its expression says.
      deadline: recorded - Date.now() > 50_000,
      sleep: codeOf(await honestHost.sleepUntil("task:later", recorded)),
      otherTime: codeOf(
        await otherHost.sleepUntil("task:later", recorded - 30_000)
      ),
      forgedRecord: codeOf(
        await entered(forgedHost, (until) => until - 30_000)
      ),
      substituted: codeOf(substituted),
    }).toStrictEqual({
      beforeEnter: "workflow.invalid",
      honest: "ok",
      deadline: true,
      sleep: "ok",
      otherTime: "workflow.invalid",
      forgedRecord: "workflow.invalid",
      substituted: "workflow.invalid",
    });
  });
});

describe("a workflow's own limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lowers the host's step limit, never raises it", async () => {
    const by = await person("builder");
    const { workflow } = await published(by, {
      limits: { maxSteps: 1 },
      tasks: [
        { first: { set: { status: "first" } } },
        { second: { set: { status: "second" } } },
      ],
    });
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    expect(endOf(run)).toStrictEqual({
      status: "failed",
      code: "workflow.too_many_steps",
    });
  });

  it("ends an attempt that runs past its task's timeout, a reusable one, long before the host's", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const { workflow } = await published(by, {
      bindings: { summary: { kind: "model", contract: key } },
      use: { timeouts: { quick: { after: { seconds: 2 } } } },
      tasks: [
        {
          greet: {
            call: "grasp.model",
            with: {
              binding: "summary",
              instructions: "Greet them.",
              input: { who: "Ada" },
              outputSchema: objectSchema({ line: { type: "string" } }),
            },
            timeout: "quick",
          },
        },
        { finish: { set: { status: "done" } } },
      ],
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "summary",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    // The model never answers: only the attempt's timeout ends the call.
    const gateway = gatewayAnswering({ hang: true });
    const startedAt = Date.now();
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    // Its request cut off with its attempt, never left running past it.
    const cutOff = await vi.waitFor(
      () => {
        expect(gateway.requests[0]?.signal.aborted).toBeTruthy();
        return true;
      },
      { timeout: 5000, interval: 100 }
    );
    expect({
      status: run.status,
      // Its task's two seconds, not the host's minute.
      early:
        Date.parse(run.endedAt ?? "") - startedAt < maxAttemptTimeoutMs / 2,
      cutOff,
    }).toStrictEqual({ status: "failed", early: true, cutOff: true });
  });

  it("refuses to lower an active time nothing holds yet, by pointer", async () => {
    const by = await person("builder");
    const { executable, workflow } = await published(by, {
      limits: { maxActiveMs: 60_000 },
      tasks: [{ finish: { set: { status: "done" } } }],
    });
    const [version] = await workflowVersions(env, by, workflow.id);
    expect({
      executable,
      unsupported:
        version?.build.executable === false ? version.build.unsupported : [],
    }).toStrictEqual({
      executable: false,
      unsupported: [
        {
          pointer: "/document/metadata/grasp/limits/maxActiveMs",
          taskId: null,
          feature: "limits.maxActiveMs",
        },
      ],
    });
  });
});

describe("an activation's share of core's CPU, for calls tried once", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never cuts off the one attempt of a model call an activation can't fund", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    /** The step's retries and whether its module ran, on `activationFuel`. */
    const attempted = async (activationFuel?: number) => {
      const retries: number[] = [];
      const ran = { module: false };
      const host = await hostOf(ada, workflow.id, { activationFuel, retries });
      await host.do("task:greet", adaData, async () => {
        ran.module = true;
        return await Promise.resolve({ ok: true, value: { output: null } });
      });
      return { retries, ran: ran.module };
    };
    expect({
      funded: await attempted(),
      unfunded: await attempted(0),
    }).toStrictEqual({
      // Its one attempt, the call tried once.
      funded: { retries: [0], ran: true },
      // Its one attempt all the same, on a share of its own.
      unfunded: { retries: [0], ran: true },
    });
  });
});
