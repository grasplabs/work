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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  createTriggerResource,
  deleteTriggerResource,
  setTriggerEnabled,
  updateTriggerVersion,
} from "../src/trigger-resources.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
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

/** `start` on workflow `id` for trigger `trigger`, asked and granted by `admin`. */
const grantStart = async (admin: Identity, trigger: string, id: string) => {
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
  { cron = "* * * * *", timeZone = "UTC", granted = true } = {}
) => {
  const trigger = await createTriggerResource(env, admin, {
    kind: "schedule",
    workflowId: id,
    version: 1,
    config: scheduleConfig(cron, timeZone),
  });
  if (granted) {
    await grantStart(admin, trigger.id, id);
  }
  return trigger;
};

/** Trigger `id`'s schedule, as core keeps it. */
const scheduleOf = async (id: string) =>
  await env.DB.prepare(
    "SELECT version, next_at AS nextAt, failed_starts AS failedStarts FROM trigger_schedules WHERE trigger_id = ?"
  )
    .bind(id)
    .first<{ version: number; nextAt: number | null; failedStarts: number }>();

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

  it("audit a start refused for good and go on, and stop, audited, after too many failures", async () => {
    const admin = await person("admin");
    const workflow = await reporting(admin);
    const ungranted = await scheduleTrigger(admin, workflow.id, {
      granted: false,
    });
    const failing = await scheduleTrigger(admin, workflow.id);
    const occurrence = lastMinute();
    await dueAt(ungranted.id, occurrence);
    await dueAt(failing.id, occurrence);
    // A failure of core's own: the occurrence stays due, tried later.
    await startDueScheduleTriggers(
      failingOnce(/^insert into "workflow_start_receipts"/iu)
    );
    const afterRefusal = await scheduleOf(ungranted.id);
    const afterFailure = await scheduleOf(failing.id);
    // One more failure would be too many.
    await dueAt(ungranted.id, occurrence, maxFailedStarts - 1);
    await startDueScheduleTriggers(
      env,
      new Date(Date.now() + 2 ** maxFailedStarts * minuteMs)
    );
    const stopped = await scheduleOf(ungranted.id);
    const ungrantedRuns = await runsOf(ungranted.id);
    const logged = await allEvents();
    const about = logged.filter(
      ({ target, action }) =>
        target?.id === ungranted.id && action.startsWith("trigger.schedule.")
    );

    expect({
      refused: {
        movedOn: (afterRefusal?.nextAt ?? 0) > occurrence.getTime(),
        failedStarts: afterRefusal?.failedStarts,
      },
      failed: {
        next: afterFailure?.nextAt,
        failedStarts: afterFailure?.failedStarts,
      },
      stopped: { next: stopped?.nextAt, failedStarts: stopped?.failedStarts },
      runs: ungrantedRuns.length,
      audited: about.map(({ action, detail }) => ({ action, detail })),
    }).toStrictEqual({
      refused: { movedOn: true, failedStarts: 1 },
      failed: { next: occurrence.getTime(), failedStarts: 1 },
      stopped: { next: null, failedStarts: maxFailedStarts },
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
      ],
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
      backlog: "workflow.resource_invalid",
      moveToOtherInput: "workflow.resource_invalid",
    });
  });
});
