/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { runObject } from "./runs.ts";
import { unique } from "./sign-in.ts";

// A JSON workflow's recalls pinned to its run, and every way out of it
// gated on them (GRA-299; the threat model is on the issue): once the run
// may no longer read what it recalled (its collection's grant revoked, a
// document erased), a model call carrying it is refused before the gateway
// is asked, and so is the run's output: it fails as `brain.revoked`.

const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, {
    app: async (named: string, role: "user" | "builder") =>
      await appFor(env, by, named, role),
    resource: async (
      ref: Parameters<typeof requireResourceRole>[2],
      needed: Parameters<typeof requireResourceRole>[3]
    ) => {
      await requireResourceRole(env, by, ref, needed);
    },
  });
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
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

/** Action `look`: recalls "leave", answering the evidence's own text. */
const recallsModule = `import { action, resource, v } from "@grasp-os/sdk/action";

export const look = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.knowledge("docs", { operations: ["recall"] })],
  handler: async (ctx) => {
    const pack = await ctx.resources.docs.recall({ query: "leave" });
    return { status: pack.items.map(({ statement }) => statement).join(" ") };
  },
});
`;

/**
 * What a recalling workflow does with what it recalled: ends with it as
 * its output, asks a model about it, or starts a child on it.
 */
type Then = "output" | "model" | "child";

/** A child workflow of `by`'s greeting its input's `who`, at 1.0.0. */
const greeter = async (by: Identity) => {
  const child = await createWorkflowResource(env, by, `child-${unique()}`);
  await publishWorkflowVersion(env, by, child.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: child.name,
        version: "1.0.0",
        title: child.name,
        metadata: {
          grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ greeting: { type: "string" } }) },
      do: [{ greet: { set: { greeting: '${ "Hi, " + .who }' } } }],
    }),
    basedOn: null,
  });
  return child;
};

/**
 * A workflow of `by`'s that recalls through its action, waits, then does
 * `then` with what it recalled: its collection everyone reads, granted to
 * it with the Brain, each binding approved by `admin`.
 */
const recallingWorkflow = async (by: Identity, admin: Identity, then: Then) => {
  const keys = {
    knowledge: `docs-${unique()}`,
    model: `summary-${unique()}`,
  };
  await publishCatalogContract(env, admin, {
    key: keys.knowledge,
    kind: "knowledge",
  });
  await publishCatalogContract(env, admin, { key: keys.model, kind: "model" });
  const collection = await createCollection(env, admin, {
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const fact = `Ask your lead ${unique()} before you take leave.`;
  const leave = await saveDocument(env, admin, {
    collectionId: collection.id,
    path: "leave.md",
    text: `# Leave\n${fact}`,
    ifVersion: 0,
  });
  const workflow = await createWorkflowResource(env, by, `pin-${unique()}`);
  const child = then === "child" ? await greeter(by) : undefined;
  const afterOf: Record<Then, unknown[]> = {
    output: [{ finish: { set: { status: "${ $context.recalled }" } } }],
    model: [
      {
        greet: {
          call: "grasp.model",
          with: {
            binding: "summary",
            instructions: "Summarize it.",
            input: { recalled: "${ $context.recalled }" },
            outputSchema: objectSchema({ line: { type: "string" } }),
          },
          export: { as: "${ {line: .line} }" },
        },
      },
      { finish: { set: { status: "${ $context.line }" } } },
    ],
    child: [
      {
        "greet-child": {
          run: {
            workflow: {
              namespace: workflowNamespace,
              name: child?.name ?? "",
              version: "1.0.0",
              input: { who: "${ $context.recalled }" },
            },
          },
          metadata: { grasp: { binding: "child" } },
        },
      },
      { finish: { set: { status: "${ .greeting }" } } },
    ],
  };
  const extraBindings: Record<Then, Record<string, unknown>> = {
    output: {},
    model: { summary: { kind: "model", contract: keys.model } },
    child: {
      child: {
        kind: "workflow",
        contract: `${workflowNamespace}/${child?.name ?? ""}/1.0.0`,
      },
    },
  };
  if (child !== undefined) {
    await granted(by, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "workflow", workflowId: child.id },
      actions: ["start"],
      binding: "CHILD",
    });
  }
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
              look: { kind: "operation", contract: "local:code/look.ts#look" },
              docs: { kind: "knowledge", contract: keys.knowledge },
              ...extraBindings[then],
            },
          },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        {
          look: {
            call: "grasp.operation",
            with: {
              binding: "look",
              arguments: { who: "${ $workflow.input.who }" },
            },
            export: { as: "${ {recalled: .status} }" },
          },
        },
        { hold: { wait: "PT3S" } },
        ...afterOf[then],
      ],
    }),
    basedOn: null,
    modules: { "code/look.ts": recallsModule },
  });
  const collectionGrant = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "collection", collectionId: collection.id },
    actions: ["read"],
    binding: `DOCS_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "platform" },
    actions: ["brain"],
    binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "docs",
    target: { kind: "knowledge", permissionId: collectionGrant },
    reviewed: { version: 1 },
  });
  if (then === "model") {
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "summary",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
  }
  return { workflow, collectionGrant, documentId: leave.id, fact };
};

/** Run `run` once it sleeps in its hold, after its recall. */
const holding = async (run: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const waiting = await runInDurableObject(
        runObject(run),
        (_object, state) =>
          state.storage.sql
            .exec(
              "SELECT count(*) AS n FROM steps WHERE type = 'sleep' AND state = 'waiting'"
            )
            .one().n
      );
      expect(waiting).toBe(1);
    },
    { timeout: 20_000, interval: 50 }
  );
};

/** Run `runId` of workflow `id` once it has ended. */
const ended = async (
  by: Identity,
  id: string,
  runId: string
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** The outcomes of run `runId`'s model call receipts. */
const modelOutcomesOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" &&
        event.target?.id === runId &&
        event.detail.call === "grasp.model"
    )
    .map(({ detail }) => detail.outcome);
};

/** How many child runs run `parentId` started. */
const childrenOf = async (parentId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_resource_runs WHERE parent_run_id = ?"
  )
    .bind(parentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** Erases `made`'s document from Knowledge, as a purge erases it. */
const erase = async ({
  documentId,
}: Awaited<ReturnType<typeof recallingWorkflow>>) => {
  await env.KNOWLEDGE.prepare("DELETE FROM documents WHERE id = ?")
    .bind(documentId)
    .run();
};

describe("a JSON workflow's recalled evidence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses its model call and its output once what it recalled can't be read, though it may as long as it can", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const gateway = fakeGateway({
      text: '{"line":"Ask first."}',
      inputTokens: 10,
      outputTokens: 5,
    });
    const ai: AiBinding = env.AI;
    vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
    /**
     * A run of a new recalling workflow (`asks` a model or ends with what
     * it recalled), `between` its recall and what follows.
     */
    const ran = async (
      then: Then,
      between?: (
        made: Awaited<ReturnType<typeof recallingWorkflow>>
      ) => Promise<void>
    ) => {
      const made = await recallingWorkflow(ada, admin, then);
      const { runId } = await startWorkflow(
        env,
        { type: "person", person: ada },
        made.workflow.id,
        { version: 1, input: { who: "Ada" }, key: unique() }
      );
      if (runId === null) {
        throw new Error("The start admitted no run");
      }
      await holding(runId);
      await between?.(made);
      const asked = gateway.requests.length;
      const run = await ended(ada, made.workflow.id, runId);
      return {
        status: run.status,
        code: run.status === "failed" ? (run.error?.code ?? null) : null,
        // What it recalled, nowhere in what it ended with if refused.
        carries: JSON.stringify([
          run.output ?? null,
          run.error ?? null,
        ]).includes(made.fact),
        asked: gateway.requests.length - asked,
        model: then === "model" ? await modelOutcomesOf(runId) : [],
        children: await childrenOf(runId),
      };
    };
    const revoke = async ({
      collectionGrant,
    }: Awaited<ReturnType<typeof recallingWorkflow>>) => {
      await revokePermission(env, admin, collectionGrant);
    };

    const kept = await ran("output");
    const keptAsking = await ran("model");
    const keptChild = await ran("child");
    const revokedOutput = await ran("output", revoke);
    const erasedOutput = await ran("output", erase);
    const revokedAsking = await ran("model", revoke);
    const revokedChild = await ran("child", revoke);

    expect({
      kept,
      keptAsking,
      keptChild,
      revokedOutput,
      erasedOutput,
      revokedAsking,
      revokedChild,
    }).toStrictEqual({
      // Still readable: its output is what it recalled, its model is asked
      // once, and its child starts on it.
      kept: {
        status: "completed",
        code: null,
        carries: true,
        asked: 0,
        model: [],
        children: 0,
      },
      keptAsking: {
        status: "completed",
        code: null,
        carries: false,
        asked: 1,
        model: ["started", "done"],
        children: 0,
      },
      keptChild: {
        status: "completed",
        code: null,
        carries: true,
        asked: 0,
        model: [],
        children: 1,
      },
      // Its collection's grant revoked, or its document erased, while it
      // waited: its output never leaves it.
      revokedOutput: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        asked: 0,
        model: [],
        children: 0,
      },
      erasedOutput: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        asked: 0,
        model: [],
        children: 0,
      },
      // Nor does its model call, refused before the gateway is asked, its
      // receipt kept as the refusal; nor its child, never started.
      revokedAsking: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        asked: 0,
        model: ["brain.revoked"],
        children: 0,
      },
      revokedChild: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        asked: 0,
        model: [],
        children: 0,
      },
    });
  });
});
