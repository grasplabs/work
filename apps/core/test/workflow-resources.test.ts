/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  createTriggerResource,
  deleteTriggerResource,
} from "../src/trigger-resources.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  getWorkflowResource,
  listWorkflowResources,
  publishWorkflowVersion,
  releaseWorkflowName,
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
      // No actions of its own: an empty list, recorded as such.
      actions: [],
      author: ada.userId,
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

  it("answers a retried publication with the version it made, as the publisher may see it, though a workflow it binds is no longer the publisher's, or is gone", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    await shareWorkflowResource(env, ada, child.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const parent = await workflowOf(bob, "parent");
    const bound = definitionOf({
      name: parent.name,
      bindings: {
        greeting: {
          kind: "workflow",
          contract: `${workflowNamespace}/${child.name}/1.0.0`,
        },
      },
      tasks: [runTask("greeting", child.name, "1.0.0")],
    });
    const first = await publish(bob, parent.id, bound);
    // Bob loses his role in the child.
    await unshareWorkflowResource(env, ada, child.id, {
      type: "person",
      id: bob.userId,
    });
    const unshared = await publish(bob, parent.id, bound);
    // A later version binds it no more, and Ada deletes the child.
    await publish(
      bob,
      parent.id,
      definitionOf({ name: parent.name, version: "2.0.0" }),
      first.version
    );
    await deleteWorkflowResource(env, ada, child.id);
    const deleted = await publish(bob, parent.id, bound);

    const versions = await workflowVersions(env, bob, parent.id);
    const seen = versions.find(({ version }) => version === first.version);
    // Bob builds the parent, not the child: a retry tells him no more of
    // what the version binds than its listing does.
    expect({
      unshared,
      deleted,
      versions: versions.length,
      // Bob only uses the child: even the publication that made the
      // version names it no more than the listing does.
      first: first.bindings.map(({ resourceId, contractId }) => ({
        resourceId,
        contractId,
      })),
      binds: seen?.bindings.map(({ resourceId, contractId }) => ({
        resourceId,
        contractId,
      })),
    }).toStrictEqual({
      unshared: seen,
      deleted: seen,
      versions: 2,
      // The contract key stays: Bob builds the parent, and its definition
      // text, which he reads, names it.
      first: [
        {
          resourceId: null,
          contractId: `${workflowNamespace}/${child.name}/1.0.0`,
        },
      ],
      binds: [
        {
          resourceId: null,
          contractId: `${workflowNamespace}/${child.name}/1.0.0`,
        },
      ],
    });
  });

  it("answers two identical publications racing each other with the one version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf({ name: workflow.name });
    const [first, second] = await Promise.all([
      publish(ada, workflow.id, definition),
      publish(ada, workflow.id, definition),
    ]);
    const versions = await workflowVersions(env, ada, workflow.id);
    expect({ same: first, versions: versions.length }).toStrictEqual({
      same: second,
      versions: 1,
    });
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
    // Shared with Bob as a user, it resolves for him; which workflow it
    // pins stays a builder's to see, as in the version's listing.
    await shareWorkflowResource(env, ada, adasChild.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const shared = await probe(adasChild.name);
    expect(shared.bindings).toMatchObject([
      { alias: "greeting", resourceId: null },
    ]);
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

  it("lists each workflow with the reader's own role in it, from their rows alone", async () => {
    const ada = await person("builder");
    const team = await newTeam();
    const reader = await person("builder", [team]);
    const [used, built, unshared] = await Promise.all([
      workflowOf(ada, "used"),
      workflowOf(ada, "built"),
      workflowOf(ada, "unshared"),
    ]);
    const owned = await workflowOf(reader, "owned");
    await shareWorkflowResource(env, ada, used.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    // Two rows of theirs: the highest wins.
    await shareWorkflowResource(env, ada, built.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    await shareWorkflowResource(env, ada, built.id, {
      type: "team",
      id: team,
      role: "builder",
    });
    // Someone else's row on a workflow the reader has none on.
    const other = await person("builder");
    await shareWorkflowResource(env, ada, unshared.id, {
      type: "person",
      id: other.userId,
      role: "builder",
    });

    const mine = new Set([used.id, built.id, unshared.id, owned.id]);
    const listed = await listWorkflowResources(env, reader);
    expect(
      listed
        .filter(({ id }) => mine.has(id))
        .map(({ id, role }) => ({ id, role }))
        .toSorted((a, b) => a.id.localeCompare(b.id))
    ).toStrictEqual(
      [
        { id: used.id, role: "user" },
        { id: built.id, role: "builder" },
        { id: owned.id, role: "builder" },
      ].toSorted((a, b) => a.id.localeCompare(b.id))
    );
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

/** A definition of workflow `name` that runs `child` 1.0.0 as `greeting`. */
const bindingDefinition = (name: string, child: string, version = "1.0.0") =>
  definitionOf({
    name,
    version,
    bindings: {
      greeting: {
        kind: "workflow",
        contract: `${workflowNamespace}/${child}/1.0.0`,
      },
    },
    tasks: [runTask("greeting", child, "1.0.0")],
  });

/** The details a refusal carried, or what was thrown instead. */
const detailsOf = async (promise: Promise<unknown>): Promise<unknown> => {
  const error = await refusal(promise);
  return typeof error === "object" && error !== null && "details" in error
    ? error.details
    : error;
};

/** How many versions of `id` are stored, deleted workflow or not. */
const storedVersions = async (id: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM workflow_resource_versions WHERE workflow_resource_id = ?"
  )
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

describe("what keeps a workflow from being deleted", () => {
  it("is only another workflow's current version, named to the owner as far as they may see it", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    await shareWorkflowResource(env, ada, child.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const bobs = await workflowOf(bob, "binder");
    await publish(bob, bobs.id, bindingDefinition(bobs.name, child.name));
    await unshareWorkflowResource(env, ada, child.id, {
      type: "person",
      id: bob.userId,
    });
    // Ada can't see Bob's workflow: she learns there is one, not which.
    await expect(
      detailsOf(deleteWorkflowResource(env, ada, child.id))
    ).resolves.toStrictEqual({
      binders: [],
      hidden: 1,
      triggers: { ids: [], hidden: 0 },
      appBindings: [],
      liveRuns: 0,
    });
    const events = await allEvents();
    const refused = events.find(
      ({ action, target }) =>
        action === "workflow.delete_refused" && target?.id === child.id
    );
    expect(refused?.detail).toMatchObject({ binders: 1, binder1: bobs.id });
    // Bob's next version binds nothing: his old one keeps nothing alive.
    await publish(
      bob,
      bobs.id,
      definitionOf({ name: bobs.name, version: "2.0.0" }),
      1
    );
    await expect(
      outcome(deleteWorkflowResource(env, ada, child.id))
    ).resolves.toBe("ok");
  });

  it("names the binders the owner may see", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const parent = await workflowOf(ada, "parent");
    await publish(ada, parent.id, bindingDefinition(parent.name, child.name));
    await expect(
      detailsOf(deleteWorkflowResource(env, ada, child.id))
    ).resolves.toStrictEqual({
      binders: [{ id: parent.id, name: parent.name }],
      hidden: 0,
      triggers: { ids: [], hidden: 0 },
      appBindings: [],
      liveRuns: 0,
    });
  });

  it("can't be dodged by publishing while it is deleted", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const [published, deleted] = await Promise.all([
      outcome(publish(ada, workflow.id, definitionOf({ name: workflow.name }))),
      outcome(deleteWorkflowResource(env, ada, workflow.id)),
    ]);
    // Whichever lands first, no version lands in a deleted workflow: one
    // that published went in while it was live, and one that didn't left
    // nothing behind.
    const versions = await storedVersions(workflow.id);
    expect({
      deleted,
      published: ["ok", "workflow.resource_unavailable"].includes(published),
      versions,
      gone: await outcome(getWorkflowResource(env, ada, workflow.id)),
    }).toStrictEqual({
      deleted: "ok",
      published: true,
      versions: published === "ok" ? 1 : 0,
      gone: "workflow.resource_unavailable",
    });
  });

  it("isn't undone by a share racing it", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    const [deleted, shared] = await Promise.all([
      outcome(deleteWorkflowResource(env, ada, workflow.id)),
      outcome(
        shareWorkflowResource(env, ada, workflow.id, {
          type: "person",
          id: bob.userId,
          role: "user",
        })
      ),
    ]);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM workflow_resource_members WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .first<{ n: number }>();
    // Whichever lands first, the workflow stays deleted, and a share that
    // was refused wrote nothing.
    expect({
      deleted,
      shared: ["ok", "workflow.resource_unavailable"].includes(shared),
      rows: rows?.n,
      gone: await outcome(getWorkflowResource(env, bob, workflow.id)),
    }).toStrictEqual({
      deleted: "ok",
      shared: true,
      rows: shared === "ok" ? 1 : 0,
      gone: "workflow.resource_unavailable",
    });
  });
});

describe("role ceilings", () => {
  it("caps a team's builders at their own organization role", async () => {
    const ada = await person("builder");
    const team = await newTeam();
    const plain = await person("user", [team]);
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf({ name: workflow.name }));
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "team",
      id: team,
      role: "builder",
    });
    const seen = await getWorkflowResource(env, plain, workflow.id);
    expect({
      role: seen.role,
      publish: await outcome(
        publish(
          plain,
          workflow.id,
          definitionOf({ name: workflow.name, version: "2.0.0" }),
          1
        )
      ),
    }).toStrictEqual({ role: "user", publish: "role.forbidden" });
  });

  it("caps an owner demoted to user", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const demoted: Acting = { ...ada, role: "user" };
    const seen = await getWorkflowResource(env, demoted, workflow.id);
    expect({
      role: seen.role,
      publish: await outcome(
        publish(demoted, workflow.id, definitionOf({ name: workflow.name }))
      ),
    }).toStrictEqual({ role: "user", publish: "role.forbidden" });
  });

  it("shows whom it is shared with to nobody without a role in it", async () => {
    const ada = await person("builder");
    const stranger = await person("builder");
    const workflow = await workflowOf(ada);
    await expect(
      outcome(workflowMembers(env, stranger, workflow.id))
    ).resolves.toBe("workflow.resource_unavailable");
  });

  it("names a bound workflow no more once it is deleted, even to who built it", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    await shareWorkflowResource(env, ada, child.id, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const parent = await workflowOf(bob, "parent");
    const first = await publish(
      bob,
      parent.id,
      bindingDefinition(parent.name, child.name)
    );
    // The parent binds it no more, so Ada may delete the child.
    await publish(
      bob,
      parent.id,
      definitionOf({ name: parent.name, version: "2.0.0" }),
      first.version
    );
    const before = await workflowVersions(env, bob, parent.id);
    await deleteWorkflowResource(env, ada, child.id);
    const after = await workflowVersions(env, bob, parent.id);
    const boundIn = (versions: typeof after) =>
      versions.find(({ version }) => version === first.version)?.bindings[0]
        ?.resourceId;

    expect({ before: boundIn(before), after: boundIn(after) }).toStrictEqual({
      before: child.id,
      after: null,
    });
  });

  it("names a bound workflow only to its builders", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const child = await workflowOf(ada, "child");
    const first = await publish(
      ada,
      child.id,
      definitionOf({ name: child.name })
    );
    const parent = await workflowOf(ada, "parent");
    await publish(ada, parent.id, bindingDefinition(parent.name, child.name));
    await shareWorkflowResource(env, ada, parent.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const [asBob] = await workflowVersions(env, bob, parent.id);
    const [asAda] = await workflowVersions(env, ada, parent.id);
    expect({
      bob: asBob?.bindings,
      ada: asAda?.bindings[0]?.resourceId,
    }).toStrictEqual({
      bob: [
        {
          alias: "greeting",
          kind: "workflow",
          resourceId: null,
          resourceVersion: null,
          // Bob only uses the parent: its definition text isn't his.
          contractId: null,
          fingerprint: first.contractHash,
        },
      ],
      ada: child.id,
    });
  });
});

describe("Grasp staff", () => {
  it("never unshare, nor publish bindings the current version doesn't have", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const staff = await person("admin", [], true);
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf({ name: workflow.name }));
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    expect({
      unshare: await outcome(
        unshareWorkflowResource(env, staff, workflow.id, {
          type: "person",
          id: bob.userId,
        })
      ),
      bind: await outcome(
        publish(
          staff,
          workflow.id,
          bindingDefinition(workflow.name, child.name, "2.0.0"),
          1
        )
      ),
    }).toStrictEqual({ unshare: "role.forbidden", bind: "role.forbidden" });
    // Reading, and a version that binds nothing new, as for Apps.
    const plain = await publish(
      staff,
      workflow.id,
      definitionOf({ name: workflow.name, version: "2.0.0", status: "ok" }),
      1
    );
    expect({
      version: plain.version,
      definition: await workflowDefinition(env, staff, workflow.id, 2),
    }).toStrictEqual({
      version: 2,
      definition: definitionOf({
        name: workflow.name,
        version: "2.0.0",
        status: "ok",
      }),
    });
  });

  it("never publish a version that drops what the current version binds", async () => {
    const ada = await person("builder");
    const staff = await person("admin", [], true);
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const workflow = await workflowOf(ada);
    await publish(
      ada,
      workflow.id,
      bindingDefinition(workflow.name, child.name)
    );

    expect({
      dropped: await outcome(
        publish(
          staff,
          workflow.id,
          definitionOf({ name: workflow.name, version: "2.0.0" }),
          1
        )
      ),
      kept: await outcome(
        publish(
          staff,
          workflow.id,
          bindingDefinition(workflow.name, child.name, "2.0.0"),
          1
        )
      ),
    }).toStrictEqual({ dropped: "role.forbidden", kept: "ok" });
  });
});

describe("stored versions", () => {
  it("are the same version for a retry that only formats the definition differently", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf({ name: workflow.name });
    const first = await publish(ada, workflow.id, definition);
    const reformatted = JSON.stringify(JSON.parse(definition), null, 2);
    await expect(publish(ada, workflow.id, reformatted)).resolves.toStrictEqual(
      first
    );
  });

  it("are refused, never served, once their record no longer matches its hashes", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    // The database refuses to change a version; someone with its raw files
    // gets past that, which is what the hashes are for.
    const refusedByDatabase = await outcome(
      env.DB.prepare(
        "UPDATE workflow_resource_versions SET definition = '{}' WHERE workflow_resource_id = ?"
      )
        .bind(child.id)
        .run()
    );
    expect(refusedByDatabase).toContain("immutable");
    await env.DB.prepare(
      "DROP TRIGGER workflow_resource_versions_immutable_update"
    ).run();
    await env.DB.prepare(
      'UPDATE workflow_resource_versions SET definition = ?, contract = replace(contract, \'"label":"Instructions"\', \'"label":"Changed"\') WHERE workflow_resource_id = ?'
    )
      .bind(definitionOf({ name: child.name, status: "tampered" }), child.id)
      .run();
    // A manifest that lost what its actions may do is malformed, even
    // with its hash written to match: no version is listed as doing
    // nothing for want of the record. And one whose list was changed,
    // however well formed, no longer hashes to what was sealed: review
    // never shows less than the build allows.
    const bare = await workflowOf(ada, "bare");
    await publish(ada, bare.id, definitionOf({ name: bare.name }));
    const sealed = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ?"
    )
      .bind(bare.id)
      .first<{ manifest: string }>();
    const { actions: _dropped, ...withoutActions } = z
      .record(z.string(), z.json())
      .parse(JSON.parse(sealed?.manifest ?? "{}"));
    const rehashed = canonicalJson(withoutActions);
    await env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ? WHERE workflow_resource_id = ?"
    )
      .bind(rehashed, await sha256Hex(rehashed), bare.id)
      .run();
    const altered = await workflowOf(ada, "altered");
    await publish(ada, altered.id, definitionOf({ name: altered.name }));
    await env.DB.prepare(
      `UPDATE workflow_resource_versions SET manifest = json_set(manifest, '$.actions', json('[{"binding":"notify","module":"code/notify.ts","export":"notify","uses":[]}]')) WHERE workflow_resource_id = ?`
    )
      .bind(altered.id)
      .run();
    const parent = await workflowOf(ada, "parent");
    expect({
      definition: await outcome(workflowDefinition(env, ada, child.id, 1)),
      binding: await outcome(
        publish(ada, parent.id, bindingDefinition(parent.name, child.name))
      ),
      actions: await outcome(workflowVersions(env, ada, bare.id)),
      alteredActions: await outcome(workflowVersions(env, ada, altered.id)),
    }).toStrictEqual({
      definition: "workflow.version_corrupt",
      binding: "workflow.version_corrupt",
      actions: "workflow.version_corrupt",
      alteredActions: "workflow.version_corrupt",
    });
  });

  it("are bounded so a version's row fits", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const oversized = `${definitionOf({ name: workflow.name })}${" ".repeat(1024 * 1024)}`;
    // A schema whose constants make the contract larger than a version holds.
    const values = Array.from(
      { length: 4000 },
      (_, index) => `${String(index).padStart(4, "0")}-${"v".repeat(100)}`
    );
    const big = definitionOf({ name: workflow.name }).replace(
      '"who":{"type":"string"}',
      JSON.stringify({ who: { type: "string", enum: values } }).slice(1, -1)
    );
    expect({
      definition: await outcome(publish(ada, workflow.id, oversized)),
      contract: await problemCodes(publish(ada, workflow.id, big)),
    }).toStrictEqual({
      definition: "workflow.resource_invalid",
      contract: ["contract.too_large /input/schema"],
    });
  });
});

describe("creating workflows", () => {
  it("audits a refused name", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await outcome(createWorkflowResource(env, ada, workflow.name));
    const events = await allEvents();
    expect(
      events.some(
        ({ action, actor, detail }) =>
          action === "workflow.create_refused" &&
          actor.type === "person" &&
          actor.userId === ada.userId &&
          detail.reason === "workflow.name_taken"
      )
    ).toBeTruthy();
  });

  it("stops at the quota policy's cap per person, deleted ones included", async () => {
    const configured = quotaLimitsSchema.parse(env.QUOTA_LIMITS);
    const ada = await person("builder");
    env.QUOTA_LIMITS = {
      generation: configured.generation + 100,
      limits: { ...configured.limits, workflowResourcesPerPerson: 2 },
    };
    try {
      const first = await workflowOf(ada);
      await workflowOf(ada);
      await deleteWorkflowResource(env, ada, first.id);
      await expect(outcome(workflowOf(ada))).resolves.toBe(
        "workflow.resource_limit"
      );
    } finally {
      env.QUOTA_LIMITS = {
        generation: configured.generation + 101,
        limits: configured.limits,
      };
    }
  });
});

/** The audit events about workflow `id` of `action`, by their detail. */
const eventsOf = async (action: string, id: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter((event) => event.action === action && event.target?.id === id)
    .map(({ detail }) => detail);
};

/** What writing `statement` for row `id` came to: "ok", or its error. */
const written = async (statement: string, id: string): Promise<string> =>
  await outcome(env.DB.prepare(statement).bind(id).run());

/** A deleted workflow of `by`'s that published `versions`, by name. */
const deletedWorkflow = async (by: Acting, versions = ["1.0.0"]) => {
  const workflow = await workflowOf(by, "gone");
  let basedOn: number | null = null;
  for (const version of versions) {
    // oxlint-disable-next-line no-await-in-loop -- one publication after another
    const published = await publish(
      by,
      workflow.id,
      definitionOf({ name: workflow.name, version }),
      basedOn
    );
    basedOn = published.version;
  }
  await deleteWorkflowResource(env, by, workflow.id);
  return workflow;
};

describe("releasing a deleted workflow's name", () => {
  it("lets an admin give it to a new workflow, which is another workflow", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const old = await deletedWorkflow(ada);
    await expect(
      outcome(createWorkflowResource(env, bob, old.name))
    ).resolves.toBe("workflow.name_taken");
    await releaseWorkflowName(env, admin, old.name);
    const taken = await createWorkflowResource(env, bob, old.name);
    // Released again once taken: it is a live workflow's now.
    expect({
      sameId: taken.id === old.id,
      old: await outcome(getWorkflowResource(env, ada, old.id)),
      again: await outcome(releaseWorkflowName(env, admin, old.name)),
      released: await eventsOf("workflow.name.released", old.id),
    }).toStrictEqual({
      sameId: false,
      old: "workflow.resource_unavailable",
      again: "workflow.name_unreleasable",
      released: [{ name: old.name }],
    });
  });

  it("records a release once: releasing a released name nobody took changes nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const old = await deletedWorkflow(ada);
    await releaseWorkflowName(env, admin, old.name);
    await releaseWorkflowName(env, admin, old.name);
    await expect(
      eventsOf("workflow.name.released", old.id)
    ).resolves.toHaveLength(1);
  });

  it("releases only a deleted workflow's name", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const live = await workflowOf(ada);
    expect({
      live: await outcome(releaseWorkflowName(env, admin, live.name)),
      none: await outcome(releaseWorkflowName(env, admin, `never-${unique()}`)),
      invalid: await outcome(releaseWorkflowName(env, admin, "Not A Name")),
    }).toStrictEqual({
      live: "workflow.name_unreleasable",
      none: "workflow.name_unreleasable",
      invalid: "workflow.name_unreleasable",
    });
  });

  it("is for the organization's admins only, never Grasp staff", async () => {
    const ada = await person("builder");
    const old = await deletedWorkflow(ada);
    const tries = await Promise.all(
      [
        ada,
        await person("user"),
        await person("builder"),
        await person("admin", [], true),
      ].map(async (by) => await outcome(releaseWorkflowName(env, by, old.name)))
    );
    expect({
      tries,
      taken: await outcome(createWorkflowResource(env, ada, old.name)),
    }).toStrictEqual({
      tries: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ],
      taken: "workflow.name_taken",
    });
  });

  it("leaves the old workflow's contract keys unanswered: no workflow publishes its versions again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const mallory = await person("builder");
    const old = await deletedWorkflow(ada, ["1.0.0", "1.1.0"]);
    await releaseWorkflowName(env, admin, old.name);
    const taken = await createWorkflowResource(env, mallory, old.name);
    const again = await Promise.all(
      ["1.0.0", "1.1.0"].map(
        async (version) =>
          await outcome(
            publish(
              mallory,
              taken.id,
              definitionOf({ name: old.name, version })
            )
          )
      )
    );
    await publish(
      mallory,
      taken.id,
      definitionOf({ name: old.name, version: "2.0.0" })
    );
    // Shared with Ada, whose draft still names the old workflow's key: it
    // resolves to nothing, rather than to Mallory's workflow.
    await shareWorkflowResource(env, mallory, taken.id, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    const binder = await workflowOf(ada, "binder");
    const codes = await problemCodes(
      publish(ada, binder.id, bindingDefinition(binder.name, old.name))
    );
    expect({
      again,
      unresolved:
        Array.isArray(codes) &&
        codes.some(
          (code) => typeof code === "string" && bindingProblem.test(code)
        ),
    }).toStrictEqual({
      again: ["workflow.version_taken", "workflow.version_taken"],
      unresolved: true,
    });
  });

  it("is refused while any version of a live workflow binds it, old ones included, and audited", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf({ name: child.name }));
    const parent = await workflowOf(ada, "parent");
    await publish(ada, parent.id, bindingDefinition(parent.name, child.name));
    // Its current version binds nothing: the child can be deleted, but the
    // parent's first version still names it.
    await publish(
      ada,
      parent.id,
      definitionOf({ name: parent.name, version: "2.0.0" }),
      1
    );
    await deleteWorkflowResource(env, ada, child.id);
    const refused = await detailsOf(
      releaseWorkflowName(env, admin, child.name)
    );
    const events = await eventsOf("workflow.name_release_refused", child.id);
    await deleteWorkflowResource(env, ada, parent.id);
    await releaseWorkflowName(env, admin, child.name);
    expect({ refused, events }).toStrictEqual({
      refused: { binders: 1, triggers: 0, appBindings: 0, liveRuns: 0 },
      events: [
        {
          name: child.name,
          reason: "workflow.name_pinned",
          binders: 1,
          triggers: 0,
          appBindings: 0,
          liveRuns: 0,
        },
      ],
    });
  });

  it("is refused while an App binds it or a trigger starts it, whatever their grants", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf({ name: workflow.name }));
    const app = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
    )
      .bind(app, ada.userId, Date.now())
      .run();
    const binding = await bindWorkflowToApp(env, ada, workflow.id, {
      app,
      alias: "greet",
      version: 1,
    });
    const trigger = await createTriggerResource(env, ada, {
      kind: "system",
      workflowId: workflow.id,
      version: 1,
      config: {},
    });
    // Neither holds a grant to start it, so neither keeps it from being
    // deleted; both still name it.
    await deleteWorkflowResource(env, ada, workflow.id);
    const both = await detailsOf(
      releaseWorkflowName(env, admin, workflow.name)
    );
    await deleteTriggerResource(env, ada, trigger.id);
    const app_ = await detailsOf(
      releaseWorkflowName(env, admin, workflow.name)
    );
    await unbindWorkflowFromApp(env, ada, binding.id);
    await releaseWorkflowName(env, admin, workflow.name);
    expect({ both, app: app_ }).toStrictEqual({
      both: { binders: 0, triggers: 1, appBindings: 1, liveRuns: 0 },
      app: { binders: 0, triggers: 0, appBindings: 1, liveRuns: 0 },
    });
  });

  it("never lets a released workflow be live again, nor a live one's name be released, whatever writes it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const old = await deletedWorkflow(ada);
    const live = await workflowOf(ada);
    await releaseWorkflowName(env, admin, old.name);
    const undeleted = await written(
      "UPDATE workflow_resources SET deleted_at = NULL WHERE id = ?",
      old.id
    );
    const unreleased = await written(
      "UPDATE workflow_resources SET name_released_at = NULL WHERE id = ?",
      old.id
    );
    const liveReleased = await written(
      "UPDATE workflow_resources SET name_released_at = 1, name_released_by = 'x' WHERE id = ?",
      live.id
    );
    expect({
      undeleted: undeleted.includes("a released name stays released"),
      unreleased: unreleased.includes("a released name stays released"),
      liveReleased: liveReleased.includes(
        "only a deleted workflow's name is released"
      ),
    }).toStrictEqual({ undeleted: true, unreleased: true, liveReleased: true });
  });
});
