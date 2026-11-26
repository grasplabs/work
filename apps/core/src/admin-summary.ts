import { adminSnapshotSchema } from "@grasp-os/shared/admin-snapshot";
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import {
  adminSummaryMaxBytes,
  adminSummaryMaxSkewMs,
  adminSummaryPurpose,
  adminSummaryRequestSchema,
  adminSummaryRunDays,
  adminSummarySchema,
  adminSummaryWeeks,
  fewPeople,
  fewPeopleBelow,
} from "@grasp-os/shared/admin-summary";
import type {
  AdminSummary,
  CoreNeedKind,
} from "@grasp-os/shared/admin-summary";
import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { snapshotOf } from "./admin-snapshot.ts";
import { auditLog } from "./audit-log.ts";
import { organizationId } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { consoleSigned } from "./console-signed.ts";
import {
  agents,
  apps,
  workflowResourceLifecycles,
  workflowResources,
} from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import { staffAccessEnded } from "./onboarding/gate.ts";
import { summaryOf } from "./onboarding/summary.ts";
import { activityOf } from "./workflows/activity.ts";
import { everyRun } from "./workflows/run-view.ts";

// Grasp's admin's summary of this client (@grasp-os/shared/admin-summary):
// how it stands, in counts and dates, for the admin's sidebar and Inbox,
// which used to read the whole admin snapshot for its counts alone. What
// it can't let happen, and what stops it here:
//
// - Anyone but Grasp's admin reading it: a member, the company's admin,
//   someone with an interview link, the admin's key for another client or
//   another purpose. It isn't behind `/rpc` or any session: only a request
//   signed with the key derived for this purpose alone from this client's
//   auth secret reads it (console-signed.ts), fresh, small and well formed,
//   after the router-secret check every path passes.
// - A person, or anything anyone wrote, reaching the admin: the answer is
//   counts and dates only, and only what the schema names leaves core.
//   The needs are worked out from the admin snapshot with the admin's own
//   code (`adminViewOf`), so they count exactly what the admin would show,
//   and leave as a count per kind: never the team, lead or work each is
//   about. Active people leave the audit log as a count per week.
//
// No read is put in the audit log, as none of the onboarding summary's or
// the AI status report's is: the answer holds no personal data, so there is
// nothing about anyone for the company to see read. For the same reason it
// is answered after the company ended Grasp's staff access, as those are,
// but then only with what running the service needs: where the onboarding
// stands, what needs Grasp, and how its connections stand; how it uses
// Grasp (`activity`, `asked`) is sent as null. The snapshot, which names
// people, is refused then.

const dayMs = 24 * 60 * 60 * 1000;

/** How the company uses Grasp, while it shares it. */
type Activity = NonNullable<AdminSummary["activity"]>;

/** `YYYY-MM-DD` of the UTC day `day` days after 1 January 1970. */
const dateOf = (day: number): string =>
  new Date(day * dayMs).toISOString().slice(0, 10);

/**
 * What needs Grasp, as the admin's view of the snapshot says (the same
 * code the admin runs, src/admin/views.ts there), by kind and the most
 * pressing first: how many of each, nothing of what each is about.
 */
const needsOf = (snapshot: AdminSnapshot): AdminSummary["needs"] => {
  const { org, state } = adminOrgOf(snapshot, {
    id: organizationId,
    name: snapshot.company.name,
  });
  const view = adminViewOf(org, state, snapshot.now.slice(0, 10));
  const counts = new Map<CoreNeedKind, number>();
  for (const { kind } of view.needs) {
    // Never from core's view: the admin reads invoices from Stripe.
    if (kind !== "overdue") {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts].map(([kind, needs]) => ({ kind, count: needs }));
};

/**
 * The company's shared connections by how they stand, those Composio
 * couldn't be asked about now left out; null when connect didn't answer.
 */
const connectorsOf = (
  integrations: AdminSnapshot["integrations"]
): AdminSummary["connectors"] => {
  if (integrations === null) {
    return null;
  }
  const counts = { works: 0, again: 0, stopped: 0 };
  for (const { state } of integrations.connected) {
    if (state !== "unread") {
      counts[state] += 1;
    }
  }
  return counts;
};

/**
 * What runs in the company: every workflow's runs over the last days
 * (`activityOf`, as the Workflows page counts them, by the UTC day each
 * started), and how many workflows are published and not paused, Apps
 * live (published, not archived or removed), and agents on (the
 * company's and people's own).
 */
const runningOf = async (
  env: Env,
  at: Date
): Promise<Omit<Activity, "activePeople">> => {
  const db = drizzle(env.DB);
  const [workflows, [live], [appsLive], [agentsOn]] = await db.batch([
    db.select({ id: workflowResources.id }).from(workflowResources),
    db
      .select({ count: count() })
      .from(workflowResources)
      .leftJoin(
        workflowResourceLifecycles,
        eq(workflowResourceLifecycles.workflowResourceId, workflowResources.id)
      )
      .where(
        and(
          isNotNull(workflowResources.currentVersion),
          isNull(workflowResources.deletedAt),
          isNull(workflowResourceLifecycles.pausedAt)
        )
      ),
    db
      .select({ count: count() })
      .from(apps)
      .where(
        and(
          isNotNull(apps.currentVersion),
          isNull(apps.archivedAt),
          isNull(apps.removedAt)
        )
      ),
    db.select({ count: count() }).from(agents).where(eq(agents.state, "on")),
  ]);
  const activity = await activityOf(
    env,
    { workflows: [], scope: everyRun(workflows.map(({ id }) => id)) },
    { days: adminSummaryRunDays },
    at
  );
  return {
    runs: activity.days.map(({ day, completed, failed }) => ({
      day,
      done: completed,
      failed,
    })),
    workflowsLive: live?.count ?? 0,
    appsLive: appsLive?.count ?? 0,
    agentsOn: agentsOn?.count ?? 0,
  };
};

/**
 * Weekly active people: for each of the last weeks up to `at`, Monday to
 * Sunday in UTC, how many distinct people did something themselves in
 * it, counted from the audit log's `active_weeks` table (week, user_id),
 * one row per person per week, which the log writes in the transaction
 * that appends an event whose `actor.type` is `person` (by
 * `actor.userId`), the week being the Monday of the event's own `at`
 * (`AuditLog.activePeople`). That is anything a signed-in member did that
 * core audits: a chat turn's model calls, a change, an audited read, a
 * press on a card in a chat app. Staff (`staff`), agents working on their
 * own (`agent`), Apps, workflow runs and the platform (`system`) count as
 * nobody. A week without anyone is 0; one with 1 to 4 people is sent as
 * `fewPeople` ("1–4"), so staff never learn of one person's activity
 * where the company is one or two people; 5 or more exactly. The table
 * fills from the release that added it on (earlier weeks read 0), and
 * keeps the last 9 weeks: one more than the summary's 8, and the
 * person's rows go when they are erased.
 */
const activePeopleOf = async (
  env: Env,
  at: Date
): Promise<Activity["activePeople"]> => {
  const today = Math.floor(at.getTime() / dayMs);
  // Days since Monday: 1 January 1970 was a Thursday.
  const monday = today - ((today + 3) % 7);
  const first = monday - 7 * (adminSummaryWeeks - 1);
  const weeks = await auditLog(env).activePeople(dateOf(first));
  const counted = new Map(weeks.map(({ week, people }) => [week, people]));
  return Array.from({ length: adminSummaryWeeks }, (_, index) => {
    const week = dateOf(first + 7 * index);
    const people = counted.get(week) ?? 0;
    return {
      week,
      people: people > 0 && people < fewPeopleBelow ? fewPeople : people,
    };
  });
};

/** The summary of this client at `at`, from what core holds. */
export const adminSummaryOf = async (
  env: Env,
  at: Date
): Promise<AdminSummary> => {
  const now = at.toISOString();
  // Once the company ended Grasp's staff access, only what running the
  // service needs: how it uses Grasp isn't read at all.
  const shared = !(await staffAccessEnded(
    env,
    signInConfig(env)?.staff?.opened
  ));
  const [snapshot, activity] = await Promise.all([
    // Read as the admin reads it: what the admin's view is worked out from.
    (async () => adminSnapshotSchema.parse(await snapshotOf(env, now)))(),
    shared
      ? (async () => {
          const [running, activePeople] = await Promise.all([
            runningOf(env, at),
            activePeopleOf(env, at),
          ]);
          return { ...running, activePeople };
        })()
      : null,
  ]);
  const { gate } = snapshot;
  const { stage, day, days, known } = summaryOf(snapshot, gate, now);
  return {
    now,
    onboarding: {
      stage,
      day,
      days,
      known,
      threshold: gate.threshold,
      told: snapshot.told,
      paused: snapshot.paused,
      ready: gate.ready,
      open: gate.open,
      openedAt: gate.openedAt,
    },
    needs: needsOf(snapshot),
    connectors: connectorsOf(snapshot.integrations),
    asked: shared ? snapshot.asked.length : null,
    activity,
  };
};

/**
 * The admin's request for the summary: 200 with it, once the request is
 * signed, fresh and well formed; 403 for anything else, logged with why;
 * anything but a `POST` a path core doesn't serve.
 */
export const adminSummaryResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const asked = await consoleSigned(request, env, {
    purpose: adminSummaryPurpose,
    schema: adminSummaryRequestSchema,
    maxBytes: adminSummaryMaxBytes,
    maxSkewMs: adminSummaryMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("admin.summary.refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  // Only what the schema names leaves core. No audit entry: see the top
  // of this file.
  const summary = adminSummarySchema.parse(
    await adminSummaryOf(env, new Date())
  );
  return Response.json(summary, {
    headers: { "cache-control": "no-store" },
  });
};
