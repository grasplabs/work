import { agentIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import type {
  Authority,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { permissionsOpenTo } from "../src/permissions-open.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  createTriggerResource,
  setTriggerEnabled,
  updateTriggerVersion,
} from "../src/trigger-resources.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  admitWorkflowStart,
  authorizeWorkflowStart,
  startWorkflow,
} from "../src/workflow-starts.ts";
import type { StartInvoker } from "../src/workflow-starts.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Starting an independent workflow (workflow-starts.ts), and the
// permissions of independent resources it relies on (permissions.ts),
// from their threat model: who may start a workflow and as whom, a stale
// or revoked grant, "latest", team membership and revocation changing
// under a start, and the triggers that start one on their own. Each test
// makes its own people, workflows and grants.

type Person = Identity;

/**
 * A member of the organization in `role`, in `teams` (Better Auth's
 * `team_members` and the session's list alike), as their session has them.
 */
const person = async (
  role: Role,
  teams: string[] = [],
  staff = false
): Promise<Person> => {
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
    ...teams.map((team) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, Date.now())
    ),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: teams.map((id) => ({ id, name: "Team" })),
    staff,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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

/** Takes `who` out of the organization. */
const leaves = async (who: Person): Promise<void> => {
  await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
    .bind(who.userId)
    .run();
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

/** A greeting workflow's definition at `version`. */
const definitionOf = (name: string, version = "1.0.0"): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ finish: { set: { status: "done" } } }],
  });

/** A workflow `owner` created, published at version 1 (and 2, if asked). */
const workflowOf = async (owner: Person, versions = 1) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `greet-${unique()}`
  );
  for (let version = 1; version <= versions; version += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each builds on the one before
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(workflow.name, `${version}.0.0`),
      basedOn: version === 1 ? null : version - 1,
    });
  }
  return workflow;
};

/** The roles `by` names things with in a permission, as the RPC hands them. */
const rolesOf = (by: Person) => ({
  app: async (app: string, role: "user" | "builder") =>
    await appFor(env, by, app, role),
  resource: async (
    ref: { type: "workflow" | "store" | "trigger"; id: string },
    needed: "user" | "builder"
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** `request` asked for by `by` and granted by `admin`: its ID. */
const granted = async (
  by: Person,
  admin: Person,
  request: PermissionRequest
): Promise<string> => {
  const { id } = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, id, { version: null });
  return id;
};

/** `start` on workflow `id`, for `subject`. */
const startsOn = (
  subject: PermissionRequest["subject"],
  id: string
): PermissionRequest => ({
  subject,
  object: { type: "workflow", workflowId: id },
  actions: ["start"],
  binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
});

const agentOf = (onBehalfOf: string, agentId: string): StartInvoker => {
  const authority: Authority = {
    subject: { type: "agent", agentId: agentIdSchema.parse(agentId) },
    onBehalfOf,
    mode: "interactive",
  };
  return { type: "agent", authority };
};

const appOf = (
  onBehalfOf: string,
  appId: string,
  appVersion = 1
): StartInvoker => ({
  type: "app",
  authority: {
    subject: { type: "app", appId: appIdSchema.parse(appId) },
    onBehalfOf,
    mode: "interactive",
    appVersion,
  },
});

const personOf = (who: Person): StartInvoker => ({
  type: "person",
  person: who,
});

/** A start request: the version, a greeting and a fresh key. */
const request = (version: unknown = 1, who: unknown = "Ada") => ({
  version,
  input: { who },
  key: `key-${unique()}`,
});

/** An App `owner` owns, with no version yet. */
const appOwnedBy = async (owner: Person): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Engine', '', ?, ?)"
  )
    .bind(id, owner.userId, Date.now())
    .run();
  return id;
};

describe("a person starting a workflow", () => {
  it("starts an exact version they have a role in, acting for themselves", async () => {
    const ada = await person("builder");
    const reader = await person("user");
    const stranger = await person("builder");
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const started = await startWorkflow(
      env,
      personOf(reader),
      workflow.id,
      request()
    );
    expect(started).toMatchObject({
      workflowId: workflow.id,
      version: 1,
      invoker: { type: "person", id: reader.userId },
      principal: reader.userId,
    });
    // Someone with no role in it: as for a workflow that doesn't exist.
    await expect(
      outcome(startWorkflow(env, personOf(stranger), workflow.id, request()))
    ).resolves.toBe("workflow.resource_unavailable");
  });

  it("never names latest, a range or a version never published", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const tries = await Promise.all(
      ["latest", "^1.0.0", 0, 1.5, 9].map(
        async (version) =>
          await outcome(
            startWorkflow(env, personOf(ada), workflow.id, request(version))
          )
      )
    );
    expect(tries).toStrictEqual([
      "workflow.start_invalid",
      "workflow.start_invalid",
      "workflow.start_invalid",
      "workflow.start_invalid",
      "workflow.version_not_found",
    ]);
  });

  it("takes only input the version accepts, and says where without the value", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const secret = { nested: `secret-${unique()}` };
    const attempt = startWorkflow(
      env,
      personOf(ada),
      workflow.id,
      request(1, secret)
    );
    const [code, error] = await Promise.all([
      outcome(attempt),
      refusal(attempt),
    ]);
    expect({
      code,
      leaks: JSON.stringify(error).includes(secret.nested),
    }).toStrictEqual({ code: "workflow.start_invalid", leaks: false });
  });

  it("is the same start for the same key, and refuses the key with other input", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const first = request();
    const started = await startWorkflow(env, personOf(ada), workflow.id, first);
    expect({
      again: await startWorkflow(env, personOf(ada), workflow.id, first),
      other: await outcome(
        startWorkflow(env, personOf(ada), workflow.id, {
          ...first,
          input: { who: "Grace" },
        })
      ),
    }).toStrictEqual({ again: started, other: "workflow.start_conflict" });
  });
});

describe("authority changing under a start", () => {
  it("refuses a start whose team membership ended after it was decided", async () => {
    const ada = await person("builder");
    const team = await newTeam();
    const inTeam = await person("builder", [team]);
    const workflow = await workflowOf(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "team",
      id: team,
      role: "user",
    });
    const decided = await authorizeWorkflowStart(
      env,
      personOf(inTeam),
      workflow.id,
      1
    );
    // Better Auth removes them from the team; their session still lists it.
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
    )
      .bind(team, inTeam.userId)
      .run();
    await expect(
      outcome(admitWorkflowStart(env, decided, { who: "Ada" }, "k1"))
    ).resolves.toBe("workflow.start_denied");
    const events = await allEvents();
    expect(
      events.some(
        ({ action, target }) =>
          action === "workflow.start.refused" && target?.id === workflow.id
      )
    ).toBeTruthy();
  });

  it("refuses a start decided before its workflow's members changed, or it was deleted", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    const before = await authorizeWorkflowStart(
      env,
      personOf(ada),
      workflow.id,
      1
    );
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const staleMembers = await outcome(
      admitWorkflowStart(env, before, { who: "Ada" }, "k1")
    );
    const decided = await authorizeWorkflowStart(
      env,
      personOf(ada),
      workflow.id,
      1
    );
    await deleteWorkflowResource(env, ada, workflow.id);
    expect({
      staleMembers,
      deleted: await outcome(
        admitWorkflowStart(env, decided, { who: "Ada" }, "k2")
      ),
    }).toStrictEqual({
      staleMembers: "workflow.start_denied",
      deleted: "workflow.start_denied",
    });
  });
});

describe("an agent starting a workflow", () => {
  it("needs its own grant and a person who could start it themselves", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const outsider = await person("builder");
    const workflow = await workflowOf(ada);
    const agent = `agent-${unique()}`;
    const ungranted = await outcome(
      startWorkflow(env, agentOf(ada.userId, agent), workflow.id, request())
    );
    await granted(
      ada,
      admin,
      startsOn(
        { type: "agent", agentId: agentIdSchema.parse(agent) },
        workflow.id
      )
    );
    const forAda = await startWorkflow(
      env,
      agentOf(ada.userId, agent),
      workflow.id,
      request()
    );
    expect({
      ungranted,
      forAda: forAda.principal,
      // The agent's grant never lends the person a role they don't have.
      forOutsider: await outcome(
        startWorkflow(
          env,
          agentOf(outsider.userId, agent),
          workflow.id,
          request()
        )
      ),
    }).toStrictEqual({
      ungranted: "workflow.start_denied",
      forAda: ada.userId,
      forOutsider: "workflow.start_denied",
    });
  });

  it("is refused once its grant is revoked, also for a start decided before", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    const agent = `agent-${unique()}`;
    const grant = await granted(
      ada,
      admin,
      startsOn(
        { type: "agent", agentId: agentIdSchema.parse(agent) },
        workflow.id
      )
    );
    const decided = await authorizeWorkflowStart(
      env,
      agentOf(ada.userId, agent),
      workflow.id,
      1
    );
    await revokePermission(env, admin, grant);
    expect({
      decidedBefore: await outcome(
        admitWorkflowStart(env, decided, { who: "Ada" }, "k1")
      ),
      after: await outcome(
        startWorkflow(env, agentOf(ada.userId, agent), workflow.id, request())
      ),
    }).toStrictEqual({
      decidedBefore: "workflow.start_denied",
      after: "workflow.start_denied",
    });
  });
});

describe("an App starting a workflow", () => {
  it("needs a grant of its own from an approved version, and its grouping gives none", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    // An App Ada owns: building it gives it nothing on her workflow.
    const app = await appOwnedBy(ada);
    const ungranted = await outcome(
      startWorkflow(env, appOf(ada.userId, app), workflow.id, request())
    );
    await granted(
      ada,
      admin,
      startsOn({ type: "app", appId: appIdSchema.parse(app) }, workflow.id)
    );
    const started = await startWorkflow(
      env,
      appOf(ada.userId, app),
      workflow.id,
      request()
    );
    // A version of the App no admin approved changes nothing.
    await env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 2, 'tree', 0, ?, 'Unreviewed', ?, 0)"
    )
      .bind(app, ada.userId, Date.now())
      .run();
    expect({
      ungranted,
      started: started.invoker,
      unapproved: await outcome(
        startWorkflow(env, appOf(ada.userId, app, 2), workflow.id, request())
      ),
    }).toStrictEqual({
      ungranted: "workflow.start_denied",
      started: { type: "app", id: app },
      unapproved: "workflow.start_denied",
    });
  });
});

describe("a trigger starting a workflow", () => {
  it("starts only the exact version it pins, with a grant of its own, for whoever bound it", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada, 2);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const trigger = await createTriggerResource(env, bob, {
      kind: "schedule",
      workflowId: workflow.id,
      version: 1,
      config: { cron: "0 9 * * 1-5", timeZone: "Europe/Amsterdam" },
    });
    const invoker: StartInvoker = { type: "trigger", triggerId: trigger.id };
    const ungranted = await outcome(
      startWorkflow(env, invoker, workflow.id, request(1))
    );
    await granted(bob, admin, {
      ...startsOn({ type: "trigger", triggerId: trigger.id }, workflow.id),
    });
    const started = await startWorkflow(env, invoker, workflow.id, request(1));
    expect({
      ungranted,
      principal: started.principal,
      otherVersion: await outcome(
        startWorkflow(env, invoker, workflow.id, request(2))
      ),
    }).toStrictEqual({
      ungranted: "workflow.start_denied",
      // Bob bound it: never the workflow's owner.
      principal: bob.userId,
      otherVersion: "workflow.trigger_unavailable",
    });
  });

  it("moves to another version only explicitly, and stops when disabled or its person leaves", async () => {
    const admin = await person("admin");
    const bob = await person("builder");
    const workflow = await workflowOf(bob, 2);
    const trigger = await createTriggerResource(env, bob, {
      kind: "webhook",
      workflowId: workflow.id,
      version: 1,
      config: { inputMapping: { who: "body.who" } },
    });
    await granted(
      bob,
      admin,
      startsOn({ type: "trigger", triggerId: trigger.id }, workflow.id)
    );
    const invoker: StartInvoker = { type: "trigger", triggerId: trigger.id };
    await updateTriggerVersion(env, bob, trigger.id, 2);
    const moved = {
      old: await outcome(startWorkflow(env, invoker, workflow.id, request(1))),
      now: await outcome(startWorkflow(env, invoker, workflow.id, request(2))),
    };
    const decided = await authorizeWorkflowStart(env, invoker, workflow.id, 2);
    await setTriggerEnabled(env, bob, trigger.id, false);
    const disabled = await outcome(
      admitWorkflowStart(env, decided, { who: "Ada" }, "k1")
    );
    await setTriggerEnabled(env, bob, trigger.id, true);
    await leaves(bob);
    expect({
      moved,
      disabled,
      left: await outcome(startWorkflow(env, invoker, workflow.id, request(2))),
    }).toStrictEqual({
      moved: { old: "workflow.trigger_unavailable", now: "ok" },
      disabled: "workflow.start_denied",
      left: "workflow.start_denied",
    });
  });

  it("keeps the workflow it starts from being deleted", async () => {
    const ada = await person("builder");
    const workflow = await workflowOf(ada);
    await createTriggerResource(env, ada, {
      kind: "system",
      workflowId: workflow.id,
      version: 1,
      config: { event: "note.created" },
    });
    const error = await refusal(deleteWorkflowResource(env, ada, workflow.id));
    expect(error).toMatchObject({
      code: "workflow.resource_bound",
      details: { binders: [], hidden: 0, triggers: 1 },
    });
  });
});

describe("permissions of independent resources", () => {
  it("are asked for only by a subject's builders, and only for what it can use", async () => {
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    const trigger = await createTriggerResource(env, ada, {
      kind: "system",
      workflowId: workflow.id,
      version: 1,
      config: {},
    });
    const subject = { type: "workflow", workflowId: workflow.id } as const;
    const ask = async (by: Person, permission: PermissionRequest) =>
      await outcome(requestPermission(env, by, permission, rolesOf(by)));
    expect({
      // Bob builds neither: as if neither existed.
      notBuilder: await ask(bob, startsOn(subject, workflow.id)),
      notInWorkflow: await ask(
        bob,
        startsOn(
          { type: "agent", agentId: agentIdSchema.parse("agent-x") },
          workflow.id
        )
      ),
      triggerReads: await ask(ada, {
        subject: { type: "trigger", triggerId: trigger.id },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["read"],
        binding: "READS",
      }),
      triggerConnects: await ask(ada, {
        subject: { type: "trigger", triggerId: trigger.id },
        object: { type: "connection", connectionId: "connection-mail" },
        actions: ["mail.send"],
        binding: "MAIL",
      }),
      workflowPlatform: await ask(ada, {
        subject,
        object: { type: "platform" },
        actions: ["statistics"],
        binding: "STATS",
      }),
    }).toStrictEqual({
      notBuilder: "workflow.resource_unavailable",
      notInWorkflow: "workflow.resource_unavailable",
      triggerReads: "permission.invalid",
      triggerConnects: "permission.invalid",
      workflowPlatform: "permission.invalid",
    });
  });

  it("are listed only to those with a role in the workflow they name, and audited by its ID", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const workflow = await workflowOf(ada);
    const id = await granted(
      ada,
      admin,
      startsOn(
        { type: "agent", agentId: agentIdSchema.parse(`agent-${unique()}`) },
        workflow.id
      )
    );
    const listedTo = async (who: Person) => {
      const listed = await permissionsOpenTo(env, who);
      return listed.some((permission) => permission.id === id);
    };
    const events = await allEvents();
    const grantEvent = events.find(
      ({ action, target }) =>
        action === "permission.granted" && target?.id === id
    );
    expect({
      ada: await listedTo(ada),
      bob: await listedTo(bob),
      detail: grantEvent?.detail.workflowId,
    }).toStrictEqual({ ada: true, bob: false, detail: workflow.id });
  });
});
