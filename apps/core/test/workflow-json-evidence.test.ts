/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { v } from "@grasp-os/sdk";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
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
import { mockIdp } from "./idp.ts";
import { runObject } from "./runs.ts";
import { signedInApi, unique } from "./sign-in.ts";

// A JSON workflow's recalls pinned to its run, and every way out of it
// gated on them (GRA-299; the threat model is on the issue): once the run
// may no longer read what it recalled (its collection's grant revoked, a
// document erased), a model call carrying it is refused before the gateway
// is asked, and so is the run's output: it fails as `brain.revoked`.

const allowedModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A member of the organization with `role`, as their session has them. */
const idp = mockIdp();

/** An admin signed in, with their API: who purges. */
type Admin = Awaited<ReturnType<typeof signedInApi>>;

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

/** How action `look` reads the bound collection. */
type How = "recall" | "search" | "read";

/**
 * Action `look`: recalls "leave", searches for it, or reads the document
 * its input names, answering the text it was handed.
 */
const lookModule = (how: How): string => {
  const bodies: Record<How, string> = {
    recall: `const pack = await ctx.resources.docs.recall({ query: "leave" });
    return { status: pack.items.map(({ statement }) => statement).join(" ") };`,
    search: `const hits = await ctx.resources.docs.search({ text: "leave" });
    return { status: hits.map(({ excerpt }) => excerpt).join(" ") };`,
    read: `const found = await ctx.resources.docs.read({ id: args.who });
    return { status: found.text };`,
  };
  return `import { action, resource, v } from "@grasp-os/sdk/action";

export const look = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [resource.knowledge("docs", { operations: ["${how}"] })],
  handler: async (ctx, args) => {
    ${bodies[how]}
  },
});
`;
};

/** The event type a recalling workflow emits. */
const recalledType = "grasp.leave.recalled";

/**
 * What a recalling workflow does with what it recalled: ends with it as
 * its output, asks a model about it, starts a child on it, asks its
 * builder to decide on it, or emits it as an event's data.
 */
type Then = "output" | "model" | "child" | "decision" | "emit";

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
 * `then` with what it recalled (a decision asks `admin`): its collection everyone reads, granted to
 * it with the Brain, each binding approved by `admin`.
 */
const recallingWorkflow = async (
  by: Identity,
  admin: Identity,
  then: Then,
  how: How = "recall"
) => {
  const keys = {
    knowledge: `docs-${unique()}`,
    model: `summary-${unique()}`,
    decision: `review-${unique()}`,
    event: `recalled-${unique()}`,
  };
  await publishCatalogContract(env, admin, {
    key: keys.knowledge,
    kind: "knowledge",
  });
  await publishCatalogContract(env, admin, { key: keys.model, kind: "model" });
  await publishCatalogContract(env, admin, {
    key: keys.decision,
    kind: "decision",
    input: JSON.stringify(v.object({ recalled: v.string() }).descriptor),
    response: JSON.stringify(v.null().descriptor),
  });
  await publishCatalogContract(env, admin, {
    key: keys.event,
    kind: "event",
    events: {
      [recalledType]: {
        data: JSON.stringify(v.object({ recalled: v.string() }).descriptor),
        browser: false,
      },
    },
  });
  const collection = await createCollection(env, admin, {
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  const lead = `lead${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;
  const fact = `Ask your ${lead} before you take leave.`;
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
    decision: [
      {
        review: {
          call: "grasp.decision",
          with: {
            binding: "review",
            recipients: [admin.userId],
            prompt: "Is this right?",
            input: { recalled: "${ $context.recalled }" },
          },
        },
      },
      { finish: { set: { status: "decided" } } },
    ],
    emit: [
      {
        "tell-recalled": {
          emit: {
            event: {
              with: {
                type: recalledType,
                data: { recalled: "${ $context.recalled }" },
              },
            },
          },
          metadata: { grasp: { binding: "recalledEvents" } },
        },
      },
      { finish: { set: { status: "${ $context.recalled }" } } },
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
    decision: { review: { kind: "decision", contract: keys.decision } },
    emit: { recalledEvents: { kind: "event", contract: keys.event } },
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
    modules: { "code/look.ts": lookModule(how) },
  });
  const collectionGrant = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "collection", collectionId: collection.id },
    actions: ["read"],
    binding: `DOCS_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  // Only a recall needs the Brain: a search or a read, the collection.
  if (how === "recall") {
    await granted(by, admin, {
      subject: { type: "workflow", workflowId: workflow.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: `BRAIN_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
  }
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
  if (then === "decision") {
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "review",
      target: { kind: "decision", deciders: [`person:${admin.userId}`] },
      reviewed: { version: 1 },
    });
  }
  if (then === "emit") {
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "recalledEvents",
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
  }
  // A read reads the document its input names.
  const who = how === "read" ? leave.id : "Ada";
  return { workflow, collectionGrant, documentId: leave.id, fact, lead, who };
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

type Made = Awaited<ReturnType<typeof recallingWorkflow>>;

/** Starts `made` for `by`: its run's ID, once it holds after its read. */
const startedHolding = async (by: Identity, made: Made): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    made.workflow.id,
    { version: 1, input: { who: made.who }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await holding(runId);
  return runId;
};

/** What a run ended with, and whether that carries what it was handed. */
const endOf = (made: Made, run: WorkflowResourceRun) => ({
  status: run.status,
  code: run.status === "failed" ? (run.error?.code ?? null) : null,
  carries: JSON.stringify([run.output ?? null, run.error ?? null]).includes(
    made.fact
  ),
});

/** How many decisions run `runId` opened. */
const decisionsOf = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_decisions WHERE resource_run_id = ?"
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** How many events run `runId` emitted. */
const emittedOf = async (runId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_emitted_events WHERE run_id = ?"
  )
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
const erase = async ({ documentId }: Made) => {
  await env.KNOWLEDGE.prepare("DELETE FROM documents WHERE id = ?")
    .bind(documentId)
    .run();
};

/** Purges `made`'s lead from its document, as `admin`: the document stays. */
const purgeLead = async (admin: Admin, { documentId, lead }: Made) => {
  const input: PurgeInput = {
    type: "content",
    documentIds: [documentId],
    terms: [lead],
    reason: "erasure_request",
  };
  const plan = await admin.api.knowledge.preparePurge(input);
  await admin.api.knowledge.purge(input, plan.token);
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
    const ran = async (then: Then, between?: (made: Made) => Promise<void>) => {
      const made = await recallingWorkflow(ada, admin, then);
      const runId = await startedHolding(ada, made);
      await between?.(made);
      const asked = gateway.requests.length;
      const run = await ended(ada, made.workflow.id, runId);
      return {
        ...endOf(made, run),
        asked: gateway.requests.length - asked,
        model: then === "model" ? await modelOutcomesOf(runId) : [],
        children: await childrenOf(runId),
      };
    };
    const revoke = async ({ collectionGrant }: Made) => {
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

  it("opens no decision and emits no event once what it recalled can't be read, though it does as long as it can", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const revoke = async ({ collectionGrant }: Made) => {
      await revokePermission(env, admin, collectionGrant);
    };
    // Kept readable: the decision opens (the run then waits on it), and
    // the event is emitted.
    const keptDeciding = await recallingWorkflow(ada, admin, "decision");
    const keptDecidingRun = await startedHolding(ada, keptDeciding);
    await vi.waitFor(
      async () => {
        await expect(decisionsOf(keptDecidingRun)).resolves.toBe(1);
      },
      { timeout: 30_000, interval: 100 }
    );
    const keptEmitting = await recallingWorkflow(ada, admin, "emit");
    const keptEmittingRun = await startedHolding(ada, keptEmitting);
    const keptEmittingEnd = await ended(
      ada,
      keptEmitting.workflow.id,
      keptEmittingRun
    );
    /** A run that `then`s once its collection's grant was revoked. */
    const revokedRun = async (then: "decision" | "emit") => {
      const made = await recallingWorkflow(ada, admin, then);
      const runId = await startedHolding(ada, made);
      await revoke(made);
      return {
        ...endOf(made, await ended(ada, made.workflow.id, runId)),
        decisions: await decisionsOf(runId),
        emitted: await emittedOf(runId),
      };
    };

    expect({
      keptEmitting: {
        ...endOf(keptEmitting, keptEmittingEnd),
        emitted: await emittedOf(keptEmittingRun),
      },
      revokedDeciding: await revokedRun("decision"),
      revokedEmitting: await revokedRun("emit"),
    }).toStrictEqual({
      keptEmitting: {
        status: "completed",
        code: null,
        carries: true,
        emitted: 1,
      },
      // Refused before anything of it is kept or sent.
      revokedDeciding: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        decisions: 0,
        emitted: 0,
      },
      revokedEmitting: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
        decisions: 0,
        emitted: 0,
      },
    });
  });

  it("pins what a search or a read hands over as a recall's evidence, without the Brain: refused once its document is gone or purged", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const purger = await signedInApi(idp, "admin");
    /** A run that reads `how`, and what befalls its document while it waits. */
    const ranReading = async (
      how: "search" | "read",
      meanwhile?: "erased" | "purged"
    ) => {
      const made = await recallingWorkflow(ada, admin, "output", how);
      const runId = await startedHolding(ada, made);
      if (meanwhile === "erased") {
        await erase(made);
      }
      if (meanwhile === "purged") {
        await purgeLead(purger, made);
      }
      return endOf(made, await ended(ada, made.workflow.id, runId));
    };

    expect({
      searched: await ranReading("search"),
      read: await ranReading("read"),
      searchedErased: await ranReading("search", "erased"),
      readErased: await ranReading("read", "erased"),
      searchedPurged: await ranReading("search", "purged"),
      readPurged: await ranReading("read", "purged"),
    }).toStrictEqual({
      // Without the Brain permission: a search or a read needs only the
      // collection, and its output is what it was handed.
      searched: { status: "completed", code: null, carries: true },
      read: { status: "completed", code: null, carries: true },
      // Its document erased while it waited, its collection still read.
      searchedErased: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
      },
      readErased: { status: "failed", code: "brain.revoked", carries: false },
      // Its lead purged from it while it waited: the document stays, in
      // its collection, at a new version.
      searchedPurged: {
        status: "failed",
        code: "brain.revoked",
        carries: false,
      },
      readPurged: { status: "failed", code: "brain.revoked", carries: false },
    });
  });
});
