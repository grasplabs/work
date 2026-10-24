import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "../audit-outbox.ts";
import {
  triggerResources,
  triggerResourceVersions,
  workflowEmittedEvents,
} from "../db/core/schema.ts";
import {
  backoffMs,
  defaultBudgetMs,
  defaultMaxAttempts,
} from "../outbox-delivery.ts";
import { startWorkflow } from "../workflow-starts.ts";
import { admitChild } from "./quotas.ts";
import { runOf } from "./resource-runs.ts";

// Delivering the events JSON workflows emit (emitted-events.ts) from
// core's outbox, `workflow_emitted_events`, to what consumes platform
// events: system triggers (platform specification 15.1, "Platform outbox
// event; declared resource/event type; dedupe by event ID";
// trigger-resources.ts). Core's cron trigger drains it every minute
// (`drainEmittedEvents`). Threat model, and how each is closed:
//
// - An event starting a trigger's run twice: a lost acknowledgement, a
//   drain killed after the start and before it settled, two drains at
//   once. Each trigger's start is keyed by the event's ID
//   (`startKeyOf`), and a start's receipt is one per trigger, person and
//   key (workflow-starts.ts): the same event delivered again gets the
//   same run. Its place in the emitting run's lineage is claimed under the
//   event and the trigger too (quotas.ts, `admitChild`): one slot, however
//   often. A drain holds an event under a lease while it delivers it, and
//   settles it only while it still holds that lease: one that lost it to
//   another settles nothing.
// - An event's run escaping its emitting run's limits. The trigger's run
//   joins the emitting run's lineage, one level deeper, taking one of its
//   descendant runs, its age counting from the lineage's root
//   (`TriggerCause`), as a child run does; past any of them it is
//   refused (`workflow.lineage_limit`). It is no child of the emitting
//   run, so goes on after that run ends. A restricted run's event starts
//   it restricted.
// - A trigger acting on authority it lost. Each delivery is a start as any
//   trigger's (workflow-starts.ts): the trigger live, enabled and pinning
//   that version, its person still with a role, and its own `start` grant
//   active, all read again as the start is admitted.
// - An event reaching a trigger that didn't ask for it. Only system
//   triggers whose current version declares the event's catalog contract
//   and type take it, and only those created before it was emitted: a new
//   trigger gets no history.
// - An event delivered after its retention. Retention removes its data
//   and closes it undelivered (retention.ts), with an audit entry; a drain
//   claims only an event whose data is still there.
// - An event dropped silently. Each is settled delivered, once every
//   matching trigger started its run or refused it for good, each
//   refusal audited (`workflow.event.refused`); or undeliverable, after
//   `defaultMaxAttempts` failed deliveries, with why, audited
//   (`workflow.event.undeliverable`) and logged. A failure of core's own
//   is tried again, backing off as outbox-delivery.ts does.

/** Most events one drain takes at a time. */
const eventsPerRead = 25;

/** How long a drain holds an event it delivers before another may take it. */
export const deliveryLeaseMs = 60_000;

/** A refusal of a start that may go another time: tried again. */
const retriedCodes: ReadonlySet<string> = new Set(["workflow.run_limit"]);

/** The start key of `event`'s run: the same for every trigger and delivery. */
const startKeyOf = (event: string): string =>
  `${coreStartKeyPrefix}event:${event}`;

type EventRow = typeof workflowEmittedEvents.$inferSelect;

/** A system trigger that takes `event`, as its current version pins it. */
interface Consumer {
  id: string;
  workflowId: string;
  workflowVersion: number;
}

/**
 * The live, enabled system triggers whose current version takes `event`'s
 * contract and type, created before it was emitted.
 */
const consumersOf = async (env: Env, event: EventRow): Promise<Consumer[]> =>
  await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
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
        eq(triggerResourceVersions.eventContract, event.contractId),
        eq(triggerResourceVersions.eventType, event.type),
        eq(triggerResources.kind, "system"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt),
        lte(triggerResources.createdAt, event.createdAt)
      )
    )
    .orderBy(asc(triggerResources.id));

/** What a delivery came to: the triggers that refused it for good. */
interface Delivered {
  refused: { trigger: string; code: string }[];
}

/**
 * Starts the run of each trigger that takes `event`, once: the triggers
 * that refused it for good. Throws on anything to try again.
 */
const deliver = async (env: Env, event: EventRow): Promise<Delivered> => {
  const consumers = await consumersOf(env, event);
  if (consumers.length === 0 || event.data === null) {
    return { refused: [] };
  }
  const run = await runOf(env, event.runId);
  if (run === undefined) {
    throw new Error(`Event ${event.id}'s run ${event.runId} has no record`);
  }
  const input = z.json().parse(JSON.parse(event.data));
  const refused: Delivered["refused"] = [];
  for (const consumer of consumers) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one trigger at a time
      const place = await admitChild(
        env,
        { id: run.id, rootRunId: run.rootRunId, depth: run.depth },
        `event:${event.id}:${consumer.id}`
      );
      // oxlint-disable-next-line no-await-in-loop -- one trigger at a time
      await startWorkflow(
        env,
        {
          type: "trigger",
          triggerId: consumer.id,
          cause: { runId: run.id, restricted: event.restricted, place },
        },
        consumer.workflowId,
        {
          version: consumer.workflowVersion,
          input,
          key: startKeyOf(event.id),
        },
        undefined,
        { event: event.id, emittingRun: event.runId }
      );
    } catch (error) {
      if (!isExpectedError(error) || retriedCodes.has(error.code)) {
        throw error;
      }
      refused.push({ trigger: consumer.id, code: error.code });
    }
  }
  return { refused };
};

/** The event `id`, claimed under a lease until `lease`, if it is due. */
const claimed = async (
  env: Env,
  id: string,
  now: number,
  lease: number
): Promise<EventRow | undefined> => {
  const [row] = await drizzle(env.DB)
    .update(workflowEmittedEvents)
    .set({ deliveryAt: new Date(lease) })
    .where(
      and(
        eq(workflowEmittedEvents.id, id),
        isNull(workflowEmittedEvents.deliveredAt),
        isNull(workflowEmittedEvents.detailsRemovedAt),
        or(
          isNull(workflowEmittedEvents.deliveryAt),
          lte(workflowEmittedEvents.deliveryAt, new Date(now))
        )
      )
    )
    .returning();
  return row;
};

/** That `event` is still held under `lease`, undelivered, as SQL. */
const stillHeld = (event: EventRow, lease: number) =>
  and(
    eq(workflowEmittedEvents.id, event.id),
    isNull(workflowEmittedEvents.deliveredAt),
    eq(workflowEmittedEvents.deliveryAt, new Date(lease))
  );

/** That `event` was settled at `at`, as SQL, for its audit entries. */
const settledAt = (event: EventRow, at: number) =>
  sql`EXISTS (SELECT 1 FROM ${workflowEmittedEvents}
    WHERE ${workflowEmittedEvents.id} = ${event.id}
      AND ${workflowEmittedEvents.deliveredAt} = ${at})`;

/** Settles `event` delivered, with the refusals it met, while held. */
const settleDelivered = async (
  env: Env,
  event: EventRow,
  lease: number,
  { refused }: Delivered
): Promise<void> => {
  const at = Date.now();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(workflowEmittedEvents)
      .set({ deliveredAt: new Date(at) })
      .where(stillHeld(event, lease)),
    ...refused.map(({ trigger, code }) =>
      outboxedWhere(
        db,
        {
          actor: { type: "system" },
          action: "workflow.event.refused",
          target: { type: "workflow_run", id: event.runId },
          detail: { event: event.id, type: event.type, trigger, code },
        },
        settledAt(event, at)
      )
    ),
  ]);
};

/**
 * Settles `event` after a delivery that failed with `error`, while held:
 * tried again after a backoff, or, past `maxAttempts`, undeliverable for
 * good, audited and logged.
 */
const settleFailed = async (
  env: Env,
  event: EventRow,
  lease: number,
  error: unknown,
  maxAttempts: number
): Promise<void> => {
  const attempts = event.deliveryAttempts + 1;
  const code = isExpectedError(error) ? error.code : "internal.unexpected";
  const db = drizzle(env.DB);
  if (attempts < maxAttempts) {
    log.warn("workflow.event.delivery_failed", {
      event: event.id,
      attempts,
      ...errorFields(error),
    });
    await db
      .update(workflowEmittedEvents)
      .set({
        deliveryAttempts: attempts,
        deliveryAt: new Date(Date.now() + backoffMs(attempts)),
      })
      .where(stillHeld(event, lease));
    return;
  }
  log.error("workflow.event.undeliverable", {
    event: event.id,
    attempts,
    ...errorFields(error),
  });
  const at = Date.now();
  await auditedBatch(env, db, [
    db
      .update(workflowEmittedEvents)
      .set({
        deliveryAttempts: attempts,
        deliveredAt: new Date(at),
        undeliverable: code,
      })
      .where(stillHeld(event, lease)),
    outboxedWhere(
      db,
      {
        actor: { type: "system" },
        action: "workflow.event.undeliverable",
        target: { type: "workflow_run", id: event.runId },
        detail: { event: event.id, type: event.type, attempts, code },
      },
      settledAt(event, at)
    ),
  ]);
};

/** How a drain goes. */
export interface EventDrainOptions {
  /** How long it goes on delivering: checked before each event. */
  budgetMs?: number;
  /** How many failed deliveries settle an event as undeliverable. */
  maxAttempts?: number;
}

/**
 * Delivers the emitted events that are due, oldest first, each held under
 * a lease while it is, until none are due or the budget is spent: how
 * many it settled delivered. An event that fails is tried again later,
 * and settled undeliverable once it failed `maxAttempts` times.
 */
export const drainEmittedEvents = async (
  env: Env,
  {
    budgetMs = defaultBudgetMs,
    maxAttempts = defaultMaxAttempts,
  }: EventDrainOptions = {}
): Promise<number> => {
  const ends = Date.now() + budgetMs;
  const db = drizzle(env.DB);
  const tried = new Set<string>();
  let delivered = 0;
  while (Date.now() < ends) {
    const now = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- one read after another
    const due = await db
      .select({ id: workflowEmittedEvents.id })
      .from(workflowEmittedEvents)
      .where(
        and(
          isNull(workflowEmittedEvents.deliveredAt),
          isNull(workflowEmittedEvents.detailsRemovedAt),
          or(
            isNull(workflowEmittedEvents.deliveryAt),
            lte(workflowEmittedEvents.deliveryAt, new Date(now))
          )
        )
      )
      .orderBy(asc(workflowEmittedEvents.createdAt))
      .limit(eventsPerRead);
    const fresh = due.filter(({ id }) => !tried.has(id));
    if (fresh.length === 0) {
      break;
    }
    for (const { id } of fresh) {
      tried.add(id);
      if (Date.now() >= ends) {
        break;
      }
      const lease = Date.now() + deliveryLeaseMs;
      // oxlint-disable-next-line no-await-in-loop -- one event at a time
      const event = await claimed(env, id, Date.now(), lease);
      if (event === undefined) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one event at a time
        const outcome = await deliver(env, event);
        // oxlint-disable-next-line no-await-in-loop -- one event at a time
        await settleDelivered(env, event, lease, outcome);
        delivered += 1;
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop -- one event at a time
        await settleFailed(env, event, lease, error, maxAttempts);
      }
    }
  }
  return delivered;
};
