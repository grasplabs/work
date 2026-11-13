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
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { inputMappingSchema } from "@grasp-os/shared/workflow-triggers";
import type { InputMapping } from "@grasp-os/shared/workflow-triggers";
import type { ConnectorEvent } from "@grasp-os/shared/workflows";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "../audit-outbox.ts";
import {
  connectorTriggerHolds,
  permissions,
  triggerHourSlots,
  triggerResources,
  triggerResourceVersions,
  workflowStartReceipts,
} from "../db/core/schema.ts";
import { allowingPermissionSql } from "../permissions.ts";
import { liveWorkflow } from "../workflow-resources.ts";
import { isStaleRefusal, startWorkflow } from "../workflow-starts.ts";
import type { TriggerCause } from "../workflow-starts.ts";
import type { StampedRun } from "./mail-stamps.ts";
import { admitInLineage } from "./quotas.ts";
import { runOf } from "./resource-runs.ts";
import { triggeredRunsPerHour } from "./runs.ts";
import type { StartFiles } from "./start-files.ts";

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
//   trigger's: the trigger live and enabled, of the workflow's live
//   version, its person still with a role, and its own `start` grant active, read again
//   as the start is admitted.
// - Code in a mapping. The input is built from JSON Pointers into the
//   event (RFC 6901) and literal defaults (`inputOf`): nothing is
//   evaluated, and a pointer that finds nothing leaves its default. The
//   input is then checked against the live version's schema as any
//   start's is; one it doesn't take is refused for good.
// - A workflow starting itself without end: its own mail reaching a
//   mailbox its trigger watches, or two workflows mailing each other. A
//   workflow's mail is stamped (mail-stamps.ts, `resource_run_mail_calls`),
//   and a stamped event's run joins the stamping run's lineage, one level
//   deeper, admitted
//   against its nesting and descendant limits (quotas.ts, `admitInLineage`),
//   so the lineage's limits end the loop (`workflow.lineage_limit`,
//   refused for good). Its work is charged to its workflow's own account
//   in that lineage (quotas.ts, `triggeredAccountClaimed`), so a busy
//   workflow's runs never use up the stamping run's allowances. A stamped
//   event of a run no longer kept is refused for good, audited
//   (`lineage.unjoinable`), never started as a new root. Besides, a
//   trigger starts at most `triggeredRunsPerHour` runs an hour, counted as
//   each is admitted; past that the event waits in connect's outbox and is
//   delivered again later, and one held back longer than `maxHeldMs` is
//   dropped for the trigger, audited (`workflow.event.dropped`), so the
//   backlog can't grow without end. The residual case, as for email
//   triggers: mail through a connector that puts no stamp on it (one not
//   native, such as Composio's) is anyone's mail, a root, so a workflow
//   mailing its own watched mailbox that way goes on at up to the hourly
//   limit; the drop bounds only the backlog.
// - An event a trigger settled taken as new, or one held past its day
//   started after all. Each trigger's turn at an event is a small state
//   machine (`startConnectorTriggers`): started already (a receipt under
//   its key): settled, nothing asked again; settled for it already (a
//   tombstone: dropped or refused): nothing; held past `maxHeldMs`:
//   dropped, checked before any try; else tried. A drop or a refusal for
//   good leaves a tombstone, audited once by the write that made it, so a
//   delivery again for another trigger's sake starts and audits nothing
//   more. Holds and tombstones of events that stopped coming (a trigger
//   disabled or its grant revoked, connect giving up) are swept by the
//   clock past `holdsKeptMs`.
// - An event dropped silently. A trigger that refuses it for good (its
//   grant to start revoked, its person gone, an input its workflow doesn't
//   take, its lineage full, its workflow paused: what
//   happens while it is paused never starts it later) is audited
//   (`workflow.event.refused`) and the event settled for it; anything
//   else fails the delivery, so connect delivers it again, until held
//   back too long, audited as dropped.
// - Refusals writing the audit log without end, or events at once all
//   taking the hour's last place. Before anything that could audit (a
//   start, a refusal for good) an event takes a place in the trigger's
//   hourly room (`tookPlace`, `trigger_hour_slots`), in one conditional
//   insert: at most `triggeredRunsPerHour` an hour, however many arrive
//   together. One without a place is held back, audited by nothing, and
//   dropped after a day, audited once. A place counts only within its
//   hour: delivered again within it, an event takes no other; after it,
//   it takes a place anew under the limit, so retries never run past it.
//
// Email triggers' messages (inbound-email.ts) go through the same steps
// (`startOnce`), each message an event of its own.

/** A trigger that takes an event or a message, as its current version keeps it. */
export interface Taker {
  id: string;
  version: number;
  workflowId: string;
  inputMapping: string | null;
}

/** The refusals of a trigger's start taken as for good. */
export const refusedForGood: ReadonlySet<string> = new Set([
  "workflow.start_denied",
  "workflow.start_invalid",
  "workflow.lineage_limit",
  "workflow.paused",
  // An input holding files where nothing hands the run any, or more than a
  // start hands it: the same input is refused so again.
  "file.start_files",
  // A message's attachments past the workflow's run-file bytes: dropped,
  // audited, rather than failing every delivery until its sender gives up
  // unheard. Anyone may mail a trigger, so its runs' files can fill the
  // workflow's room; the hourly limit bounds how fast.
  "file.workflow_quota",
]);

const hourMs = 60 * 60 * 1000;

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

/**
 * Takes a place in `taker`'s hourly room for the event of key `same`, if
 * it has none in the last hour: in one conditional insert, only while
 * fewer than `triggeredRunsPerHour` were taken in the last hour, so of
 * events arriving at once no more than the room take one. A place counts
 * only within its hour: an event delivered again after its place left the
 * hour takes a new one, under the same limit, never alongside a full
 * hour. Whether the event has a place in the last hour now, taken by this
 * delivery or an earlier one.
 */
const tookPlace = async (
  env: Env,
  taker: Taker,
  same: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const hourStart = new Date(now - hourMs);
  await db
    .insert(triggerHourSlots)
    .select(
      sql`SELECT ${taker.id}, ${same}, ${now}
        WHERE (SELECT COUNT(*) FROM ${triggerHourSlots}
          WHERE ${triggerHourSlots.triggerId} = ${taker.id}
            AND ${triggerHourSlots.takenAt} > ${hourStart.getTime()}) < ${triggeredRunsPerHour}`
    )
    .onConflictDoUpdate({
      target: [triggerHourSlots.triggerId, triggerHourSlots.eventKey],
      set: { takenAt: new Date(now) },
      // Only a place that left the hour is taken anew.
      setWhere: lte(triggerHourSlots.takenAt, hourStart),
    });
  const place = await db
    .select({ takenAt: triggerHourSlots.takenAt })
    .from(triggerHourSlots)
    .where(
      and(
        eq(triggerHourSlots.triggerId, taker.id),
        eq(triggerHourSlots.eventKey, same),
        gt(triggerHourSlots.takenAt, hourStart)
      )
    )
    .get();
  return place !== undefined;
};

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
 * The input `mapping` makes of `source` (an event, a message): its
 * defaults, then each field the source has a value at the field's pointer
 * for. Nothing is evaluated.
 */
export const inputOf = (mapping: InputMapping, source: unknown): Json => {
  const document = z.json().parse(source);
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

/** Where `taker`'s row for the event of key `same` is, as SQL. */
const holdOf = (taker: Taker, same: string) =>
  and(
    eq(connectorTriggerHolds.triggerId, taker.id),
    eq(connectorTriggerHolds.eventKey, same)
  );

/**
 * One event (or message) for one trigger: what it is, what its start
 * takes, and how its refusals are audited and its failures logged.
 */
export interface Arrival {
  /** The key of the event for the trigger: its holds and tombstones are by it. */
  same: string;
  /** The start's idempotency key. */
  key: string;
  /** What a stamped event's place in its lineage is admitted once by. */
  admission: string;
  input: Json;
  /** The run whose own mail it is, if any. */
  stamped: StampedRun | undefined;
  /** What admitting its start requires besides room (a grant to hear). */
  also?: SQL;
  /** The files its start may hand its run: a message's attachments. */
  files?: StartFiles;
  /** Noted with its start. */
  noted: Readonly<Record<string, string>>;
  /**
   * The audit actions of a refusal and a drop, and the detail of both. An
   * arrival `answered` is never held back, so never dropped: it has none.
   */
  audited: {
    refused: string;
    dropped?: string;
    detail: Readonly<Record<string, string | number>>;
  };
  /** What its log lines say of it. */
  logged: Readonly<Record<string, string>>;
  /** Refused for good, as this, without a try (mail that may loop). */
  refusedAs?: string;
  /**
   * Its sender is answered at once and tries again on its own (a webhook
   * trigger's delivery): without a place in the hour's room it is told to
   * try again, holding nothing back; and when what `also` requires no
   * longer holds as it is admitted, it is told so (`stale`), settling
   * nothing, so the same arrival sent again as `also` now requires starts.
   */
  answered?: true;
}

/**
 * What became of one trigger's turn at an event: `stale` only for an
 * arrival `answered`, whose `also` no longer held as it was admitted.
 */
export type Outcome = "started" | "gone" | "retry" | "unavailable" | "stale";

/**
 * `taker` at its hourly limit for `arrival`: held back since its first
 * such try, to be delivered again. Whether it is dropped is decided before
 * its next try (`startOnce`).
 */
const heldBack = async (
  env: Env,
  taker: Taker,
  arrival: Arrival
): Promise<"retry"> => {
  await drizzle(env.DB)
    .insert(connectorTriggerHolds)
    .values({
      triggerId: taker.id,
      eventKey: arrival.same,
      heldSince: new Date(),
    })
    .onConflictDoNothing();
  log.warn("workflow.trigger_rate_limited", arrival.logged);
  return "retry";
};

/**
 * Settles `arrival` for `taker` for good, as `settled`: a tombstone
 * (`connectorTriggerHolds`), so a delivery of it again starts nothing
 * here, and audited once, only by the write that settled it.
 */
const settle = async (
  env: Env,
  taker: Taker,
  arrival: Arrival,
  settled: "dropped" | "refused",
  detail: Record<string, string | number>
): Promise<"gone"> => {
  const db = drizzle(env.DB);
  const at = new Date();
  await auditedBatch(env, db, [
    db
      .insert(connectorTriggerHolds)
      .values({
        triggerId: taker.id,
        eventKey: arrival.same,
        heldSince: at,
        settled,
        settledAt: at,
      })
      .onConflictDoUpdate({
        target: [
          connectorTriggerHolds.triggerId,
          connectorTriggerHolds.eventKey,
        ],
        set: { settled, settledAt: at },
        setWhere: isNull(connectorTriggerHolds.settled),
      }),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action:
        settled === "dropped"
          ? (arrival.audited.dropped ?? arrival.audited.refused)
          : arrival.audited.refused,
      target: { type: "trigger", id: taker.id },
      detail: { ...arrival.audited.detail, version: taker.version, ...detail },
    }),
  ]);
  return "gone";
};

/** Whether trigger `taker` is disabled or deleted now, read live. */
const isGone = async (env: Env, taker: Taker): Promise<boolean> => {
  const live = await drizzle(env.DB)
    .select({ id: triggerResources.id })
    .from(triggerResources)
    .where(
      and(
        eq(triggerResources.id, taker.id),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();
  return live === undefined;
};

/**
 * What became of `taker`'s start of `arrival` that threw `error`: gone
 * (refused for good, audited, or held back too long, dropped, audited:
 * settled), unavailable (the trigger disabled or deleted meanwhile), or to
 * try again (core's own failure, or a decision gone stale, such as a
 * version published as it was decided: tried again on the new one).
 */
const refusalOf = async (
  env: Env,
  taker: Taker,
  arrival: Arrival,
  error: unknown
): Promise<Outcome> => {
  if (!isExpectedError(error)) {
    log.error("workflow.trigger_failed", {
      ...arrival.logged,
      ...errorFields(error),
    });
    return "retry";
  }
  if (
    error.code === "workflow.trigger_unavailable" ||
    (await isGone(env, taker))
  ) {
    return "unavailable";
  }
  let { code } = error;
  if (isStaleRefusal(error)) {
    // What the admitting statement required besides, its grant to hear,
    // revoked for good; or what it was decided on changed meanwhile, to be
    // decided again.
    const now = await drizzle(env.DB).get<{ hears: number }>(
      sql`SELECT ${arrival.also ?? sql`1`} AS hears`
    );
    if (now.hears === 1) {
      return "retry";
    }
    if (arrival.answered === true) {
      return "stale";
    }
    code = "permission.revoked";
  } else if (!refusedForGood.has(code)) {
    return "retry";
  }
  return await settle(env, taker, arrival, "refused", { code });
};

/**
 * The lineage a trigger's run of a stamped event or message joins: the
 * stamping independent run's, one level deeper, admitted once per `admission`
 * (the event or message and the trigger; quotas.ts, `admitInLineage`, which
 * throws `workflow.lineage_limit` past its limits); none for one no run
 * stamped; `unjoinable` for a run no longer kept.
 */
const causeOf = async (
  env: Env,
  admission: string,
  stamped: StampedRun | undefined
): Promise<TriggerCause | "unjoinable" | undefined> => {
  if (stamped === undefined) {
    return undefined;
  }
  const run = await runOf(env, stamped.runId);
  if (run === undefined) {
    return "unjoinable";
  }
  const place = await admitInLineage(
    env,
    { id: run.id, rootRunId: run.rootRunId, depth: run.depth },
    admission
  );
  return { runId: run.id, restricted: run.restricted, place };
};

/**
 * `taker`'s turn at `arrival`, a small state machine: started already (a
 * receipt under its key): settled, nothing asked again; settled for it
 * already (a tombstone: dropped or refused): gone; held past `maxHeldMs`:
 * dropped, checked before any try; without a place in the hour's room
 * (`tookPlace`): held back, nothing audited; refused without a try
 * (`refusedAs`): settled; else tried, admitted only while `also` holds.
 */
export const startOnce = async (
  env: Env,
  taker: Taker,
  arrival: Arrival
): Promise<Outcome> => {
  const { same, key } = arrival;
  const db = drizzle(env.DB);
  const admitted = await db
    .select({ id: workflowStartReceipts.id })
    .from(workflowStartReceipts)
    .where(
      and(
        eq(workflowStartReceipts.invokerType, "trigger"),
        eq(workflowStartReceipts.invokerId, taker.id),
        eq(workflowStartReceipts.idempotencyKey, key)
      )
    )
    .get();
  if (admitted !== undefined) {
    await db
      .delete(connectorTriggerHolds)
      .where(and(holdOf(taker, same), isNull(connectorTriggerHolds.settled)));
    return "started";
  }
  const state = await db
    .select({
      heldSince: connectorTriggerHolds.heldSince,
      settled: connectorTriggerHolds.settled,
    })
    .from(connectorTriggerHolds)
    .where(holdOf(taker, same))
    .get();
  if (state?.settled !== undefined && state.settled !== null) {
    return "gone";
  }
  if (
    state !== undefined &&
    Date.now() - state.heldSince.getTime() >= maxHeldMs
  ) {
    return await settle(env, taker, arrival, "dropped", {
      reason: "hourly_limit",
      heldSince: state.heldSince.toISOString(),
    });
  }
  if (!(await tookPlace(env, taker, same))) {
    if (arrival.answered === true) {
      log.warn("workflow.trigger_rate_limited", arrival.logged);
      return "retry";
    }
    return await heldBack(env, taker, arrival);
  }
  if (arrival.refusedAs !== undefined) {
    return await settle(env, taker, arrival, "refused", {
      code: arrival.refusedAs,
    });
  }
  try {
    const cause = await causeOf(env, arrival.admission, arrival.stamped);
    if (cause === "unjoinable") {
      // Never a new root: that is how a loop would go on.
      return await settle(env, taker, arrival, "refused", {
        code: "lineage.unjoinable",
        ...(arrival.stamped === undefined
          ? {}
          : { emittingRun: arrival.stamped.runId }),
      });
    }
    // The version live now: a publish before it is admitted refuses it as
    // stale, and it is tried again on the new one.
    const workflow = await liveWorkflow(env, taker.workflowId);
    const version = workflow?.currentVersion;
    if (version === undefined || version === null) {
      throw workflowResourceErrors.create("workflow.start_denied");
    }
    await startWorkflow(
      env,
      {
        type: "trigger",
        triggerId: triggerIdSchema.parse(taker.id),
        ...(cause === undefined ? {} : { cause }),
      },
      taker.workflowId,
      { version, args: arrival.input, key },
      // Read again as it is admitted: what else it needs.
      arrival.also,
      {
        ...arrival.noted,
        ...(cause === undefined ? {} : { emittingRun: cause.runId }),
      },
      undefined,
      arrival.files
    );
    await db
      .delete(connectorTriggerHolds)
      .where(and(holdOf(taker, same), isNull(connectorTriggerHolds.settled)));
    return "started";
  } catch (error) {
    return await refusalOf(env, taker, arrival, error);
  }
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
    takers.map(async (taker): Promise<Outcome> => {
      const mapping = inputMappingSchema.parse(
        JSON.parse(taker.inputMapping ?? "{}")
      );
      return await startOnce(env, taker, {
        same,
        key: `${coreStartKeyPrefix}connector:${taker.id}:${same}`,
        admission: `connector:${same}:${taker.id}`,
        input: inputOf(mapping, event),
        stamped,
        also: hearsSql(taker.id, event),
        noted: { event: same, connection: event.connection },
        audited: {
          refused: "workflow.event.refused",
          dropped: "workflow.event.dropped",
          detail: { event: event.type },
        },
        logged: { type: "connector", trigger: taker.id },
      });
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

/**
 * How long a hold or a tombstone is kept: past connect's two days of
 * deliveries of an event (connect's events.ts, `maxDeliveryAttempts`), so
 * every delivery of it finds its tombstone, and long past a hold's day.
 */
export const holdsKeptMs = 7 * 24 * 60 * 60 * 1000;

/** Most rows one statement of a sweep removes. */
export const sweptPerStatement = 500;

/** How long one sweep goes on deleting before it leaves the rest to the next. */
const sweepBudgetMs = 5000;

/**
 * Removes the holds and tombstones of triggers past {@link holdsKeptMs}
 * before `now` (events that stopped arriving, the trigger disabled or its
 * grant revoked, connect giving up; events settled long ago), and the
 * places in their hourly rooms past their hour, which count for nothing
 * more. {@link sweptPerStatement} rows of each at a time, until none are
 * left or `budgetMs` has passed: what a clock run leaves, the next
 * deletes.
 */
export const sweepConnectorTriggerHolds = async (
  env: Env,
  now: Date,
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const holdsBefore = now.getTime() - holdsKeptMs;
  const placesBefore = now.getTime() - hourMs;
  const ends = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const [holds, places] = await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM connector_trigger_holds WHERE rowid IN (SELECT rowid FROM connector_trigger_holds WHERE coalesce(settled_at, held_since) < ? LIMIT ?)"
      ).bind(holdsBefore, sweptPerStatement),
      env.DB.prepare(
        "DELETE FROM trigger_hour_slots WHERE rowid IN (SELECT rowid FROM trigger_hour_slots WHERE taken_at <= ? LIMIT ?)"
      ).bind(placesBefore, sweptPerStatement),
    ]);
    const full =
      (holds?.meta.changes ?? 0) === sweptPerStatement ||
      (places?.meta.changes ?? 0) === sweptPerStatement;
    if (!full || Date.now() >= ends) {
      return;
    }
  }
};
