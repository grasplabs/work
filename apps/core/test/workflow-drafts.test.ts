import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  editWorkflowDraft,
  publishWorkflowDraft,
  workflowDraft,
} from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// A workflow's draft (workflow-drafts.ts), from its threat model: two
// edits at once never both land, text that doesn't pass is kept but never
// becomes a checkpoint or a version, only builders read it, and it keeps
// only what it needs. Each test makes its own people and workflows.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Acting> => {
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
  return { userId, role, teams: [], staff };
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

/** A definition of workflow `name` that passes, ending in `status`. */
const definitionOf = (
  name: string,
  { status = "done", tasks }: { status?: string; tasks?: unknown[] } = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks ?? [{ finish: { set: { status } } }],
  });

/** How many revisions of workflow `id`'s draft are stored. */
const storedRevisions = async (id: string): Promise<number[]> => {
  const { results } = await env.DB.prepare(
    "SELECT revision FROM workflow_resource_drafts WHERE workflow_resource_id = ? ORDER BY revision"
  )
    .bind(id)
    .all<{ revision: number }>();
  return results.map(({ revision }) => revision);
};

const workflowOf = async (by: Acting) =>
  await createWorkflowResource(env, by, `draft-${unique()}`);

describe("a workflow's draft", () => {
  it("starts from a definition that passes, and publishes its checkpoint as the next version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const started = await workflowDraft(env, ada, workflow.id);
    expect(started).toMatchObject({
      revision: 0,
      problems: [],
      checkpoint: null,
    });

    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: started.source,
      modules: {},
    });
    expect(saved).toMatchObject({
      revision: 1,
      problems: [],
      checkpoint: { revision: 1, source: started.source },
      editedBy: ada.userId,
    });
    const version = await publishWorkflowDraft(env, ada, workflow.id, {
      revision: 1,
      basedOn: null,
    });
    expect(version).toMatchObject({ version: 1 });
    // Once published, a later edit builds on that version.
    const next = definitionOf(workflow.name, { status: "later" }).replace(
      '"1.0.0"',
      '"1.1.0"'
    );
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 1,
      source: next,
      modules: {},
    });
    await expect(
      outcome(
        publishWorkflowDraft(env, ada, workflow.id, {
          revision: 2,
          basedOn: null,
        })
      )
    ).resolves.toBe("workflow.version_conflict");
    await publishWorkflowDraft(env, ada, workflow.id, {
      revision: 2,
      basedOn: 1,
    });
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      2
    );
  });

  it("is the current version's definition before anyone edits it", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf(workflow.name);
    await publishWorkflowVersion(env, ada, workflow.id, {
      definition,
      basedOn: null,
    });
    await expect(workflowDraft(env, ada, workflow.id)).resolves.toMatchObject({
      revision: 0,
      source: definition,
      checkpoint: { revision: 0, source: definition },
    });
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
    const first = definitionOf(workflow.name, { status: "ada" });
    const second = definitionOf(workflow.name, { status: "bo" });
    const outcomes = await Promise.all([
      outcome(
        editWorkflowDraft(env, ada, workflow.id, {
          expectedRevision: 0,
          source: first,
          modules: {},
        })
      ),
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          expectedRevision: 0,
          source: second,
          modules: {},
        })
      ),
    ]);
    expect(outcomes.toSorted()).toStrictEqual([
      "ok",
      "workflow.draft_conflict",
    ]);
    const kept = await workflowDraft(env, ada, workflow.id);
    expect({
      revision: kept.revision,
      source: outcomes[0] === "ok" ? first : second,
    }).toStrictEqual({ revision: 1, source: kept.source });
    // An edit of the revision it read lands; one of an older one doesn't.
    await expect(
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          expectedRevision: 0,
          source: second,
          modules: {},
        })
      )
    ).resolves.toBe("workflow.draft_conflict");
    await expect(
      outcome(
        editWorkflowDraft(env, bo, workflow.id, {
          expectedRevision: 1,
          source: second,
          modules: {},
        })
      )
    ).resolves.toBe("ok");
    // A stale edit is refused though the revision after the one it read
    // is no longer stored: only the latest and the checkpoint are.
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 2,
      source: "{",
      modules: {},
    });
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 3,
      source: "{ still",
      modules: {},
    });
    const stale = await outcome(
      editWorkflowDraft(env, bo, workflow.id, {
        expectedRevision: 2,
        source: second,
        modules: {},
      })
    );
    const latest = await workflowDraft(env, ada, workflow.id);
    expect({
      stale,
      revision: latest.revision,
      source: latest.source,
    }).toStrictEqual({
      stale: "workflow.draft_conflict",
      revision: 4,
      source: "{ still",
    });
  });

  it("keeps text that doesn't pass with its problems, never as a checkpoint or a version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const good = definitionOf(workflow.name);
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: good,
      modules: {},
    });
    const secret = `secret-${unique()}`;
    const invalid = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 1,
      source: definitionOf(workflow.name, {
        tasks: [{ finish: { set: { status: secret }, unknown: true } }],
      }),
      modules: {},
    });
    const incomplete = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 2,
      source: good.slice(0, 40),
      modules: {},
    });
    expect({
      invalid: invalid.problems.map(
        ({ code, pointer, taskId }) => `${code} ${pointer} ${taskId}`
      ),
      invalidCheckpoint: invalid.checkpoint?.revision,
      incomplete: incomplete.problems.map(({ code }) => code),
      incompleteCheckpoint: incomplete.checkpoint?.revision,
      // The diagram is the checkpoint's: the text that passed, never the
      // latest edit's.
      diagram: incomplete.checkpoint?.diagram.tasks.map(
        ({ id, kind }) => `${id} ${kind}`
      ),
      leaked: JSON.stringify(invalid.problems).includes(secret),
    }).toStrictEqual({
      invalid: ["profile.unknown_property /do/0/finish/unknown finish"],
      invalidCheckpoint: 1,
      incomplete: ["json.invalid"],
      incompleteCheckpoint: 1,
      diagram: ["finish set"],
      leaked: false,
    });
    // Only the latest revision, once it passed, publishes: an earlier one
    // conflicts, as an edit of it would.
    await expect(
      outcome(
        publishWorkflowDraft(env, ada, workflow.id, {
          revision: 3,
          basedOn: null,
        })
      )
    ).resolves.toBe("workflow.draft_unchecked");
    await expect(
      outcome(
        publishWorkflowDraft(env, ada, workflow.id, {
          revision: 1,
          basedOn: null,
        })
      )
    ).resolves.toBe("workflow.draft_conflict");
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      0
    );
  });

  it("answers an edit with the revision it wrote and its checkpoint then, though another lands right after it", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const passing = definitionOf(workflow.name, { status: "first" });
    const theirs = definitionOf(workflow.name, { status: "theirs" });
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: passing,
      modules: {},
    });
    // Core's database, where another builder's edit that passes lands as
    // soon as this one's batch has, keeping only itself as its checkpoint.
    let raced = false;
    const racing = new Proxy(env.DB, {
      get: (target, property): unknown => {
        if (property === "batch" && !raced) {
          return async (statements: D1PreparedStatement[]) => {
            raced = true;
            const results = await target.batch(statements);
            await target.batch([
              target
                .prepare(
                  "INSERT INTO workflow_resource_drafts (workflow_resource_id, revision, source, checked, problems, edited_by, edited_at) VALUES (?, 3, ?, 1, '[]', ?, ?)"
                )
                .bind(workflow.id, theirs, ada.userId, Date.now()),
              target
                .prepare(
                  "DELETE FROM workflow_resource_drafts WHERE workflow_resource_id = ? AND revision < 3"
                )
                .bind(workflow.id),
            ]);
            return results;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const saved = await editWorkflowDraft(
      { ...env, DB: racing },
      ada,
      workflow.id,
      { expectedRevision: 1, source: "{ mine, not yet", modules: {} }
    );
    const latest = await workflowDraft(env, ada, workflow.id);
    expect({
      saved: [
        saved.revision,
        saved.source,
        saved.checkpoint?.revision,
        saved.checkpoint?.source,
      ],
      latest: [latest.revision, latest.source],
    }).toStrictEqual({
      saved: [2, "{ mine, not yet", 1, passing],
      latest: [3, theirs],
    });
  });

  it("reads its text and its checkpoint as one saved state, though an edit that passes lands between two reads", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const passing = definitionOf(workflow.name, { status: "first" });
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: passing,
      modules: {},
    });
    await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 1,
      source: "{ not yet",
      modules: {},
    });
    // Core's database, where another builder's edit that passes lands as
    // soon as a single read of the draft has run.
    let landed = false;
    const land = async (target: D1Database): Promise<void> => {
      landed = true;
      await target
        .prepare(
          "INSERT INTO workflow_resource_drafts (workflow_resource_id, revision, source, checked, problems, edited_by, edited_at) VALUES (?, 3, ?, 1, '[]', ?, ?)"
        )
        .bind(workflow.id, passing, ada.userId, Date.now())
        .run();
    };
    const racing = new Proxy(env.DB, {
      get: (target, property): unknown => {
        // A batch's reads all see one state; the edit lands after it.
        if (property === "batch" && !landed) {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            await land(target);
            return results;
          };
        }
        if (property !== "prepare") {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (landed || !query.includes("workflow_resource_drafts")) {
            return statement;
          }
          const ran = (bound: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(bound, {
              get: (inner, name): unknown => {
                const value: unknown = Reflect.get(inner, name);
                if (typeof value !== "function") {
                  return value;
                }
                if (name === "bind") {
                  return (...values: unknown[]) => ran(inner.bind(...values));
                }
                if (["all", "first", "raw", "run"].includes(String(name))) {
                  return async (...args: unknown[]) => {
                    const result: unknown = await Reflect.apply(
                      value,
                      inner,
                      args
                    );
                    await land(target);
                    return result;
                  };
                }
                return value.bind(inner);
              },
            });
          return ran(statement);
        };
      },
    });
    const read = await workflowDraft({ ...env, DB: racing }, ada, workflow.id);
    // The edit landed while it read, and it read one of the two states
    // that were ever saved: before the edit, or after it.
    const state = {
      revision: read.revision,
      checkpoint: read.checkpoint?.revision ?? null,
    };
    const saved = [
      { revision: 2, checkpoint: 1 },
      { revision: 3, checkpoint: 3 },
    ];
    expect({
      landed,
      saved: saved.some(
        (one) =>
          one.revision === state.revision && one.checkpoint === state.checkpoint
      ),
    }).toStrictEqual({ landed: true, saved: true });
  });

  it("finds a contract too large for a version, so a draft that passes publishes", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // Names as long as a schema allows, until the contract outgrows a
    // version's row while the definition stays within its own bound.
    const properties = Object.fromEntries(
      Array.from({ length: 3000 }, (_, index) => [
        `p${String(index).padStart(4, "0")}${"n".repeat(59)}`,
        { type: "string" },
      ])
    );
    const source = JSON.stringify({
      ...JSON.parse(definitionOf(workflow.name)),
      input: {
        schema: {
          format: "json",
          document: {
            type: "object",
            properties,
            additionalProperties: false,
          },
        },
      },
    });
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source,
      modules: {},
    });
    expect({
      problems: saved.problems.map(({ code, pointer }) => `${code} ${pointer}`),
      checkpoint: saved.checkpoint,
    }).toStrictEqual({
      problems: ["contract.too_large /input/schema"],
      checkpoint: null,
    });
  });

  it("refuses a draft past 1 MiB of UTF-8, however few characters it has", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // Under a million characters, each three bytes in UTF-8.
    await expect(
      outcome(
        editWorkflowDraft(env, ada, workflow.id, {
          expectedRevision: 0,
          source: "界".repeat(700_000),
          modules: {},
        })
      )
    ).resolves.toBe("workflow.resource_invalid");
  });

  it("keeps text whose problems would outgrow its row, with a short problem in their place", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // A key the profile doesn't know, every character of which a JSON
    // Pointer escapes as two: its problem alone is larger than the text.
    const source = definitionOf(workflow.name, {
      tasks: [
        { finish: { set: { status: "done" }, ["/".repeat(750_000)]: 1 } },
      ],
    });
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source,
      modules: {},
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

  it("refuses text that names another workflow, at its document", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      expectedRevision: 0,
      source: definitionOf(`other-${unique()}`),
      modules: {},
    });
    expect(
      saved.problems.map(({ code, pointer }) => `${code} ${pointer}`)
    ).toStrictEqual(["workflow.identity_mismatch /document"]);
  });

  it("is read and edited only by the workflow's builders, never by Grasp staff", async () => {
    const ada = await person("builder");
    const user = await person("builder");
    const staff = await person("admin", true);
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const edit = {
      expectedRevision: 0,
      source: definitionOf(workflow.name),
      modules: {},
    };
    expect({
      read: await outcome(workflowDraft(env, user, workflow.id)),
      edit: await outcome(editWorkflowDraft(env, user, workflow.id, edit)),
      publish: await outcome(
        publishWorkflowDraft(env, user, workflow.id, {
          revision: 1,
          basedOn: null,
        })
      ),
      staff: await outcome(editWorkflowDraft(env, staff, workflow.id, edit)),
    }).toStrictEqual({
      read: "role.forbidden",
      edit: "role.forbidden",
      publish: "role.forbidden",
      staff: "role.forbidden",
    });
  });

  it("keeps only its latest revision and its latest checkpoint, audits each edit, and goes with its workflow", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const good = definitionOf(workflow.name);
    for (const [revision, source] of [good, good, "{", "{ not yet"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one edit after the other
      await editWorkflowDraft(env, ada, workflow.id, {
        expectedRevision: revision,
        source,
        modules: {},
      });
    }
    const kept = await storedRevisions(workflow.id);
    const events = await allEvents();
    const audited = events.filter(
      (event) =>
        event.action === "workflow.draft.edited" &&
        event.target?.id === workflow.id
    );
    expect({ kept, audited: audited.length }).toStrictEqual({
      kept: [2, 4],
      audited: 4,
    });
    await deleteWorkflowResource(env, ada, workflow.id);
    await expect(storedRevisions(workflow.id)).resolves.toStrictEqual([]);
  });
});
