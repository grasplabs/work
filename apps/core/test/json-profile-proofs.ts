/* oxlint-disable unicorn/no-thenable -- an if step's list is its then */
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { publishWorkflowVersion } from "../src/workflow-publish.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphAttachmentReadsUrl,
  graphAttachmentUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { fakeProviderFor } from "./model-provider.ts";
import { liveStatus, runInstance, runObject, stopped } from "./runs.ts";
import { person } from "./sealed-apps.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// grasp-workflow/2 proved end to end (GRA-1132, spec 13.10): each step
// kind that needs no outside system, and the calls of a model and a
// connector, in a definition published as a builder publishes it, started
// as a person starts it, run by the real engine, and read back as the
// run's record. Nothing of the platform is mocked. Where a step is
// durable, the run is stopped while it waits and resumed, as a deploy or
// a crash does, and what it recorded before stands. The same proofs run
// on Cloudflare's runtime and on plain workerd (`profileProofs`, called
// by json-profile.test.ts and on-prem/json-profile.test.ts). An App's
// function and a compute module are proved by their own suites
// (workflow-actions, workflow-compute, and their on-prem counterparts).

interface Shape {
  /** The run's steps. */
  readonly steps: unknown[];
  /** Its permissions, by kind. */
  readonly permissions?: Record<string, unknown>;
  /** Its args' properties: `{ who }` unless given. */
  readonly args?: Record<string, unknown>;
  /** What its output's `status` is. */
  readonly status: unknown;
}

/** A grasp-workflow/2 definition of `shape`, its output `{ status }`. */
const definitionOf = (shape: Shape): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema(shape.args ?? { who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: shape.status },
    ...(shape.permissions === undefined
      ? {}
      : { permissions: shape.permissions }),
    steps: shape.steps,
  });

/** A pause of `seconds`, so a run waits where a proof restarts it. */
const pause = (seconds: number) => ({
  id: "pause",
  type: "wait",
  for: `${seconds} seconds`,
});

/** A workflow of `by`'s, its version 1 published of `shape`. */
const published = async (
  by: Identity,
  shape: Shape
): Promise<{ id: string; name: string }> => {
  const workflow = await createWorkflowResource(env, by, `proof-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(shape),
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
      args: input ?? { who: "Ada" },
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
    ? { output: run.result }
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
 * activation. Its deadlines stay where they were, as core's engine keeps
 * them when it resumes a run (engine.ts, `keepDeadlines`): the time it was
 * stopped counts. Answers when it was stopped.
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
  await runInstance(runId).resume({ keepDeadlines: true });
  return stoppedAt;
};

/**
 * Step `id`'s sleep in run `runId`, as its object's journal records it:
 * when it is due, and how long it sleeps (0 for one whose deadline an
 * expression resolved). With `waiting`, once it sleeps.
 */
const sleepOf = async (
  runId: string,
  id: string,
  { waiting: asleep = false } = {}
): Promise<{ deadline: number; length: number }> =>
  await vi.waitFor(
    async () => {
      const row = await runInDurableObject(
        runObject(runId),
        (_instance, state) =>
          state.storage.sql
            .exec(
              `SELECT deadline, duration_ms AS length FROM steps WHERE type = 'sleep' AND name = ?${asleep ? " AND state = 'waiting'" : ""}`,
              `${id}:task`
            )
            .toArray()[0]
      );
      if (row === undefined) {
        throw new Error(`Step ${id} hasn't slept yet`);
      }
      return { deadline: Number(row.deadline), length: Number(row.length) };
    },
    { timeout: 90_000, interval: 100 }
  );

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

/** The model the organization chose, the one a binding may name. */
const allowedModel = "mistral/mistral-large-latest";

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

/**
 * The proofs of the steps that call nothing outside, where they run
 * (Cloudflare's runtime, or plain workerd).
 */
export const stepProofs = (where: string): void => {
  describe(
    `grasp-workflow/2's steps and calls, end to end ${where}`,
    {
      timeout: 180_000,
    },
    () => {
      // The identity provider people sign in through, faked as the outside
      // system it is.
      mockIdp();

      it("output: answers its value as the run's output", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          steps: [],
          status: { $expr: '"Hello, " + args.who' },
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

      it("if: runs its then when its condition holds, else its else", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          steps: [
            {
              id: "route",
              type: "if",
              condition: { $expr: 'args.who === "Ada"' },
              then: [],
              else: [
                {
                  id: "stranger",
                  type: "raise",
                  error: { code: "test.stranger", message: "Failed." },
                },
              ],
            },
          ],
          status: { $expr: '"Hello, " + args.who' },
        });
        const [ada, grace] = await Promise.all([
          started(by, workflow.id, { who: "Ada" }),
          started(by, workflow.id, { who: "Grace" }),
        ]);
        expect({
          ada: endOf(await ended(by, workflow.id, ada)),
          grace: endOf(await ended(by, workflow.id, grace)),
        }).toStrictEqual({
          ada: { status: "completed", output: { status: "Hello, Ada" } },
          grace: { status: "failed", code: "test.stranger" },
        });
      });

      it("wait: sleeps its length and until an expression's deadline, through a restart while it sleeps", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          args: { who: { kind: "string" }, deadline: { kind: "number" } },
          steps: [
            pause(2),
            { id: "linger", type: "wait", until: { $expr: "args.deadline" } },
          ],
          status: { $expr: '"Hello, " + args.who' },
        });
        const deadline = Date.now() + 5000;
        const runId = await started(by, workflow.id, { who: "Ada", deadline });
        // Each wait restarted while it sleeps, the one of a length and the
        // expression's, each read as its journal had it before.
        const paused = await sleepOf(runId, "pause", { waiting: true });
        await restarted(runId);
        const linger = await sleepOf(runId, "linger", { waiting: true });
        await restarted(runId);
        const run = await ended(by, workflow.id, runId);
        const lingered = await sleepOf(runId, "linger");
        expect({
          end: endOf(run),
          pause: await sleepOf(runId, "pause"),
          linger: lingered.deadline,
          // Gone on only once the last sleep was due.
          slept: Date.parse(run.endedAt ?? "") >= linger.deadline,
        }).toStrictEqual({
          end: { status: "completed", output: { status: "Hello, Ada" } },
          // Each deadline where it was before its restart: neither cut
          // short nor moved.
          pause: { deadline: paused.deadline, length: 2000 },
          linger: deadline,
          slept: true,
        });
      });

      it("raise: fails the run with the domain error it raises, nothing after it run", async () => {
        const by = await person("builder");
        const workflow = await published(by, {
          steps: [
            {
              id: "deny",
              type: "raise",
              error: {
                code: "invoice.conflict",
                message: "The invoice changed meanwhile.",
              },
            },
            pause(60),
          ],
          status: "unreached",
        });
        const run = await ended(
          by,
          workflow.id,
          await started(by, workflow.id)
        );
        expect(endOf(run)).toStrictEqual({
          status: "failed",
          code: "invoice.conflict",
        });
      });
    }
  );
};

/**
 * The proofs of the steps that call a provider or a connector, where they
 * run: in a file of their own on plain workerd, where they take longest.
 */
export const callProofs = (where: string): void => {
  describe(
    `grasp-workflow/2's steps and calls, end to end ${where}`,
    {
      timeout: 180_000,
    },
    () => {
      // The identity provider people sign in through, faked as the outside
      // system it is.
      const idp = mockIdp();

      it("agent: asks the provider once for the task's structured output, and nothing again after a restart", async () => {
        const admin = await person("admin");
        const by = await person("builder");
        const contract = `summary-${unique()}`;
        await publishCatalogContract(env, admin, {
          key: contract,
          kind: "model",
        });
        const workflow = await published(by, {
          permissions: { ai: { contract } },
          steps: [
            {
              id: "greet",
              type: "generate",
              instructions: "Greet them.",
              input: { who: { $expr: "args.who" } },
              returns: objectSchema({ line: { kind: "string" } }),
            },
            pause(2),
          ],
          status: { $expr: "greet.line" },
        });
        // The provider behind connect, the one outside system here: the
        // model chosen before the binding to it is approved.
        const provider = await fakeProviderFor([allowedModel], {
          text: '{"line":"Hello Ada"}',
          inputTokens: 100,
          outputTokens: 20,
        });
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "ai",
          target: { kind: "model", model: allowedModel },
          reviewed: { version: 1 },
        });
        const runId = await started(by, workflow.id);
        await restarted(runId);
        const run = await ended(by, workflow.id, runId);
        expect({
          end: endOf(run),
          requests: provider.requests.length,
          receipts: await receiptsOf(runId, "grasp.model"),
        }).toStrictEqual({
          end: { status: "completed", output: { status: "Hello Ada" } },
          requests: 1,
          receipts: ["started", "done"],
        });
      });

      it("do: calls a native connector through connect once, its provider answering, and nothing again after a restart", async () => {
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
              // As its connector declares it: a read whose content an
              // action may keep as a file of its run (GRA-886).
              ...(operation.answersFile === true ? { answersFile: true } : {}),
            },
          },
        });
        const workflow = await published(builder.identity, {
          permissions: { connections: { mail: { contract: key } } },
          args: {
            mailbox: { kind: "string" },
            message: { kind: "string" },
            attachment: { kind: "string" },
          },
          steps: [
            {
              id: "read",
              type: "call",
              connection: "mail",
              action: "mail.readAttachment",
              args: {
                mailbox: { $expr: "args.mailbox" },
                message: { $expr: "args.message" },
                attachment: { $expr: "args.attachment" },
                as: "text",
              },
            },
            pause(2),
          ],
          status: { $expr: "read.content" },
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
    }
  );
};

/** The proofs, where they run (Cloudflare's runtime, or plain workerd). */
export const profileProofs = (where: string): void => {
  stepProofs(where);
  callProofs(where);
};
