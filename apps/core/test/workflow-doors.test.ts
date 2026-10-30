/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { DiagramTask } from "@grasp-os/shared/workflow-diagrams";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createTriggerResource } from "../src/trigger-resources.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { unique } from "./sign-in.ts";

// A workflow drawn in named parts, with doors to the workflows it leads
// to (workflow-doors.ts), from its threat model: a door names another
// workflow only for a reader with a role in it, and shows only how the
// flow goes on to anyone else; a definition with no parts is drawn in
// none.

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of workflow `name`: `{ who }` in, `{ status }` out, doing `tasks`. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  bindings: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** A published workflow of `owner`'s that only says it is done. */
const finishing = async (owner: Identity, prefix: string) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `${prefix}-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
    definition: definitionOf(workflow.name, [
      { finish: { set: { status: "done" } } },
    ]),
    basedOn: null,
  });
  return workflow;
};

const created = "invoice.checked";

/** An event contract of `admin`'s with the checked-invoice type: its key. */
const invoiceEvents = async (admin: Identity): Promise<string> => {
  const contract = `invoice-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [created]: {
        data: JSON.stringify(v.object({ who: v.string() }).descriptor),
        browser: false,
      },
    },
  });
  return contract;
};

/** Each task of `tasks` and the tasks under it, in order. */
const allTasks = (tasks: readonly DiagramTask[]): DiagramTask[] =>
  tasks.flatMap((task) => [
    task,
    ...task.scopes.flatMap((scope) => allTasks(scope.tasks)),
  ]);

describe("a workflow's parts and doors", () => {
  it("draws a drafted workflow in the parts it names, and none where it names none", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      ada,
      `parts-${unique()}`
    );
    const check = {
      name: "Check the invoice",
      purpose: "Make sure it is complete before anyone pays it.",
      summary: "Grasp reads the invoice and says what is missing.",
    };
    const draft = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: definitionOf(workflow.name, [
        {
          read: {
            set: { status: "read" },
            metadata: { grasp: { section: check } },
          },
        },
        { complete: { set: { status: "complete" } } },
        {
          pay: {
            set: { status: "paid" },
            metadata: { grasp: { section: { name: "Pay it" } } },
          },
        },
      ]),
      modules: {},
    });
    expect(draft.problems).toStrictEqual([]);
    const tasks = draft.checkpoint?.diagram.tasks ?? [];
    expect(tasks.map((task) => [task.id, task.section ?? null])).toStrictEqual([
      ["read", check],
      ["complete", null],
      ["pay", { name: "Pay it", purpose: null, summary: null }],
    ]);
    // Read again, it is the same.
    const again = await workflowDraft(env, ada, workflow.id);
    expect(again.checkpoint?.diagram).toStrictEqual(draft.checkpoint?.diagram);

    const plain = await finishing(ada, "plain");
    const unparted = await workflowDraft(env, ada, plain.id);
    expect(
      unparted.checkpoint?.diagram.tasks.some(
        (task) => task.section !== undefined
      )
    ).toBeFalsy();
  });

  it("names the workflow behind a door only to someone with a role in it, and shows anyone else only how the flow goes on", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    // Ada's child workflow, which Bob has no role in.
    const child = await finishing(ada, "child");
    // A workflow an event starts: Ada's, on a system trigger.
    const contract = await invoiceEvents(admin);
    const started = await finishing(ada, "started");
    await createTriggerResource(env, ada, {
      kind: "system",
      workflowId: started.id,
      version: 1,
      config: { event: { contract, type: created } },
    });
    // Ada's parent runs her child, then hands the item over through the
    // event as its last task. Bob builds the parent alone.
    const parent = await createWorkflowResource(env, ada, `parent-${unique()}`);
    await shareWorkflowResource(env, ada, parent.id, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const source = definitionOf(
      parent.name,
      [
        {
          child: {
            run: {
              workflow: {
                namespace: workflowNamespace,
                name: child.name,
                version: "1.0.0",
                input: { who: "${ $workflow.input.who }" },
              },
            },
            metadata: { grasp: { binding: "greeting" } },
          },
        },
        {
          announce: {
            emit: {
              event: {
                with: {
                  type: created,
                  data: { who: "${ $workflow.input.who }" },
                },
              },
            },
            metadata: { grasp: { binding: "invoices" } },
          },
        },
      ],
      {
        greeting: {
          kind: "workflow",
          contract: `${workflowNamespace}/${child.name}/1.0.0`,
        },
        invoices: { kind: "event", contract },
      }
    );
    const saved = await editWorkflowDraft(env, ada, parent.id, {
      expectedRevision: 0,
      source,
      modules: {},
    });
    expect(saved.problems).toStrictEqual([]);

    const doorsFor = async (reader: Identity) => {
      const draft = await workflowDraft(env, reader, parent.id);
      return Object.fromEntries(
        allTasks(draft.checkpoint?.diagram.tasks ?? []).map((task) => [
          task.id,
          task.doors ?? [],
        ])
      );
    };
    // Bob, who has no role in either, sees how the flow goes on, and no
    // workflow behind either door.
    await expect(doorsFor(bob)).resolves.toStrictEqual({
      child: [{ flow: "waits", workflowId: null, name: null }],
      announce: [{ flow: "hands", workflowId: null, name: null }],
    });
    // Ada, who owns both, sees which workflows they are.
    await expect(doorsFor(ada)).resolves.toStrictEqual({
      child: [{ flow: "waits", workflowId: child.id, name: child.name }],
      announce: [{ flow: "hands", workflowId: started.id, name: started.name }],
    });

    // An edit that doesn't pass leaves the checkpoint Ada holds, doors and
    // all: its answer draws that diagram again without them, and a read
    // of the draft still has them.
    const failed = await editWorkflowDraft(env, ada, parent.id, {
      expectedRevision: saved.revision,
      source: "{",
      modules: {},
    });
    const read = await workflowDraft(env, ada, parent.id);
    const doorsOf = (tasks: readonly DiagramTask[]) =>
      allTasks(tasks).flatMap((task) => task.doors ?? []).length;
    expect({
      checkpoint: failed.checkpoint?.revision,
      answered: doorsOf(failed.checkpoint?.diagram.tasks ?? []),
      read: doorsOf(read.checkpoint?.diagram.tasks ?? []),
    }).toStrictEqual({
      checkpoint: saved.revision,
      answered: 0,
      read: 2,
    });
  });
});
