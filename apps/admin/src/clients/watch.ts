/**
 * Watching Stephen at every client, so Grasp knows before a client tells
 * it. Every hour the watch reads each active client's admin snapshot
 * (src/clients/admin.ts), whose `stephen` counts core keeps of how he
 * fared in the chat apps over the last day (core's
 * src/channels/signals.ts), and whose integrations say which connections
 * need a new sign-in. Counts only: nothing anyone wrote, nor who.
 *
 * What the watch read last is kept (`client_watch`) for the client's
 * Setup to show, a line a signal, each over its bar marked
 * (src/clients/watch-signals.ts) and the Setup saying it needs a look.
 *
 * Each read is in the client's own audit log, as every staff read of its
 * snapshot is, by the watch: `watch@` the domain clients are served under.
 * A client whose company ended Grasp's staff access refuses the read, and
 * isn't watched until it opens it again.
 */
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { clientWatch } from "../db/schema.ts";
import { clientSnapshots } from "./admin.ts";
import { signalsOf, watchedSignalsSchema } from "./watch-signals.ts";
import type { WatchedSignals } from "./watch-signals.ts";

/** The watch's cron (wrangler.jsonc): every hour, at 45 past. */
export const watchCron = "45 * * * *";

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
 * Reads every active client's Stephen at `now`, and keeps it. A client
 * that doesn't answer is left as it was: the grid says it's unreachable.
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
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    await keep(env, client.id, signals, now);
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
