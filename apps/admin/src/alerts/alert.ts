/**
 * Telling staff when a release or a rollout needs a person: a release
 * that didn't import, an organization whose deploy failed, and each one's
 * recovery. Whatever writes the audit event of such a failure, or of its
 * end, calls `alert` beside it: the import (src/releases/import.ts), a
 * deploy's end (src/rollout/deploy.ts), and the rollout pass for a halt
 * or a 429 that blocks every rollout (src/rollout/scheduler.ts). `alert`
 * only records the change, for
 * the channels switched on then; `deliverAlerts`, at the end of each cron
 * run (src/server.ts), tells those still on (src/alerts/channels.ts):
 * mail and Discord (src/alerts/senders.ts).
 *
 * Each thing alerts once a state: its first failure is told, the same
 * failure again changes nothing, however often the every-minute cron or a
 * retry reports it, and its recovery is told once (one row a thing, in
 * `alerts`). A channel that refuses a message, or can't send yet, is
 * tried again at the next run, up to `MAX_ATTEMPTS` runs, then given up
 * on, logged. Nothing here
 * ever throws into what called it: an import or a rollout never fails
 * for an alert.
 */
import "@tanstack/react-start/server-only";
import { log } from "@grasp-os/shared/log";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { invocationLeaseMs, withLease } from "../db/lease.ts";
import { alerts, clients } from "../db/schema.ts";
import { channelIds } from "../rollout/channel-ids.ts";
import { alertChannelIds } from "./alert-channels.ts";
import type { AlertChannel } from "./alert-channels.ts";
import { onChannels, switchedOn } from "./channels.ts";
import type { AlertOrganization } from "./message.ts";
import { factsOf, messageOf } from "./message.ts";
import type { AlertSender } from "./senders.ts";

/**
 * When a recovery's failure was recorded, in epoch milliseconds: set by
 * `alert` from the failure's row, never by its callers.
 */
const failedAtSchema = z.number().int().optional();

/**
 * What changed: a release that failed to import, or imported after that;
 * an organization whose deploy of a release failed, or that deployed one
 * after that; a channel's rollout that halted (`since` it started or was
 * last resumed: each halt its own); a 429 that blocks the deployer token
 * `until` then; an organization set aside after platform faults in a
 * row (`since` its last deploy started: each time its own). Identifiers,
 * codes and counts only, as the audit event has them.
 */
export const alertEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("import_failed"),
    releaseId: z.string(),
    code: z.string(),
    attempt: z.number().int(),
  }),
  z.object({
    kind: z.literal("imported"),
    releaseId: z.string(),
    failedAt: failedAtSchema,
  }),
  z.object({
    kind: z.literal("deploy_failed"),
    clientId: z.string(),
    releaseId: z.string(),
    code: z.string(),
  }),
  z.object({
    kind: z.literal("deployed"),
    clientId: z.string(),
    releaseId: z.string(),
    failedAt: failedAtSchema,
  }),
  z.object({
    kind: z.literal("rollout_halted"),
    rolloutId: z.string(),
    channel: z.enum(channelIds),
    releaseId: z.string(),
    done: z.number().int(),
    failed: z.number().int(),
    since: z.number().int(),
  }),
  z.object({ kind: z.literal("rollout_blocked"), until: z.number().int() }),
  z.object({
    kind: z.literal("deploy_set_aside"),
    clientId: z.string(),
    releaseId: z.string(),
    code: z.string(),
    since: z.number().int(),
  }),
]);
export type AlertEvent = z.infer<typeof alertEventSchema>;

/** The most characters of a failure's code a message carries. */
const MAX_CODE_CHARS = 200;

/**
 * `event` with its code, if it has one, cut to its first line and
 * `MAX_CODE_CHARS`: a code is meant to be short, but one that's a raw
 * error message must not fill a message. Its whole text stays where it
 * is, in the audit event.
 */
const bounded = (event: AlertEvent): AlertEvent =>
  "code" in event
    ? {
        ...event,
        code: (event.code.split(/\r?\n/u, 1)[0] ?? "").slice(0, MAX_CODE_CHARS),
      }
    : event;

/** How many cron runs try a channel that refuses a message before giving up on it. */
export const MAX_ATTEMPTS = 5;

/**
 * What `event` is about, one row a thing, and whether it says that thing
 * fails. A halt and a block are each a thing of their own, told once and
 * never recovered: a rollout halted again after a resume is a new halt.
 */
const subjectOf = (event: AlertEvent): { key: string; failing: boolean } => {
  if (event.kind === "rollout_halted") {
    return { key: `halt:${event.rolloutId}:${event.since}`, failing: true };
  }
  if (event.kind === "rollout_blocked") {
    return { key: `blocked:${event.until}`, failing: true };
  }
  if (event.kind === "deploy_set_aside") {
    return { key: `aside:${event.clientId}:${event.since}`, failing: true };
  }
  return "clientId" in event
    ? {
        key: `deploy:${event.clientId}`,
        failing: event.kind === "deploy_failed",
      }
    : {
        key: `import:${event.releaseId}`,
        failing: event.kind === "import_failed",
      };
};

/**
 * Records `event` at `now` when it changes the state of what it's about,
 * to be told by the next cron run: a first failure, to the channels
 * switched on now; a recovery after one, to exactly the channels that took
 * the failure (one still waiting to take it gets neither), and dropped
 * with the failure, at once, when none took it: nobody was told it
 * failed. The same state again changes nothing; a recovery of something
 * not failing too. Logged, never thrown, when it can't be recorded.
 */
export const alert = async (
  db: AdminDatabase,
  given: AlertEvent,
  now = new Date()
): Promise<void> => {
  const event = bounded(given);
  const { key, failing } = subjectOf(event);
  try {
    if (failing) {
      const change = {
        failing,
        event: JSON.stringify(event),
        changedAt: now,
        pending: JSON.stringify([...(await switchedOn(db))]),
        attempts: 0,
        told: "[]",
      };
      await db
        .insert(alerts)
        .values({ key, ...change })
        .onConflictDoUpdate({
          target: alerts.key,
          set: change,
          setWhere: eq(alerts.failing, false),
        });
      return;
    }
    const failed = and(eq(alerts.key, key), eq(alerts.failing, true));
    // One batch: the recovery goes to the channels its failure reached;
    // a failure that reached none goes with it.
    await db.batch([
      db
        .update(alerts)
        .set({
          failing,
          // With when it failed, which the recovery tells.
          event: sql`json_set(${JSON.stringify(event)}, '$.failedAt', ${alerts.changedAt})`,
          changedAt: now,
          pending: sql`${alerts.told}`,
          attempts: 0,
        })
        .where(and(failed, ne(alerts.told, "[]"))),
      db.delete(alerts).where(and(failed, eq(alerts.told, "[]"))),
    ]);
  } catch (error) {
    log.error("alerts.not_recorded", {
      key,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};

const pendingSchema = z.array(z.enum(alertChannelIds));

/**
 * Row `row`'s event, the channels it still has to tell, and those its
 * failure reached; null when it can't be read.
 */
const readStored = (
  row: typeof alerts.$inferSelect
): {
  event: AlertEvent;
  pending: AlertChannel[];
  told: AlertChannel[];
} | null => {
  try {
    return {
      event: alertEventSchema.parse(JSON.parse(row.event)),
      pending: pendingSchema.parse(JSON.parse(row.pending)),
      told: pendingSchema.parse(JSON.parse(row.told)),
    };
  } catch {
    return null;
  }
};

/** The organization `event` is about, as the admin keeps it; null for a release, or one it doesn't hold. */
const organizationOf = async (
  db: AdminDatabase,
  event: AlertEvent
): Promise<AlertOrganization | null> => {
  if (!("clientId" in event)) {
    return null;
  }
  const [organization] = await db
    .select({
      name: clients.name,
      channel: clients.channel,
      pinnedReleaseId: clients.pinnedReleaseId,
    })
    .from(clients)
    .where(eq(clients.id, event.clientId));
  return organization ?? null;
};

/**
 * Saves `told` as the channels row `row`'s failure reached, while the row
 * still holds that change: whether it did.
 */
const saveTold = async (
  db: AdminDatabase,
  row: typeof alerts.$inferSelect,
  told: ReadonlySet<AlertChannel>
): Promise<boolean> => {
  const saved = await db
    .update(alerts)
    .set({ told: JSON.stringify([...told]) })
    .where(and(eq(alerts.key, row.key), eq(alerts.changedAt, row.changedAt)))
    .returning({ key: alerts.key });
  return saved.length > 0;
};

/**
 * Tells one recorded change, `row`, to each channel still to tell that's
 * still on (`senders`): one switched off since is passed over. A channel
 * that refuses it, or isn't set up or can't be read just now, stays to
 * tell, for the next run, until `MAX_ATTEMPTS` runs tried. A failure's
 * channel is saved as told before the send, so a recovery recorded while
 * it's on its way goes to that channel too, and taken back if it refuses:
 * a run that dies in between tells that failure again, never loses its
 * recovery. Saved only while the row still holds this change: one that
 * changed since is left to the next run. A change that recovered is gone
 * once told.
 */
const deliverOne = async (
  env: Env,
  db: AdminDatabase,
  senders: ReadonlyMap<AlertChannel, AlertSender | null>,
  row: typeof alerts.$inferSelect
): Promise<void> => {
  const stored = readStored(row);
  if (stored === null) {
    log.error("alerts.unreadable", { key: row.key });
  }
  const left: AlertChannel[] = [];
  const told = new Set(stored?.told);
  const message =
    stored === null
      ? null
      : messageOf(
          env,
          factsOf(env, {
            event: stored.event,
            organization: await organizationOf(db, stored.event),
            at: row.changedAt,
          })
        );
  for (const channel of stored?.pending ?? []) {
    const send = senders.get(channel);
    if (send === undefined || message === null) {
      continue;
    }
    if (send === null) {
      log.warn("alerts.refused", { key: row.key, channel, code: "not_ready" });
      left.push(channel);
      continue;
    }
    if (row.failing) {
      told.add(channel);
      // oxlint-disable-next-line no-await-in-loop -- two channels at most
      if (!(await saveTold(db, row, told))) {
        // It recovered or changed since this run read it: the next run
        // tells what it holds now.
        return;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const refused = await send(message);
    if (refused !== null) {
      log.warn("alerts.refused", { key: row.key, channel, code: refused });
      left.push(channel);
      if (row.failing) {
        told.delete(channel);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await saveTold(db, row, told);
      }
    }
  }
  const attempts = row.attempts + 1;
  const givenUp = left.length > 0 && attempts >= MAX_ATTEMPTS;
  if (givenUp) {
    log.error("alerts.given_up", { key: row.key, channels: left.join(",") });
  }
  const pending = givenUp ? [] : left;
  const still = and(
    eq(alerts.key, row.key),
    eq(alerts.changedAt, row.changedAt)
  );
  await (pending.length === 0 && !row.failing
    ? db.delete(alerts).where(still)
    : db
        .update(alerts)
        .set({ pending: JSON.stringify(pending), attempts })
        .where(still));
};

/**
 * Tells the channels that are on and set up of each recorded change they
 * haven't been told yet: a pass at the end of each cron run, one run at a
 * time (the `alerts` lease, src/db/lease.ts), so runs that overlap never
 * send a change twice. Each change on its own: one that fails is logged
 * and the rest go on. Never throws.
 */
export const deliverAlerts = async (env: Env): Promise<void> => {
  const db = adminDatabase(env.DB);
  try {
    await withLease(db, "alerts", invocationLeaseMs, async () => {
      const rows = await db
        .select()
        .from(alerts)
        .where(ne(alerts.pending, "[]"));
      if (rows.length === 0) {
        return;
      }
      const senders = await onChannels(env);
      for (const row of rows) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one change at a time: a handful a run
          await deliverOne(env, db, senders, row);
        } catch (error) {
          log.error("alerts.delivery_failed", {
            key: row.key,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    });
  } catch (error) {
    log.error("alerts.delivery_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
};
