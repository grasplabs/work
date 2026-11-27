/**
 * Telling staff when a release or a rollout needs a person: a release
 * that didn't import, an organization whose deploy failed, and each one's
 * recovery. Whatever writes the audit event of such a failure, or of its
 * end, calls `alert` beside it, today the import (src/releases/import.ts)
 * and a deploy's end (src/rollout/deploy.ts), later the rollout's pass
 * for a halt or a blocked rollout. `alert` only records the change, for
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
import { withLease } from "../db/lease.ts";
import { alerts, clients } from "../db/schema.ts";
import { alertChannelIds } from "./alert-channels.ts";
import type { AlertChannel } from "./alert-channels.ts";
import { onChannels, switchedOn } from "./channels.ts";
import { messageFor } from "./senders.ts";
import type { AlertMessage, AlertSender } from "./senders.ts";

/**
 * What changed: a release that failed to import, or imported after that;
 * an organization whose deploy of a release failed, or that deployed one
 * after that. Identifiers and a code only, as the audit event has them.
 */
export const alertEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("import_failed"),
    releaseId: z.string(),
    code: z.string(),
    attempt: z.number().int(),
  }),
  z.object({ kind: z.literal("imported"), releaseId: z.string() }),
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
  }),
]);
export type AlertEvent = z.infer<typeof alertEventSchema>;

/** How many cron runs try a channel that refuses a message before giving up on it. */
export const MAX_ATTEMPTS = 5;

/** What `event` is about, one row a thing, and whether it says that thing fails. */
const subjectOf = (event: AlertEvent): { key: string; failing: boolean } =>
  "clientId" in event
    ? {
        key: `deploy:${event.clientId}`,
        failing: event.kind === "deploy_failed",
      }
    : {
        key: `import:${event.releaseId}`,
        failing: event.kind === "import_failed",
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
  event: AlertEvent,
  now = new Date()
): Promise<void> => {
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
          event: JSON.stringify(event),
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

/**
 * `event` as a message: what happened, to which release and organization,
 * its code, and where in the admin to look.
 */
export const messageOf = (
  env: Env,
  event: AlertEvent,
  name: string | null
): AlertMessage => {
  const releases = "/platform/releases";
  if (event.kind === "import_failed") {
    return messageFor(env, {
      subject: `Release ${event.releaseId} didn't import`,
      text: `The admin couldn't import release ${event.releaseId} (${event.code}, attempt ${event.attempt}). It tries again by itself, waiting longer each time; it reaches no channel until it imports.`,
      path: releases,
    });
  }
  if (event.kind === "imported") {
    return messageFor(env, {
      subject: `Release ${event.releaseId} imported`,
      text: `Release ${event.releaseId} imported after failing before.`,
      path: releases,
    });
  }
  const organization =
    name === null ? event.clientId : `${name} (${event.clientId})`;
  const setup = `/organizations/${encodeURIComponent(event.clientId)}/setup`;
  return event.kind === "deploy_failed"
    ? messageFor(env, {
        subject: `${organization}: deploy of ${event.releaseId} failed`,
        text: `The deploy of release ${event.releaseId} to ${organization} failed (${event.code}). Retry it on its Setup once what stopped it is fixed.`,
        path: setup,
      })
    : messageFor(env, {
        subject: `${organization} deployed ${event.releaseId}`,
        text: `${organization} runs release ${event.releaseId} now, after a failed deploy.`,
        path: setup,
      });
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

/** Organization `clientId`'s name as the admin keeps it; null for a release, or one it doesn't hold. */
const nameOf = async (
  db: AdminDatabase,
  event: AlertEvent
): Promise<string | null> => {
  if (!("clientId" in event)) {
    return null;
  }
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, event.clientId));
  return client?.name ?? null;
};

/**
 * Tells one recorded change, `row`, to each channel still to tell that's
 * still on (`senders`): one switched off since is passed over. A channel
 * that refuses it, or isn't set up or can't be read just now, stays to
 * tell, for the next run, until `MAX_ATTEMPTS` runs tried. Saved only
 * while the row still holds this change: one that changed since is left
 * to the next run. A change that recovered is gone once told.
 */
const deliverOne = async (
  env: Env,
  db: AdminDatabase,
  senders: ReadonlyMap<AlertChannel, AlertSender | null>,
  row: typeof alerts.$inferSelect
): Promise<void> => {
  const stored = readStored(row);
  const left: AlertChannel[] = [];
  const told = new Set(stored?.told);
  if (stored === null) {
    log.error("alerts.unreadable", { key: row.key });
  } else {
    const { event, pending } = stored;
    const message = messageOf(env, event, await nameOf(db, event));
    for (const channel of pending) {
      const send = senders.get(channel);
      if (send === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- two channels at most
      const refused = send === null ? "not_ready" : await send(message);
      if (refused === null) {
        told.add(channel);
      } else {
        log.warn("alerts.refused", { key: row.key, channel, code: refused });
        left.push(channel);
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
        .set({
          pending: JSON.stringify(pending),
          attempts,
          // Only a failure's: a recovery tells no one anything to recover from.
          told: row.failing ? JSON.stringify([...told]) : row.told,
        })
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
    await withLease(db, "alerts", async () => {
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
