/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../../src/auth/identity.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../../src/workflow-resources.ts";
import { startWorkflow } from "../../src/workflow-starts.ts";
import { resourceRunFor } from "../../src/workflows/resource-runs.ts";
import { unique } from "../sign-in.ts";

// A JSON workflow's compute module on-prem: the calculation runs on the
// sandbox host, as App inspection does (workflow-modules.ts), where the
// supervisor kills a call that runs past its deadline; plain workerd
// enforces no CPU limit of its own.

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const builder = async (): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'builder', ?)"
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return { userId, role: "builder", teams: [], staff: false };
};

/** A module whose `count` runs `body` as its handler. */
const moduleRunning = (
  body: string
): string => `import { compute, v } from "@grasp-os/sdk/compute";

export const count = compute({
  input: v.array(v.number()).max(10),
  output: v.number(),
  handler: (items) => {
    ${body}
  },
});
`;

/** Publishes and runs a workflow calling `count` of `module`: how it ended. */
const ran = async (by: Acting, module: string) => {
  const workflow = await createWorkflowResource(env, by, `c-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: {
              count: { kind: "compute", contract: "local:code/count.ts#count" },
            },
          },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        {
          add: {
            call: "grasp.compute",
            with: { binding: "count", arguments: "${ [1, 2, 3] }" },
          },
        },
        { answer: { set: { status: "${ tostring }" } } },
      ],
    }),
    basedOn: null,
    modules: { "code/count.ts": module },
  });
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflow.id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, workflow.id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 90_000, interval: 500 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

describe("a JSON workflow's compute module on-prem", () => {
  it("runs its calculation on the sandbox host", async () => {
    const by = await builder();
    await expect(
      ran(by, moduleRunning("return items.length;"))
    ).resolves.toStrictEqual({
      status: "completed",
      output: { status: "3" },
    });
  });

  it("fails the run once the sandbox kills a calculation that never ends", async () => {
    const by = await builder();
    await expect(
      ran(by, moduleRunning("for (;;) { items.length; }"))
    ).resolves.toStrictEqual({
      status: "failed",
      code: "workflow.compute_failed",
    });
  }, 120_000);
});
