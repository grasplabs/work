import {
  eventSourceErrors,
  eventSourceRefusalReasons,
  eventSourceRetention,
} from "@grasp-os/shared/event-sources";
import type {
  EventSourceDelivery,
  EventSourceDeliveryPage,
  EventSourceDeliveryWithPayload,
  EventSourceRefusalReason,
  EventSourceRefusals,
  EventSourceTrigger,
} from "@grasp-os/shared/event-sources";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, desc, eq, gt, lt, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Acting } from "../auth/identity.ts";
import {
  eventSourceCounts,
  eventSourceDeliveries,
  eventSources,
} from "../db/core/schema.ts";
import {
  liveSource,
  requireSourceAdmin,
  sourceEntry,
  sourceUnavailable,
} from "../event-sources.ts";
import { triggersOnSource } from "../trigger-resources.ts";

// What an event source received, for its admins to see (GRA-1997): after
// adding a source an admin couldn't tell whether anything arrived, what it
// looked like, or why a sender fails. So an accepted delivery is kept,
// briefly, and a refused one is counted, never kept. The rule: a payload
// for a day, its row (time, type, how many triggers it started) for seven,
// counts by the hour for seven, and of a refused delivery nothing but one
// more in a count. Threat model, written before the code, and how each is
// closed:
//
// - An unauthenticated sender storing bytes it chose. A refused delivery
//   is unauthenticated input: no body, header, signature or sender's
//   address of one is written anywhere here. What it adds to is a count
//   whose key is ours alone: the source the URL's token resolved to, one
//   of four reasons core names (`eventSourceRefusalReasons`) and the hour.
//   Nothing a sender sends is part of a key or a value.
// - An unauthenticated sender flooding rows. Refused deliveries are one
//   row for each source, reason and hour, however many came: at most the
//   reasons times the hours of a week for a source. Each costs one
//   upsert of a row already there, an anonymous write, bounded by the
//   router's limits before core reads a byte (apps/router): 120 requests
//   a minute for an address and 3,000 a minute for a URL. The counts are
//   never audited, so a flood can't fill the audit log.
// - Probing for tokens. A URL no live source has is counted nowhere and
//   writes nothing (it is logged, as before), so a guess costs what it did
//   and a count never says a token exists: only a URL that is a source's
//   counts, to that source's admins. The answer to the sender is the same
//   whatever was counted, and every write here runs after it
//   (`waitUntil`), so a URL that is a source's answers no slower than one
//   that isn't; a write that fails is logged and fails nothing.
// - A retry read as a second run. A sender that resends a `webhook-id`
//   (it timed out, say) is told 202 again and starts nothing anew, though
//   each trigger says `started` of the run it already has. A delivery is
//   kept under the hash of its source and `webhook-id` (what the audit
//   log names it by), once: the retry leaves the first row and the counts
//   as they are, so nobody reads two runs into one.
// - A sender holding the secret sending a lot. Each accepted delivery is
//   one row, and a source holds its newest `perSource` at most, trimmed in
//   the batch that writes one, so a source's rows and payloads (each
//   within `eventSourceLimits.bodyBytes`, the body it came in) are bounded
//   whatever it sends. Its counts by the hour count every delivery all the
//   same, so what the page says it received stays true past that. A
//   delivery that can't be written here is still taken: this is a record
//   of the delivery, never part of admitting it.
// - Personal data in payloads. An outside system's event may name people
//   anywhere, under no key of ours, so erasing a person can't find them:
//   a payload is held for a day (`payloadMs`), as a kept event is
//   (event-waits.ts), and its row for seven (`deliveryMs`), both read as
//   gone from that moment whatever the clock has deleted yet, and deleted
//   on the clock (`sweepSourceDeliveries`). The payload is company data
//   from an outside system, never one person's own content, so it lives in
//   core's database, not a person's.
// - Who reads a payload. Only an admin who isn't Grasp staff
//   (`requireSourceAdmin`), as for every change to a source: a builder
//   picks a source by name and reads nothing of its deliveries. A list
//   never holds a payload; reading one is its own call, audited once
//   (`event_source.delivery.read`: who, which source, which delivery,
//   never the payload), on record before it is answered: an audit event
//   that can't be stored fails the read.
// - Reading across sources by ID. A delivery is read by its source and its
//   ID together, in one condition: a delivery of another source is
//   answered as one that isn't there, and audits nothing.
// - A signed delivery that fails. One too large, not an event, in
//   conflict with an earlier one of its `webhook-id` or told to try again
//   is counted by a reason of its own (`too_large`, `body`, `conflict`,
//   `busy`), as the likeliest mistakes of a sender being set up; its body
//   is kept no more than an unsigned one's.
// - A revoked or rotated secret. A delivery to a revoked secret, or one
//   whose secret changed as it was admitted, is refused as before and
//   counted (`revoked`, `rotated`). What the source accepted before stays
//   listed for its window: its admins made the change and may still read
//   it.
// - A deleted source. Its deliveries and counts are deleted in the batch
//   that deletes it (event-sources.ts), and every write here requires the
//   source live in its own statement, so nothing is written for it after.
//   Its token is cleared, so later requests to its URL resolve to nothing.
// - A test event causing side effects. An admin's test event
//   (`recordTest`, from source-events.ts) is validated as a delivery's
//   body is, listed marked a test, and answered with the triggers that
//   match it: it starts no run, reaches no waiting run and is never kept
//   for a wait, so nothing outside changes. It isn't counted as received,
//   so "last event" stays the sender's. Audited once.

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

/** When the hour `at` is in began. */
const hourOf = (at: number): number => at - (at % hourMs);

/** That source `id` is live, as SQL: what every write here requires. */
const liveSql = (id: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${eventSources}
    WHERE ${eventSources.id} = ${id} AND ${eventSources.deletedAt} IS NULL)`;

/** One more of `outcome` for live source `source` in the hour of `now`. */
const counted = (
  db: DrizzleD1Database,
  source: string,
  outcome: "accepted" | EventSourceRefusalReason,
  now: number,
  also: SQL = sql`TRUE`
) =>
  db
    .insert(eventSourceCounts)
    .select(
      sql`SELECT ${source}, ${outcome}, ${hourOf(now)}, 1, ${now}
        WHERE ${liveSql(source)} AND ${also}`
    )
    .onConflictDoUpdate({
      target: [
        eventSourceCounts.sourceId,
        eventSourceCounts.outcome,
        eventSourceCounts.hour,
      ],
      set: {
        count: sql`${eventSourceCounts.count} + 1`,
        lastAt: sql`max(${eventSourceCounts.lastAt}, excluded.last_at)`,
      },
    });

/** What is kept of an event a source took. */
interface Kept {
  /**
   * A delivery's: the hash of its source and `webhook-id`, as the audit
   * log names it. A test event's: one of its own.
   */
  id: string;
  source: string;
  type: string;
  data: Json;
  test: boolean;
  /** How many triggers it started. */
  triggers: number;
}

/** The row of `kept`, written only while its source is live. */
const keptRow = (db: DrizzleD1Database, kept: Kept, now: number) =>
  db.insert(eventSourceDeliveries).select(
    sql`SELECT ${kept.id}, ${kept.source}, ${now}, ${kept.type},
        ${kept.test ? 1 : 0}, ${kept.triggers}, ${JSON.stringify(kept.data)}
        WHERE ${liveSql(kept.source)}`
  );

/** Deletes all but source `source`'s newest `perSource` deliveries. */
const trimmed = (db: DrizzleD1Database, source: string) =>
  db.delete(eventSourceDeliveries).where(
    and(
      eq(eventSourceDeliveries.sourceId, source),
      sql`rowid IN (SELECT rowid FROM ${eventSourceDeliveries}
        WHERE ${eventSourceDeliveries.sourceId} = ${source}
        ORDER BY ${eventSourceDeliveries.receivedAt} DESC,
          ${eventSourceDeliveries.id} DESC
        LIMIT -1 OFFSET ${eventSourceRetention.perSource})`
    )
  );

/**
 * Keeps a delivery a source accepted, and counts it, once by its ID: a
 * sender's retry of a delivery already listed (the same `webhook-id`,
 * which started nothing anew) leaves the first as it is and counts
 * nothing. Never throws: the delivery was taken whatever comes of
 * recording it.
 */
export const recordDelivery = async (
  env: Env,
  kept: Omit<Kept, "test">
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  try {
    await db.batch([
      keptRow(db, { ...kept, test: false }, now).onConflictDoNothing(),
      // Only when the row before it was written: `changes()` is its.
      counted(db, kept.source, "accepted", now, sql`changes() > 0`),
      trimmed(db, kept.source),
    ]);
  } catch (error) {
    log.error("workflow.webhook.unrecorded", errorFields(error));
  }
};

/**
 * Counts a delivery source `source` refused for `reason`, and nothing of
 * the delivery. Never throws: the refusal stands whatever comes of
 * counting it.
 */
export const countRefusal = async (
  env: Env,
  source: string,
  reason: EventSourceRefusalReason
): Promise<void> => {
  try {
    await counted(drizzle(env.DB), source, reason, Date.now());
  } catch (error) {
    log.error("workflow.webhook.uncounted", errorFields(error));
  }
};

/** A delivery's columns, as its list shows it: never its payload. */
const listed = {
  id: eventSourceDeliveries.id,
  receivedAt: eventSourceDeliveries.receivedAt,
  type: eventSourceDeliveries.eventType,
  test: eventSourceDeliveries.test,
  triggers: eventSourceDeliveries.triggers,
  hasPayload: sql<number>`${eventSourceDeliveries.payload} IS NOT NULL`,
};

/** A delivery's row as its list shows it at `now`. */
const viewOf = (
  row: {
    id: string;
    receivedAt: Date;
    type: string;
    test: boolean;
    triggers: number;
    hasPayload: number;
  },
  now: number
): EventSourceDelivery => ({
  id: row.id,
  receivedAt: row.receivedAt.toISOString(),
  type: row.type,
  test: row.test,
  triggersStarted: row.triggers,
  // Gone a day after it came, whatever the clock has cleared yet.
  payloadHeld:
    row.hasPayload === 1 &&
    row.receivedAt.getTime() > now - eventSourceRetention.payloadMs,
});

/**
 * Keeps the test event `kept` that `by` sent its source, marked a test,
 * audited in the batch that keeps it: how it is listed. Counted nowhere.
 */
export const recordTest = async (
  env: Env,
  by: Acting,
  kept: Omit<Kept, "id" | "test" | "triggers">,
  matched: number
): Promise<EventSourceDelivery> => {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await auditedBatch(env, db, [
    keptRow(db, { ...kept, id, test: true, triggers: 0 }, now),
    outboxedIfChanged(
      db,
      sourceEntry(by, "event_source.test_sent", kept.source, {
        delivery: id,
        event: kept.type,
        matched,
      })
    ),
    trimmed(db, kept.source),
  ]);
  const row = await db
    .select(listed)
    .from(eventSourceDeliveries)
    .where(eq(eventSourceDeliveries.id, id))
    .get();
  // Its source was deleted as it was sent.
  if (row === undefined) {
    throw sourceUnavailable();
  }
  return viewOf(row, now);
};

/** The live source `id` for an admin, or the refusal. */
const adminSource = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<string> => {
  requireSourceAdmin(by);
  const source = await liveSource(env, id);
  if (source === undefined) {
    throw sourceUnavailable();
  }
  return source.id;
};

/** A page's cursor: the last delivery's time, a dot, and its ID. */
const pageSchema = z
  .string()
  .regex(/^(?<at>\d{1,15})\.(?<id>[0-9a-f-]{36,64})$/u)
  .transform((page) => {
    const [at = "", id = ""] = page.split(".");
    return { at: new Date(Number(at)), id };
  });

/**
 * Source `id`'s deliveries of the last seven days, newest first, a page at
 * a time, for an admin (`EventSourcesApi.deliveries`).
 */
export const listDeliveries = async (
  env: Env,
  by: Acting,
  id: unknown,
  page?: unknown
): Promise<EventSourceDeliveryPage> => {
  const source = await adminSource(env, by, id);
  const after =
    page === undefined
      ? undefined
      : eventSourceErrors.parse("webhook.page_invalid", pageSchema, page);
  const now = Date.now();
  const rows = await drizzle(env.DB)
    .select(listed)
    .from(eventSourceDeliveries)
    .where(
      and(
        eq(eventSourceDeliveries.sourceId, source),
        gt(
          eventSourceDeliveries.receivedAt,
          new Date(now - eventSourceRetention.deliveryMs)
        ),
        after === undefined
          ? undefined
          : or(
              lt(eventSourceDeliveries.receivedAt, after.at),
              and(
                eq(eventSourceDeliveries.receivedAt, after.at),
                lt(eventSourceDeliveries.id, after.id)
              )
            )
      )
    )
    .orderBy(
      desc(eventSourceDeliveries.receivedAt),
      desc(eventSourceDeliveries.id)
    )
    .limit(eventSourceRetention.pageSize + 1);
  const shown = rows.slice(0, eventSourceRetention.pageSize);
  const last = shown.at(-1);
  return {
    deliveries: shown.map((row) => viewOf(row, now)),
    next:
      rows.length > shown.length && last !== undefined
        ? `${last.receivedAt.getTime()}.${last.id}`
        : null,
  };
};

/**
 * Delivery `deliveryId` of source `id` with its payload, for an admin
 * (`EventSourcesApi.delivery`): audited before it is answered whenever a
 * payload is. One of another source, or past its seven days, isn't there.
 */
export const readDelivery = async (
  env: Env,
  by: Acting,
  id: unknown,
  deliveryId: unknown
): Promise<EventSourceDeliveryWithPayload> => {
  const source = await adminSource(env, by, id);
  const wanted = identifierSchema.safeParse(deliveryId);
  const now = Date.now();
  const db = drizzle(env.DB);
  const row = wanted.success
    ? await db
        .select({ ...listed, payload: eventSourceDeliveries.payload })
        .from(eventSourceDeliveries)
        .where(
          and(
            eq(eventSourceDeliveries.id, wanted.data),
            eq(eventSourceDeliveries.sourceId, source),
            gt(
              eventSourceDeliveries.receivedAt,
              new Date(now - eventSourceRetention.deliveryMs)
            )
          )
        )
        .get()
    : undefined;
  if (row === undefined) {
    throw eventSourceErrors.create("webhook.delivery_unavailable");
  }
  const view = viewOf(row, now);
  if (!view.payloadHeld || row.payload === null) {
    return { ...view, payload: null };
  }
  // On record before it is read: a batch that fails answers no payload.
  await auditedBatch(env, db, [
    outboxed(
      db,
      sourceEntry(by, "event_source.delivery.read", source, {
        delivery: row.id,
      })
    ),
  ]);
  return { ...view, payload: z.json().parse(JSON.parse(row.payload)) };
};

/**
 * How often source `id` refused a delivery in the last seven days, by
 * reason, for an admin (`EventSourcesApi.refusals`).
 */
export const sourceRefusals = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<EventSourceRefusals[]> => {
  const source = await adminSource(env, by, id);
  const now = Date.now();
  const rows = await drizzle(env.DB)
    .select({
      reason: eventSourceCounts.outcome,
      lastDay: sql<number>`SUM(CASE WHEN ${eventSourceCounts.hour} > ${now - dayMs}
        THEN ${eventSourceCounts.count} ELSE 0 END)`,
      lastWeek: sql<number>`SUM(${eventSourceCounts.count})`,
      lastAt: sql<number>`MAX(${eventSourceCounts.lastAt})`,
    })
    .from(eventSourceCounts)
    .where(
      and(
        eq(eventSourceCounts.sourceId, source),
        ne(eventSourceCounts.outcome, "accepted"),
        gt(
          eventSourceCounts.hour,
          new Date(now - eventSourceRetention.deliveryMs)
        )
      )
    )
    .groupBy(eventSourceCounts.outcome);
  return eventSourceRefusalReasons.flatMap((reason) => {
    const row = rows.find((each) => each.reason === reason);
    return row === undefined
      ? []
      : [
          {
            reason,
            lastDay: row.lastDay,
            lastWeek: row.lastWeek,
            lastAt: new Date(row.lastAt).toISOString(),
          },
        ];
  });
};

/**
 * The live webhook triggers on source `id`, each with its workflow, for an
 * admin (`EventSourcesApi.triggers`): every one, as an admin sees every
 * workflow and its triggers (workflow-resources.ts, trigger-resources.ts);
 * nobody else is answered, so nobody learns of a workflow they have no
 * role in.
 */
export const sourceTriggers = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<EventSourceTrigger[]> =>
  await triggersOnSource(env, await adminSource(env, by, id));

/** The most rows one statement of the sweep clears or deletes. */
const sweptPerBatch = 100;

/** How long one clock run sweeps for, at most. */
const sweepBudgetMs = 5000;

/**
 * On the clock: clears the payloads past their day and deletes the
 * deliveries and counts past their seven, in bounded batches until none
 * is left or `budgetMs` is spent.
 */
export const sweepSourceDeliveries = async (
  env: Env,
  now = new Date(),
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const db = drizzle(env.DB);
  const until = Date.now() + budgetMs;
  const payloadsBefore = now.getTime() - eventSourceRetention.payloadMs;
  const rowsBefore = now.getTime() - eventSourceRetention.deliveryMs;
  const batches = [
    sql`UPDATE ${eventSourceDeliveries} SET payload = NULL
      WHERE rowid IN (SELECT rowid FROM ${eventSourceDeliveries}
        WHERE ${eventSourceDeliveries.receivedAt} <= ${payloadsBefore}
          AND ${eventSourceDeliveries.payload} IS NOT NULL
        LIMIT ${sweptPerBatch})`,
    sql`DELETE FROM ${eventSourceDeliveries}
      WHERE rowid IN (SELECT rowid FROM ${eventSourceDeliveries}
        WHERE ${eventSourceDeliveries.receivedAt} <= ${rowsBefore}
        LIMIT ${sweptPerBatch})`,
    sql`DELETE FROM ${eventSourceCounts}
      WHERE rowid IN (SELECT rowid FROM ${eventSourceCounts}
        WHERE ${eventSourceCounts.hour} <= ${rowsBefore}
        LIMIT ${sweptPerBatch})`,
  ];
  for (const batch of batches) {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one batch after another
      const swept = await db.run(batch);
      if (swept.meta.changes < sweptPerBatch || Date.now() >= until) {
        break;
      }
    }
  }
};
