/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  getWorkflowResource,
  listWorkflowResources,
  publishWorkflowVersion,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowDefinition,
  workflowMembers,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Independent workflows (workflow-resources.ts), from its threat model:
// authority never comes from a definition's text or a "latest" alias, a
// published version never changes, an App neither gains nor removes a
// workflow, and a workflow another one runs can't be deleted. Each test
// makes its own people and workflows.

/** A problem reported at the `greeting` binding's declaration. */
const bindingProblem = /^\S+ \/document\/metadata\/grasp\/bindings\/greeting/u;

/** A member of the organization in `role`, as their session has them. */
const person = async (
  role: Role,
  teams: string[] = [],
  staff = false
): Promise<Acting> => {
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
    role,
    teams: teams.map((id) => ({ id, name: "Team" })),
    staff,
  };
};

const newTeam = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Team', 'organization', ?)"
  )
    .bind(id, Date.now())
    .run();
  return id;
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

interface Draft {
  name: string;
  version?: string;
  namespace?: string;
  status?: string;
  bindings?: Record<string, { kind: string; contract: string }>;
  tasks?: unknown[];
  instructions?: string;
}

/** A grasp-open-workflow/1 definition's text: a greeting, by default. */
const definitionOf = ({
  name,
  version = "1.0.0",
  namespace = workflowNamespace,
  status = "done",
  bindings = {},
  tasks,
  instructions = "Greet the person.",
}: Draft): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {
            instructions: {
              schema: { type: "string", maxLength: 200 },
              label: "Instructions",
              default: instructions,
              sensitive: false,
            },
          },
          bindings,
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks ?? [{ finish: { set: { status } } }],
  });

/** A task that runs workflow `name` at `version` through binding `alias`. */
const runTask = (alias: string, name: string, version: string) => ({
  child: {
    run: {
      workflow: {
        namespace: workflowNamespace,
        name,
        version,
        input: { who: "${ $workflow.input.who }" },
      },
    },
    metadata: { grasp: { binding: alias } },
  },
});

/** A workflow `by` created, under a name of its own. */
const workflowOf = async (by: Acting, prefix = "greet") =>
  await createWorkflowResource(env, by, `${prefix}-${unique()}`);

/** Publishes `definition` to `id` for `by`, on its current version. */
const publish = async (
  by: Acting,
  id: string,
  definition: string,
  basedOn: number | null = null
) => await publishWorkflowVersion(env, by, id, { definition, basedOn });

/** The codes of a refused publication's problems. */
const problemCodes = async (promise: Promise<unknown>): Promise<unknown> => {
  const error = await refusal(promise);
  if (
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null &&
    "problems" in error.details &&
    Array.isArray(error.details.problems)
  ) {
    return error.details.problems.map(
      (problem: { code: string; pointer: string }) =>
        `${problem.code} ${problem.pointer}`
    );
  }
  return error;
};

describe("creating a workflow", () => {
  it("is for builders, with a name no workflow has had", async () => {
    const ada = await person("builder");
    const user = await person("user");
    const name = `notes-${unique()}`;
    const created = await createWorkflowResource(env, ada, name);
    expect(created).toMatchObject({
      namespace: workflowNamespace,
      name,
      owner: ada.userId,
      currentVersion: null,
      role: "builder",
    });
    await expect(
      outcome(createWorkflowResource(env, user, `x-${unique()}`))
    ).resolves.toBe("role.forbidden");
    await expect(outcome(createWorkflowResource(env, ada, name))).resolves.toBe(
      "workflow.name_taken"
    );
    await expect(
      outcome(createWorkflowResource(env, ada, "Not Kebab"))
    ).resolves.toBe("workflow.resource_invalid");
    // A deleted workflow's name stays its own: a new workflow given it
    // would answer contracts the old one's callers named.
    await deleteWorkflowResource(env, ada, created.id);
    await expect(outcome(createWorkflowResource(env, ada, name))).resolves.toBe(
      "workflow.name_taken"
    );
  });
});

describe("publishing a version", () => {
  it("pins the definition, its contract and manifest, and moves the current version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const first = await publish(
      ada,
      workflow.id,
      definitionOf({ name: workflow.name })
    );
    expect(first).toMatchObject({
      resourceId: workflow.id,
      version: 1,
      definitionVersion: "1.0.0",
      profile: "grasp-open-workflow/1",
      bindings: [],
      author: ada.userId,
      definitionHash: await sha256Hex(definitionOf({ name: workflow.name })),
    });
    const second = await publish(
      ada,
      workflow.id,
      definitionOf({ name: workflow.name, version: "1.1.0", status: "ok" }),
      1
    );
    // Same input, output and parameter schemas: the same contract, in
    // another manifest.
    expect({
      version: second.version,
      sameContract: second.contractHash === first.contractHash,
      sameManifest: second.manifestHash === first.manifestHash,
    }).toStrictEqual({ version: 2, sameContract: true, sameManifest: false });
    const current = await getWorkflowResource(env, ada, workflow.id);
    const versions = await workflowVersions(env, ada, workflow.id);
    expect({
      current: current.currentVersion,
      versions: versions.map(({ version }) => version),
    }).toStrictEqual({ current: 2, versions: [2, 1] });
    await expect(workflowDefinition(env, ada, workflow.id, 1)).resolves.toBe(
      definitionOf({ name: workflow.name })
    );
    const events = await allEvents();
    const published = events.filter(
      ({ action, target }) =>
        action === "workflow.version.published" && target?.id === workflow.id
    );
    expect(published.map(({ detail }) => detail.manifestHash)).toStrictEqual([
      first.manifestHash,
      second.manifestHash,
    ]);
  });

  it("answers a retried publication with the version it made, and refuses other content under its version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf({ name: workflow.name });
    const first = await publish(ada, workflow.id, definition);
    // The retry still says it built on nothing: it is the same publication.
    await expect(publish(ada, workflow.id, definition)).resolves.toStrictEqual(
      first
    );
    await expect(
      outcome(
        publish(
          ada,
          workflow.id,
          definitionOf({ name: workflow.name, status: "other" }),
          1
        )
      )
    ).resolves.toBe("workflow.version_exists");
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      1
    );
  });

  it("refuses a publication built on a version no longer current, also when two race", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf({ name: workflow.name }));
    await expect(
      outcome(
        publish(
          ada,
          workflow.id,
          definitionOf({ name: workflow.name, version: "2.0.0" }),
          null
        )
      )
    ).resolves.toBe("workflow.version_conflict");
    const raced = await Promise.all(
      ["2.0.0", "3.0.0"].map(
        async (version) =>
          await outcome(
            publish(
              ada,
              workflow.id,
              definitionOf({ name: workflow.name, version }),
              1
            )
          )
      )
    );
    expect(raced.toSorted()).toStrictEqual(["ok", "workflow.version_conflict"]);
    const versions = await workflowVersions(env, ada, workflow.id);
    const current = await getWorkflowResource(env, ada, workflow.id);
    expect({
      current: current.currentVersion,
      versions: versions.map(({ version }) => version),
    }).toStrictEqual({ current: 2, versions: [2, 1] });
  });

  it("refuses a definition the profile refuses, with its diagnostics and none of its values", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const secret = `secret-${unique()}`;
    const definition = definitionOf({
      name: workflow.name,
      instructions: secret,
      tasks: [{ finish: { set: { status: secret }, unknown: true } }],
    });
    const error = await refusal(publish(ada, workflow.id, definition));
    expect(error).toMatchObject({ code: "workflow.definition_invalid" });
    expect(JSON.stringify(error)).not.toContain(secret);
    await expect(
      problemCodes(publish(ada, workflow.id, "{"))
    ).resolves.toStrictEqual(["json.invalid /"]);
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      0
    );
  });
});

describe("authority from source text", () => {
  it("lands a definition only in the workflow it names, and only for its builders", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const adas = await workflowOf(ada);
    const bobs = await workflowOf(bob);
    // Bob names Ada's workflow in his own: refused, nothing written.
    await expect(
      outcome(publish(bob, bobs.id, definitionOf({ name: adas.name })))
    ).resolves.toBe("workflow.identity_mismatch");
    // Another namespace, even the platform's own, is never selected by text.
    await expect(
      outcome(
        publish(
          ada,
          adas.id,
          definitionOf({ name: adas.name, namespace: "grasp" })
        )
      )
    ).resolves.toBe("workflow.identity_mismatch");
    // Bob publishing into Ada's by its ID: as if it didn't exist.
    await expect(
      outcome(publish(bob, adas.id, definitionOf({ name: adas.name })))
    ).resolves.toBe("workflow.resource_unavailable");
    await expect(workflowVersions(env, ada, adas.id)).resolves.toHaveLength(0);
    await expect(workflowVersions(env, bob, bobs.id)).resolves.toHaveLength(0);
  });

  it("resolves a workflow binding to the exact version it names, never a later one or an alias", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    const first = await publish(
      ada,
      child.id,
      definitionOf({ name: child.name })
    );
    const parent = await workflowOf(ada, "parent");
    const contract = `${workflowNamespace}/${child.name}/1.0.0`;
    const bound = await publish(
      ada,
      parent.id,
      definitionOf({
        name: parent.name,
        bindings: { greeting: { kind: "workflow", contract } },
        tasks: [runTask("greeting", child.name, "1.0.0")],
      })
    );
    expect(bound.bindings).toStrictEqual([
      {
        alias: "greeting",
        kind: "workflow",
        resourceId: child.id,
        resourceVersion: 1,
        contractId: contract,
        fingerprint: first.contractHash,
      },
    ]);
    // A new version of the child changes nothing the parent pinned.
    await publish(
      ada,
      child.id,
      definitionOf({ name: child.name, version: "2.0.0" }),
      1
    );
    const [kept] = await workflowVersions(env, ada, parent.id);
    expect(kept).toStrictEqual(bound);
    // "latest", a range or a version never published is no contract at all.
    const aliases = ["latest", "^1.0.0", "1.x", "9.9.9"];
    const refused = await Promise.all(
      aliases.map(
        async (version) =>
          await problemCodes(
            publish(
              ada,
              parent.id,
              definitionOf({
                name: parent.name,
                version: "1.1.0",
                bindings: {
                  greeting: {
                    kind: "workflow",
                    contract: `${workflowNamespace}/${child.name}/${version}`,
                  },
                },
                tasks: [runTask("greeting", child.name, "1.0.0")],
              }),
              1
            )
          )
      )
    );
    // Each refused at the binding itself.
    const atBinding = refused.map(
      (codes) =>
        Array.isArray(codes) &&
        codes.some(
          (code) => typeof code === "string" && bindingProblem.test(code)
        )
    );
    expect(atBinding).toStrictEqual(aliases.map(() => true));
    const current = await getWorkflowResource(env, ada, parent.id);
    expect(current.currentVersion).toBe(1);
  });

  it("resolves a binding only to a workflow its publisher has a role in, refusing it as if it didn't exist", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const adasChild = await workflowOf(ada, "private");
    await publish(ada, adasChild.id, definitionOf({ name: adasChild.name }));
    const bobs = await workflowOf(bob, "prober");
    const probe = async (name: string) =>
      await publish(
        bob,
        bobs.id,
        definitionOf({
          name: bobs.name,
          bindings: {
            greeting: {
              kind: "workflow",
              contract: `${workflowNamespace}/${name}/1.0.0`,
            },
          },
          tasks: [runTask("greeting", name, "1.0.0")],
        })
      );
    const hidden = await problemCodes(probe(adasChild.name));
    const missing = await problemCodes(probe(`missing-${unique()}`));
    expect(hidden).toStrictEqual(missing);
    // Shared with Bob as a user, it resolves for him.
    await shareWorkflowResource(env, ada, adasChild.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const shared = await probe(adasChild.name);
    expect(shared.bindings[0]?.resourceId).toBe(adasChild.id);
  });
});

describe("roles in a workflow", () => {
  it("lets a user follow it and only builders change it, capped by the organization role", async () => {
    const ada = await person("builder");
    const reader = await person("builder");
    const plainUser = await person("user");
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf({ name: workflow.name }));
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const asUser = await getWorkflowResource(env, reader, workflow.id);
    const versions = await workflowVersions(env, reader, workflow.id);
    expect({ role: asUser.role, versions: versions.length }).toStrictEqual({
      role: "user",
      versions: 1,
    });
    for (const attempt of [
      publish(
        reader,
        workflow.id,
        definitionOf({ name: workflow.name, version: "2.0.0" }),
        1
      ),
      workflowDefinition(env, reader, workflow.id, 1),
      shareWorkflowResource(env, reader, workflow.id, {
        type: "person",
        id: plainUser.userId,
        role: "user",
      }),
      deleteWorkflowResource(env, reader, workflow.id),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(outcome(attempt)).resolves.toBe("role.forbidden");
    }
    // Someone whose organization role doesn't build is never a builder.
    await expect(
      outcome(
        shareWorkflowResource(env, ada, workflow.id, {
          type: "person",
          id: plainUser.userId,
          role: "builder",
        })
      )
    ).resolves.toBe("workflow.resource_invalid");
    // Unshared, it is gone for them, as if it didn't exist.
    await unshareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
    });
    await expect(
      outcome(getWorkflowResource(env, reader, workflow.id))
    ).resolves.toBe("workflow.resource_unavailable");
    await expect(listWorkflowResources(env, reader)).resolves.toStrictEqual([]);
  });

  it("reaches a team's people while they are in it", async () => {
    const ada = await person("builder");
    const team = await newTeam();
    const inTeam = await person("builder", [team]);
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "team",
      id: team,
      role: "builder",
    });
    const asTeam = await getWorkflowResource(env, inTeam, workflow.id);
    expect(asTeam.role).toBe("builder");
    await expect(
      workflowMembers(env, inTeam, workflow.id)
    ).resolves.toMatchObject([{ type: "team", id: team, role: "builder" }]);
    const leftTeam: Acting = { ...inTeam, teams: [] };
    await expect(
      outcome(getWorkflowResource(env, leftTeam, workflow.id))
    ).resolves.toBe("workflow.resource_unavailable");
  });

  it("never lets Grasp staff decide whom it reaches or delete it", async () => {
    const ada = await person("builder");
    const staff = await person("admin", [], true);
    const workflow = await workflowOf(ada);
    await expect(
      outcome(
        shareWorkflowResource(env, staff, workflow.id, {
          type: "person",
          id: staff.userId,
          role: "builder",
        })
      )
    ).resolves.toBe("role.forbidden");
    await expect(
      outcome(deleteWorkflowResource(env, staff, workflow.id))
    ).resolves.toBe("role.forbidden");
  });
});

describe("Apps and workflows", () => {
  it("gives an App's builders no role in a workflow, and leaves it in place when the App goes", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    // Bob owns an App, which the product may show together with Ada's
    // workflow, and Ada builds that App with him.
    const app = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
      ).bind(app, bob.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'builder', ?, ?)"
      ).bind(app, ada.userId, bob.userId, Date.now()),
    ]);
    await expect(
      outcome(getWorkflowResource(env, bob, workflow.id))
    ).resolves.toBe("workflow.resource_unavailable");
    await expect(
      outcome(publish(bob, workflow.id, definitionOf({ name: workflow.name })))
    ).resolves.toBe("workflow.resource_unavailable");
    // The App is removed: the workflow, its owner and versions stay.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM app_members WHERE app_id = ?").bind(app),
      env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(app),
    ]);
    await expect(
      getWorkflowResource(env, ada, workflow.id)
    ).resolves.toMatchObject({
      owner: ada.userId,
      role: "builder",
    });
  });
});

describe("deleting a workflow", () => {
  it("is refused while another live workflow runs one of its versions", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const parent = await workflowOf(ada, "parent");
    const parentDefinition = (version: string) =>
      definitionOf({
        name: parent.name,
        version,
        bindings: {
          greeting: {
            kind: "workflow",
            contract: `${workflowNamespace}/${child.name}/1.0.0`,
          },
        },
        tasks: [runTask("greeting", child.name, "1.0.0")],
      });
    await publish(ada, parent.id, parentDefinition("1.0.0"));
    await expect(
      outcome(deleteWorkflowResource(env, ada, child.id))
    ).resolves.toBe("workflow.resource_bound");
    const events = await allEvents();
    expect(
      events.some(
        ({ action, target }) =>
          action === "workflow.delete_refused" && target?.id === child.id
      )
    ).toBeTruthy();
    // Once the parent is gone, the child can go; then it's gone for good.
    await deleteWorkflowResource(env, ada, parent.id);
    await deleteWorkflowResource(env, ada, child.id);
    await expect(
      outcome(getWorkflowResource(env, ada, child.id))
    ).resolves.toBe("workflow.resource_unavailable");
    await expect(
      outcome(deleteWorkflowResource(env, ada, child.id))
    ).resolves.toBe("workflow.resource_unavailable");
  });

  it("never lets a publication bind a workflow being deleted", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const parent = await workflowOf(ada, "parent");
    const [published, deleted] = await Promise.all([
      outcome(
        publish(
          ada,
          parent.id,
          definitionOf({
            name: parent.name,
            bindings: {
              greeting: {
                kind: "workflow",
                contract: `${workflowNamespace}/${child.name}/1.0.0`,
              },
            },
            tasks: [runTask("greeting", child.name, "1.0.0")],
          })
        )
      ),
      outcome(deleteWorkflowResource(env, ada, child.id)),
    ]);
    // Exactly one wins: a bound child stays, a deleted child is bound by
    // nothing.
    const versions = await workflowVersions(env, ada, parent.id);
    const childNow = await outcome(getWorkflowResource(env, ada, child.id));
    expect({
      wins: [published, deleted].filter((result) => result === "ok").length,
      bound: versions.map(({ bindings }) =>
        bindings.map(({ resourceId }) => resourceId)
      ),
      child: childNow,
    }).toStrictEqual(
      deleted === "ok"
        ? { wins: 1, bound: [], child: "workflow.resource_unavailable" }
        : { wins: 1, bound: [[child.id]], child: "ok" }
    );
  });
});
