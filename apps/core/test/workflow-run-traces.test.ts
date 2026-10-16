/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { outcome, unique } from "./sign-in.ts";

// A run laid over its version's diagram (resource-run-trace.ts): the
// tasks its own journal reached, and so the path it took through the
// declared branches, never one the diagram suggests; the diagram of the
// version the run pinned, whatever was published since; and only for the
// workflow's builders.

const person = async (role: Role = "builder"): Promise<Acting> => {
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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const definitionOf = (name: string, version: string, tasks: unknown[]) =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** Spec 13.9's routing, by who: branches that join explicitly. */
const routing = [
  {
    route: {
      switch: [
        {
          ada: { when: '${ $workflow.input.who == "Ada" }', then: "greet-ada" },
        },
        { anyone: { then: "greet-other" } },
      ],
    },
  },
  { "greet-ada": { set: { status: "ada" }, then: "finished" } },
  { "greet-other": { set: { status: "other" }, then: "finished" } },
  { finished: { set: "${ . }" } },
];

/** Starts version `version` of workflow `id` for `who`, and waits for its end. */
const ranFor = async (
  by: Acting,
  id: string,
  version: number,
  who: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version, input: { who }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start made a run");
  }
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** A trace as lines: what the diagram declares, and what the run reached. */
const pathOf = (trace: WorkflowRunTrace) => ({
  status: trace.status,
  declared: trace.diagram.tasks.map(({ id }) => id),
  reached: trace.tasks.map(({ task, state }) => `${task} ${state}`).toSorted(),
});

describe("a run's trace", () => {
  it("shows the tasks the run's own journal reached, so the branch it took, over every declared one", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", routing),
      basedOn: null,
    });
    const ada = await ranFor(by, workflow.id, 1, "Ada");
    const grace = await ranFor(by, workflow.id, 1, "Grace");
    const declared = ["route", "greet-ada", "greet-other", "finished"];
    expect({
      ada: pathOf(await resourceRunTrace(env, by, workflow.id, ada)),
      grace: pathOf(await resourceRunTrace(env, by, workflow.id, grace)),
    }).toStrictEqual({
      ada: {
        status: "completed",
        declared,
        reached: ["finished reached", "greet-ada reached", "route reached"],
      },
      grace: {
        status: "completed",
        declared,
        reached: ["finished reached", "greet-other reached", "route reached"],
      },
    });
  });

  it("is drawn over the run's own version, not one published since, and shows where it failed", async () => {
    const by = await person();
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", [
        {
          mark: {
            set: { status: "marked" },
            export: {
              as: '${ {count: "not a number"} }',
              schema: objectSchema({ count: { type: "integer" } }),
            },
          },
        },
      ]),
      basedOn: null,
    });
    const failed = await ranFor(by, workflow.id, 1, "Ada");
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "2.0.0", routing),
      basedOn: 1,
    });
    expect(
      pathOf(await resourceRunTrace(env, by, workflow.id, failed))
    ).toStrictEqual({
      status: "failed",
      declared: ["mark"],
      reached: ["mark failed"],
    });
  });

  it("is only for the workflow's builders, and only of its own runs", async () => {
    const by = await person();
    const user = await person("user");
    const workflow = await createWorkflowResource(
      env,
      by,
      `traced-${unique()}`
    );
    const other = await createWorkflowResource(env, by, `traced-${unique()}`);
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(workflow.name, "1.0.0", routing),
      basedOn: null,
    });
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const run = await ranFor(user, workflow.id, 1, "Ada");
    expect({
      user: await outcome(resourceRunTrace(env, user, workflow.id, run)),
      elsewhere: await outcome(resourceRunTrace(env, by, other.id, run)),
    }).toStrictEqual({
      user: "role.forbidden",
      elsewhere: "workflow.run_unavailable",
    });
  });
});
