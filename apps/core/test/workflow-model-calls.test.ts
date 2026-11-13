import {
  agentIdSchema,
  appIdSchema,
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { revokePermission } from "../src/permissions.ts";
import {
  createTriggerResource,
  updateTriggerVersion,
} from "../src/trigger-resources.ts";
import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import { workflowDefinition } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { withQuotas } from "./quota-limits.ts";
import { runObject, woken } from "./runs.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { webhookConfig } from "./source-config.ts";
import {
  adaStart,
  allowedModel,
  answer,
  callEventsOf,
  chooseModel,
  ended,
  endOf,
  granted,
  greetStep,
  greetingWorkflow,
  hold,
  identityOf,
  person,
  providerAnswering,
  receiptsOf,
  started,
} from "./workflow-calls.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// The calls of grasp-workflow/2 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

const idp = mockIdp();

/**
 * The read of the organization's chosen models, as the gateway routes a
 * call, after the call was authorized and before the ledger admits its
 * request (ai-model-choice.ts, `readModelChoice`).
 */
const modelChoiceRead = /from "org_settings"/iu;

/** A call's read of its run's authority (resource-authority.ts). */
const authorityRead = /approval\.alias/iu;

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
        binding: "ai",
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

  it("holds a run's model calls to its limit across a replay, sending nothing past it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The greeting spends the run's one call; the step after its replay
    // asks for a second.
    const { workflow } = await greetingWorkflow(ada, admin, {
      after: [greetStep("again")],
    });
    const provider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Never sent"}')
    );
    const run = await withQuotas(
      { lineageModelRequests: 1 },
      async () => await ended(ada, workflow.id, await started(ada, workflow.id))
    );
    expect({
      end: endOf(run),
      requests: provider.requests.length,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.model_call_limit" },
      requests: 1,
    });
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
      config: await webhookConfig(),
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
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'App', '', ?, ?)"
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
      await publishDefinition(
        env,
        ada,
        workflow.id,
        JSON.stringify({
          ...first,
          steps: first.steps.map((step, index) =>
            index === 0 ? { ...step, title: "Wait a day" } : step
          ),
        })
      );
      const trigger = await createTriggerResource(env, ada, {
        kind: "webhook",
        workflowId: workflow.id,
        version: 1,
        config: await webhookConfig(),
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
