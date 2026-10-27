import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { v } from "@grasp-os/sdk";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { admitRunEvent } from "../src/workflows/run-events.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphAttachmentReadsUrl,
  graphAttachmentUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { liveStatus, resumed, runObject, stopped } from "./runs.ts";
import { person } from "./sealed-apps.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The Open Workflow JSON profile proved end to end (GRA-1132, spec 13.10):
// each task kind and named call that needs no outside system, in a
// definition published as a builder publishes it, started as a person
// starts it, run by the real engine, and read back as the run's record.
// Nothing is mocked. Where a kind is durable, the run is stopped while it
// waits and resumed, as a deploy or a crash does, and what it recorded
// before stands. The same proofs run on Cloudflare's runtime and on plain
// workerd (`profileProofs`, called by json-profile.test.ts and
// on-prem/json-profile.test.ts). Calls that reach outside systems (a
// model, a connector, an App's operation, a compute module) are proved by
// their own suites (workflow-calls, workflow-actions, workflow-compute,
// and their on-prem counterparts).

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

interface Shape {
  /** The run's tasks. */
  readonly do: unknown[];
  /** Its bindings, by alias. */
  readonly bindings?: Record<string, unknown>;
  /** Its parameters, by name. */
  readonly params?: Record<string, unknown>;
  /** Its input's properties: `{ who }` unless given. */
  readonly input?: Record<string, unknown>;
  /** Its output's properties: `{ status }` unless given. */
  readonly output?: Record<string, unknown>;
}

/** Workflow `name`'s 1.0.0 in the profile, of `shape`. */
const definitionOf = (name: string, shape: Shape): string =>
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
          params: shape.params ?? {},
          bindings: shape.bindings ?? {},
        },
      },
    },
    input: {
      schema: objectSchema(shape.input ?? { who: { type: "string" } }),
    },
    output: {
      schema: objectSchema(shape.output ?? { status: { type: "string" } }),
    },
    do: shape.do,
  });

/** A workflow of `by`'s, its 1.0.0 published of `shape`. */
const published = async (
  by: Identity,
  shape: Shape | ((name: string) => Shape)
): Promise<{ id: string; name: string }> => {
  const workflow = await createWorkflowResource(env, by, `proof-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(
      workflow.name,
      typeof shape === "function" ? shape(workflow.name) : shape
    ),
    basedOn: null,
  });
  return workflow;
};

/** A run of version 1 of workflow `id`, started by `by` on `input`. */
const started = async (
  by: Identity,
  id: string,
  input?: unknown
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      version: 1,
      input: input ?? { who: "Ada" },
      key: unique(),
    }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** Run `runId` of workflow `id`, once it has ended. */
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
    { timeout: 90_000, interval: 200 }
  );

/** How a run ended: its status, and its output or its error's code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** Once run `runId` waits (a sleep, an event, a decision). */
const waiting = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 90_000, interval: 200 }
  );
};

/** Why a proof restarts a run's object, as the abort carries it. */
const restartReason = "Restarted by the proof";

/**
 * Restarts run `runId` while it waits, as a deploy or a crash does: the
 * engine stops it, its object is restarted where it is, losing all it held
 * in memory, and the engine resumes it, replaying its journal in a fresh
 * activation. Answers when it was stopped.
 */
const restarted = async (runId: string): Promise<number> => {
  await waiting(runId);
  const stoppedAt = Date.now();
  await stopped(runId);
  await runInDurableObject(runObject(runId), (_instance, state) => {
    state.abort(restartReason);
  }).catch((error: unknown) => {
    // Aborting fails the call that aborted, with its own reason: that is
    // the restart. Any other failure is one, and fails the proof.
    if (!String(error).includes(restartReason)) {
      throw error;
    }
  });
  await resumed(runId);
  return stoppedAt;
};

/** The audit entries of `action` about `target`. */
const auditedOf = async (action: string, target: string) => {
  const events = await allEvents();
  return events.filter(
    (entry) => entry.action === action && entry.target?.id === target
  );
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

/** An event contract of `admin`'s: `grasp.job.completed`, `{ note }`. */
const jobEvents = async (admin: Identity): Promise<string> => {
  const contract = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      "grasp.job.completed": {
        data: JSON.stringify(v.object({ note: v.string() }).descriptor),
        browser: false,
      },
    },
  });
  return contract;
};

/** The model the tests' deployment allows (vite.config.ts). */
const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The calls run `runId` made of `call`, by outcome, as the audit log has them. */
const receiptsOf = async (runId: string, call: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target, detail }) =>
        action === "workflow.run.called" &&
        target?.id === runId &&
        detail?.call === call
    )
    .map(({ detail }) => detail?.outcome);
};

type Idp = ReturnType<typeof mockIdp>;

/** Someone signed in through the identity provider, as core takes them. */
const signedIn = async (idp: Idp, role: "admin" | "builder") => {
  const session = await signedInApi(idp, role);
  const identity: Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { session, identity };
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

/**
 * A shared Microsoft 365 mailbox `admin` connects through connect's own
 * consent flow, as `subject`: its connection's ID and the mailbox.
 */
const connectShared = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  subject: string
) => {
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, subject),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName?.startsWith(`${subject}@`) === true
  );
  if (typeof connection?.accountName !== "string") {
    throw new TypeError("Expected the shared connection");
  }
  return { id: connection.id, mailbox: connection.accountName };
};

/** A JSON Schema text of connect's, as the catalog's envelope text for it. */
const enveloped = (text: string): string =>
  JSON.stringify({
    format: "json",
    document: z.unknown().parse(JSON.parse(text)),
  });

/** The proofs, where they run (Cloudflare's runtime, or plain workerd). */
export const profileProofs = (where: string): void => {
  describe(
    `the JSON workflow profile's tasks and calls, end to end ${where}`,
    {
      timeout: 180_000,
    },
    () => {
      // The identity provider people sign in through, faked as the outside
      // system it is.
      const idp = mockIdp();

      it("set: answers its value as the run's output", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [{ greet: { set: { status: '${ "Hello, " + .who }' } } }],
        });
        const run = await ended(
          by,
          workflow.id,
          await started(by, workflow.id)
        );
        expect(endOf(run)).toStrictEqual({
          status: "completed",
          output: { status: "Hello, Ada" },
        });
      });

      it("do: runs its tasks in order, each on the last's output, and a then jumps past the rest", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            {
              steps: {
                do: [
                  { first: { set: { said: '${ "Hello, " + .who }' } } },
                  { second: { set: { status: '${ .said + "!" }' } } },
                ],
                then: "end",
              },
            },
            { skipped: { set: { status: "skipped" } } },
          ],
        });
        const run = await ended(
          by,
          workflow.id,
          await started(by, workflow.id)
        );
        expect(endOf(run)).toStrictEqual({
          status: "completed",
          output: { status: "Hello, Ada!" },
        });
      });

      it("switch: takes the first case that holds, else its default", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            {
              route: {
                switch: [
                  { ada: { when: '${ .who == "Ada" }', then: "greet-ada" } },
                  { anyone: { then: "greet-other" } },
                ],
              },
            },
            { "greet-ada": { set: { status: "ada" }, then: "end" } },
            { "greet-other": { set: { status: "other" }, then: "end" } },
          ],
        });
        const [ada, grace] = await Promise.all([
          started(by, workflow.id, { who: "Ada" }),
          started(by, workflow.id, { who: "Grace" }),
        ]);
        expect({
          ada: endOf(await ended(by, workflow.id, ada)),
          grace: endOf(await ended(by, workflow.id, grace)),
        }).toStrictEqual({
          ada: { status: "completed", output: { status: "ada" } },
          grace: { status: "completed", output: { status: "other" } },
        });
      });

      it("wait: sleeps its sealed length and an expression's, through a restart while it sleeps, and goes on with what it had", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            { greet: { set: { said: '${ "Hello, " + .who }' } } },
            { pause: { wait: "PT2S" } },
            { linger: { wait: '${ "PT1S" }' } },
            { finish: { set: { status: "${ .said }" } } },
          ],
        });
        const begun = Date.now();
        const runId = await started(by, workflow.id);
        await restarted(runId);
        const run = await ended(by, workflow.id, runId);
        expect({
          end: endOf(run),
          // Both sleeps, whole: never cut short by the restart.
          slept: Date.parse(run.endedAt ?? "") - begun >= 3000,
        }).toStrictEqual({
          end: { status: "completed", output: { status: "Hello, Ada" } },
          slept: true,
        });
      });

      it("raise: fails the run with the domain error it raises, nothing after it run", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            {
              deny: {
                raise: {
                  error: {
                    type: "urn:grasp:error:invoice.conflict",
                    status: 409,
                    title: "The invoice changed meanwhile.",
                  },
                },
              },
            },
            { unreached: { set: { status: "unreached" } } },
          ],
        });
        const run = await ended(
          by,
          workflow.id,
          await started(by, workflow.id)
        );
        expect(endOf(run)).toStrictEqual({
          status: "failed",
          code: "workflow.raised",
        });
      });

      it("emit: writes its event once to the outbox, through a restart right after it", async () => {
        const admin = await person("admin");
        const contract = await jobEvents(admin);
        const workflow = await published(admin, {
          bindings: { jobEvents: { kind: "event", contract } },
          do: [
            {
              publish: {
                emit: {
                  event: {
                    with: {
                      type: "grasp.job.completed",
                      data: { note: '${ "Done for " + .who }' },
                    },
                  },
                },
                metadata: { grasp: { binding: "jobEvents" } },
              },
            },
            { pause: { wait: "PT1S" } },
            { finish: { set: { status: "emitted" } } },
          ],
        });
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "jobEvents",
          target: { kind: "event" },
          reviewed: { version: 1 },
        });
        const runId = await started(admin, workflow.id);
        await restarted(runId);
        const run = await ended(admin, workflow.id, runId);
        const { results } = await env.DB.prepare(
          "SELECT type, data FROM workflow_emitted_events WHERE run_id = ?"
        )
          .bind(runId)
          .all<{ type: string; data: string }>();
        const audited = await auditedOf("workflow.event.emitted", runId);
        expect({
          end: endOf(run),
          emitted: results,
          audited: audited.length,
        }).toStrictEqual({
          end: { status: "completed", output: { status: "emitted" } },
          emitted: [
            {
              type: "grasp.job.completed",
              data: JSON.stringify({ note: "Done for Ada" }),
            },
          ],
          audited: 1,
        });
      });

      it("listen: waits for its event through a restart, and goes on with the event's data", async () => {
        const admin = await person("admin");
        const contract = await jobEvents(admin);
        const workflow = await published(admin, {
          bindings: { jobEvents: { kind: "event", contract } },
          do: [
            {
              "await-job": {
                listen: {
                  to: { one: { with: { type: "grasp.job.completed" } } },
                },
                timeout: { after: { minutes: 5 } },
                metadata: { grasp: { binding: "jobEvents" } },
                output: { as: "${ { status: .[0].note } }" },
              },
            },
          ],
        });
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "jobEvents",
          target: { kind: "event" },
          reviewed: { version: 1 },
        });
        const runId = await started(admin, workflow.id);
        await restarted(runId);
        await waiting(runId);
        await admitRunEvent(env, {
          workflowId: workflow.id,
          runId,
          binding: "jobEvents",
          type: "grasp.job.completed",
          data: { note: "done" },
          key: unique(),
          source: "https://grasp.test/proofs",
          sender: "proofs",
        });
        const run = await ended(admin, workflow.id, runId);
        expect(endOf(run)).toStrictEqual({
          status: "completed",
          output: { status: "done" },
        });
      });

      it("run: starts its child workflow once, under the parent's grant, and goes on with the child's output", async () => {
        const admin = await person("admin");
        const child = await published(admin, {
          output: { greeting: { type: "string" } },
          do: [{ greet: { set: { greeting: '${ "Hello, " + .who }' } } }],
        });
        const parent = await createWorkflowResource(
          env,
          admin,
          `parent-${unique()}`
        );
        const asked = await requestPermission(
          env,
          admin,
          {
            subject: { type: "workflow", workflowId: parent.id },
            object: { type: "workflow", workflowId: child.id },
            actions: ["start"],
            binding: "CHILD",
          },
          rolesOf(admin)
        );
        await grantPermission(env, admin, asked.id, { version: null });
        await publishWorkflowVersion(env, admin, parent.id, {
          definition: definitionOf(parent.name, {
            bindings: {
              child: {
                kind: "workflow",
                contract: `${workflowNamespace}/${child.name}/1.0.0`,
              },
            },
            do: [
              {
                "greet-child": {
                  run: {
                    workflow: {
                      namespace: workflowNamespace,
                      name: child.name,
                      version: "1.0.0",
                      input: { who: "${ $workflow.input.who }" },
                    },
                  },
                  metadata: { grasp: { binding: "child" } },
                },
              },
              { finish: { set: { status: "${ .greeting }" } } },
            ],
          }),
          basedOn: null,
        });
        const runId = await started(admin, parent.id);
        const run = await ended(admin, parent.id, runId);
        const { results: children } = await env.DB.prepare(
          "SELECT status FROM workflow_resource_runs WHERE parent_run_id = ?"
        )
          .bind(runId)
          .all<{ status: string }>();
        expect({ end: endOf(run), children }).toStrictEqual({
          end: { status: "completed", output: { status: "Hello, Ada" } },
          children: [{ status: "completed" }],
        });
      });

      it("grasp.now and grasp.random: answer once, recorded, the same after a restart", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            { clock: { call: "grasp.now", export: { as: "${ {at: .} }" } } },
            {
              dice: {
                call: "grasp.random",
                with: {},
                export: { as: "${ $context + {r: .} }" },
              },
            },
            { pause: { wait: "PT2S" } },
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
        const runId = await started(by, workflow.id);
        const stoppedAt = await restarted(runId);
        const run = await ended(by, workflow.id, runId);
        const [at, r] = z
          .object({ status: z.string() })
          .parse(run.output)
          .status.split(" ")
          .map(Number);
        expect({
          status: run.status,
          // Recorded before the restart: asked again as the run replayed
          // after it, the time would be after the run was stopped.
          recorded: (at ?? Number.POSITIVE_INFINITY) <= stoppedAt,
          fraction: (r ?? -1) >= 0 && (r ?? 1) < 1,
        }).toStrictEqual({
          status: "completed",
          recorded: true,
          fraction: true,
        });
      });

      it("grasp.sleepUntil: sleeps until the deadline it recorded, through a restart", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          do: [
            {
              until: {
                call: "grasp.sleepUntil",
                with: {
                  timestamp:
                    "${ $workflow.startedAt.epoch.milliseconds + 3000 }",
                },
              },
            },
            {
              finish: {
                set: {
                  status:
                    "${ $workflow.startedAt.epoch.milliseconds | tostring }",
                },
              },
            },
          ],
        });
        const runId = await started(by, workflow.id);
        await restarted(runId);
        const run = await ended(by, workflow.id, runId);
        const startedAt = Number(
          z.object({ status: z.string() }).parse(run.output).status
        );
        expect({
          status: run.status,
          slept: Date.parse(run.endedAt ?? "") - startedAt >= 3000,
        }).toStrictEqual({ status: "completed", slept: true });
      });

      it("grasp.model: asks the provider once for the task's structured output, and nothing again after a restart", async () => {
        const admin = await person("admin");
        const by = await person("builder");
        const contract = `summary-${unique()}`;
        await publishCatalogContract(env, admin, {
          key: contract,
          kind: "model",
        });
        const workflow = await published(by, {
          bindings: { summary: { kind: "model", contract } },
          do: [
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
            { pause: { wait: "PT2S" } },
            { finish: { set: { status: "${ $context.line }" } } },
          ],
        });
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "summary",
          target: { kind: "model", model: allowedModel },
          reviewed: { version: 1 },
        });
        // The provider behind AI Gateway, the one outside system here.
        const gateway = fakeGateway({
          text: '{"line":"Hello Ada"}',
          inputTokens: 100,
          outputTokens: 20,
        });
        const ai: AiBinding = env.AI;
        const fetching = vi
          .spyOn(ai, "fetch")
          .mockImplementation(gateway.binding.fetch);
        try {
          const runId = await started(by, workflow.id);
          await restarted(runId);
          const run = await ended(by, workflow.id, runId);
          expect({
            end: endOf(run),
            requests: gateway.requests.length,
            receipts: await receiptsOf(runId, "grasp.model"),
          }).toStrictEqual({
            end: { status: "completed", output: { status: "Hello Ada" } },
            requests: 1,
            receipts: ["started", "done"],
          });
        } finally {
          fetching.mockRestore();
        }
      });

      it("grasp.connector: calls a native connector through connect once, its provider answering, and nothing again after a restart", async () => {
        const admin = await signedIn(idp, "admin");
        const builder = await signedIn(idp, "builder");
        const { id: connectionId, mailbox } = await connectShared(
          admin.session,
          `proof-${unique()}`
        );
        // The operation's schemas, exactly as connect serves them.
        const served = await env.CONNECT.connectorContract({
          contract: "microsoft-365.mail@1",
          connectionId,
        });
        const operation = Object.values(served.actions).find(
          (each) => each.tool === "mail.readAttachment"
        );
        if (operation === undefined) {
          throw new Error("Expected mail.readAttachment in the contract");
        }
        const key = `mail-${unique()}`;
        await publishCatalogContract(env, admin.identity, {
          key,
          kind: "connector",
          operations: {
            "mail.readAttachment": {
              input: enveloped(operation.input),
              output: enveloped(operation.output),
              readOnly: true,
            },
          },
        });
        const workflow = await published(builder.identity, {
          bindings: { mail: { kind: "connector", contract: key } },
          input: {
            mailbox: { type: "string" },
            message: { type: "string" },
            attachment: { type: "string" },
          },
          do: [
            {
              read: {
                call: "grasp.connector",
                with: {
                  binding: "mail",
                  operation: "mail.readAttachment",
                  arguments: {
                    mailbox: "${ $workflow.input.mailbox }",
                    message: "${ $workflow.input.message }",
                    attachment: "${ $workflow.input.attachment }",
                    as: "text",
                  },
                },
                export: { as: "${ {read: .content} }" },
              },
            },
            { pause: { wait: "PT2S" } },
            { finish: { set: { status: "${ $context.read }" } } },
          ],
        });
        const asked = await requestPermission(
          env,
          builder.identity,
          {
            subject: { type: "workflow", workflowId: workflow.id },
            object: { type: "connection", connectionId },
            actions: ["mail.readAttachment"],
            binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
          },
          rolesOf(builder.identity)
        );
        await grantPermission(env, admin.identity, asked.id, {
          version: null,
        });
        await approveWorkflowBinding(env, admin.identity, workflow.id, {
          alias: "mail",
          target: {
            kind: "connector",
            permissionId: asked.id,
            contract: "microsoft-365.mail@1",
          },
          reviewed: { version: 1 },
        });
        // Microsoft Graph, the one outside system here, holds the attachment.
        await providers().fetch(graphAttachmentUrl, {
          method: "POST",
          body: JSON.stringify({
            mailbox,
            message: "m1",
            id: "a1",
            name: "notes.txt",
            contentType: "text/plain",
            contentBytes: btoa("due 2026-11-01"),
          }),
        });
        const runId = await started(builder.identity, workflow.id, {
          mailbox,
          message: "m1",
          attachment: "a1",
        });
        await restarted(runId);
        const run = await ended(builder.identity, workflow.id, runId);
        const events = await allEvents();
        const calls = events.filter(
          ({ action, detail }) =>
            action === "connection.call" && detail?.run === runId
        );
        // What left the platform: Graph handed out the content once.
        const graph = await providers().fetch(
          `${graphAttachmentReadsUrl}?${new URLSearchParams({ mailbox, message: "m1", id: "a1" }).toString()}`
        );
        const { reads } = z
          .object({ reads: z.number() })
          .parse(await graph.json());
        expect({
          end: endOf(run),
          receipts: await receiptsOf(runId, "grasp.connector"),
          // Connect's own record of the call: once.
          calls: calls.length,
          reads,
        }).toStrictEqual({
          end: { status: "completed", output: { status: "due 2026-11-01" } },
          receipts: ["started", "done"],
          calls: 1,
          reads: 1,
        });
      });

      it("grasp.decision: asks its recipient once, waits through a restart, and goes on with their confirmed answer", async () => {
        const admin = await person("admin");
        const owner = await person("builder");
        const reviewer = await person("user");
        const contract = `approval-${unique()}`;
        await publishCatalogContract(env, admin, {
          key: contract,
          kind: "decision",
          input: JSON.stringify(v.object({ who: v.string() }).descriptor),
          response: JSON.stringify(
            v.object({ comment: v.string() }).descriptor
          ),
        });
        const workflow = await published(owner, {
          bindings: { approval: { kind: "decision", contract } },
          do: [
            {
              ask: {
                call: "grasp.decision",
                with: {
                  binding: "approval",
                  recipients: [`person:${reviewer.userId}`],
                  prompt: "Greet them?",
                  input: { who: "${ $workflow.input.who }" },
                },
                export: { as: "${ {approved: .approved} }" },
              },
            },
            {
              finish: {
                set: {
                  status:
                    '${ if $context.approved then "approved" else "declined" end }',
                },
              },
            },
          ],
        });
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "approval",
          target: { kind: "decision", deciders: [`person:${reviewer.userId}`] },
          reviewed: { version: 1 },
        });
        const runId = await started(owner, workflow.id);
        await restarted(runId);
        const decision = await vi.waitFor(
          async () => {
            const row = await env.DB.prepare(
              "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
            )
              .bind(runId)
              .first<{ id: string }>();
            if (row === null) {
              throw new Error("No decision yet");
            }
            return row.id;
          },
          { timeout: 30_000, interval: 200 }
        );
        const answer = { approved: true, payload: { comment: "Looks right" } };
        const review = await reviewDecision(env, reviewer, decision, answer);
        if (review.state !== "review") {
          throw new Error("Nothing to review");
        }
        const { confirmation } = await confirmDecision(
          env,
          reviewer,
          decision,
          review.decision.revision,
          review.response
        );
        await answerDecision(
          env,
          reviewer,
          decision,
          review.response,
          confirmation
        );
        const run = await ended(owner, workflow.id, runId);
        const { results: decisions } = await env.DB.prepare(
          "SELECT status FROM workflow_decisions WHERE resource_run_id = ?"
        )
          .bind(runId)
          .all<{ status: string }>();
        const opened = await auditedOf("workflow.decision.opened", decision);
        expect({
          end: endOf(run),
          decisions,
          opened: opened.length,
        }).toStrictEqual({
          end: { status: "completed", output: { status: "approved" } },
          decisions: [{ status: "approved" }],
          opened: 1,
        });
      });
    }
  );
};
