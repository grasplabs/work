import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { maxFailedStarts } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { editWorkflowDraft } from "../src/workflow-drafts.ts";
import {
  decideGoLive,
  pauseWorkflow,
  requestGoLive,
  resumeWorkflow,
  setWorkflowStage,
  workflowLifecycle,
} from "../src/workflow-lifecycle.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  admitWorkflowStart,
  decideWorkflowStart,
  startWorkflow,
} from "../src/workflow-starts.ts";
import { startDueScheduleTriggers } from "../src/workflows/schedule-triggers.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// An independent workflow's lifecycle (workflow-lifecycle.ts), from its
// threat model: a stage that follows the workflow until a builder sets
// one, and never says live without an approval; going live only on the
// say of its owner or an admin who didn't ask for it, for the exact
// version they read; concurrent writes refused, never merged; a paused
// workflow starting nothing, from people or triggers, a start decided
// before the pause included, and its schedules skipping without
// stopping; Grasp staff and users changing nothing. Each test makes its
// own people and workflows.

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

/**
 * A workflow `owner` created and published `versions` times, shared with
 * a builder and a user of its own.
 */
const workflowOf = async (owner: Identity, versions = 1) => {
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
  const builder = await person("builder");
  const user = await person("user");
  await shareWorkflowResource(env, owner, workflow.id, {
    type: "person",
    id: builder.userId,
    role: "builder",
  });
  await shareWorkflowResource(env, owner, workflow.id, {
    type: "person",
    id: user.userId,
    role: "user",
  });
  return { ...workflow, builder, user };
};

/** A start of version 1 by `who`, with a fresh key. */
const startBy = async (who: Identity, id: string) =>
  await startWorkflow(env, { type: "person", person: who }, id, {
    version: 1,
    input: { who: "Ada" },
    key: `key-${unique()}`,
  });

/** The lifecycle events audited on workflow `id`, oldest first. */
const lifecycleEvents = async (id: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ target, action }) =>
        target?.id === id &&
        (action.startsWith("workflow.go_live.") ||
          action.startsWith("workflow.stage.") ||
          action === "workflow.paused" ||
          action === "workflow.resumed")
    )
    .map(({ action, actor, detail }) => ({ action, actor, detail }));
};

describe("a workflow's lifecycle", { timeout: 60_000 }, () => {
  it("follows the workflow until a builder sets a stage, and never says live before a version went live", async () => {
    const owner = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    const mapped = await workflowLifecycle(env, owner, workflow.id);
    await editWorkflowDraft(env, owner, workflow.id, {
      expectedRevision: 0,
      source: definitionOf(workflow.name),
      modules: {},
    });
    const designed = await workflowLifecycle(env, owner, workflow.id);
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    const testing = await workflowLifecycle(env, owner, workflow.id);
    const notLive = await Promise.all(
      (["live", "scaling"] as const).map(
        async (stage) =>
          await outcome(
            setWorkflowStage(env, owner, workflow.id, { stage, revision: 0 })
          )
      )
    );
    const set = await setWorkflowStage(env, owner, workflow.id, {
      stage: "designed",
      revision: 0,
    });

    expect({
      followed: [mapped, designed, testing].map((lifecycle) => ({
        stage: lifecycle.stage,
        stageSet: lifecycle.stageSet,
        draft: lifecycle.draft,
        publishedVersion: lifecycle.publishedVersion,
        revision: lifecycle.revision,
      })),
      notLive,
      set: { stage: set.stage, stageSet: set.stageSet, revision: set.revision },
      audited: await lifecycleEvents(workflow.id),
    }).toStrictEqual({
      followed: [
        {
          stage: "mapped",
          stageSet: false,
          draft: null,
          publishedVersion: null,
          revision: 0,
        },
        {
          stage: "designed",
          stageSet: false,
          draft: { revision: 1, checkpoint: 1 },
          publishedVersion: null,
          revision: 0,
        },
        {
          stage: "testing",
          stageSet: false,
          draft: { revision: 1, checkpoint: 1 },
          publishedVersion: 1,
          revision: 0,
        },
      ],
      notLive: ["workflow.stage_invalid", "workflow.stage_invalid"],
      set: { stage: "designed", stageSet: true, revision: 1 },
      audited: [
        {
          action: "workflow.stage.updated",
          actor: { type: "person", userId: owner.userId },
          detail: { stage: "designed", previous: null },
        },
      ],
    });
  });

  it("goes live only on the say of its owner or an admin who didn't ask, for the exact version waiting", async () => {
    const owner = await person("builder");
    const admin = await person("admin");
    const workflow = await workflowOf(owner, 2);
    const { builder, user } = workflow;
    const unpublished = await outcome(
      requestGoLive(env, builder, workflow.id, { version: 3, revision: 0 })
    );
    const byUser = await outcome(
      requestGoLive(env, user, workflow.id, { version: 1, revision: 0 })
    );
    const asked = await requestGoLive(env, builder, workflow.id, {
      version: 1,
      revision: 0,
    });
    const ownerSees = await workflowLifecycle(env, owner, workflow.id);
    const decide = async (by: Identity, version = 1, revision = 1) => {
      const decided = await outcome(
        decideGoLive(env, by, workflow.id, {
          version,
          verdict: "approve",
          revision,
        })
      );
      return decided;
    };
    const refused = {
      builderOwnRequest: await decide(builder),
      user: await decide(user),
      otherVersion: await decide(owner, 2),
    };
    const approved = await decideGoLive(env, owner, workflow.id, {
      version: 1,
      verdict: "approve",
      revision: 1,
    });
    const alreadyLive = await outcome(
      requestGoLive(env, builder, workflow.id, { version: 1, revision: 2 })
    );
    const backToTesting = await outcome(
      setWorkflowStage(env, builder, workflow.id, {
        stage: "testing",
        revision: 2,
      })
    );
    const scaling = await setWorkflowStage(env, builder, workflow.id, {
      stage: "scaling",
      revision: 2,
    });
    // The owner asks for the next version: an admin approves it, and the
    // workflow stays scaling.
    await requestGoLive(env, owner, workflow.id, { version: 2, revision: 3 });
    const ownRequest = await decide(owner, 2, 4);
    const second = await decideGoLive(env, admin, workflow.id, {
      version: 2,
      verdict: "approve",
      revision: 4,
    });

    const goLiveEvents = await lifecycleEvents(workflow.id);

    expect({
      unpublished,
      byUser,
      asked: {
        goLive: asked.goLive?.version,
        canDecideAsker: asked.canDecide,
        canDecideOwner: ownerSees.canDecide,
      },
      refused,
      approved: {
        stage: approved.stage,
        live: approved.live?.version,
        approvedBy: approved.live?.approvedBy,
        goLive: approved.goLive,
      },
      alreadyLive,
      backToTesting,
      scaling: scaling.stage,
      ownRequest,
      second: { stage: second.stage, live: second.live?.version },
      audited: goLiveEvents
        .filter(({ action }) => action.startsWith("workflow.go_live."))
        .map(({ action, detail }) => ({ action, detail })),
    }).toStrictEqual({
      unpublished: "workflow.go_live_invalid",
      byUser: "role.forbidden",
      asked: { goLive: 1, canDecideAsker: false, canDecideOwner: true },
      refused: {
        builderOwnRequest: "role.forbidden",
        user: "role.forbidden",
        otherVersion: "workflow.go_live_not_pending",
      },
      approved: {
        stage: "live",
        live: 1,
        approvedBy: owner.userId,
        goLive: null,
      },
      alreadyLive: "workflow.go_live_invalid",
      backToTesting: "workflow.stage_invalid",
      scaling: "scaling",
      ownRequest: "workflow.go_live_own_request",
      second: { stage: "scaling", live: 2 },
      audited: [
        {
          action: "workflow.go_live.requested",
          detail: { version: 1, replaced: null },
        },
        {
          action: "workflow.go_live.approved",
          detail: { version: 1, previous: null, requestedBy: builder.userId },
        },
        {
          action: "workflow.go_live.requested",
          detail: { version: 2, replaced: null },
        },
        {
          action: "workflow.go_live.approved",
          detail: { version: 2, previous: 1, requestedBy: owner.userId },
        },
      ],
    });
  });

  it("refuses a write over a revision another write moved on, and a rejection leaves nothing live", async () => {
    const owner = await person("builder");
    const workflow = await createWorkflowResource(
      env,
      owner,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, owner, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    const admin = await person("admin");
    // Two writers read revision 0: the second to land is refused.
    await requestGoLive(env, owner, workflow.id, { version: 1, revision: 0 });
    const stale = await outcome(
      pauseWorkflow(env, admin, workflow.id, { revision: 0 })
    );
    const rejected = await decideGoLive(env, admin, workflow.id, {
      version: 1,
      verdict: "reject",
      revision: 1,
    });

    const staleEvents = await lifecycleEvents(workflow.id);

    expect({
      stale,
      rejected: {
        stage: rejected.stage,
        live: rejected.live,
        goLive: rejected.goLive,
        paused: rejected.paused,
        revision: rejected.revision,
      },
      audited: staleEvents.map(({ action }) => action),
    }).toStrictEqual({
      stale: "workflow.lifecycle_conflict",
      rejected: {
        stage: "testing",
        live: null,
        goLive: null,
        paused: null,
        revision: 2,
      },
      audited: ["workflow.go_live.requested", "workflow.go_live.rejected"],
    });
  });

  it("lets only its builders change it, never Grasp staff, while anyone with a role reads it", async () => {
    const owner = await person("builder");
    const workflow = await workflowOf(owner);
    const staff = await person("admin", true);
    const stranger = await person("builder");
    const read = await workflowLifecycle(env, workflow.user, workflow.id);

    expect({
      read: { stage: read.stage, canChange: read.canChange },
      user: await outcome(
        pauseWorkflow(env, workflow.user, workflow.id, { revision: 0 })
      ),
      staff: await outcome(
        pauseWorkflow(env, staff, workflow.id, { revision: 0 })
      ),
      stranger: await outcome(workflowLifecycle(env, stranger, workflow.id)),
      invalid: await outcome(
        setWorkflowStage(env, owner, workflow.id, {
          stage: "shipped",
          revision: 0,
        })
      ),
      audited: await lifecycleEvents(workflow.id),
    }).toStrictEqual({
      read: { stage: "testing", canChange: false },
      user: "role.forbidden",
      staff: "role.forbidden",
      stranger: "workflow.resource_unavailable",
      invalid: "workflow.resource_invalid",
      audited: [],
    });
  });
});

describe("a paused workflow", { timeout: 120_000 }, () => {
  it("starts nothing until resumed, a start decided before the pause included", async () => {
    const owner = await person("builder");
    const workflow = await workflowOf(owner);
    const decided = await decideWorkflowStart(
      env,
      { type: "person", person: workflow.user },
      workflow.id,
      { version: 1, input: { who: "Ada" }, key: `key-${unique()}` }
    );
    if ("start" in decided) {
      throw new Error("A new start was answered as one already admitted");
    }
    const paused = await pauseWorkflow(env, workflow.builder, workflow.id, {
      revision: 0,
    });
    const pausedAgain = await pauseWorkflow(env, owner, workflow.id, {
      revision: 1,
    });
    const decidedBefore = await outcome(
      admitWorkflowStart(env, decided.authorization)
    );
    const whilePaused = await outcome(startBy(workflow.user, workflow.id));
    const resumed = await resumeWorkflow(env, owner, workflow.id, {
      revision: 1,
    });
    const afterResume = await outcome(startBy(workflow.user, workflow.id));
    const events = await allEvents();
    const refusals = events
      .filter(
        ({ target, action }) =>
          target?.id === workflow.id && action === "workflow.start.refused"
      )
      .map(({ detail }) => detail.reason);

    const pauseEvents = await lifecycleEvents(workflow.id);

    expect({
      paused: { by: paused.paused?.by, revision: paused.revision },
      pausedAgain: pausedAgain.revision,
      decidedBefore,
      whilePaused,
      resumed: { paused: resumed.paused, revision: resumed.revision },
      afterResume,
      refusals,
      audited: pauseEvents.map(({ action, actor }) => ({ action, actor })),
    }).toStrictEqual({
      paused: { by: workflow.builder.userId, revision: 1 },
      pausedAgain: 1,
      decidedBefore: "workflow.start_denied",
      whilePaused: "workflow.paused",
      resumed: { paused: null, revision: 2 },
      afterResume: "ok",
      refusals: ["workflow.start_denied", "workflow.paused"],
      audited: [
        {
          action: "workflow.paused",
          actor: { type: "person", userId: workflow.builder.userId },
        },
        {
          action: "workflow.resumed",
          actor: { type: "person", userId: owner.userId },
        },
      ],
    });
  });

  it("skips its schedules' occurrences, audited, without counting them toward stopping", async () => {
    const admin = await person("admin");
    const workflow = await createWorkflowResource(
      env,
      admin,
      `greet-${unique()}`
    );
    await publishWorkflowVersion(env, admin, workflow.id, {
      definition: definitionOf(workflow.name),
      basedOn: null,
    });
    const trigger = await createTriggerResource(env, admin, {
      kind: "schedule",
      workflowId: workflow.id,
      version: 1,
      config: {
        schedule: { cron: "* * * * *", timeZone: "UTC" },
        input: { who: "Ada" },
        missedOccurrences: "coalesce",
      },
    });
    const request: PermissionRequest = {
      subject: {
        type: "trigger",
        triggerId: triggerIdSchema.parse(trigger.id),
      },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    };
    const { id: permission } = await requestPermission(env, admin, request, {
      app: () => {
        throw new Error("No App here");
      },
      resource: async (ref, needed) => {
        await requireResourceRole(env, admin, ref, needed);
      },
    });
    await grantPermission(env, admin, permission, { version: null });
    await pauseWorkflow(env, admin, workflow.id, { revision: 0 });
    // One refusal short of stopping, as if it had failed before.
    const minute = 60_000;
    const occurrence = new Date(
      Math.floor(Date.now() / minute) * minute - minute
    );
    await env.DB.prepare(
      "UPDATE trigger_schedules SET next_at = ?, failed_starts = ? WHERE trigger_id = ?"
    )
      .bind(occurrence.getTime(), maxFailedStarts - 1, trigger.id)
      .run();
    await startDueScheduleTriggers(env);
    const schedule = await env.DB.prepare(
      "SELECT next_at AS nextAt, failed_starts AS failedStarts FROM trigger_schedules WHERE trigger_id = ?"
    )
      .bind(trigger.id)
      .first<{ nextAt: number | null; failedStarts: number }>();
    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workflow_start_receipts WHERE invoker_type = 'trigger' AND invoker_id = ?"
    )
      .bind(trigger.id)
      .first<{ count: number }>();
    const logged = await allEvents();
    const audited = logged
      .filter(
        ({ target, action }) =>
          target?.id === trigger.id && action.startsWith("trigger.schedule.")
      )
      .map(({ action, detail }) => ({ action, detail }));

    expect({
      movedOn: (schedule?.nextAt ?? 0) > occurrence.getTime(),
      failedStarts: schedule?.failedStarts,
      runs: runs?.count,
      audited,
    }).toStrictEqual({
      movedOn: true,
      failedStarts: maxFailedStarts - 1,
      runs: 0,
      audited: [
        {
          action: "trigger.schedule.refused",
          detail: {
            version: 1,
            scheduledAt: occurrence.toISOString(),
            code: "workflow.paused",
          },
        },
      ],
    });
  });
});
