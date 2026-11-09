import { agentIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

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
import type { StartInvoker } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { refusal, unique } from "./sign-in.ts";

// A workflow's own actions reading Knowledge (resource-reads.ts), from
// GRA-700's threat model: a brain binding is one collection, read as
// the run's person may, with only the operations the action declares;
// each call is decided again and kept as an effect of its own; a sensitive
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

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
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
  uses = '[resource.knowledge("docs", { operations: ["search", "read"] })]'
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

/**
 * Searches, and reads the document the run's input names and the first
 * hit by its ID.
 */
const looksEverywhere =
  lookModule(`const hits = await ctx.resources.docs.search({ text: "leave" });
    const found = await ctx.resources.docs.read({ id: args.doc });
    const first = await ctx.resources.docs.read({ id: hits[0]?.id ?? "" });
    return {
      status: JSON.stringify({
        hits: hits.map(({ title }) => title),
        found: found.title,
        first: first.title,
      }),
    };`);

/**
 * Searches for what follows `search:` in the run's input, answering the
 * titles found, or else reads the document it names.
 */
const searchesOrReads = lookModule(`if (args.doc.startsWith("search:")) {
      const hits = await ctx.resources.docs.search({ text: args.doc.slice(7) });
      return { status: JSON.stringify(hits.map(({ title }) => title)) };
    }
    const found = await ctx.resources.docs.read({ id: args.doc });
    return { status: found.title };`);

/**
 * Recalls "leave" from the collection through the Brain (GRA-1067),
 * answering the headings its evidence cites.
 */
const recalls = lookModule(
  `const pack = await ctx.resources.docs.recall({ query: "leave" });
    return { status: JSON.stringify(pack.items.map(({ citationLocator }) => citationLocator[0] ?? "")) };`,
  '[resource.knowledge("docs", { operations: ["recall"] })]'
);

/** The workflow's `brain` permission, granted by `admin`. */
const brainOf = async (
  by: Identity,
  admin: Identity,
  workflowId: string
): Promise<string> =>
  await granted(by, admin, {
    subject: { type: "workflow", workflowId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
  });

/** A definition calling action `look`, after `before`, its Brain binding `docs`. */
const definitionOf = (
  keys: { knowledge: string },
  before: readonly unknown[] = []
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { $expr: "look" },
    permissions: {
      modules: {
        look: { kind: "action", contract: "local:code/look.ts#look" },
      },
      brain: { docs: { contract: keys.knowledge } },
    },
    steps: [
      ...before,
      {
        id: "look",
        type: "call",
        module: "look",
        args: { doc: { $expr: "args.who" } },
      },
    ],
  });

/** Suspends a run before its action: time to change what it relies on. */
const hold = { id: "hold", type: "wait", for: "1 second" };

/**
 * A workflow of `by`'s whose action reads `docs`, its one collection: the
 * handbook everyone reads, the payroll team's own (`team`), or its
 * sensitive salaries collection (`sensitive`), each granted to the
 * workflow and approved by `admin`. Also a collection it was never
 * granted.
 */
const readingWorkflow = async (
  by: Identity,
  admin: Identity,
  module: string,
  {
    sensitive = false,
    team: teamOnly = false,
    before = [],
  }: { sensitive?: boolean; team?: boolean; before?: unknown[] } = {}
) => {
  const keys = { knowledge: `docs-${unique()}` };
  await publishCatalogContract(env, admin, {
    key: keys.knowledge,
    kind: "knowledge",
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
    definition: definitionOf(keys, before),
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
  return {
    workflow,
    permissionId,
    documents: { leave: leave.id, elsewhere: elsewhere.id },
  };
};

/**
 * Starts version 1 of workflow `id` for `by`, its action reading `doc`:
 * as `by` themselves, or as another invoker of theirs.
 */
const started = async (
  by: Identity,
  id: string,
  doc: string,
  invoker?: StartInvoker
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    invoker ?? { type: "person", person: by },
    id,
    {
      version: 1,
      input: { who: doc },
      key: unique(),
    }
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

describe("a workflow action's knowledge uses", () => {
  it("search and read their one collection as the run's person, each call an effect of its own", async () => {
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
            // What a search found, read by the ID it answered.
            first: "Leave",
          }),
        },
      },
      // A search and two reads.
      receipts: [
        ["grasp.knowledge", "docs"],
        ["grasp.knowledge", "docs"],
        ["grasp.knowledge", "docs"],
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
        '[resource.knowledge("docs", { operations: ["search"] })]'
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

  it("refuse the next read once the workflow's permission is revoked, and a sensitive collection's data to a run that isn't restricted", async () => {
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
      sensitive: sensitiveEnd,
    }).toStrictEqual({
      revoked: { status: "failed", code: "workflow.call_denied" },
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
      searchesOrReads,
      { team: true }
    );
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const endOf = async (by: Identity, doc: string) =>
      await ended(by, workflow.id, await started(by, workflow.id, doc));
    expect({
      ada: {
        search: await endOf(ada, "search:leave"),
        read: await endOf(ada, documents.leave),
      },
      bob: {
        search: await endOf(bob, "search:leave"),
        read: await endOf(bob, documents.leave),
      },
    }).toStrictEqual({
      ada: {
        search: { status: "completed", output: { status: '["Leave"]' } },
        read: { status: "completed", output: { status: "Leave" } },
      },
      // The same workflow, grant and approvals, started by someone the
      // team leaves out: as if the collection held nothing.
      bob: {
        search: { status: "completed", output: { status: "[]" } },
        read: { status: "failed", code: "resource.item_not_found" },
      },
    });
  });

  it("read a sensitive collection in a run restricted from its start, and refuse even a search that finds nothing to one that isn't", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, documents } = await readingWorkflow(
      ada,
      admin,
      searchesOrReads,
      { sensitive: true }
    );
    // An agent's start that names no chat starts restricted, failing
    // closed (workflow-starts.ts, `restrictedStart`).
    const agentId = agentIdSchema.parse(`agent-${unique()}`);
    await granted(ada, admin, {
      subject: { type: "agent", agentId },
      object: { type: "workflow", workflowId: workflow.id },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const agent: StartInvoker = {
      type: "agent",
      authority: {
        subject: { type: "agent", agentId },
        onBehalfOf: ada.userId,
        mode: "interactive",
      },
    };
    const endOf = async (doc: string, invoker?: StartInvoker) =>
      await ended(
        ada,
        workflow.id,
        await started(ada, workflow.id, doc, invoker)
      );
    expect({
      restricted: {
        search: await endOf("search:leave", agent),
        read: await endOf(documents.leave, agent),
      },
      unrestricted: {
        search: await endOf("search:leave"),
        nothingFound: await endOf("search:zebra"),
      },
    }).toStrictEqual({
      restricted: {
        search: { status: "completed", output: { status: '["Leave"]' } },
        read: { status: "completed", output: { status: "Leave" } },
      },
      unrestricted: {
        search: { status: "failed", code: "permission.restricted" },
        // Refused alike: an empty answer would still say what isn't there.
        nothingFound: { status: "failed", code: "permission.restricted" },
      },
    });
  });

  it("refuse approving a collection no run's person may ever read: one only its owner reads, one only admins read, or one deleted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const keys = { knowledge: `docs-${unique()}` };
    await publishCatalogContract(env, admin, {
      key: keys.knowledge,
      kind: "knowledge",
    });
    const workflow = await createWorkflowResource(env, ada, `read-${unique()}`);
    await publishWorkflowVersion(env, ada, workflow.id, {
      definition: definitionOf(keys),
      basedOn: null,
      modules: { "code/look.ts": looksEverywhere },
    });
    const approving = async (collection: { id: string }) => {
      const permissionId = await granted(ada, admin, {
        subject: { type: "workflow", workflowId: workflow.id },
        object: { type: "collection", collectionId: collection.id },
        actions: ["read"],
        binding: `DOCS_${unique().toUpperCase().replaceAll("-", "_")}`,
      });
      return async () => {
        const error = await refusal(
          approveWorkflowBinding(env, admin, workflow.id, {
            alias: "docs",
            target: { kind: "knowledge", permissionId },
            reviewed: { version: 1 },
          })
        );
        return z
          .object({
            code: z.string(),
            details: z.object({ issues: z.array(z.string()) }),
          })
          .parse(error);
      };
    };
    // A request already refuses a personal or admins-only collection
    // (permissions.ts), and no collection's access changes yet: each is
    // granted as one everyone reads, then becomes one no delegate reads,
    // as only the database could make it now.
    const collectionFor = async (name: string) =>
      await createCollection(env, admin, { name, access: "everyone" });
    const mine = await collectionFor("Mine");
    const board = await collectionFor("Board");
    const gone = await collectionFor("Gone");
    const personal = await approving(mine);
    const adminsOnly = await approving(board);
    const deleted = await approving(gone);
    await env.KNOWLEDGE.batch([
      env.KNOWLEDGE.prepare(
        "UPDATE collections SET access = 'me', owner = ? WHERE id = ?"
      ).bind(ada.userId, mine.id),
      env.KNOWLEDGE.prepare(
        "UPDATE collections SET access = 'admins' WHERE id = ?"
      ).bind(board.id),
      env.KNOWLEDGE.prepare("DELETE FROM collections WHERE id = ?").bind(
        gone.id
      ),
    ]);
    const unreadable = {
      code: "workflow.binding_invalid",
      details: {
        issues: [
          "target.permissionId: A workflow can't read a personal or admins-only collection.",
        ],
      },
    };
    expect({
      personal: await personal(),
      adminsOnly: await adminsOnly(),
      deleted: await deleted(),
    }).toStrictEqual({
      personal: unreadable,
      adminsOnly: unreadable,
      deleted: {
        code: "workflow.binding_invalid",
        details: {
          issues: ["target.permissionId: That collection no longer exists."],
        },
      },
    });
  });

  it("publish only where the action's knowledge use is a brain binding of a knowledge contract, never a files one or another kind", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const knowledge = `docs-${unique()}`;
    const files = `files-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: knowledge,
      kind: "knowledge",
    });
    await publishCatalogContract(env, admin, { key: files, kind: "files" });
    /** What publishing `docs` under permission kind `kind` comes to: "ok", or its problems by pointer. */
    const publishing = async (kind: string, contract: string) => {
      const workflow = await createWorkflowResource(
        env,
        ada,
        `read-${unique()}`
      );
      const document = z
        .looseObject({
          permissions: z.looseObject({ brain: z.unknown() }),
        })
        .parse(JSON.parse(definitionOf({ knowledge })));
      const { brain: _brain, ...others } = document.permissions;
      const error = await refusal(
        publishWorkflowVersion(env, ada, workflow.id, {
          definition: JSON.stringify({
            ...document,
            permissions: { ...others, [kind]: { docs: { contract } } },
          }),
          basedOn: null,
          modules: { "code/look.ts": looksEverywhere },
        })
      );
      if (error === "ok") {
        return error;
      }
      const refused = z
        .object({
          code: z.literal("workflow.definition_invalid"),
          details: z.object({
            problems: z.array(
              z.object({ code: z.string(), pointer: z.string() })
            ),
          }),
        })
        .parse(error);
      return refused.details.problems.map(({ code, pointer }) => [
        pointer,
        code,
      ]);
    };
    expect({
      brain: await publishing("brain", knowledge),
      // The run's own files passed off as the collection.
      filesContract: await publishing("brain", files),
      filesBinding: await publishing("files", files),
      connector: await publishing("connections", knowledge),
    }).toStrictEqual({
      brain: "ok",
      filesContract: [
        ["/permissions/brain/docs/contract", "binding.unknown_contract"],
      ],
      filesBinding: [
        ["/permissions/modules/look/contract", "binding.use_undeclared"],
      ],
      connector: [
        ["/permissions/modules/look/contract", "binding.use_undeclared"],
        ["/permissions/connections/docs/contract", "binding.unknown_contract"],
      ],
    });
  });

  it("recall their one collection through the Brain only while the workflow holds the brain permission, and stop once it is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const allowed = await readingWorkflow(ada, admin, recalls);
    await brainOf(ada, admin, allowed.workflow.id);
    const allowedRun = await started(
      ada,
      allowed.workflow.id,
      allowed.documents.leave
    );
    const allowedEnd = await ended(ada, allowed.workflow.id, allowedRun);
    const withoutBrain = await readingWorkflow(ada, admin, recalls);
    const withoutBrainEnd = await ended(
      ada,
      withoutBrain.workflow.id,
      await started(ada, withoutBrain.workflow.id, withoutBrain.documents.leave)
    );
    const revoked = await readingWorkflow(ada, admin, recalls, {
      before: [hold],
    });
    const brainGrant = await brainOf(ada, admin, revoked.workflow.id);
    const revokedRun = await started(
      ada,
      revoked.workflow.id,
      revoked.documents.leave
    );
    await revokePermission(env, admin, brainGrant);
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    // A sensitive collection's evidence never reaches a run that isn't
    // restricted, as its search's doesn't.
    const sensitive = await readingWorkflow(ada, admin, recalls, {
      sensitive: true,
    });
    await brainOf(ada, admin, sensitive.workflow.id);
    const sensitiveEnd = await ended(
      ada,
      sensitive.workflow.id,
      await started(ada, sensitive.workflow.id, sensitive.documents.leave)
    );
    const events = await allEvents();
    expect({
      allowed: allowedEnd,
      recorded: events.some(
        ({ action, detail }) =>
          action === "knowledge.search" &&
          detail.via === "recall" &&
          detail.run === allowedRun
      ),
      withoutBrain: withoutBrainEnd,
      revoked: revokedEnd,
      sensitive: sensitiveEnd,
    }).toStrictEqual({
      // The bound collection's evidence alone, though another holds
      // "leave" too.
      allowed: {
        status: "completed",
        output: { status: JSON.stringify(["Leave"]) },
      },
      recorded: true,
      withoutBrain: { status: "failed", code: "brain.denied" },
      revoked: { status: "failed", code: "brain.denied" },
      // Refused as the Brain refuses: the run may not have it.
      sensitive: { status: "failed", code: "brain.denied" },
    });
  });
});
