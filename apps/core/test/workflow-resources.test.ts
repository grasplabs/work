import { v } from "@grasp-os/sdk";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
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
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  getWorkflowResource,
  listWorkflowResources,
  publishWorkflowVersion,
  releaseWorkflowName,
  setWorkflowProcess,
  shareWorkflowResource,
  unshareWorkflowResource,
  workflowDefinition,
  workflowMembers,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { configuredLimits } from "./quota-limits.ts";
import { outcome, refusal, unique } from "./sign-in.ts";
import { webhookConfig } from "./source-config.ts";

// Independent workflows (workflow-resources.ts), from its threat model:
// a definition's text names no workflow, so it carries no authority; a
// published version never changes; an App neither gains nor removes a
// workflow; and what an App or a trigger pins keeps a workflow's name
// from being released. Each test makes its own people and workflows.

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

interface Draft {
  status?: string;
  permissions?: Record<string, unknown>;
  steps?: unknown[];
  instructions?: string;
}

/** A grasp-workflow/2 definition's text: a greeting, by default. */
const definitionOf = ({
  status = "done",
  permissions = {},
  steps = [],
  instructions = "Greet the person.",
}: Draft = {}): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    params: {
      instructions: {
        label: "Instructions",
        type: { kind: "string", default: instructions },
        sensitive: false,
      },
    },
    permissions,
    steps,
  });

/** A new admin, signed in as the catalog's publications need. */
const catalogAdmin = async () => {
  const admin = await person("admin");
  return {
    ...admin,
    email: `${admin.userId}@acme.test`,
    name: "Admin",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

/** A model contract of the catalog's, published by an admin: its key. */
const modelContract = async (): Promise<string> => {
  const key = `model-${unique()}`;
  await publishCatalogContract(env, await catalogAdmin(), {
    key,
    kind: "model",
  });
  return key;
};

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
    const first = await publish(ada, workflow.id, definitionOf());
    expect(first).toMatchObject({
      resourceId: workflow.id,
      version: 1,
      definitionVersion: "1.0.0",
      profile: "grasp-workflow/2",
      bindings: [],
      // No actions of its own: an empty list, recorded as such.
      actions: [],
      author: ada.userId,
    });
    const second = await publish(
      ada,
      workflow.id,
      definitionOf({ status: "ok" }),
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
      definitionOf()
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

  it("answers a retried publication with the version it made, and numbers other content as the next", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf();
    const first = await publish(ada, workflow.id, definition);
    // The retry still says it built on nothing: it is the same publication.
    await expect(publish(ada, workflow.id, definition)).resolves.toStrictEqual(
      first
    );
    // The document names no version: the publication numbers it.
    const other = await publish(
      ada,
      workflow.id,
      definitionOf({ status: "other" }),
      1
    );
    expect([first, other].map((each) => each.definitionVersion)).toStrictEqual([
      "1.0.0",
      "2.0.0",
    ]);
  });

  it("answers two identical publications racing each other with the one version", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf();
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
    await publish(ada, workflow.id, definitionOf());
    await expect(
      outcome(
        publish(ada, workflow.id, definitionOf({ status: "2.0.0" }), null)
      )
    ).resolves.toBe("workflow.version_conflict");
    const raced = await Promise.all(
      ["2.0.0", "3.0.0"].map(
        async (version) =>
          await outcome(
            publish(ada, workflow.id, definitionOf({ status: version }), 1)
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

  it("refuses a definition the format refuses, with its diagnostics and none of its values", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const secret = `secret-${unique()}`;
    const definition = definitionOf({
      instructions: secret,
      steps: [{ id: "finish", type: "call", module: secret }],
    });
    const error = await refusal(publish(ada, workflow.id, definition));
    expect(error).toMatchObject({ code: "workflow.definition_invalid" });
    expect(JSON.stringify(error)).not.toContain(secret);
    await expect(
      problemCodes(publish(ada, workflow.id, "{"))
    ).resolves.toStrictEqual(["schema.invalid "]);
    await expect(workflowVersions(env, ada, workflow.id)).resolves.toHaveLength(
      0
    );
  });

  it("resolves every permission of the most a definition holds, all kinds together, and refuses one more", async () => {
    const admin = await catalogAdmin();
    const model = await modelContract();
    // The model and 63 events, each its own contract, are the most (64);
    // a 64th event is one more.
    const events = Array.from({ length: 64 }, () => `events-${unique()}`);
    for (const key of events) {
      // oxlint-disable-next-line no-await-in-loop -- one admin's publications, in order
      await publishCatalogContract(env, admin, {
        key,
        kind: "event",
        events: {
          "grasp.job.completed": {
            data: JSON.stringify(v.object({ note: v.string() }).descriptor),
            browser: false,
          },
        },
      });
    }
    const holding = (count: number) =>
      definitionOf({
        permissions: {
          ai: { contract: model },
          events: Object.fromEntries(
            events
              .slice(0, count)
              .map((key, index) => [`events${index}`, { contract: key }])
          ),
        },
      });
    const workflow = await workflowOf(admin);
    const published = await publish(admin, workflow.id, holding(63));
    await expect(
      problemCodes(publish(admin, workflow.id, holding(64), 1))
    ).resolves.toStrictEqual(["workflow.too_many_permissions /permissions"]);
    expect(
      published.bindings.map(({ contractId }) => contractId).toSorted()
    ).toStrictEqual([model, ...events.slice(0, 63)].toSorted());
  });
});

describe("roles in a workflow", () => {
  it("lets a user follow it and only builders change it, capped by the organization role", async () => {
    const ada = await person("builder");
    const reader = await person("builder");
    const plainUser = await person("user");
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf());
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
      publish(reader, workflow.id, definitionOf({ status: "2.0.0" }), 1),
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
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'App', '', ?, ?)"
      ).bind(app, bob.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'builder', ?, ?)"
      ).bind(app, ada.userId, bob.userId, Date.now()),
    ]);
    await expect(
      outcome(getWorkflowResource(env, bob, workflow.id))
    ).resolves.toBe("workflow.resource_unavailable");
    await expect(
      outcome(publish(bob, workflow.id, definitionOf()))
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

/** A definition asking model `key` through binding `greeting`. */
const bindingDefinition = (key: string, status = "done") =>
  definitionOf({
    status,
    permissions: { ai: { contract: key } },
    steps: [
      {
        id: "greet",
        type: "generate",
        instructions: "Greet them.",
        input: { who: { $expr: "args.who" } },
        returns: objectSchema({ line: { kind: "string" } }),
      },
    ],
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
  it("can't be dodged by publishing while it is deleted", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const [published, deleted] = await Promise.all([
      outcome(publish(ada, workflow.id, definitionOf())),
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
    await publish(ada, workflow.id, definitionOf());
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "team",
      id: team,
      role: "builder",
    });
    const seen = await getWorkflowResource(env, plain, workflow.id);
    expect({
      role: seen.role,
      publish: await outcome(
        publish(plain, workflow.id, definitionOf({ status: "2.0.0" }), 1)
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
      publish: await outcome(publish(demoted, workflow.id, definitionOf())),
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
});

describe("the business process a workflow serves", () => {
  it("is set and cleared by its builders, Grasp staff among them, shown to everyone with a role, audited, and only one of the list", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const staff = await person("admin", [], true);
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });

    const before = await getWorkflowResource(env, bob, workflow.id);
    const set = await setWorkflowProcess(env, ada, workflow.id, "p2p");
    const listed = await listWorkflowResources(env, bob);
    const again = await setWorkflowProcess(env, ada, workflow.id, "p2p");
    const refused = {
      user: await outcome(setWorkflowProcess(env, bob, workflow.id, "o2c")),
      unknown: await outcome(setWorkflowProcess(env, ada, workflow.id, "x2y")),
    };
    const byStaff = await setWorkflowProcess(env, staff, workflow.id, "r2r");
    const cleared = await setWorkflowProcess(env, ada, workflow.id, null);
    const after = await getWorkflowResource(env, bob, workflow.id);
    const events = await allEvents();

    expect({
      before: before.process,
      set: set.process,
      listed: listed.find(({ id }) => id === workflow.id)?.process,
      again: again.process,
      refused,
      byStaff: byStaff.process,
      cleared: cleared.process,
      after: after.process,
      audited: events
        .filter(
          ({ action, target }) =>
            action === "workflow.process_set" && target?.id === workflow.id
        )
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      before: null,
      set: "p2p",
      listed: "p2p",
      again: "p2p",
      refused: { user: "role.forbidden", unknown: "workflow.resource_invalid" },
      byStaff: "r2r",
      cleared: null,
      after: null,
      audited: [
        {
          actor: { type: "person", userId: ada.userId },
          detail: { process: "p2p", previousProcess: null },
        },
        {
          actor: { type: "staff", userId: staff.userId },
          detail: { process: "r2r", previousProcess: "p2p" },
        },
        {
          actor: { type: "person", userId: ada.userId },
          detail: { process: null, previousProcess: "r2r" },
        },
      ],
    });
  });
});

describe("Grasp staff", () => {
  it("never unshare, nor publish bindings the current version doesn't have", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const staff = await person("admin", [], true);
    const model = await modelContract();
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf());
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
        publish(staff, workflow.id, bindingDefinition(model, "2.0.0"), 1)
      ),
    }).toStrictEqual({ unshare: "role.forbidden", bind: "role.forbidden" });
    // Reading, and a version that binds nothing new, as for Apps.
    const plain = await publish(
      staff,
      workflow.id,
      definitionOf({ status: "ok" }),
      1
    );
    expect({
      version: plain.version,
      definition: await workflowDefinition(env, staff, workflow.id, 2),
    }).toStrictEqual({
      version: 2,
      definition: definitionOf({ status: "ok" }),
    });
  });

  it("never publish a version that drops what the current version binds", async () => {
    const ada = await person("builder");
    const staff = await person("admin", [], true);
    const model = await modelContract();
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, bindingDefinition(model));

    expect({
      dropped: await outcome(
        publish(staff, workflow.id, definitionOf({ status: "2.0.0" }), 1)
      ),
      kept: await outcome(
        publish(staff, workflow.id, bindingDefinition(model, "2.0.0"), 1)
      ),
    }).toStrictEqual({ dropped: "role.forbidden", kept: "ok" });
  });
});

describe("stored versions", () => {
  it("are the same version for a retry that only formats the definition differently", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const definition = definitionOf();
    const first = await publish(ada, workflow.id, definition);
    const reformatted = JSON.stringify(JSON.parse(definition), null, 2);
    await expect(publish(ada, workflow.id, reformatted)).resolves.toStrictEqual(
      first
    );
  });

  it("are refused, never served, once their record no longer matches its hashes", async () => {
    const ada = await person("builder");
    const child = await workflowOf(ada, "child");
    await publish(ada, child.id, definitionOf());
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
      .bind(definitionOf({ status: "tampered" }), child.id)
      .run();
    // A manifest that lost what its actions may do is malformed, even
    // with its hash written to match: no version is listed as doing
    // nothing for want of the record. And one whose list was changed,
    // however well formed, no longer hashes to what was sealed: review
    // never shows less than the build allows.
    const bare = await workflowOf(ada, "bare");
    await publish(ada, bare.id, definitionOf());
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
    await publish(ada, altered.id, definitionOf());
    await env.DB.prepare(
      `UPDATE workflow_resource_versions SET manifest = json_set(manifest, '$.actions', json('[{"binding":"notify","module":"code/notify.ts","export":"notify","uses":[]}]')) WHERE workflow_resource_id = ?`
    )
      .bind(altered.id)
      .run();
    expect({
      definition: await outcome(workflowDefinition(env, ada, child.id, 1)),
      actions: await outcome(workflowVersions(env, ada, bare.id)),
      alteredActions: await outcome(workflowVersions(env, ada, altered.id)),
    }).toStrictEqual({
      definition: "workflow.version_corrupt",
      actions: "workflow.version_corrupt",
      alteredActions: "workflow.version_corrupt",
    });
  });

  it("are bounded so a version's row fits", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const oversized = `${definitionOf()}${" ".repeat(1024 * 1024)}`;
    // A schema whose constants make the contract larger than a version holds.
    const values = Array.from(
      { length: 4000 },
      (_, index) => `${String(index).padStart(4, "0")}-${"v".repeat(100)}`
    );
    const big = definitionOf().replace(
      '"who":{"kind":"string"}',
      JSON.stringify({ who: { kind: "enum", values } }).slice(1, -1)
    );
    expect({
      definition: await outcome(publish(ada, workflow.id, oversized)),
      contract: await problemCodes(publish(ada, workflow.id, big)),
    }).toStrictEqual({
      definition: "workflow.resource_invalid",
      contract: ["contract.too_large /args"],
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

  it("stops at the quota limits' cap per person, deleted ones included", async () => {
    const ada = await person("builder");
    env.TEST_QUOTA_LIMITS = {
      ...configuredLimits,
      workflowResourcesPerPerson: 2,
    };
    try {
      const first = await workflowOf(ada);
      await workflowOf(ada);
      await deleteWorkflowResource(env, ada, first.id);
      await expect(outcome(workflowOf(ada))).resolves.toBe(
        "workflow.resource_limit"
      );
    } finally {
      env.TEST_QUOTA_LIMITS = configuredLimits;
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

/** A deleted workflow of `by`'s that published `versions` versions. */
const deletedWorkflow = async (by: Acting, versions = 1) => {
  const workflow = await workflowOf(by, "gone");
  let basedOn: number | null = null;
  for (const version of Array.from({ length: versions }, (_, at) => at)) {
    // oxlint-disable-next-line no-await-in-loop -- one publication after another
    const published = await publish(
      by,
      workflow.id,
      definitionOf({ status: `v${version}` }),
      basedOn
    );
    basedOn = published.version;
  }
  await deleteWorkflowResource(env, by, workflow.id);
  return workflow;
};

/** Sets the status of every App binding to workflow `old`, as SQL. */
const bound = async (old: { id: string }, status: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE app_workflow_bindings SET status = ? WHERE workflow_resource_id = ?"
  )
    .bind(status, old.id)
    .run();
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
    await expect(
      eventsOf("workflow.name_release_refused", live.id)
    ).resolves.toStrictEqual([
      { name: live.name, reason: "workflow.name_unreleasable" },
    ]);
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
    const refused = await eventsOf("workflow.name_release_refused", old.id);
    const events = await allEvents();
    const audited = events.filter(
      ({ action, detail }) =>
        action === "workflow.name_release_refused" &&
        detail.name === old.name &&
        detail.reason === "role.forbidden"
    );
    expect({
      tries,
      audited: audited.length,
      // Refused before anything is read of the name: no workflow named.
      targeted: refused.length,
      taken: await outcome(createWorkflowResource(env, ada, old.name)),
    }).toStrictEqual({
      tries: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ],
      audited: 4,
      targeted: 0,
      taken: "workflow.name_taken",
    });
  });

  it("is refused while an App binds it or a trigger starts it, whatever their grants", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await publish(ada, workflow.id, definitionOf());
    const app = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'App', '', ?, ?)"
    )
      .bind(app, ada.userId, Date.now())
      .run();
    const binding = await bindWorkflowToApp(env, ada, workflow.id, {
      app,
      alias: "greet",
      version: 1,
    });
    const trigger = await createTriggerResource(env, ada, {
      kind: "webhook",
      workflowId: workflow.id,
      version: 1,
      config: await webhookConfig(),
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
      both: { triggers: 1, appBindings: 1, liveRuns: 0 },
      app: { triggers: 0, appBindings: 1, liveRuns: 0 },
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
    const renamed = await written(
      "UPDATE workflow_resources SET name = 'renamed-' || id WHERE id = ?",
      old.id
    );
    const insertedReleased = await written(
      "INSERT INTO workflow_resources (id, name, owner_id, created_at, deleted_at, name_released_at, name_released_by) VALUES (?, 'x-' || hex(randomblob(4)), 'x', 1, 1, 1, 'x')",
      crypto.randomUUID()
    );
    // REPLACE over the released row would bring it back, live and holding
    // nothing it may hold.
    const replaced = await written(
      "INSERT OR REPLACE INTO workflow_resources (id, name, owner_id, created_at) SELECT id, name, owner_id, created_at FROM workflow_resources WHERE id = ?",
      old.id
    );
    const row = await env.DB.prepare(
      "SELECT deleted_at IS NOT NULL AS deleted, name_released_at IS NOT NULL AS released FROM workflow_resources WHERE id = ?"
    )
      .bind(old.id)
      .first<{ deleted: number; released: number }>();
    expect({
      undeleted: undeleted.includes("a released name stays released"),
      unreleased: unreleased.includes("a released name stays released"),
      liveReleased: liveReleased.includes(
        "only a deleted workflow's name is released"
      ),
      renamed: renamed.includes("a released name stays released"),
      insertedReleased: insertedReleased.includes(
        "a new workflow holds its name"
      ),
      replaced: replaced.includes("a workflow keeps its row"),
      row,
    }).toStrictEqual({
      undeleted: true,
      unreleased: true,
      liveReleased: true,
      renamed: true,
      insertedReleased: true,
      replaced: true,
      row: { deleted: 1, released: 1 },
    });
  });

  it("lands once when two admins release it at the same time", async () => {
    const ada = await person("builder");
    const old = await deletedWorkflow(ada);
    const [first, second] = await Promise.all([
      outcome(releaseWorkflowName(env, await person("admin"), old.name)),
      outcome(releaseWorkflowName(env, await person("admin"), old.name)),
    ]);
    expect({
      first,
      second,
      released: await eventsOf("workflow.name.released", old.id),
    }).toStrictEqual({
      first: "ok",
      second: "ok",
      released: [{ name: old.name }],
    });
  });

  it("tries again when what pinned it goes meanwhile, and gives up busy when pins keep coming back", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const pinnedBy = async () => {
      const workflow = await workflowOf(ada);
      await publish(ada, workflow.id, definitionOf());
      const app = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'App', '', ?, ?)"
      )
        .bind(app, ada.userId, Date.now())
        .run();
      await bindWorkflowToApp(env, ada, workflow.id, {
        app,
        alias: "greet",
        version: 1,
      });
      await deleteWorkflowResource(env, ada, workflow.id);
      return workflow;
    };
    // The binding goes between the miss and the count: the next try lands.
    const gone = await pinnedBy();
    const recovered = await outcome(
      releaseWorkflowName(env, admin, gone.name, {
        recounting: async () => {
          await bound(gone, "removed");
        },
      })
    );
    // It goes before each count and comes back after: never settled.
    const flapping = await pinnedBy();
    const busy = await outcome(
      releaseWorkflowName(env, admin, flapping.name, {
        recounting: async () => {
          await bound(flapping, "removed");
        },
        recounted: async () => {
          await bound(flapping, "active");
        },
      })
    );
    expect({
      recovered,
      released: await eventsOf("workflow.name.released", gone.id),
      busy,
      refused: await eventsOf("workflow.name_release_refused", flapping.id),
    }).toStrictEqual({
      recovered: "ok",
      released: [{ name: gone.name }],
      busy: "workflow.name_busy",
      refused: [{ name: flapping.name, reason: "workflow.name_busy" }],
    });
  });

  it("numbers a new holder's versions past every earlier holder's", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const first = await deletedWorkflow(ada, 2);
    await releaseWorkflowName(env, admin, first.name);
    const second = await createWorkflowResource(env, ada, first.name);
    const secondOwn = await publish(ada, second.id, definitionOf());
    await deleteWorkflowResource(env, ada, second.id);
    await releaseWorkflowName(env, admin, first.name);
    const third = await createWorkflowResource(env, ada, first.name);
    const thirdOwn = await publish(ada, third.id, definitionOf());
    // The contract keys an earlier holder's callers named never answer
    // for a new holder's versions.
    expect(
      [secondOwn, thirdOwn].map((each) => each.definitionVersion)
    ).toStrictEqual(["3.0.0", "4.0.0"]);
  });
});
