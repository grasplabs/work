import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { maxFailedStarts } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { pauseWorkflow, resumeWorkflow } from "../src/workflow-pause.ts";
import {
  createWorkflowResource,
  getWorkflowResource,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  admitWorkflowStart,
  decideWorkflowStart,
  startWorkflow,
} from "../src/workflow-starts.ts";
import { startDueScheduleTriggers } from "../src/workflows/schedule-triggers.ts";
import { allEvents } from "./audit-events.ts";
import { greetingOf } from "./json-workflow-apps.ts";
import { outcome, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// An independent workflow's pause (workflow-pause.ts), from its
// threat model: a paused workflow starts nothing, from people or
// triggers, a start decided before the pause included, and its schedules
// skip without stopping; Grasp staff and users change nothing. Each test
// makes its own people and workflows.

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
    await publishDefinition(
      env,
      owner,
      workflow.id,
      greetingOf(undefined, `Version ${version}`)
    );
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
    args: { who: "Ada" },
    key: `key-${unique()}`,
  });

/** The pause events audited on workflow `id`, oldest first. */
const pauseEventsOf = async (id: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ target, action }) =>
        target?.id === id &&
        (action === "workflow.paused" || action === "workflow.resumed")
    )
    .map(({ action, actor, detail }) => ({ action, actor, detail }));
};

describe("a workflow's pause", { timeout: 60_000 }, () => {
  it("lets only its builders change it, never Grasp staff, while anyone with a role reads it on the workflow", async () => {
    const owner = await person("builder");
    const workflow = await workflowOf(owner);
    const staff = await person("admin", true);
    const stranger = await person("builder");
    const read = await getWorkflowResource(env, workflow.user, workflow.id);

    expect({
      read: { paused: read.paused, role: read.role },
      user: await outcome(pauseWorkflow(env, workflow.user, workflow.id)),
      staff: await outcome(pauseWorkflow(env, staff, workflow.id)),
      stranger: await outcome(pauseWorkflow(env, stranger, workflow.id)),
      audited: await pauseEventsOf(workflow.id),
    }).toStrictEqual({
      read: { paused: false, role: "user" },
      user: "role.forbidden",
      staff: "role.forbidden",
      stranger: "workflow.resource_unavailable",
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
      { version: 1, args: { who: "Ada" }, key: `key-${unique()}` }
    );
    if ("start" in decided) {
      throw new Error("A new start was answered as one already admitted");
    }
    const paused = await pauseWorkflow(env, workflow.builder, workflow.id);
    const pausedAgain = await pauseWorkflow(env, owner, workflow.id);
    const decidedBefore = await outcome(
      admitWorkflowStart(env, decided.authorization)
    );
    const whilePaused = await outcome(startBy(workflow.user, workflow.id));
    const resumed = await resumeWorkflow(env, owner, workflow.id);
    const afterResume = await outcome(startBy(workflow.user, workflow.id));
    const events = await allEvents();
    const refusals = events
      .filter(
        ({ target, action }) =>
          target?.id === workflow.id && action === "workflow.start.refused"
      )
      .map(({ detail }) => detail.reason);

    const pauseEvents = await pauseEventsOf(workflow.id);

    expect({
      paused: paused.paused,
      pausedAgain: pausedAgain.paused,
      decidedBefore,
      whilePaused,
      resumed: resumed.paused,
      afterResume,
      refusals,
      audited: pauseEvents.map(({ action, actor }) => ({ action, actor })),
    }).toStrictEqual({
      paused: true,
      // Pausing a paused workflow changes nothing (audited once, below).
      pausedAgain: true,
      decidedBefore: "workflow.start_denied",
      whilePaused: "workflow.paused",
      resumed: false,
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
    await publishDefinition(env, admin, workflow.id, greetingOf());
    const trigger = await createTriggerResource(env, admin, {
      kind: "schedule",
      workflowId: workflow.id,
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
    await pauseWorkflow(env, admin, workflow.id);
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
