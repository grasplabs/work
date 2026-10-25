/**
 * Watching Stephen at every client, so Grasp knows before a client tells
 * it. Every hour the watch reads each active client's admin snapshot
 * (src/clients/admin.ts), whose `stephen` counts core keeps of how he
 * fared in the chat apps over the last day (core's
 * src/channels/signals.ts), and whose integrations say which connections
 * need a new sign-in. Counts only: nothing anyone wrote, nor who.
 *
 * Each signal has a bar (`bars`). When one goes over it, staff are told
 * once in the staff alerts' channel (src/alerts.ts), with the client and
 * a link to its page; not again while it stays over, and again once it
 * went back under and over again (`clearStaffAlert`). What the watch read
 * last is kept (`client_watch`) for the client's Setup to show, a line a
 * signal.
 *
 * The bot secret's expiry is watched apart, by the day
 * (src/clients/teams-bot-expiry.ts, GRA-782).
 *
 * Each read is in the client's own audit log, as every staff read of its
 * snapshot is, by the watch: `watch@` the domain clients are served under.
 * A client whose company ended Grasp's staff access refuses the read, and
 * isn't watched until it opens it again.
 */
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";

import { clearStaffAlert, sendStaffAlert } from "../alerts.ts";
import { adminDatabase } from "../db/act.ts";
import { clientWatch } from "../db/schema.ts";
import { clientSnapshots } from "./admin.ts";
import { bars, signalsOf, watchedSignalsSchema } from "./watch-signals.ts";
import type { WatchedSignals } from "./watch-signals.ts";

/** The watch's cron (wrangler.jsonc): every hour, at 45 past. */
export const watchCron = "45 * * * *";

/**
 * Tells staff of each of client `clientId`'s `signals` that went over its
 * bar, once, and clears each that's back under, at `now`.
 */
const alertOn = async (
  env: Env,
  clientId: string,
  signals: WatchedSignals,
  now: Date
): Promise<void> => {
  for (const { kind, over } of bars) {
    const numbers = over(signals);
    // oxlint-disable-next-line no-await-in-loop -- a few alerts, one at a time
    await (numbers === null
      ? clearStaffAlert(env, clientId, kind)
      : sendStaffAlert(env, { clientId, kind, numbers }, now));
  }
};

/** Keeps `signals` as what the watch last read of client `clientId`. */
const keep = async (
  env: Env,
  clientId: string,
  signals: WatchedSignals,
  now: Date
): Promise<void> => {
  const value = JSON.stringify(signals);
  await adminDatabase(env.DB)
    .insert(clientWatch)
    .values({ clientId, readAt: now, signals: value })
    .onConflictDoUpdate({
      target: clientWatch.clientId,
      set: { readAt: now, signals: value },
    });
};

/**
 * Reads every active client's Stephen at `now`, keeps it and tells staff
 * of each signal over its bar. A client that doesn't answer is left as it
 * was: the grid says it's unreachable, and its alerts stand.
 */
export const watchStephen = async (env: Env, now: Date): Promise<void> => {
  const domain = env.CLIENT_DOMAIN ?? "";
  if (domain === "") {
    log.warn("watch.no_client_domain", {});
    return;
  }
  const read = await clientSnapshots(env, {
    email: `watch@${domain}`,
    sub: "",
  });
  let watched = 0;
  for (const { client, outcome } of read) {
    const signals = "snapshot" in outcome ? signalsOf(outcome.snapshot) : null;
    if (signals === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one client at a time: its alerts in order
    await keep(env, client.id, signals, now);
    // oxlint-disable-next-line no-await-in-loop -- one client at a time: its alerts in order
    await alertOn(env, client.id, signals, now);
    watched += 1;
  }
  log.info("watch.read", { clients: read.length, watched });
};

/** What the watch last read of client `clientId`, and when; null before it read any. */
export const lastWatched = async (
  env: Env,
  clientId: string
): Promise<{ readAt: Date; signals: WatchedSignals } | null> => {
  const [row] = await adminDatabase(env.DB)
    .select({ readAt: clientWatch.readAt, signals: clientWatch.signals })
    .from(clientWatch)
    .where(eq(clientWatch.clientId, clientId));
  if (row === undefined) {
    return null;
  }
  const signals = watchedSignalsSchema.safeParse(JSON.parse(row.signals));
  return signals.success ? { readAt: row.readAt, signals: signals.data } : null;
};
