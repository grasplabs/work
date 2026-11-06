import { v } from "@grasp-os/sdk";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../../src/auth/identity.ts";
import { approveWorkflowBinding } from "../../src/workflow-bindings.ts";
import { publishCatalogContract } from "../../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../../src/workflow-resources.ts";
import { startWorkflow } from "../../src/workflow-starts.ts";
import { resourceRunFor } from "../../src/workflows/resource-runs.ts";
import { admitRunEvent } from "../../src/workflows/run-events.ts";
import { definitionOf, passing } from "../json-workflow-apps.ts";
import { liveStatus } from "../runs.ts";
import { unique } from "../sign-in.ts";

// A JSON workflow's run on-prem: its sealed build loads as a sandbox
// session owned by its workflow, with only the run host's calls passed in
// (sealed-run.ts), through the real engine, across a wait that ends one
// load and starts the next, and an event wait whose event comes while no
// load is running.

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
      definition: definitionOf([
        { id: "pause", type: "wait", for: "1 second" },
        // A wait the host resolves to a deadline, and sleeps until.
        { id: "linger", type: "wait", until: { $expr: "0" } },
        passing("greet"),
      ]),
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

  it("takes an event wait's event in the sandbox, after the load that waited for it ended", async () => {
    const userId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
      ).bind(Date.now()),
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
      ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
      env.DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'admin', ?)"
      ).bind(crypto.randomUUID(), userId, Date.now()),
    ]);
    const by = {
      userId,
      email: `${userId}@acme.test`,
      name: "Person",
      role: "admin" as const,
      teams: [],
      staff: false,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const contract = `job-events-${unique()}`;
    await publishCatalogContract(env, by, {
      key: contract,
      kind: "event",
      events: {
        "grasp.job.completed": {
          data: JSON.stringify(v.object({ note: v.string() }).descriptor),
          browser: false,
        },
      },
    });
    const workflow = await createWorkflowResource(env, by, `run-${unique()}`);
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(
        [
          {
            id: "job",
            type: "wait",
            event: { from: "jobEvents", type: "grasp.job.completed" },
            timeout: "5 minutes",
          },
        ],
        {
          bindings: { jobEvents: { kind: "event", contract } },
          status: { $expr: 'steps.job.output.event?.data.note ?? ""' },
        }
      ),
      basedOn: null,
    });
    await approveWorkflowBinding(env, by, workflow.id, {
      alias: "jobEvents",
      target: { kind: "event" },
      reviewed: { version: 1 },
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
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("waiting");
      },
      { timeout: 90_000, interval: 500 }
    );
    await admitRunEvent(env, {
      workflowId: workflow.id,
      runId,
      binding: "jobEvents",
      type: "grasp.job.completed",
      data: { note: "done" },
      key: unique(),
      source: "https://grasp.test/on-prem",
      sender: "on-prem",
    });
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
      output: { status: "done" },
    });
  });
});
