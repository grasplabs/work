import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  permissions,
  workflowBindingApprovals,
  workflowResourceRuns,
  workflowStartReceipts,
} from "../src/db/core/schema.ts";
import { workflowActivity } from "../src/workflow-own.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { greetingOf } from "./json-workflow-apps.ts";
import { unique } from "./sign-in.ts";

// A workflow's own files and activity (src/workflow-own.ts), as its page
// reads them. These tests start from the ways they can fail: someone with
// no role in the workflow learning of it; a run's files reaching someone
// its results aren't shown to; a user seeing others' runs in the
// activity. What the workflow's runs, bindings and permissions
// are is set up as core keeps them, as their own tests make them.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role): Promise<Acting> => {
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

/** A workflow Ada builds, published once, which Uma uses. */
const greeting = async () => {
  const ada = await person("builder");
  const uma = await person("user");
  const workflow = await createWorkflowResource(env, ada, `greet-${unique()}`);
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition: greetingOf(),
    basedOn: null,
  });
  await shareWorkflowResource(env, ada, workflow.id, {
    type: "person",
    id: uma.userId,
    role: "user",
  });
  return { ada, uma, workflow };
};

/** A permission workflow `workflowId` holds to read the Brain. */
const held = async (workflowId: string): Promise<string> => {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(permissions)
    .values({
      id,
      subjectType: "workflow",
      subjectId: workflowId,
      objectType: "platform",
      objectId: "platform",
      actions: JSON.stringify(["brain"]),
      binding: `BRAIN_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
      status: "active",
      requestedBy: "someone",
      requestedAt: new Date(),
    });
  return id;
};

/** A brain binding of version 1 to permission `permissionId`, approved by `by`. */
const bound = async (
  workflowId: string,
  alias: string,
  permissionId: string,
  by: Acting,
  revoked = false
): Promise<void> => {
  await drizzle(env.DB)
    .insert(workflowBindingApprovals)
    .values({
      id: crypto.randomUUID(),
      workflowResourceId: workflowId,
      alias,
      kind: "brain",
      contractId: "grasp.brain@1",
      fingerprint: unique(),
      target: JSON.stringify({ kind: "brain", permissionId }),
      reviewedVersion: 1,
      status: revoked ? "revoked" : "active",
      approvedBy: by.userId,
      approvedAt: new Date(),
      revokedBy: revoked ? by.userId : null,
      revokedAt: revoked ? new Date(Date.now() + 1000) : null,
    });
};

/** A run of version 1 for `principal`, started at `at`, ended a second later unless still running. */
const ran = async (
  workflowId: string,
  principal: Acting,
  at: number,
  status: "running" | "completed" = "completed"
): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(workflowStartReceipts).values({
    id,
    invokerType: "person",
    invokerId: principal.userId,
    idempotencyKey: unique(),
    workflowResourceId: workflowId,
    workflowResourceVersion: 1,
    manifestHash: "manifest",
    principalId: principal.userId,
    authorityGeneration: 0,
    inputHash: "input",
    createdAt: new Date(at),
  });
  await db.insert(workflowResourceRuns).values({
    id,
    workflowResourceId: workflowId,
    version: 1,
    manifestHash: "manifest",
    buildHash: "build",
    principalId: principal.userId,
    status,
    createdAt: new Date(at),
    endedAt: status === "running" ? null : new Date(at + 1000),
  });
  return id;
};

describe("a workflow's own files and activity", () => {
  it("tells what happened to it, newest first: versions, bindings approved and revoked, and runs as the reader may see them", async () => {
    const { ada, uma, workflow } = await greeting();
    const brain = await held(workflow.id);
    await bound(workflow.id, "handbook", brain, ada, true);
    const now = Date.now() + 60_000;
    const umas = await ran(workflow.id, uma, now);
    const adas = await ran(workflow.id, ada, now + 5000, "running");

    const whose = new Map([
      [umas, "uma"],
      [adas, "ada"],
    ]);
    const shape = (entries: Awaited<ReturnType<typeof workflowActivity>>) =>
      entries.map((entry) => {
        if (entry.kind === "run") {
          return `${entry.change} ${whose.get(entry.runId) ?? "?"}`;
        }
        if (entry.kind === "binding") {
          return `${entry.change} ${entry.alias}`;
        }
        return `version ${entry.version}`;
      });

    expect({
      ada: shape(await workflowActivity(env, ada, workflow.id)),
      uma: shape(await workflowActivity(env, uma, workflow.id)),
    }).toStrictEqual({
      ada: [
        "started ada",
        "ended uma",
        "started uma",
        "revoked handbook",
        "approved handbook",
        "version 1",
      ],
      // A user sees their own runs only.
      uma: [
        "ended uma",
        "started uma",
        "revoked handbook",
        "approved handbook",
        "version 1",
      ],
    });
  });
});
