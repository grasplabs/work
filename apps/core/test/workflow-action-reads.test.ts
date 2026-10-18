/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { createCollection } from "../src/knowledge/collections.ts";
import { saveDocument } from "../src/knowledge/documents.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { publishTemplate } from "../src/resource-templates.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { refusal, unique } from "./sign-in.ts";

// A workflow's own actions reading Knowledge and published templates
// (resource-reads.ts), from GRA-700's threat model: a knowledge binding is
// one collection, read as the run's person may, with only the operations
// the action declares; a template binding is one pinned version; each call
// is decided again and kept as an effect of its own; a sensitive
// collection's data never reaches a run that isn't restricted.

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

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

/** The module of action `look`, declaring `uses` and running `body`. */
const lookModule = (
  body: string,
  uses = '[resource.knowledge("docs", { operations: ["search", "read"] }), resource.template("letter")]'
): string => `import { action, resource, v } from "@grasp-os/sdk/action";

export const look = action({
  args: { doc: v.string() },
  returns: v.object({ status: v.string() }),
  uses: ${uses},
  handler: async (ctx, args) => {
    ${body}
  },
});
`;

/** Searches, reads the document the run's input names, reads the letter. */
const looksEverywhere =
  lookModule(`const hits = await ctx.resources.docs.search({ text: "leave" });
    const found = await ctx.resources.docs.read({ id: args.doc });
    const letter = await ctx.resources.letter.read();
    return {
      status: JSON.stringify({
        hits: hits.map(({ title }) => title),
        found: found.title,
        greeting: letter.content,
      }),
    };`);

/** A definition of `name` calling action `look`, after `before`. */
const definitionOf = (
  name: string,
  keys: { knowledge: string; template: string },
  before: unknown[] = []
): string =>
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
          params: {},
          bindings: {
            look: { kind: "operation", contract: "local:code/look.ts#look" },
            docs: { kind: "knowledge", contract: keys.knowledge },
            letter: { kind: "template", contract: keys.template },
          },
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      ...before,
      {
        look: {
          call: "grasp.operation",
          with: {
            binding: "look",
            arguments: { doc: "${ $workflow.input.who }" },
          },
        },
      },
    ],
  });

/** Suspends a run before its action: time to change what it relies on. */
const hold = { hold: { wait: "PT1S" } };

/**
 * A workflow of `by`'s whose action reads `docs`, its one collection: the
 * handbook, or the sensitive salaries collection (`sensitive`), each
 * granted to the workflow and approved by `admin`, with `letter` a pinned
 * template version. Also a collection it was never granted.
 */
const readingWorkflow = async (
  by: Identity,
  admin: Identity,
  module: string,
  {
    sensitive = false,
    before = [],
  }: { sensitive?: boolean; before?: unknown[] } = {}
) => {
  const keys = {
    knowledge: `docs-${unique()}`,
    template: `letter-${unique()}`,
  };
  await publishCatalogContract(env, admin, {
    key: keys.knowledge,
    kind: "knowledge",
  });
  await publishCatalogContract(env, admin, {
    key: keys.template,
    kind: "template",
  });
  // A team of the admin and the workflow's builder, whose run reads as
  // them: a sensitive collection is a team's.
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
  const bound = await createCollection(
    env,
    teamAdmin,
    sensitive
      ? { name: "Salaries", access: "teams", teams: [team], sensitive: true }
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
    definition: definitionOf(workflow.name, keys, before),
    basedOn: null,
    modules: { "code/look.ts": module },
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
  const content = { greeting: "Dear" };
  const template = await publishTemplate(env, admin, {
    contract: "grasp.letter@1",
    content,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "letter",
    target: {
      kind: "template",
      templateId: template.templateId,
      version: template.version,
      contentHash: await sha256Hex(canonicalJson(content)),
    },
    reviewed: { version: 1 },
  });
  return {
    workflow,
    permissionId,
    templateId: template.templateId,
    documents: { leave: leave.id, elsewhere: elsewhere.id },
  };
};

/** Starts version 1 of workflow `id` for `by`, its action reading `doc`. */
const started = async (
  by: Identity,
  id: string,
  doc: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: doc }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of workflow `id` ended. */
const ended = async (by: Identity, id: string, runId: string) => {
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 30_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

/** The receipts of run `runId`'s calls: call, binding and outcome. */
const receiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" && event.target?.id === runId
    )
    .map(({ detail }) => ({
      call: detail?.call,
      binding: detail?.binding,
      result: detail?.outcome,
    }));
};

/** What run `runId` kept of calls refused at its action's admission. */
const refusalsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.call.refused" && event.target?.id === runId
    )
    .map(({ detail }) => ({ call: detail?.call, reason: detail?.reason }));
};

describe("a workflow action's knowledge and template uses", () => {
  it("search and read their one collection as the run's person, read the pinned template, each call an effect of its own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, documents } = await readingWorkflow(
      ada,
      admin,
      looksEverywhere
    );
    const runId = await started(ada, workflow.id, documents.leave);
    const end = await ended(ada, workflow.id, runId);
    expect({
      end,
      receipts: await receiptsOf(runId),
    }).toStrictEqual({
      // The bound collection's hit alone, though another holds "leave" too.
      end: {
        status: "completed",
        output: {
          status: JSON.stringify({
            hits: ["Leave"],
            found: "Leave",
            greeting: { greeting: "Dear" },
          }),
        },
      },
      receipts: [
        ["grasp.knowledge", "docs"],
        ["grasp.knowledge", "docs"],
        ["grasp.template", "letter"],
      ].flatMap(([call, binding]) =>
        ["started", "done"].map((result) => ({ call, binding, result }))
      ),
    });
  });

  it("refuse a document outside the collection as one that isn't there, and an operation the use doesn't declare", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const outside = await readingWorkflow(ada, admin, looksEverywhere);
    const outsideEnd = await ended(
      ada,
      outside.workflow.id,
      await started(ada, outside.workflow.id, outside.documents.elsewhere)
    );
    // Declares search alone, and calls read anyway.
    const undeclared = await readingWorkflow(
      ada,
      admin,
      lookModule(
        `const docs = ctx.resources.docs as unknown as Record<string, (request: unknown) => Promise<unknown>>;
    await docs.read?.({ id: args.doc });
    return { status: "read" };`,
        '[resource.knowledge("docs", { operations: ["search"] }), resource.template("letter")]'
      )
    );
    const undeclaredRun = await started(
      ada,
      undeclared.workflow.id,
      undeclared.documents.leave
    );
    const undeclaredEnd = await ended(
      ada,
      undeclared.workflow.id,
      undeclaredRun
    );
    expect({
      outside: outsideEnd,
      undeclared: undeclaredEnd,
      undeclaredReceipts: await receiptsOf(undeclaredRun),
      undeclaredEvidence: await refusalsOf(undeclaredRun),
    }).toStrictEqual({
      outside: { status: "failed", code: "resource.item_not_found" },
      undeclared: { status: "failed", code: "workflow.call_denied" },
      // Nothing was ever called: refused at the action's own admission.
      undeclaredReceipts: [],
      undeclaredEvidence: [{ call: "docs", reason: "operation_undeclared" }],
    });
  });

  it("refuse the next read once the workflow's permission is revoked, a template whose content changed since it was approved, and a sensitive collection's data to a run that isn't restricted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const revoked = await readingWorkflow(ada, admin, looksEverywhere, {
      before: [hold],
    });
    const revokedRun = await started(
      ada,
      revoked.workflow.id,
      revoked.documents.leave
    );
    await revokePermission(env, admin, revoked.permissionId);
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    // Reads the letter alone, once its content changed.
    const tampered = await readingWorkflow(
      ada,
      admin,
      lookModule(`const letter = await ctx.resources.letter.read();
    return { status: JSON.stringify(letter.content) };`),
      { before: [hold] }
    );
    const tamperedRun = await started(
      ada,
      tampered.workflow.id,
      tampered.documents.leave
    );
    // Its content and the hash stored with it changed together, behind
    // the platform's back: only the approval's pin still tells.
    const changed = canonicalJson({ greeting: "Changed" });
    await env.DB.prepare(
      "UPDATE resource_templates SET content = ?, content_hash = ? WHERE id = ?"
    )
      .bind(changed, await sha256Hex(changed), tampered.templateId)
      .run();
    const tamperedEnd = await ended(ada, tampered.workflow.id, tamperedRun);
    const sensitive = await readingWorkflow(ada, admin, looksEverywhere, {
      sensitive: true,
    });
    const sensitiveEnd = await ended(
      ada,
      sensitive.workflow.id,
      await started(ada, sensitive.workflow.id, sensitive.documents.leave)
    );
    expect({
      revoked: revokedEnd,
      tampered: tamperedEnd,
      sensitive: sensitiveEnd,
    }).toStrictEqual({
      revoked: { status: "failed", code: "workflow.call_denied" },
      // Content no longer the pinned hash's serves nothing.
      tampered: { status: "failed", code: "resource.unavailable" },
      sensitive: { status: "failed", code: "permission.restricted" },
    });
  });

  it("refuse a definition whose action uses a knowledge or template binding as another kind", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const keys = {
      knowledge: `docs-${unique()}`,
      template: `letter-${unique()}`,
    };
    await publishCatalogContract(env, admin, {
      key: keys.knowledge,
      kind: "knowledge",
    });
    await publishCatalogContract(env, admin, {
      key: keys.template,
      kind: "template",
    });
    for (const uses of [
      // Uses the template binding as knowledge.
      '[resource.knowledge("letter", { operations: ["search"] })]',
      // Uses the knowledge binding as a template.
      '[resource.template("docs")]',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const workflow = await createWorkflowResource(
        env,
        ada,
        `read-${unique()}`
      );
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const error = await refusal(
        publishWorkflowVersion(env, ada, workflow.id, {
          definition: definitionOf(workflow.name, keys),
          basedOn: null,
          modules: {
            "code/look.ts": lookModule('return { status: "x" };', uses),
          },
        })
      );
      const parsed = z
        .object({ code: z.string(), details: z.unknown() })
        .parse(error);
      expect([parsed.code, JSON.stringify(parsed.details)]).toStrictEqual([
        "workflow.definition_invalid",
        expect.stringContaining("binding.unknown_use"),
      ]);
    }
  });
});
