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

// A JSON workflow's run on-prem: its sealed build loads as a sandbox
// session owned by its workflow, with only the host's calls and each
// attempt's `evaluate` passed in (resource-host.ts), through the real
// engine, across a wait that ends one load and starts the next.

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

describe("a JSON workflow's run on-prem", () => {
  it("runs its sealed build in the sandbox, across a wait", async () => {
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
    const by: Acting = { userId, role: "builder", teams: [], staff: false };
    const workflow = await createWorkflowResource(env, by, `run-${unique()}`);
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
              bindings: {},
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          { pause: { wait: "PT1S" } },
          {
            greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } },
          },
        ],
      }),
      basedOn: null,
    });
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: by },
      workflow.id,
      { version: 1, input: { who: "Ada" }, key: unique() }
    );
    const run = await vi.waitFor(
      async () => {
        const read = await resourceRunFor(env, by, workflow.id, runId);
        expect(read.endedAt).not.toBeNull();
        return read;
      },
      { timeout: 90_000, interval: 500 }
    );
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { status: "Hello, Ada" },
    });
  });
});
