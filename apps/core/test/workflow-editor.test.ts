import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { DiagramScope } from "@grasp-os/shared/workflow-diagrams";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { draftOf } from "../src/drafts.ts";
import { publish } from "../src/publish.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  editWorkflowDraft,
  editWorkflowStep,
  workflowDraft,
} from "../src/workflow-editor.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import {
  workflowKind,
  createWorkflowResource,
  deleteWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { person as identityOf } from "./sealed-run-harness.ts";
import { outcome, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A workflow's draft as its editor writes it (workflow-editor.ts, on
// drafts.ts), from its threat model: two edits at once never both land,
// text that doesn't pass is kept but never drawn or published, only
// builders read it, and it goes with its workflow. Each test makes its own
// people and workflows.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Identity> => {
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
    staff,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A definition that passes, ending in `status`, with `steps` (none by default). */
const definitionOf = ({
  status = "done",
  steps = [],
}: { status?: string; steps?: unknown[] } = {}): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    steps,
  });

/** A step that waits a moment, `id`. */
const waitStep = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "wait",
  for: "1 second",
  ...more,
});

/** How many checkpoints of workflow `id`'s draft are stored. */
const storedCheckpoints = async (id: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM draft_checkpoints WHERE subject_kind = 'workflow' AND subject_id = ?"
  )
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** Publishes workflow `id`'s draft at `revision`, as its builder `by` does. */
const publishAt = async (by: Identity, id: string, revision: number) =>
  await publish(env, workflowKind, by, id, revision);

const workflowOf = async (by: Identity) =>
  await createWorkflowResource(env, by, `draft-${unique()}`);

/** Scopes as the drawing reads them, with the scopes their tasks hold. */
const drawn = (
  scopes: readonly DiagramScope[] | undefined
): unknown[] | undefined =>
  scopes?.map(({ kind, name, guarded, tasks }) => ({
    kind,
    name,
    guarded,
    tasks: tasks.map(({ id, scopes: inner }) => ({
      id,
      scopes: drawn(inner),
    })),
  }));

describe("a workflow's draft", () => {
  it("starts from a definition that passes, and publishes as the next version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const started = await workflowDraft(env, ada, workflow.id);
    expect(started).toMatchObject({ revision: 0, problems: [] });

    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: started.source,
    });
    expect(saved).toMatchObject({ revision: 1, problems: [] });
    const first = await publishAt(ada, workflow.id, 1);
    expect(first).toMatchObject({ version: 1 });
    // Once published, the draft is over that version: a later edit builds
    // on it, and publishes only at the revision it was read at.
    const after = await workflowDraft(env, ada, workflow.id);
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: after.revision,
      source: definitionOf({ status: "later" }),
    });
    await expect(
      outcome(publishAt(ada, workflow.id, after.revision))
    ).resolves.toBe("draft.conflict");
    await publishAt(ada, workflow.id, after.revision + 1);
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      2
    );
  });

  it("is the live version's definition once published, changing nothing over it", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf();
    await publishDefinition(env, ada, workflow.id, definition);
    const draft = await draftOf(env, workflowKind, workflow.id);
    await expect(workflowDraft(env, ada, workflow.id)).resolves.toMatchObject({
      revision: draft.revision,
      source: definition,
      problems: [],
    });
    expect(draft.changes).toStrictEqual({});
  });

  it("keeps the first of two edits of the same revision, and refuses the second", async () => {
    const ada = await person("builder");
    const bo = await person("builder");
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bo.userId,
      role: "builder",
    });
    const first = definitionOf({ status: "ada" });
    const second = definitionOf({ status: "bo" });
    const outcomes = await Promise.all([
      outcome(
        editWorkflowDraft(env, ada, workflow.id, {
          revision: 0,
          source: first,
        })
      ),
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          revision: 0,
          source: second,
        })
      ),
    ]);
    expect(outcomes.toSorted()).toStrictEqual(["draft.conflict", "ok"]);
    const kept = await workflowDraft(env, ada, workflow.id);
    expect({
      revision: kept.revision,
      source: outcomes[0] === "ok" ? first : second,
    }).toStrictEqual({ revision: 1, source: kept.source });
    // An edit of the revision it read lands; one of an older one doesn't.
    await expect(
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          revision: 0,
          source: second,
        })
      )
    ).resolves.toBe("draft.conflict");
    await expect(
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          revision: 1,
          source: second,
        })
      )
    ).resolves.toBe("ok");
    // A stale edit is refused, however far the draft moved since.
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 2,
      source: "{",
    });
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 3,
      source: "{ still",
    });
    const stale = await outcome(
      editWorkflowDraft(env, bo, workflow.id, {
        revision: 2,
        source: second,
      })
    );
    const latest = await workflowDraft(env, ada, workflow.id);
    expect({
      stale,
      revision: latest.revision,
      source: latest.source,
    }).toStrictEqual({
      stale: "draft.conflict",
      revision: 4,
      source: "{ still",
    });
  });

  it("draws a loop's steps as its scope for each item, as far as it nests", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: definitionOf({
        steps: [
          {
            id: "each",
            type: "forEach",
            items: { $expr: "[1, 2]" },
            while: { $expr: "item < 2" },
            do: [
              waitStep("pause"),
              {
                id: "inner",
                type: "forEach",
                items: { $expr: "[3]" },
                do: [waitStep("deep")],
              },
            ],
          },
        ],
      }),
    });
    expect({
      problems: saved.problems,
      scopes: drawn(saved.diagram?.tasks[0]?.scopes),
    }).toStrictEqual({
      problems: [],
      scopes: [
        {
          kind: "each",
          name: "item",
          // Its `while` decides, as it runs, whether the next item does.
          guarded: true,
          tasks: [
            { id: "pause", scopes: [] },
            {
              id: "inner",
              scopes: [
                {
                  kind: "each",
                  name: "item",
                  guarded: false,
                  tasks: [{ id: "deep", scopes: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("keeps text that doesn't pass with its problems, never drawn or published", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const good = definitionOf({ steps: [waitStep("finish")] });
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: good,
    });
    const secret = `secret-${unique()}`;
    const invalid = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 1,
      source: definitionOf({
        steps: [waitStep("finish", { unknown: secret })],
      }),
    });
    const incomplete = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 2,
      source: good.slice(0, 40),
    });
    expect({
      invalid: invalid.problems.map(
        ({ code, pointer }) => `${code} ${pointer}`
      ),
      invalidDiagram: invalid.diagram,
      incomplete: incomplete.problems.map(({ code }) => code),
      incompleteDiagram: incomplete.diagram,
      leaked: JSON.stringify(invalid.problems).includes(secret),
    }).toStrictEqual({
      invalid: ["workflow.unknown_property /steps/0/unknown"],
      invalidDiagram: null,
      incomplete: ["schema.invalid"],
      incompleteDiagram: null,
      leaked: false,
    });
    // Only the draft as it is publishes, and only once it passes: an
    // earlier revision conflicts, as an edit of it would.
    await expect(outcome(publishAt(ada, workflow.id, 3))).resolves.toBe(
      "workflow.definition_invalid"
    );
    await expect(outcome(publishAt(ada, workflow.id, 1))).resolves.toBe(
      "draft.conflict"
    );
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      0
    );
  });

  it("keeps an expression that reads what the schemas don't declare, or compares a number with a string, with its problem at its pointer, and never publishes it, `state` and `output` read as typed", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const model = `summary-${unique()}`;
    await publishCatalogContract(env, await identityOf("admin"), {
      key: model,
      kind: "model",
    });
    const typed = (status: string, refuse: string) =>
      JSON.stringify({
        $schema: workflowSchemaUrl,
        args: objectSchema({
          who: { kind: "string" },
          count: { kind: "number" },
        }),
        returns: objectSchema({ status: { kind: "string" } }),
        result: { status: { $expr: status } },
        permissions: { ai: { contract: model } },
        // What it keeps between runs, read as `state`, typed by its schema.
        state: { count: { kind: "number" }, line: { kind: "string" } },
        steps: [
          {
            id: "greet",
            type: "generate",
            instructions: "Greet them.",
            input: { who: { $expr: "args.who" } },
            returns: objectSchema({ line: { kind: "string" } }),
            // `output` in its state: the answer, as it keeps it.
            state: {
              count: { $expr: "(state.count ?? 0) + 1" },
              line: { $expr: "output.line" },
            },
          },
          {
            id: "refuse",
            type: "raise",
            if: { $expr: refuse },
            error: { code: "test.too_many", message: "Failed." },
          },
        ],
      });
    const good = typed(
      '"Hello, " + args.who + (state.line ?? "")',
      "args.count > (state.count ?? 3)"
    );
    const passed = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: good,
    });
    // A state key reads its schema's type: a number is no string.
    const mistyped = typed("args.missing.x", 'state.count === "many"');
    const kept = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 1,
      source: mistyped,
    });
    const published = await outcome(
      publishDefinition(env, ada, workflow.id, mistyped)
    );
    expect({
      passed: passed.problems,
      problems: kept.problems.map(({ code, pointer, message }) => ({
        code,
        pointer,
        at: /\(TS\d+, line \d+, column \d+\)$/u.exec(message)?.[0],
      })),
      diagram: kept.diagram,
      // Not a value of the definition: the literal it compared with.
      leaked: JSON.stringify(kept.problems).includes("many"),
      published,
    }).toStrictEqual({
      passed: [],
      problems: [
        {
          code: "expression.type",
          pointer: "/steps/1/if/$expr",
          at: "(TS2367, line 1, column 1)",
        },
        {
          code: "expression.type",
          pointer: "/result/status/$expr",
          at: "(TS2339, line 1, column 6)",
        },
      ],
      diagram: null,
      leaked: false,
      published: "workflow.definition_invalid",
    });
  });

  it("finds a contract too large for a version, so a draft that passes publishes", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // Names as long as a schema allows, until the contract outgrows a
    // version's row while the definition stays within its own bound.
    const properties = Object.fromEntries(
      Array.from({ length: 3000 }, (_, index) => [
        `p${String(index).padStart(4, "0")}${"n".repeat(59)}`,
        { kind: "string" },
      ])
    );
    const source = JSON.stringify({
      ...JSON.parse(definitionOf()),
      args: { kind: "object", fields: properties },
    });
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source,
    });
    expect({
      problems: saved.problems.map(({ code, pointer }) => `${code} ${pointer}`),
      diagram: saved.diagram,
    }).toStrictEqual({
      problems: ["contract.too_large /args"],
      diagram: null,
    });
  });

  it("refuses a draft past 1 MiB of UTF-8, however few characters it has", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // Under a million characters, each three bytes in UTF-8.
    await expect(
      outcome(
        editWorkflowDraft(env, ada, workflow.id, {
          revision: 0,
          source: "界".repeat(700_000),
        })
      )
    ).resolves.toBe("workflow.resource_invalid");
  });

  it("keeps text whose problems would outgrow its row, with a short problem in their place", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // A parameter whose name every character of which a JSON Pointer
    // escapes as two: its problem alone is larger than the text.
    const source = JSON.stringify({
      ...JSON.parse(definitionOf()),
      params: {
        ["/".repeat(750_000)]: { label: "Name", type: { kind: "string" } },
      },
    });
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source,
    });
    const read = await workflowDraft(env, ada, workflow.id);
    expect({
      revision: read.revision,
      kept: read.source === source,
      problems: read.problems.map(({ code, pointer }) => `${code} ${pointer}`),
      answered: saved.problems,
    }).toStrictEqual({
      revision: 1,
      kept: true,
      problems: ["definition.problems_too_large /"],
      answered: read.problems,
    });
  });

  it("is read and edited only by the workflow's builders", async () => {
    const ada = await person("builder");
    const user = await person("builder");
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const edit = {
      revision: 0,
      source: definitionOf(),
    };
    expect({
      read: await outcome(workflowDraft(env, user, workflow.id)),
      edit: await outcome(editWorkflowDraft(env, user, workflow.id, edit)),
      publish: await outcome(publishAt(user, workflow.id, 0)),
    }).toStrictEqual({
      read: "role.forbidden",
      edit: "role.forbidden",
      publish: "role.forbidden",
    });
  });

  it("keeps each edit as a checkpoint, audits each, and goes with its workflow", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    for (const [revision, source] of [
      definitionOf(),
      definitionOf({ status: "again" }),
      "{",
      "{ not yet",
    ].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one edit after the other
      await editWorkflowDraft(env, ada, workflow.id, { revision, source });
    }
    const kept = await storedCheckpoints(workflow.id);
    const events = await allEvents();
    const audited = events.filter(
      (event) =>
        event.action === "draft.saved" && event.target?.id === workflow.id
    );
    expect({ kept, audited: audited.length }).toStrictEqual({
      kept: 4,
      audited: 4,
    });
    await deleteWorkflowResource(env, ada, workflow.id);
    await expect(storedCheckpoints(workflow.id)).resolves.toBe(0);
  });
});

// One step edited on the canvas or by the agent (workflow-steps.ts,
// `editWorkflowStep`): saved as the draft's next revision and checked like
// any edit, from the draft before any edit too; only a step, or a list of
// steps, as the diagram names them, never anything else of the definition
// or a prototype, and never a step's ID; a revision someone replaced
// refused.
describe("a step edited on the canvas", () => {
  it("inserts and changes a step as the draft's next revision, nested ones too, keeping its ID, and audits which", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await publishDefinition(
      env,
      ada,
      workflow.id,
      definitionOf({
        steps: [
          {
            id: "group",
            type: "if",
            condition: { $expr: "args.who === 'ada'" },
            // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
            then: [waitStep("inner")],
          },
          waitStep("finish"),
        ],
      })
    );
    // Published through the draft, which is at this revision since.
    const { revision: start } = await workflowDraft(env, ada, workflow.id);
    const inserted = await editWorkflowStep(env, ada, workflow.id, {
      revision: start,
      edit: {
        kind: "insert",
        list: "/steps",
        index: 0,
        id: "greet",
        step: { type: "wait", for: "2 seconds" },
      },
    });
    const otherwise = await editWorkflowStep(env, ada, workflow.id, {
      revision: start + 1,
      edit: {
        kind: "insert",
        list: "/steps/1/else",
        index: 0,
        id: "elsewhere",
        step: { type: "wait", for: "3 seconds" },
      },
    });
    const changed = await editWorkflowStep(env, ada, workflow.id, {
      revision: start + 2,
      edit: {
        kind: "change",
        pointer: "/steps/1/then/0",
        // A rename is a title: the ID it names is ignored.
        step: { id: "renamed", type: "wait", for: "4 seconds", title: "Pause" },
      },
    });
    const source: unknown = JSON.parse(changed.source);
    const events = await allEvents();
    const audited = events
      .filter(
        ({ action, target, detail }) =>
          action === "draft.saved" &&
          target?.id === workflow.id &&
          "step" in detail
      )
      .map(({ detail }) => detail);

    expect({
      inserted: {
        revision: inserted.revision,
        problems: inserted.problems,
        steps: inserted.diagram?.tasks.map(({ id }) => id),
      },
      otherwise: otherwise.diagram?.tasks[1]?.scopes.map(
        ({ kind, tasks }) => `${kind} ${tasks.map(({ id }) => id).join(",")}`
      ),
      changed: {
        revision: changed.revision,
        problems: changed.problems,
        drawn: changed.diagram !== null,
      },
      steps:
        typeof source === "object" && source !== null && "steps" in source
          ? source.steps
          : undefined,
      audited,
    }).toStrictEqual({
      inserted: {
        revision: start + 1,
        problems: [],
        steps: ["greet", "group", "finish"],
      },
      otherwise: ["then inner", "else elsewhere"],
      changed: { revision: start + 3, problems: [], drawn: true },
      steps: [
        { id: "greet", type: "wait", for: "2 seconds" },
        {
          id: "group",
          type: "if",
          condition: { $expr: "args.who === 'ada'" },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [
            { id: "inner", type: "wait", for: "4 seconds", title: "Pause" },
          ],
          else: [{ id: "elsewhere", type: "wait", for: "3 seconds" }],
        },
        { id: "finish", type: "wait", for: "1 second" },
      ],
      audited: [
        {
          revision: start + 1,
          problems: 0,
          step: "insert",
          stepPointer: "/steps/0",
        },
        {
          revision: start + 2,
          problems: 0,
          step: "insert",
          stepPointer: "/steps/1/else/0",
        },
        {
          revision: start + 3,
          problems: 0,
          step: "change",
          stepPointer: "/steps/1/then/0",
        },
      ],
    });
  });

  it("keeps a step the format refuses with its problems, never drawn", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: definitionOf({ steps: [waitStep("finish")] }),
    });
    const refused = await editWorkflowStep(env, ada, workflow.id, {
      revision: 1,
      edit: {
        kind: "change",
        pointer: "/steps/0",
        step: { type: "nonsense" },
      },
    });

    expect({
      revision: refused.revision,
      problems: refused.problems.length > 0,
      diagram: refused.diagram,
    }).toStrictEqual({ revision: 2, problems: true, diagram: null });
  });

  it("edits only a step or a list of steps, of the revision read, for the workflow's builders", async () => {
    const ada = await person("builder");
    const reader = await person("user");
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 0,
      source: definitionOf({ steps: [waitStep("finish")] }),
    });
    const step = { type: "wait", for: "5 seconds" };
    const change = async (pointer: string, revision = 1) => {
      const refused = await outcome(
        editWorkflowStep(env, ada, workflow.id, {
          revision,
          edit: { kind: "change", pointer, step },
        })
      );
      return refused;
    };
    const insert = async (list: string, index = 0) => {
      const refused = await outcome(
        editWorkflowStep(env, ada, workflow.id, {
          revision: 1,
          edit: { kind: "insert", list, index, id: "added", step },
        })
      );
      return refused;
    };
    const refusals = {
      notAStep: await change("/args/fields"),
      theList: await change("/steps"),
      pastTheEnd: await change("/steps/1"),
      leadingZero: await change("/steps/00"),
      prototype: await change("/__proto__/0"),
      notAList: await insert("/args"),
      listItsTypeHasNot: await insert("/steps/0/then"),
      beyondTheList: await insert("/steps", 2),
      stale: await change("/steps/0", 0),
      user: await outcome(
        editWorkflowStep(env, reader, workflow.id, {
          revision: 1,
          edit: { kind: "change", pointer: "/steps/0", step },
        })
      ),
      invalid: await outcome(
        editWorkflowStep(env, ada, workflow.id, {
          revision: 1,
          edit: { kind: "rename", pointer: "/steps/0" },
        })
      ),
    };
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: 1,
      source: "{ not yet",
    });
    const notJson = await change("/steps/0", 2);

    expect({
      refusals,
      notJson,
      kept: await storedCheckpoints(workflow.id),
    }).toStrictEqual({
      refusals: {
        notAStep: "workflow.step_not_found",
        theList: "workflow.step_not_found",
        pastTheEnd: "workflow.step_not_found",
        leadingZero: "workflow.step_not_found",
        prototype: "workflow.step_not_found",
        notAList: "workflow.step_not_found",
        listItsTypeHasNot: "workflow.step_not_found",
        beyondTheList: "workflow.step_not_found",
        stale: "draft.conflict",
        user: "role.forbidden",
        invalid: "workflow.resource_invalid",
      },
      notJson: "workflow.draft_not_json",
      kept: 2,
    });
  });
});
