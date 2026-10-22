import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import type { ScopeFences } from "../src/workflows/resource-host.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { admittedFreely } from "./runs.ts";
import { unique } from "./sign-in.ts";

// JSON workflows as their tests write, publish and run them: a definition
// of a list of tasks, input `{ who }` and output `{ status }`, published
// once, run to its end through a real start, the engine and the host, and
// a host of one activation for a forged module to drive.

/** A builder of the organization, as their session has them. */
export const builder = async (role: Role = "builder"): Promise<Acting> => {
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
  return { userId, role, teams: [], staff: false };
};

export const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name` running `tasks`: input `{ who }`, output `{ status }`. */
export const definitionOf = (name: string, tasks: unknown[]): string =>
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
    do: tasks,
  });

/** A workflow of `by`'s, published once with `tasks`. */
export const published = async (by: Acting, tasks: unknown[]) => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  const version = await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, tasks),
    basedOn: null,
  });
  return { workflow, version };
};

/** Starts version 1 of workflow `id` for `by`, and waits for its end. */
export const ranFor = async (
  by: Acting,
  id: string
): Promise<WorkflowResourceRun> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  expect(runId).not.toBeNull();
  return await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );
};

/** What a run ended with: its status, and its output or error code. */
export const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** How many times run `runId`'s journal completed each step, by name. */
export const completedSteps = async (
  runId: string
): Promise<Map<string, number>> => {
  const page = await runObjectOf(env, runId).history({ after: 0, limit: 500 });
  const completed = new Map<string, number>();
  for (const record of page?.records ?? []) {
    const step = record.unreadable ? null : record.step;
    if (
      step !== null &&
      !record.unreadable &&
      record.type === "step_completed"
    ) {
      completed.set(step.name, (completed.get(step.name) ?? 0) + 1);
    }
  }
  return completed;
};

/** A host of a run of version 1 of workflow `id`, its steps run at once. */
export const hostOf = async (
  by: Acting,
  id: string,
  {
    step: given,
    fences,
  }: {
    /** The engine's steps, if not ones that run each step at once. */
    step?: RunStep;
    /** The run's settled scopes, if kept beyond this host. */
    fences?: ScopeFences;
  } = {}
): Promise<ResourceRunHost> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(env, id, 1, manifest?.hash ?? "");
  let count = 0;
  const step: RunStep = given ?? {
    do: async (name, _config, fn) => {
      count += 1;
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
    env,
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
        bindings: new Map(),
        restricted: false,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      ...(fences === undefined ? {} : { fences }),
      tampered: () => {
        // A refusal is what each test reads: nothing else to do with it.
      },
      admitAttempt: admittedFreely,
    }
  );
};

/** The code `settled` failed with, or "ok". */
export const codeOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? "ok" : settled.error.code;
