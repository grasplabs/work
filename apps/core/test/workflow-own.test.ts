import { collections } from "@grasp-os/brain/schema";
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  permissions,
  workflowBindingApprovals,
  workflowResourceRuns,
  workflowRunFiles,
  workflowStartReceipts,
} from "../src/db/core/schema.ts";
import {
  workflowActivity,
  workflowFiles,
  workflowKnowledge,
} from "../src/workflow-own.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { outcome, unique } from "./sign-in.ts";

// A workflow's own knowledge, files and activity (src/workflow-own.ts),
// as its page reads them. These tests start from the ways they can fail:
// someone with no role in the workflow learning of it; a run's files
// reaching someone its results aren't shown to; a collection named that
// the workflow may not read, or no longer holds; a user seeing others'
// runs in the activity. What the workflow's runs, bindings and permissions
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

/** The schema of an object with `properties`, each required. */
const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A workflow.json that greets, named `name`, as workflow-resources.test.ts publishes one. */
const definitionOf = (name: string): string =>
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
          params: {
            instructions: {
              schema: { type: "string", maxLength: 200 },
              label: "Instructions",
              default: "Greet the person.",
              sensitive: false,
            },
          },
          bindings: {},
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ finish: { set: { status: "done" } } }],
  });

/** A workflow Ada builds, published once, which Uma uses. */
const greeting = async () => {
  const ada = await person("builder");
  const uma = await person("user");
  const workflow = await createWorkflowResource(env, ada, `greet-${unique()}`);
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition: definitionOf(workflow.name),
    basedOn: null,
  });
  await shareWorkflowResource(env, ada, workflow.id, {
    type: "person",
    id: uma.userId,
    role: "user",
  });
  return { ada, uma, workflow };
};

/** A collection in Knowledge, readable as `access` says. */
const collection = async (
  name: string,
  access: "everyone" | "me" = "everyone"
): Promise<string> => {
  const id = crypto.randomUUID();
  await drizzle(env.KNOWLEDGE).insert(collections).values({
    id,
    name,
    description: "",
    owner: "someone",
    access,
    source: "here",
    createdAt: new Date(),
  });
  return id;
};

/** A permission workflow `workflowId` holds on collection `collectionId`. */
const held = async (
  workflowId: string,
  collectionId: string,
  {
    actions = ["read"],
    status = "active",
  }: { actions?: string[]; status?: "active" | "revoked" } = {}
): Promise<string> => {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(permissions)
    .values({
      id,
      subjectType: "workflow",
      subjectId: workflowId,
      objectType: "collection",
      objectId: collectionId,
      actions: JSON.stringify(actions),
      binding: `DOCS_${unique().replaceAll(/\W/gu, "_").toUpperCase()}`,
      status,
      requestedBy: "someone",
      requestedAt: new Date(),
    });
  return id;
};

/** A knowledge binding of version 1 to permission `permissionId`, approved by `by`. */
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
      kind: "knowledge",
      contractId: "grasp.knowledge@1",
      fingerprint: unique(),
      target: JSON.stringify({ kind: "knowledge", permissionId }),
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

/** A file run `runId` wrote, named `name`, finished at `at`, as `state` says. */
const wrote = async (
  workflowId: string,
  runId: string,
  name: string,
  at: number,
  state: "writing" | "done" | "deleted" = "done"
): Promise<void> => {
  await drizzle(env.DB)
    .insert(workflowRunFiles)
    .values({
      id: crypto.randomUUID(),
      runId,
      workflowResourceId: workflowId,
      openedBy: "step",
      openKey: unique(),
      name,
      type: "text/plain",
      size: name.length,
      state,
      createdAt: new Date(at - 500),
      finishedAt: state === "writing" ? null : new Date(at),
    });
};

describe("a workflow's own knowledge, files and activity", () => {
  it("names the collections it may read itself, with the bindings that use them, to anyone with a role in it", async () => {
    const { ada, uma, workflow } = await greeting();
    const stranger = await person("builder");
    const handbook = await collection(`Handbook ${unique()}`);
    const prices = await collection(`Prices ${unique()}`);
    const handbookPermission = await held(workflow.id, handbook);
    await held(workflow.id, prices);
    await bound(workflow.id, "handbook", handbookPermission, ada);
    await bound(workflow.id, "old", handbookPermission, ada, true);
    // Not the workflow's to read: revoked, write only, someone's own.
    await held(workflow.id, await collection("Revoked"), {
      status: "revoked",
    });
    await held(workflow.id, await collection("Write only"), {
      actions: ["write"],
    });
    await held(workflow.id, await collection("Private", "me"));

    const forAda = await workflowKnowledge(env, ada, workflow.id);
    const forUma = await workflowKnowledge(env, uma, workflow.id);

    expect({
      forAda: forAda.map(({ collectionId, aliases, actions }) => ({
        collectionId,
        aliases,
        actions,
      })),
      sameForUma: forUma.length === forAda.length,
      stranger: await outcome(workflowKnowledge(env, stranger, workflow.id)),
    }).toStrictEqual({
      forAda: [
        { collectionId: handbook, aliases: ["handbook"], actions: ["read"] },
        { collectionId: prices, aliases: [], actions: ["read"] },
      ],
      sameForUma: true,
      stranger: "workflow.resource_unavailable",
    });
  });

  it("lists the files its runs wrote as their results are shown: to the person each run acted for, and admins", async () => {
    const { ada, uma, workflow } = await greeting();
    const admin = await person("admin");
    const now = Date.now();
    const umas = await ran(workflow.id, uma, now - 10_000);
    const adas = await ran(workflow.id, ada, now - 5000);
    await wrote(workflow.id, umas, "uma-report.txt", now - 9000);
    await wrote(workflow.id, adas, "ada-report.txt", now - 4000);
    // Still being written, or gone with its run's details: never listed.
    await wrote(workflow.id, adas, "half.txt", now - 3000, "writing");
    await wrote(workflow.id, adas, "gone.txt", now - 2000, "deleted");

    const names = async (by: Acting) => {
      const files = await workflowFiles(env, by, workflow.id);
      return files.map(({ name }) => name);
    };

    const files = await workflowFiles(env, admin, workflow.id);

    expect({
      uma: await names(uma),
      // A builder sees every run, but only their own runs' results.
      ada: await names(ada),
      // The organization's admins see every run's, as its results.
      admin: files.map(({ name, runId, size, type }) => ({
        name,
        runId,
        size,
        type,
      })),
    }).toStrictEqual({
      uma: ["uma-report.txt"],
      ada: ["ada-report.txt"],
      admin: [
        { name: "ada-report.txt", runId: adas, size: 14, type: "text/plain" },
        { name: "uma-report.txt", runId: umas, size: 14, type: "text/plain" },
      ],
    });
  });

  it("tells what happened to it, newest first: versions, bindings approved and revoked, and runs as the reader may see them", async () => {
    const { ada, uma, workflow } = await greeting();
    const handbook = await held(workflow.id, await collection("Handbook"));
    await bound(workflow.id, "handbook", handbook, ada, true);
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
