import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { maxFailedStarts, workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { listNotifications } from "../src/notifications.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  createTriggerResource,
  deleteTriggerResource,
  setTriggerEnabled,
  updateTriggerVersion,
} from "../src/trigger-resources.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { startDueScheduleTriggers } from "../src/workflows/schedule-triggers.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// Independent schedule triggers (workflows/schedule-triggers.ts), from
// their threat model: each concrete occurrence starts one run, however
// often the clock runs or dies between starting it and moving on, and a
// run cancelled since stays cancelled; occurrences missed in an outage
// start one run; a local time the spring change skips starts nothing and
// one the autumn change repeats starts once; disabled, deleted or moved
// triggers start nothing they missed; a start refused for good is
// audited and moves on, and one that keeps failing stops, audited; and
// only a schedule, input and time zone that hold are taken.

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

/** Version `version` of workflow `name`, taking `{ [field]: string }` and handing it back. */
const definitionOf = (name: string, field: string, version = "1.0.0"): string =>
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
    input: { schema: objectSchema({ [field]: { type: "string" } }) },
    output: { schema: objectSchema({ [field]: { type: "string" } }) },
    do: [{ finish: { set: { [field]: `\${ $workflow.input.${field} }` } } }],
  });

/** A workflow of `admin`'s taking a `report`, with a second version taking a `job`. */
const reporting = async (admin: Identity) => {
  const workflow = await createWorkflowResource(
    env,
    admin,
    `report-${unique()}`
  );
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: definitionOf(workflow.name, "report"),
    basedOn: null,
  });
  return workflow;
};

/** `start` on workflow `id` for trigger `trigger`, asked and granted by `admin`: its ID. */
const grantStart = async (
  admin: Identity,
  trigger: string,
  id: string
): Promise<string> => {
  const request: PermissionRequest = {
    subject: { type: "trigger", triggerId: triggerIdSchema.parse(trigger) },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(id),
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
  return permission;
};

const nightly = { report: "nightly" };

const scheduleConfig = (
  cron = "* * * * *",
  timeZone = "UTC",
  input: unknown = nightly
) => ({
  schedule: { cron, timeZone },
  input,
  missedOccurrences: "coalesce",
});

/** A schedule trigger of `admin`'s on workflow `id`, granted unless `granted` is false. */
const scheduleTrigger = async (
  admin: Identity,
  id: string,
  {
    cron = "* * * * *",
    timeZone = "UTC",
    granted = true,
    owner = admin,
  }: {
    cron?: string;
    timeZone?: string;
    granted?: boolean;
    owner?: Identity;
  } = {}
) => {
  const trigger = await createTriggerResource(env, owner, {
    kind: "schedule",
    workflowId: id,
    version: 1,
    config: scheduleConfig(cron, timeZone),
  });
  const permission = granted
    ? await grantStart(admin, trigger.id, id)
    : undefined;
  return { ...trigger, permission };
};

/** Trigger `id`'s schedule, as core keeps it. */
const scheduleOf = async (id: string) =>
  await env.DB.prepare(
    "SELECT version, next_at AS nextAt, failed_starts AS failedStarts, attempts FROM trigger_schedules WHERE trigger_id = ?"
  )
    .bind(id)
    .first<{
      version: number;
      nextAt: number | null;
      failedStarts: number;
      attempts: number;
    }>();

/** Makes trigger `id`'s next occurrence `at`, as after an outage. */
const dueAt = async (id: string, at: Date, failedStarts = 0) => {
  await env.DB.prepare(
    "UPDATE trigger_schedules SET next_at = ?, failed_starts = ? WHERE trigger_id = ?"
  )
    .bind(at.getTime(), failedStarts, id)
    .run();
};

/** The runs trigger `trigger` started: each with its start key. */
const runsOf = async (trigger: string) => {
  const rows = await env.DB.prepare(
    "SELECT run.id, receipt.idempotency_key AS key, receipt.trigger_version AS version FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE receipt.invoker_type = 'trigger' AND receipt.invoker_id = ? ORDER BY receipt.created_at"
  )
    .bind(trigger)
    .all<{ id: string; key: string; version: number }>();
  return rows.results;
};

/** The start key of trigger `id`'s version `version` occurrence at `at`. */
const keyOf = (id: string, version: number, at: Date) =>
  `grasp:schedule:${id}:${version}:${at.toISOString()}`;

/** `env` whose database refuses, once, any statement `matches` finds. */
const failingOnce = (matches: RegExp): Env => {
  let failed = false;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (!failed && matches.test(query)) {
            failed = true;
            throw new Error("The database went away");
          }
          return target.prepare(query);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: db };
};

/**
 * `env` whose database runs `meanwhile` once, just before the batch that
 * admits a start (the one inserting its receipt) is sent: another
 * request's change landing between a due schedule's read and its start.
 */
const changedBeforeAdmission = (meanwhile: () => Promise<void>): Env => {
  let admitting = false;
  let ran = false;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (/^insert into "workflow_start_receipts"/iu.test(query)) {
            admitting = true;
          }
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]): Promise<unknown> => {
          if (admitting && !ran) {
            ran = true;
            await meanwhile();
          }
          const answer: unknown = await target.batch(statements);
          return answer;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: db };
};

/**
 * `env` in which one clock run's try fails in the workflow's own terms
 * (its queue full, as at its run limit), and `meanwhile` runs just before
 * that failure is recorded: another clock run's try of the same
 * occurrence, admitted in between.
 */
const failingWhileAnotherStarts = (meanwhile: () => Promise<void>): Env => {
  let admitting = false;
  let recording = false;
  let refused = false;
  let ran = false;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (/^insert into "workflow_start_receipts"/iu.test(query)) {
            admitting = true;
          }
          if (/^update "trigger_schedules"/iu.test(query)) {
            recording = true;
          }
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]): Promise<unknown> => {
          if (admitting && !refused) {
            refused = true;
            throw workflowErrors.create("workflow.queue_full");
          }
          if (recording && !ran) {
            ran = true;
            await meanwhile();
          }
          const answer: unknown = await target.batch(statements);
          return answer;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: db };
};

/** `env` whose run limit is full: every start's admission refused so. */
const runLimitFull = (): Env => {
  let admitting = false;
  const db = new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (/^insert into "workflow_start_receipts"/iu.test(query)) {
            admitting = true;
          }
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]): Promise<unknown> => {
          if (admitting) {
            admitting = false;
            throw workflowErrors.create("workflow.queue_full");
          }
          const answer: unknown = await target.batch(statements);
          return answer;
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  return { ...env, DB: db };
};

const minuteMs = 60_000;

/** The minute before the current one began: due now. */
const lastMinute = () =>
  new Date(Math.floor(Date.now() / minuteMs) * minuteMs - minuteMs);

describe("schedule triggers", { timeout: 120_000 }, () => {
  // Each test's schedules are its own: none left due in the next.
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE trigger_resources SET enabled = 0 WHERE kind = 'schedule'"
    ).run();
  });

  it("start one run per occurrence, however often the clock runs or dies before moving on", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    const created = await scheduleOf(trigger.id);
    const occurrence = lastMinute();
    await dueAt(trigger.id, occurrence);

    // Killed after the start, before its next occurrence was written.
    const killed = await outcome(
      startDueScheduleTriggers(
        failingOnce(/^update "trigger_schedules" set "next_at"/iu)
      )
    );
    const stillDue = await scheduleOf(trigger.id);
    // Two clock runs at once, then one more.
    await Promise.all([
      startDueScheduleTriggers(env),
      startDueScheduleTriggers(env),
    ]);
    await startDueScheduleTriggers(env);
    const runs = await runsOf(trigger.id);
    const after = await scheduleOf(trigger.id);
    const run = await vi.waitFor(
      async () => {
        const found = await resourceRunFor(
          env,
          admin,
          workflow.id,
          runs[0]?.id
        );
        expect(found.endedAt).not.toBeNull();
        return found;
      },
      { timeout: 30_000, interval: 100 }
    );
    const logged = await allEvents();
    const admitted = logged.filter(
      ({ action, detail }) =>
        action === "workflow.start.admitted" && detail.invoker === trigger.id
    );

    expect({
      firstDue: (created?.nextAt ?? 0) > Date.now() - minuteMs,
      killed,
      stillDue: stillDue?.nextAt,
      runs,
      output: run.output,
      movedOn: (after?.nextAt ?? 0) > occurrence.getTime(),
      admitted: admitted.map(({ detail }) => ({
        scheduledAt: detail.scheduledAt,
        triggerVersion: detail.triggerVersion,
      })),
    }).toStrictEqual({
      firstDue: true,
      killed: "Error: The database went away",
      stillDue: occurrence.getTime(),
      runs: [
        {
          id: runs[0]?.id,
          key: keyOf(trigger.id, 1, occurrence),
          version: 1,
        },
      ],
      output: { report: "nightly" },
      movedOn: true,
      admitted: [
        { scheduledAt: occurrence.toISOString(), triggerVersion: "1" },
      ],
    });
  });

  it("never start again an occurrence whose run was cancelled", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    const occurrence = lastMinute();
    await dueAt(trigger.id, occurrence);
    await startDueScheduleTriggers(env);
    const [started] = await runsOf(trigger.id);
    await terminateResourceRun(env, admin, workflow.id, started?.id);
    // The same occurrence due again, as a redelivery.
    await dueAt(trigger.id, occurrence);
    await startDueScheduleTriggers(env);
    const runs = await runsOf(trigger.id);
    const run = await resourceRunFor(env, admin, workflow.id, started?.id);

    expect({ runs: runs.length, status: run.status }).toStrictEqual({
      runs: 1,
      status: "cancelled",
    });
  });

  it("start one run for the occurrences an outage missed, then go on from the next", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    const firstMissed = new Date(lastMinute().getTime() - 180 * minuteMs);
    await dueAt(trigger.id, firstMissed);
    const now = new Date();
    await startDueScheduleTriggers(env, now);
    await startDueScheduleTriggers(env, now);
    const runs = await runsOf(trigger.id);
    const after = await scheduleOf(trigger.id);

    expect({
      keys: runs.map(({ key }) => key),
      next: after?.nextAt,
    }).toStrictEqual({
      keys: [keyOf(trigger.id, 1, firstMissed)],
      next: Math.floor(now.getTime() / minuteMs) * minuteMs + minuteMs,
    });
  });

  it("skip a local time the spring change skips, and start one the autumn change repeats once", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const spring = await scheduleTrigger(admin, workflow.id, {
      cron: "30 2 * * *",
      timeZone: "Europe/Amsterdam",
    });
    const autumn = await scheduleTrigger(admin, workflow.id, {
      cron: "30 2 * * *",
      timeZone: "Europe/Amsterdam",
    });
    // 2:30 CEST on 25 October 2026, then 2:30 CET an hour on.
    const repeated = new Date("2026-10-25T00:30:00Z");
    await dueAt(autumn.id, repeated);
    await startDueScheduleTriggers(env, new Date(repeated.getTime() + 1000));
    await startDueScheduleTriggers(
      env,
      new Date(repeated.getTime() + 60 * minuteMs + 1000)
    );
    const afterRepeat = await scheduleOf(autumn.id);
    await setTriggerEnabled(env, admin, autumn.id, false);
    // 2:30 CET on 27 March 2027; 28 March has no 2:30.
    const beforeGap = new Date("2027-03-27T01:30:00Z");
    await dueAt(spring.id, beforeGap);
    await startDueScheduleTriggers(env, new Date(beforeGap.getTime() + 1000));
    const afterGap = await scheduleOf(spring.id);
    const springRuns = await runsOf(spring.id);
    const autumnRuns = await runsOf(autumn.id);

    expect({
      springNext: new Date(afterGap?.nextAt ?? 0).toISOString(),
      springKeys: springRuns.map(({ key }) => key),
      autumnNext: new Date(afterRepeat?.nextAt ?? 0).toISOString(),
      autumnKeys: autumnRuns.map(({ key }) => key),
    }).toStrictEqual({
      springNext: "2027-03-29T00:30:00.000Z",
      springKeys: [keyOf(spring.id, 1, beforeGap)],
      autumnNext: "2026-10-26T01:30:00.000Z",
      autumnKeys: [keyOf(autumn.id, 1, repeated)],
    });
  });

  it("start nothing they missed while disabled, deleted or moved to another version", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    await publishWorkflowVersion(env, admin, workflow.id, {
      definition: definitionOf(workflow.name, "report", "2.0.0"),
      basedOn: 1,
    });
    const disabled = await scheduleTrigger(admin, workflow.id);
    const deleted = await scheduleTrigger(admin, workflow.id);
    const moved = await scheduleTrigger(admin, workflow.id);
    const missed = new Date(lastMinute().getTime() - 60 * minuteMs);
    await setTriggerEnabled(env, admin, disabled.id, false);
    await deleteTriggerResource(env, admin, deleted.id);
    for (const { id } of [disabled, deleted, moved]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await dueAt(id, missed);
    }
    await updateTriggerVersion(env, admin, moved.id, 2);
    const whileDisabled = await runsOf(disabled.id);
    await startDueScheduleTriggers(env);
    await setTriggerEnabled(env, admin, disabled.id, true);
    // Enabling one already enabled moves no occurrence on.
    const reenabled = await scheduleOf(disabled.id);
    await setTriggerEnabled(env, admin, disabled.id, true);
    await startDueScheduleTriggers(env);
    const counts = await Promise.all(
      [disabled, deleted, moved].map(async ({ id }) => {
        const runs = await runsOf(id);
        return runs.length;
      })
    );
    const movedSchedule = await scheduleOf(moved.id);
    const twiceEnabled = await scheduleOf(disabled.id);

    expect({
      whileDisabled: whileDisabled.length,
      counts,
      reenabledNext: (reenabled?.nextAt ?? 0) > Date.now() - minuteMs,
      sameAfterSecondEnable: twiceEnabled?.nextAt,
      moved: {
        version: movedSchedule?.version,
        future: (movedSchedule?.nextAt ?? 0) > Date.now() - minuteMs,
      },
    }).toStrictEqual({
      whileDisabled: 0,
      counts: [0, 0, 0],
      reenabledNext: true,
      sameAfterSecondEnable: reenabled?.nextAt,
      moved: { version: 2, future: true },
    });
  });

  it("audit a start refused for good and go on: a grant revoked, a person gone", async () => {
    const admin = await person("admin");
    const bob = await person("builder");
    const workflow = await reporting(admin);
    await shareWorkflowResource(env, admin, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const revoked = await scheduleTrigger(admin, workflow.id);
    const departed = await scheduleTrigger(admin, workflow.id, { owner: bob });
    await revokePermission(env, admin, revoked.permission);
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(bob.userId)
      .run();
    const occurrence = lastMinute();
    await dueAt(revoked.id, occurrence);
    await dueAt(departed.id, occurrence);
    await startDueScheduleTriggers(env);
    const schedules = await Promise.all(
      [revoked, departed].map(async ({ id }) => await scheduleOf(id))
    );
    const runs = await Promise.all(
      [revoked, departed].map(async ({ id }) => await runsOf(id))
    );
    const logged = await allEvents();
    const refusals = [revoked, departed].map(({ id }) =>
      logged
        .filter(
          ({ target, action }) =>
            target?.id === id && action === "trigger.schedule.refused"
        )
        .map(({ detail }) => detail)
    );

    expect({
      movedOn: schedules.map(
        (schedule) => (schedule?.nextAt ?? 0) > occurrence.getTime()
      ),
      failedStarts: schedules.map((schedule) => schedule?.failedStarts),
      runs: runs.map((started) => started.length),
      refusals,
    }).toStrictEqual({
      movedOn: [true, true],
      failedStarts: [1, 1],
      runs: [0, 0],
      refusals: Array.from({ length: 2 }, () => [
        {
          version: 1,
          scheduledAt: occurrence.toISOString(),
          code: "workflow.start_denied",
        },
      ]),
    });
  });

  it("only back off on core's own failures, and stop after too many refusals, audited, its owner told, until enabled again", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const failing = await scheduleTrigger(admin, workflow.id);
    const occurrence = lastMinute();
    await dueAt(failing.id, occurrence);
    // Core's database away for every try, longer than any count stops.
    for (let attempt = 0; attempt < maxFailedStarts + 2; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      await startDueScheduleTriggers(
        failingOnce(/^insert into "workflow_start_receipts"/iu),
        new Date(Date.now() + 2 ** attempt * minuteMs)
      );
    }
    const afterOutage = await scheduleOf(failing.id);
    const ungranted = await scheduleTrigger(admin, workflow.id, {
      granted: false,
    });
    // One more refusal would be too many.
    await dueAt(ungranted.id, occurrence, maxFailedStarts - 1);
    await startDueScheduleTriggers(env);
    const stopped = await scheduleOf(ungranted.id);
    const told = await listNotifications(env, admin);
    // Enabled again while enabled: its schedule starts again.
    await setTriggerEnabled(env, admin, ungranted.id, true);
    const restarted = await scheduleOf(ungranted.id);
    const ungrantedRuns = await runsOf(ungranted.id);
    const logged = await allEvents();
    const about = logged.filter(
      ({ target, action }) =>
        target?.id === ungranted.id &&
        (action.startsWith("trigger.schedule.") || action === "trigger.enabled")
    );

    expect({
      outage: {
        next: afterOutage?.nextAt,
        failedStarts: afterOutage?.failedStarts,
        backedOff: (afterOutage?.attempts ?? 0) > 0,
      },
      stopped: { next: stopped?.nextAt, failedStarts: stopped?.failedStarts },
      told: told.notifications
        .filter(({ type }) => type === "trigger_stopped")
        .map((notification) =>
          notification.type === "trigger_stopped"
            ? {
                trigger: notification.trigger,
                workflow: notification.workflow,
                workflowName: notification.workflowName,
              }
            : notification.type
        ),
      restarted: {
        future: (restarted?.nextAt ?? 0) > Date.now() - minuteMs,
        failedStarts: restarted?.failedStarts,
      },
      runs: ungrantedRuns.length,
      audited: about.map(({ action, detail }) => ({ action, detail })),
    }).toStrictEqual({
      outage: { next: occurrence.getTime(), failedStarts: 0, backedOff: true },
      stopped: { next: null, failedStarts: maxFailedStarts },
      told: [
        {
          trigger: ungranted.id,
          workflow: workflow.id,
          workflowName: workflow.name,
        },
      ],
      restarted: { future: true, failedStarts: 0 },
      runs: 0,
      audited: [
        {
          action: "trigger.schedule.refused",
          detail: {
            version: 1,
            scheduledAt: occurrence.toISOString(),
            code: "workflow.start_denied",
          },
        },
        {
          action: "trigger.schedule.stopped",
          detail: { version: 1, failedStarts: maxFailedStarts },
        },
        { action: "trigger.schedule.restarted", detail: { version: 1 } },
      ],
    });
  });

  it("wait between failed tries from the last failure, however long overdue the occurrence is", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    // Three hours overdue, after an outage.
    await dueAt(trigger.id, new Date(lastMinute().getTime() - 180 * minuteMs));
    const failing = () =>
      failingOnce(/^insert into "workflow_start_receipts"/iu);
    const now = Date.now();
    await startDueScheduleTriggers(failing(), new Date(now));
    const first = await scheduleOf(trigger.id);
    // Ten seconds on: still within the minute the first failure waits.
    await startDueScheduleTriggers(failing(), new Date(now + 10_000));
    const early = await scheduleOf(trigger.id);
    // A minute on: tried again, and now it waits two.
    await startDueScheduleTriggers(failing(), new Date(now + minuteMs));
    const second = await scheduleOf(trigger.id);
    await startDueScheduleTriggers(failing(), new Date(now + 2 * minuteMs));
    const tooSoon = await scheduleOf(trigger.id);

    expect({
      first: first?.attempts,
      early: early?.attempts,
      second: second?.attempts,
      tooSoon: tooSoon?.attempts,
    }).toStrictEqual({ first: 1, early: 1, second: 2, tooSoon: 2 });
  });

  it("start nothing for an occurrence that stopped being the next between its read and its start", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    const stale = lastMinute();
    await dueAt(trigger.id, stale);
    // Disabled and enabled again meanwhile: its schedule worked out anew.
    const reworked = stale.getTime() + 60 * minuteMs;
    await startDueScheduleTriggers(
      changedBeforeAdmission(async () => {
        await env.DB.prepare(
          "UPDATE trigger_schedules SET next_at = ? WHERE trigger_id = ?"
        )
          .bind(reworked, trigger.id)
          .run();
      })
    );
    const runs = await runsOf(trigger.id);
    const after = await scheduleOf(trigger.id);

    expect({
      runs: runs.length,
      next: after?.nextAt,
      failedStarts: after?.failedStarts,
    }).toStrictEqual({ runs: 0, next: reworked, failedStarts: 0 });
  });

  it("never count an occurrence failed, or stop for it, once another clock run started it", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const trigger = await scheduleTrigger(admin, workflow.id);
    const occurrence = lastMinute();
    // One more failure would stop it.
    await dueAt(trigger.id, occurrence, maxFailedStarts - 1);
    await startDueScheduleTriggers(
      failingWhileAnotherStarts(async () => {
        // The other clock run's try of the same occurrence, admitted.
        await startWorkflow(
          env,
          { type: "trigger", triggerId: trigger.id },
          workflow.id,
          { version: 1, input: nightly, key: keyOf(trigger.id, 1, occurrence) },
          undefined,
          { scheduledAt: occurrence.toISOString(), triggerVersion: "1" }
        );
      })
    );
    const between = await scheduleOf(trigger.id);
    // The next clock run moves it on from the occurrence started.
    await startDueScheduleTriggers(env);
    const after = await scheduleOf(trigger.id);
    const runs = await runsOf(trigger.id);
    const logged = await allEvents();

    expect({
      between: { next: between?.nextAt, failedStarts: between?.failedStarts },
      movedOn: (after?.nextAt ?? 0) > occurrence.getTime(),
      failedStarts: after?.failedStarts,
      runs: runs.map(({ key }) => key),
      stopped: logged.filter(
        ({ action, target }) =>
          action === "trigger.schedule.stopped" && target?.id === trigger.id
      ).length,
    }).toStrictEqual({
      between: {
        next: occurrence.getTime(),
        failedStarts: maxFailedStarts - 1,
      },
      movedOn: true,
      failedStarts: 0,
      runs: [keyOf(trigger.id, 1, occurrence)],
      stopped: 0,
    });
  });

  // Where core may have died in an earlier turn at an occurrence, and what
  // may have changed since: each pair, the next turn ends where it should.
  // Dying before the start, while sending it (before its receipt) or
  // before recording a failure leaves nothing written; dying after the
  // receipt leaves the occurrence started, not moved on.
  const crashes = [
    { crash: "before the start", started: false },
    { crash: "after the start was sent, before its receipt", started: false },
    { crash: "after the receipt, before moving on", started: true },
    { crash: "before a failure was recorded", started: false },
  ] as const;
  const changes = ["revoked", "disabled", "moved", "run limit full"] as const;
  const pairs = crashes.flatMap(({ crash, started }) =>
    changes.map((change) => ({ crash, started, change }))
  );

  it.each(pairs)(
    "end where they should when core died $crash and the trigger was then $change",
    async ({ started, change }) => {
      const admin = await person("admin");
      const workflow = await reporting(admin);
      await publishWorkflowVersion(env, admin, workflow.id, {
        definition: definitionOf(workflow.name, "report", "2.0.0"),
        basedOn: 1,
      });
      const trigger = await scheduleTrigger(admin, workflow.id);
      const occurrence = lastMinute();
      await dueAt(trigger.id, occurrence);
      if (started) {
        await startWorkflow(
          env,
          { type: "trigger", triggerId: trigger.id },
          workflow.id,
          { version: 1, input: nightly, key: keyOf(trigger.id, 1, occurrence) },
          undefined,
          { scheduledAt: occurrence.toISOString(), triggerVersion: "1" }
        );
      }
      if (change === "revoked") {
        await revokePermission(env, admin, trigger.permission);
      } else if (change === "disabled") {
        await setTriggerEnabled(env, admin, trigger.id, false);
      } else if (change === "moved") {
        await updateTriggerVersion(env, admin, trigger.id, 2);
      }
      await startDueScheduleTriggers(
        change === "run limit full" ? runLimitFull() : env
      );
      const schedule = await scheduleOf(trigger.id);
      const runs = await runsOf(trigger.id);
      const counted = (schedule?.failedStarts ?? 0) > 0;
      const movedOn =
        schedule?.version === 1 &&
        (schedule.nextAt ?? 0) > occurrence.getTime();

      // Started: moved on whatever changed, unless the trigger was
      // disabled or moved, which works its schedule out again.
      const expected = started
        ? {
            runs: 1,
            counted: false,
            movedOn: change === "revoked" || change === "run limit full",
          }
        : {
            runs: 0,
            counted: change === "revoked" || change === "run limit full",
            // Refused for good moves on; a full run limit retries it.
            movedOn: change === "revoked",
          };
      expect({ runs: runs.length, counted, movedOn }).toStrictEqual(expected);
    }
  );

  it("fire once per local time they name through the hour the autumn change repeats", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const halfHourly = await scheduleTrigger(admin, workflow.id, {
      cron: "*/30 * * * *",
      timeZone: "Europe/Amsterdam",
    });
    const hourly = await scheduleTrigger(admin, workflow.id, {
      cron: "0 * * * *",
      timeZone: "Europe/Amsterdam",
    });
    // 2:00 CEST on 25 October 2026; 2:00 to 3:00 CET repeats it.
    const start = new Date("2026-10-25T00:00:00Z");
    await dueAt(halfHourly.id, start);
    await dueAt(hourly.id, start);
    for (let step = 0; step <= 4; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one clock run after another
      await startDueScheduleTriggers(
        env,
        new Date(start.getTime() + step * 30 * minuteMs + 1000)
      );
    }
    const keysOf = async (id: string) => {
      const runs = await runsOf(id);
      return runs.map(({ key }) => key.split(":").slice(4).join(":"));
    };

    expect({
      halfHourly: await keysOf(halfHourly.id),
      hourly: await keysOf(hourly.id),
    }).toStrictEqual({
      // 2:00 and 2:30 CEST, then 3:00 CET: not 2:00 and 2:30 CET again.
      halfHourly: [
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T02:00:00.000Z",
      ],
      hourly: ["2026-10-25T00:00:00.000Z", "2026-10-25T02:00:00.000Z"],
    });
  });

  it("take only a schedule, time zone and input that hold, for every version they move to", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    await publishWorkflowVersion(env, admin, workflow.id, {
      definition: definitionOf(workflow.name, "job", "2.0.0"),
      basedOn: 1,
    });
    const create = async (config: unknown) =>
      await outcome(
        createTriggerResource(env, admin, {
          kind: "schedule",
          workflowId: workflow.id,
          version: 1,
          config,
        })
      );
    const trigger = await scheduleTrigger(admin, workflow.id);

    expect({
      sixFields: await create(scheduleConfig("0 * * * * *")),
      nonsense: await create(scheduleConfig("every day")),
      neverAgain: await create(scheduleConfig("0 0 30 2 *")),
      zone: await create(scheduleConfig("* * * * *", "Mars/Olympus")),
      input: await create(scheduleConfig("* * * * *", "UTC", { job: "x" })),
      tooLarge: await create(
        scheduleConfig("* * * * *", "UTC", {
          report: "x".repeat(platformLimits.operationInputBytes),
        })
      ),
      backlog: await create({
        ...scheduleConfig(),
        missedOccurrences: "all",
      }),
      moveToOtherInput: await outcome(
        updateTriggerVersion(env, admin, trigger.id, 2)
      ),
    }).toStrictEqual({
      sixFields: "workflow.resource_invalid",
      nonsense: "workflow.resource_invalid",
      neverAgain: "workflow.resource_invalid",
      zone: "workflow.resource_invalid",
      input: "workflow.resource_invalid",
      tooLarge: "workflow.resource_invalid",
      backlog: "workflow.resource_invalid",
      moveToOtherInput: "workflow.resource_invalid",
    });
  });
});
