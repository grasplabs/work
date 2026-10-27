import type { EventListener } from "@grasp-os/shared/connect";
import {
  connectorEventActions,
  eventListenerSchema,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { triggerIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { valueAtPointer } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import type { ConnectorEvent } from "@grasp-os/shared/workflows";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import {
  connectorTriggerHolds,
  permissions,
  triggerResources,
  triggerResourceVersions,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { allowingPermissionSql } from "../permissions.ts";
import { inputMappingSchema } from "../trigger-resources.ts";
import type { InputMapping } from "../trigger-resources.ts";
import { isStaleRefusal, startWorkflow } from "../workflow-starts.ts";
import type { TriggerCause } from "../workflow-starts.ts";
import type { StampedRun } from "./mail-stamps.ts";
import { admitChild } from "./quotas.ts";
import { runOf } from "./resource-runs.ts";
import { triggeredRunsPerHour } from "./runs.ts";

// Starting independent workflows from the events connections report
// (platform specification 15.1, "Connect verified event"; trigger-
// resources.ts), as core takes them from connect (connector-events.ts,
// `pumpConnectorEvents`) beside Apps' event triggers. Threat model, and
// how each is closed:
//
// - An event starting a trigger's run twice: a delivery tried again after
//   another start failed, a lost acknowledgement. Each start is keyed by
//   the trigger and a hash of the connection and the source's ID of the
//   event (`startKeyOf`), and a start's receipt is one per trigger, person
//   and key (workflow-starts.ts): the same event delivered again is the
//   same start, its run the same run, a cancelled one too.
// - An event reaching a trigger that didn't ask for it. Only live,
//   enabled connector triggers whose current version names the event's
//   connection, type and part of it (a mailbox, a drive, or none for the
//   account's own) take it; on a personal connection, only those acting
//   for its owner, as connect lets only its owner's calls use it.
// - A trigger hearing a connection it may not. It hears only with an
//   active grant of its own of the event's read action on exactly that
//   connection and part (`allowingPermissionSql`, as an App's events are
//   checked), which only an admin gives (permissions.ts); connect listens
//   only where such a grant is (`triggerListeners`). The grant is read
//   again in the statement that admits the start, so one revoked meanwhile
//   starts nothing. A revoked or disconnected connection reports nothing.
// - A trigger acting on authority it lost. Each delivery is a start as any
//   trigger's: the trigger live, enabled and pinning that version, its
//   person still with a role, and its own `start` grant active, read again
//   as the start is admitted.
// - Code in a mapping. The input is built from JSON Pointers into the
//   event (RFC 6901) and literal defaults (`inputOf`): nothing is
//   evaluated, and a pointer that finds nothing leaves its default. The
//   input is then checked against the workflow version's schema as any
//   start's is; one it doesn't take is refused for good.
// - A workflow starting itself without end: its own mail reaching a
//   mailbox its trigger watches, or a trigger and an App mailing each
//   other. An independent workflow's mail is stamped as an App run's is
//   (mail-stamps.ts, `resource_run_mail_calls`), and a stamped event's
//   run joins the stamping run's lineage, one level deeper, admitted
//   against its nesting and descendant limits (quotas.ts, `admitChild`),
//   so the lineage's limits end the loop (`workflow.lineage_limit`,
//   refused for good). An App run's mail can't join an independent
//   lineage (their runs are kept apart), so a stamped event of an App run
//   is refused for good, audited (`lineage.unjoinable`), never started as a
//   new root. Besides, a
//   trigger starts at most `triggeredRunsPerHour` runs an hour, counted as
//   each is admitted; past that the event waits in connect's outbox and is
//   delivered again later, and one held back longer than `maxHeldMs` is
//   dropped for the trigger, audited (`workflow.event.dropped`), so the
//   backlog can't grow without end.
// - An event dropped silently. A trigger that refuses it for good (its
//   grant to start revoked, its person gone, an input its workflow doesn't
//   take, its lineage full, an App run's mail) is audited
//   (`workflow.event.refused`) and the event settled for it; anything
//   else fails the delivery, so connect delivers it again, until held
//   back too long, audited as dropped.

/** A connector trigger that takes an event, as its current version pins it. */
interface Taker {
  id: string;
  version: number;
  workflowId: string;
  workflowVersion: number;
  inputMapping: string | null;
}

/** The refusals of a trigger's start taken as for good. */
const refusedForGood: ReadonlySet<string> = new Set([
  "workflow.start_denied",
  "workflow.start_invalid",
  "workflow.packages_revoked",
  "workflow.lineage_limit",
]);

/** How long an event a trigger holds back at its hourly limit waits before it is dropped. */
export const maxHeldMs = 24 * 60 * 60 * 1000;

/** That trigger `id` may hear `event`, as SQL on `permissions`. */
const hearsSql = (id: string, event: ConnectorEvent): SQL =>
  sql`EXISTS (SELECT 1 FROM ${permissions} WHERE ${allowingPermissionSql(
    { type: "trigger", triggerId: triggerIdSchema.parse(id) },
    undefined,
    {
      type: "connection",
      connectionId: event.connection,
      ...(event.resource === undefined ? {} : { resource: event.resource }),
    },
    event.action
  )} AND ${
    event.resource === undefined
      ? isNull(permissions.resource)
      : eq(permissions.resource, event.resource)
  })`;

/** That trigger `id` has room for another run this hour, as SQL. */
const roomSql = (id: string): SQL =>
  sql`((SELECT COUNT(*) FROM ${workflowStartReceipts}
    WHERE ${workflowStartReceipts.invokerType} = 'trigger'
      AND ${workflowStartReceipts.invokerId} = ${id}
      AND ${workflowStartReceipts.createdAt} > ${Date.now() - 60 * 60 * 1000}) < ${triggeredRunsPerHour})`;

/**
 * The live, enabled connector triggers whose current version takes
 * `event`, that may hear it.
 */
const takersOf = async (env: Env, event: ConnectorEvent): Promise<Taker[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      version: triggerResources.currentVersion,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      inputMapping: triggerResourceVersions.inputMapping,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.kind, "connector"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt),
        eq(triggerResourceVersions.connectionId, event.connection),
        eq(triggerResourceVersions.eventType, event.type),
        event.resource === undefined
          ? isNull(triggerResourceVersions.connectionResource)
          : eq(triggerResourceVersions.connectionResource, event.resource),
        event.owner === null
          ? undefined
          : eq(triggerResourceVersions.principalBinding, event.owner)
      )
    )
    .orderBy(asc(triggerResources.id));
  const heard = await Promise.all(
    rows.map(async (row) => {
      const allowed = await drizzle(env.DB).get<{ hears: number }>(
        sql`SELECT ${hearsSql(row.id, event)} AS hears`
      );
      return allowed.hears === 1;
    })
  );
  return rows.filter((_, index) => heard[index] === true);
};

/**
 * The input `mapping` makes of `event`: its defaults, then each field the
 * event has a value at the field's pointer for. Nothing is evaluated.
 */
export const inputOf = (mapping: InputMapping, event: ConnectorEvent): Json => {
  const document = z.json().parse(event);
  const input: Record<string, Json> = {};
  for (const [field, value] of Object.entries(mapping.defaults)) {
    input[field] = value;
  }
  for (const [field, pointer] of Object.entries(mapping.fields)) {
    const value = valueAtPointer(document, pointer);
    if (value !== undefined) {
      input[field] = value;
    }
  }
  return input;
};

/** Audits that `taker` won't start `event`'s run, as `action`, with `detail`. */
const audited = async (
  env: Env,
  taker: Taker,
  event: ConnectorEvent,
  action: "workflow.event.refused" | "workflow.event.dropped",
  detail: Record<string, string | number>
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: { type: "system" },
      action,
      target: { type: "trigger", id: taker.id },
      detail: { event: event.type, version: taker.version, ...detail },
    }),
  ]);
};

/**
 * `taker` at its hourly limit for the event of key `same`: held back, to
 * be delivered again (`retry`), or, held since longer than
 * {@link maxHeldMs}, dropped for it, audited (`gone`).
 */
const heldBack = async (
  env: Env,
  taker: Taker,
  event: ConnectorEvent,
  same: string
): Promise<"gone" | "retry"> => {
  const db = drizzle(env.DB);
  await db
    .insert(connectorTriggerHolds)
    .values({ triggerId: taker.id, eventKey: same, heldSince: new Date() })
    .onConflictDoNothing();
  const held = await db
    .select({ since: connectorTriggerHolds.heldSince })
    .from(connectorTriggerHolds)
    .where(
      and(
        eq(connectorTriggerHolds.triggerId, taker.id),
        eq(connectorTriggerHolds.eventKey, same)
      )
    )
    .get();
  if (held === undefined || Date.now() - held.since.getTime() < maxHeldMs) {
    log.warn("workflow.trigger_rate_limited", {
      type: "connector",
      trigger: taker.id,
    });
    return "retry";
  }
  await audited(env, taker, event, "workflow.event.dropped", {
    reason: "hourly_limit",
    heldSince: held.since.toISOString(),
  });
  await db
    .delete(connectorTriggerHolds)
    .where(
      and(
        eq(connectorTriggerHolds.triggerId, taker.id),
        eq(connectorTriggerHolds.eventKey, same)
      )
    );
  return "gone";
};

/**
 * What became of `taker`'s start of `event` (key `same`) that threw
 * `error`: gone (the trigger disabled, deleted or moved meanwhile, or
 * refused for good, audited, or held back too long, dropped, audited:
 * settled), or to try again.
 */
const refusalOf = async (
  env: Env,
  taker: Taker,
  event: ConnectorEvent,
  same: string,
  error: unknown
): Promise<"gone" | "retry"> => {
  if (!isExpectedError(error)) {
    log.error("workflow.trigger_failed", {
      type: "connector",
      trigger: taker.id,
      ...errorFields(error),
    });
    return "retry";
  }
  if (error.code === "workflow.trigger_unavailable") {
    return "gone";
  }
  let { code } = error;
  if (isStaleRefusal(error)) {
    // What the admitting statement required besides: its grant to hear,
    // revoked for good, or its room this hour, back later.
    const now = await drizzle(env.DB).get<{ hears: number; room: number }>(
      sql`SELECT ${hearsSql(taker.id, event)} AS hears, ${roomSql(taker.id)} AS room`
    );
    if (now.hears === 1 && now.room === 0) {
      return await heldBack(env, taker, event, same);
    }
    if (now.hears === 1) {
      return "retry";
    }
    code = "permission.revoked";
  } else if (!refusedForGood.has(code)) {
    return "retry";
  }
  await audited(env, taker, event, "workflow.event.refused", { code });
  return "gone";
};

/**
 * The lineage a stamped event's run joins, for `taker`: the stamping
 * independent run's, one level deeper, admitted once per event and
 * trigger (quotas.ts, `admitChild`, which throws `workflow.lineage_limit`
 * past its limits); none for an event no run stamped; `unjoinable` for an
 * App run's mail, which can't join an independent lineage (their runs are
 * kept apart), or a run no longer kept.
 */
const causeOf = async (
  env: Env,
  taker: Taker,
  same: string,
  stamped: StampedRun | undefined
): Promise<TriggerCause | "unjoinable" | undefined> => {
  if (stamped === undefined) {
    return undefined;
  }
  const run =
    stamped.kind === "resource" ? await runOf(env, stamped.runId) : undefined;
  if (run === undefined) {
    return "unjoinable";
  }
  const place = await admitChild(
    env,
    { id: run.id, rootRunId: run.rootRunId, depth: run.depth },
    `connector:${same}:${taker.id}`
  );
  return { runId: run.id, restricted: run.restricted, place };
};

/** What delivering an event to connector triggers came to. */
export interface TriggerDelivery {
  /** How many triggers started its run (or had, delivered before). */
  runs: number;
}

/**
 * Starts the run of each connector trigger that takes `event`, keyed by
 * `same` (a hash of its connection and source ID), in the lineage of the
 * run whose mail it is (`stamped`), if any. Refusals for good are
 * audited; throws, after trying every trigger, when any start may go
 * another time (a trigger at its hourly limit, a failure of core's), so
 * the event is delivered again and starts only what didn't start.
 */
export const startConnectorTriggers = async (
  env: Env,
  event: ConnectorEvent,
  same: string,
  stamped?: StampedRun
): Promise<TriggerDelivery> => {
  const takers = await takersOf(env, event);
  const outcomes = await Promise.all(
    takers.map(async (taker): Promise<"started" | "gone" | "retry"> => {
      const key = `${coreStartKeyPrefix}connector:${taker.id}:${same}`;
      try {
        const cause = await causeOf(env, taker, same, stamped);
        if (cause === "unjoinable") {
          // Never a new root: that is how a loop would go on.
          await audited(env, taker, event, "workflow.event.refused", {
            code: "lineage.unjoinable",
          });
          return "gone";
        }
        const mapping = inputMappingSchema.parse(
          JSON.parse(taker.inputMapping ?? "{}")
        );
        await startWorkflow(
          env,
          {
            type: "trigger",
            triggerId: taker.id,
            ...(cause === undefined ? {} : { cause }),
          },
          taker.workflowId,
          {
            version: taker.workflowVersion,
            input: inputOf(mapping, event),
            key,
          },
          // Read again as it is admitted: its grant to hear, and its room.
          sql`(${hearsSql(taker.id, event)} AND (${roomSql(taker.id)}
            OR EXISTS (SELECT 1 FROM ${workflowStartReceipts}
              WHERE ${workflowStartReceipts.invokerType} = 'trigger'
                AND ${workflowStartReceipts.invokerId} = ${taker.id}
                AND ${workflowStartReceipts.idempotencyKey} = ${key})))`,
          {
            event: same,
            connection: event.connection,
            ...(cause === undefined ? {} : { emittingRun: cause.runId }),
          }
        );
        await drizzle(env.DB)
          .delete(connectorTriggerHolds)
          .where(
            and(
              eq(connectorTriggerHolds.triggerId, taker.id),
              eq(connectorTriggerHolds.eventKey, same)
            )
          );
        return "started";
      } catch (error) {
        return await refusalOf(env, taker, event, same, error);
      }
    })
  );
  if (outcomes.includes("retry")) {
    throw new Error(`Event ${event.type} didn't start every trigger's run`);
  }
  return { runs: outcomes.filter((outcome) => outcome === "started").length };
};

/**
 * Where connect listens for connector triggers: each active grant of a
 * live, enabled connector trigger to hear its connection, for its current
 * version's event type and part and that type's read action, acting for
 * the person it binds. A grant the trigger can't use (another part, or an
 * action its event type doesn't read) listens nowhere.
 */
export const triggerListeners = async (
  env: Env,
  limit: number
): Promise<EventListener[]> => {
  const listeners: EventListener[] = [];
  for (const [type, action] of Object.entries(connectorEventActions)) {
    // oxlint-disable-next-line no-await-in-loop -- one query per event type, few
    const rows = await drizzle(env.DB)
      .select({
        connection: triggerResourceVersions.connectionId,
        resource: triggerResourceVersions.connectionResource,
        owner: triggerResourceVersions.principalBinding,
      })
      .from(permissions)
      .innerJoin(
        triggerResources,
        and(
          eq(permissions.subjectType, "trigger"),
          eq(permissions.subjectId, triggerResources.id)
        )
      )
      .innerJoin(
        triggerResourceVersions,
        and(
          eq(triggerResourceVersions.triggerId, triggerResources.id),
          eq(triggerResourceVersions.version, triggerResources.currentVersion)
        )
      )
      .where(
        and(
          eq(triggerResources.kind, "connector"),
          eq(triggerResources.enabled, true),
          isNull(triggerResources.deletedAt),
          eq(triggerResourceVersions.eventType, type),
          eq(permissions.status, "active"),
          eq(permissions.objectType, "connection"),
          eq(permissions.objectId, triggerResourceVersions.connectionId),
          sql`${permissions.resource} IS ${triggerResourceVersions.connectionResource}`,
          sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = ${action})`
        )
      )
      .limit(limit);
    for (const row of rows) {
      const listener = eventListenerSchema.safeParse({ type, ...row });
      if (listener.success) {
        listeners.push(listener.data);
      }
    }
  }
  return listeners.slice(0, limit);
};
