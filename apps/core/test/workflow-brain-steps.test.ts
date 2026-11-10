import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { createCollection } from "../src/knowledge/collection-rules.ts";
import { saveDocument } from "../src/knowledge/person-writes.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { unique } from "./sign-in.ts";

// A workflow's own steps on a Brain collection (`ctx.brain.<alias>`), from
// their threat model (sealed-run.ts, resource-reads.ts): a brain
// permission is one collection, searched, read and recalled as the run's
// person may, never past what they may read, a document outside it as one
// that isn't there; a sensitive collection's data never reaches a run that
// isn't restricted; a recall only while the workflow holds the `brain`
// permission; each call one of the run's own, with its receipts.

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
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
  return identityOf(userId, role);
};

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

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/** Searches for the run's query, and reads the document it names. */
const searchesAndReads = {
  steps: [
    {
      id: "searched",
      type: "call",
      brain: "docs",
      action: "search",
      args: { text: { $expr: "args.query" } },
    },
    {
      id: "found",
      type: "call",
      brain: "docs",
      action: "read",
      args: { id: { $expr: "args.doc" } },
      if: { $expr: 'args.doc !== ""' },
    },
  ],
  returns: {
    kind: "object",
    fields: {
      hits: { kind: "array", item: { kind: "string" } },
      found: { kind: "string" },
    },
  },
  result: {
    hits: { $expr: "searched.map((hit) => hit.title)" },
    found: { $expr: 'found?.title ?? ""' },
  },
};

/** Recalls the run's query, answering the headings its evidence cites. */
const recalls = {
  steps: [
    {
      id: "recalled",
      type: "call",
      brain: "docs",
      action: "recall",
      args: { query: { $expr: "args.query" } },
    },
  ],
  returns: {
    kind: "object",
    fields: { cited: { kind: "array", item: { kind: "string" } } },
  },
  result: {
    cited: {
      $expr: 'recalled.items.map((item) => item.citationLocator[0] ?? "")',
    },
  },
};

/**
 * Recalls the run's query, then, after a pause, writes what it recalled
 * to a file of the run: what the run read leaving it.
 */
const recallsThenWrites = {
  steps: [
    ...recalls.steps,
    { id: "hold", type: "wait", for: "1 second" },
    {
      id: "written",
      type: "call",
      files: "runFiles",
      action: "write",
      args: {
        name: "recalled.txt",
        type: "text/plain",
        text: { $expr: '"Recalled " + recalled.items.length' },
      },
    },
  ],
  returns: recalls.returns,
  result: recalls.result,
};

/**
 * A workflow of `by`'s running `shape` on `docs`, its one collection: the
 * handbook everyone reads, the payroll team's own (`team`), or its
 * sensitive salaries collection (`sensitive`), granted to the workflow
 * and approved by `admin`; and a document of a collection it was never
 * granted.
 */
const readingWorkflow = async (
  by: Identity,
  admin: Identity,
  shape: {
    readonly steps: readonly unknown[];
    readonly returns: unknown;
    readonly result: unknown;
  },
  { sensitive = false, team: teamOnly = false, files = false } = {}
) => {
  const key = `docs-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "knowledge" });
  const filesKey = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key: filesKey, kind: "files" });
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Payroll', 'organization', ?)"
    ).bind(team, Date.now()),
    ...[by, admin].map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  const teamAdmin = { ...admin, teams: [{ id: team, name: "Payroll" }] };
  const documentIn = async (collectionId: string, path: string, text: string) =>
    await saveDocument(env, teamAdmin, {
      collectionId,
      path,
      text,
      ifVersion: 0,
    });
  const teams = { access: "teams", teams: [team] } as const;
  const bound = await createCollection(
    env,
    teamAdmin,
    sensitive || teamOnly
      ? { name: sensitive ? "Salaries" : "Payroll", ...teams, sensitive }
      : { name: "Handbook", access: "everyone" }
  );
  const other = await createCollection(env, admin, {
    name: "Other",
    access: "everyone",
  });
  const leave = await documentIn(
    bound.id,
    "leave.md",
    "# Leave\nAsk your lead before you take leave."
  );
  const elsewhere = await documentIn(
    other.id,
    "other.md",
    "# Other\nLeave is not bound."
  );
  const workflow = await createWorkflowResource(env, by, `read-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { doc: { kind: "string" }, query: { kind: "string" } },
      },
      returns: shape.returns,
      result: shape.result,
      permissions: {
        brain: { docs: { contract: key } },
        ...(files ? { files: { runFiles: { contract: filesKey } } } : {}),
      },
      steps: shape.steps,
    }),
    basedOn: null,
  });
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "collection", collectionId: bound.id },
    actions: ["read"],
    binding: `DOCS_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "knowledge", permissionId },
    reviewed: { version: 1 },
  });
  if (files) {
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "runFiles",
      target: { kind: "files" },
      reviewed: { version: 1 },
    });
  }
  return { workflow, documents: { leave: leave.id, elsewhere: elsewhere.id } };
};

/** A run of version 1 of workflow `id` for `by` on `input`, and how it ended. */
const ranOn = async (
  by: Identity,
  id: string,
  input: { doc?: string; query?: string }
) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      version: 1,
      input: { doc: "", query: "leave", ...input },
      key: unique(),
    }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 30_000, interval: 100 }
  );
  return {
    runId,
    end:
      run.status === "completed"
        ? { status: run.status, output: run.output }
        : { status: run.status, code: run.error?.code },
  };
};

/** How a run of version 1 of workflow `id` for `by` on `input` ended. */
const endOf = async (
  by: Identity,
  id: string,
  input: { doc?: string; query?: string }
) => {
  const { end } = await ranOn(by, id, input);
  return end;
};

/** The receipts of run `runId`'s calls: call, permission and outcome. */
const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" && event.target?.id === runId
    )
    .map(({ detail }) => [detail?.call, detail?.binding, detail?.outcome]);
};

describe("a workflow's steps on a Brain collection", () => {
  it("search and read their one collection as the run's person, each call one of the run's own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, documents } = await readingWorkflow(
      ada,
      admin,
      searchesAndReads
    );
    const { runId, end } = await ranOn(ada, workflow.id, {
      doc: documents.leave,
    });
    const receipts = await receiptsOf(runId);
    expect({ end, receipts }).toStrictEqual({
      // The bound collection's hit alone, though another holds "leave" too.
      end: { status: "completed", output: { hits: ["Leave"], found: "Leave" } },
      receipts: ["started", "done", "started", "done"].map((outcome) => [
        "grasp.knowledge",
        "docs",
        outcome,
      ]),
    });
  });

  it("refuse a document outside the collection as one that isn't there, and a sensitive collection's data to a run that isn't restricted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const outside = await readingWorkflow(ada, admin, searchesAndReads);
    const sensitive = await readingWorkflow(ada, admin, searchesAndReads, {
      sensitive: true,
    });
    expect({
      outside: await endOf(ada, outside.workflow.id, {
        doc: outside.documents.elsewhere,
      }),
      // Refused even where nothing is found: an empty answer still says
      // what isn't there.
      sensitive: await endOf(ada, sensitive.workflow.id, { query: "zebra" }),
    }).toStrictEqual({
      outside: { status: "failed", code: "resource.item_not_found" },
      sensitive: { status: "failed", code: "permission.restricted" },
    });
  });

  it("read as the person the run acts for: a team's collection tells someone outside the team nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("user");
    const { workflow, documents } = await readingWorkflow(
      ada,
      admin,
      searchesAndReads,
      { team: true }
    );
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    expect({
      ada: {
        search: await endOf(ada, workflow.id, {}),
        read: await endOf(ada, workflow.id, { doc: documents.leave }),
      },
      bob: {
        search: await endOf(bob, workflow.id, {}),
        read: await endOf(bob, workflow.id, { doc: documents.leave }),
      },
    }).toStrictEqual({
      ada: {
        search: {
          status: "completed",
          output: { hits: ["Leave"], found: "" },
        },
        read: {
          status: "completed",
          output: { hits: ["Leave"], found: "Leave" },
        },
      },
      // The same workflow, grant and approval, started by someone the
      // team leaves out: as if the collection held nothing.
      bob: {
        search: { status: "completed", output: { hits: [], found: "" } },
        read: { status: "failed", code: "resource.item_not_found" },
      },
    });
  });

  it("recall their one collection only while the workflow holds the brain permission", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const allowed = await readingWorkflow(ada, admin, recalls);
    await granted(ada, admin, {
      subject: { type: "workflow", workflowId: allowed.workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const withoutBrain = await readingWorkflow(ada, admin, recalls);
    expect({
      allowed: await endOf(ada, allowed.workflow.id, {}),
      withoutBrain: await endOf(ada, withoutBrain.workflow.id, {}),
    }).toStrictEqual({
      // The bound collection's evidence alone.
      allowed: { status: "completed", output: { cited: ["Leave"] } },
      withoutBrain: { status: "failed", code: "brain.denied" },
    });
  });

  it("write nothing of what the run recalled once it may no longer read it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await readingWorkflow(ada, admin, recallsThenWrites, {
      files: true,
    });
    const brain = await granted(ada, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: ada },
      workflow.id,
      { version: 1, input: { doc: "", query: "leave" }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start admitted no run");
    }
    // Revoked while the run pauses between its recall and its write.
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT count(*) AS n FROM run_brain_evidence WHERE run_id = ?"
        )
          .bind(runId)
          .first<{ n: number }>();
        expect(row?.n ?? 0).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 50 }
    );
    await revokePermission(env, admin, brain);
    const run: WorkflowResourceRun = await vi.waitFor(
      async () => {
        const read = await resourceRunFor(env, ada, workflow.id, runId);
        expect(read.endedAt).not.toBeNull();
        return read;
      },
      { timeout: 30_000, interval: 100 }
    );
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM workflow_run_files WHERE run_id = ?"
    )
      .bind(runId)
      .first<{ n: number }>();
    expect({
      end: { status: run.status, code: run.error?.code },
      files: kept?.n,
    }).toStrictEqual({
      end: { status: "failed", code: "brain.revoked" },
      files: 0,
    });
  });
});
