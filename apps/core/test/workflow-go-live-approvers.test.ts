import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  decideGoLive,
  goLivesWaiting,
  requestGoLive,
  workflowLifecycle,
} from "../src/workflow-lifecycle.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// Who may approve a workflow's go-live when whoever asked for it is the
// only one who could (workflow-lifecycle.ts, GRA-1227): four-eyes, unless
// no other active member may decide it, an admin or the workflow's owner,
// as read with the state a decision names and again as its write lands.
// Each test starts from an organization with only the members it makes.

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

/** A workflow `owner` created and published at version 1. */
const workflowOf = async (owner: Identity) => {
  const workflow = await createWorkflowResource(
    env,
    owner,
    `greet-${unique()}`
  );
  await publishWorkflowVersion(env, owner, workflow.id, {
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
            bindings: {},
          },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [{ finish: { set: { status: "done" } } }],
    }),
    basedOn: null,
  });
  return workflow;
};

/** The go-live decisions audited on workflow `id`, oldest first. */
const decisions = async (id: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ target, action }) =>
        target?.id === id &&
        (action === "workflow.go_live.approved" ||
          action === "workflow.go_live.rejected")
    )
    .map(({ action, detail }) => ({ action, detail }));
};

/**
 * `env` whose database runs `meanwhile` once, right before its `nth`
 * batch: between a decision's read and its write, the second.
 */
const before = (nth: number, meanwhile: () => Promise<void>): Env => {
  let batches = 0;
  const database = new Proxy(env.DB, {
    get: (target, key): unknown => {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          if (batches === nth) {
            await meanwhile();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: database };
};

describe("a go-live nobody else may approve", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM members").run();
  });

  it("lets a one-admin company's admin approve their own, recorded as self-approved", async () => {
    const admin = await person("admin");
    // A builder who doesn't own the workflow decides nothing.
    await person("builder");
    const workflow = await workflowOf(admin);
    const asked = await requestGoLive(env, admin, workflow.id, {
      version: 1,
      revision: 0,
    });
    const waiting = await goLivesWaiting(env, admin);
    const approved = await decideGoLive(env, admin, workflow.id, {
      version: 1,
      verdict: "approve",
      revision: asked.revision,
    });
    const read = await workflowLifecycle(env, admin, workflow.id);

    expect({
      asked: {
        onlyApprover: asked.goLive?.onlyApprover,
        canDecide: asked.canDecide,
      },
      waiting: waiting.map(({ workflowId, selfApproval }) => ({
        workflowId,
        selfApproval,
      })),
      live: approved.live && {
        version: approved.live.version,
        approvedBy: approved.live.approvedBy,
        selfApproved: approved.live.selfApproved,
      },
      read: read.live?.selfApproved,
      audited: await decisions(workflow.id),
    }).toStrictEqual({
      asked: { onlyApprover: true, canDecide: true },
      waiting: [{ workflowId: workflow.id, selfApproval: true }],
      live: { version: 1, approvedBy: admin.userId, selfApproved: true },
      read: true,
      audited: [
        {
          action: "workflow.go_live.approved",
          detail: {
            version: 1,
            previous: null,
            requestedBy: admin.userId,
            self: true,
            reason: "no_other_approver",
          },
        },
      ],
    });
  });

  it("refuses one's own go-live while another admin, or the workflow's owner, may approve it", async () => {
    const admin = await person("admin");
    const second = await person("admin");
    const owner = await person("builder");
    const adminsOwn = await workflowOf(admin);
    const buildersOwn = await workflowOf(owner);
    const asked = await requestGoLive(env, admin, adminsOwn.id, {
      version: 1,
      revision: 0,
    });
    const refusedForAdmin = await outcome(
      decideGoLive(env, admin, adminsOwn.id, {
        version: 1,
        verdict: "approve",
        revision: asked.revision,
      })
    );
    // The workflow's owner may decide it: an admin asking for it waits.
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(second.userId)
      .run();
    const ownersAsked = await requestGoLive(env, admin, buildersOwn.id, {
      version: 1,
      revision: 0,
    });
    const refusedForOwner = await outcome(
      decideGoLive(env, admin, buildersOwn.id, {
        version: 1,
        verdict: "approve",
        revision: ownersAsked.revision,
      })
    );
    const ownerApproved = await decideGoLive(env, owner, buildersOwn.id, {
      version: 1,
      verdict: "approve",
      revision: ownersAsked.revision,
    });

    expect({
      asked: {
        onlyApprover: asked.goLive?.onlyApprover,
        canDecide: asked.canDecide,
      },
      refusedForAdmin,
      ownersAsked: ownersAsked.goLive?.onlyApprover,
      refusedForOwner,
      ownerApproved: ownerApproved.live?.selfApproved,
      audited: await decisions(buildersOwn.id),
    }).toStrictEqual({
      asked: { onlyApprover: false, canDecide: false },
      refusedForAdmin: "workflow.go_live_own_request",
      ownersAsked: false,
      refusedForOwner: "workflow.go_live_own_request",
      ownerApproved: false,
      audited: [
        {
          action: "workflow.go_live.approved",
          detail: { version: 1, previous: null, requestedBy: admin.userId },
        },
      ],
    });
  });

  it("refuses it once a second admin joins between the request and the decision", async () => {
    const admin = await person("admin");
    const workflow = await workflowOf(admin);
    const asked = await requestGoLive(env, admin, workflow.id, {
      version: 1,
      revision: 0,
    });
    // Joined before the decision read anything.
    await person("admin");
    const joinedBefore = await outcome(
      decideGoLive(env, admin, workflow.id, {
        version: 1,
        verdict: "approve",
        revision: asked.revision,
      })
    );
    await env.DB.prepare("DELETE FROM members WHERE user_id <> ?")
      .bind(admin.userId)
      .run();
    // Joined after the decision read the state, before its write landed.
    const joinedBetween = await outcome(
      decideGoLive(
        before(2, async () => {
          await person("admin");
        }),
        admin,
        workflow.id,
        { version: 1, verdict: "approve", revision: asked.revision }
      )
    );
    const now = await workflowLifecycle(env, admin, workflow.id);

    expect({
      joinedBefore,
      joinedBetween,
      live: now.live,
      waiting: now.goLive?.version,
      revision: now.revision,
      audited: await decisions(workflow.id),
    }).toStrictEqual({
      joinedBefore: "workflow.go_live_own_request",
      joinedBetween: "workflow.go_live_own_request",
      live: null,
      waiting: 1,
      revision: asked.revision,
      audited: [],
    });
  });
});
