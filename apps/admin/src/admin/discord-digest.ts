/**
 * The admin's morning digest (`digestOf`), posted to Grasp's own Discord
 * every weekday at 08:00 in Berlin: the text the admin's Sources page shows
 * as Discord will post it, of every organization whose core answers now.
 *
 * Workers' crons run in UTC, so the digest's cron fires at both hours 08:00
 * in Berlin can be (06:00 UTC in summer, 07:00 in winter) and only the one
 * that is 08:00 there posts: nothing is kept between runs.
 *
 * Where it goes is the webhook URL in Secrets Store
 * (DISCORD_DIGEST_WEBHOOK), which names the channel too. Until someone puts
 * it there, the digest isn't sent and no client is read for it. A URL that
 * isn't a Discord webhook is never posted to: the digest names clients.
 *
 * Each core's audit log records the read, as it does a staff member's in
 * the admin, with the digest as the reader: `digest@` the domain clients
 * are served under.
 */
import { digestOf } from "@grasp-os/shared/admin/admin-tools";
import { log } from "@grasp-os/shared/log";

import { clientAdmins } from "../clients/admin.ts";
import { ifStored, storeSecret } from "../deploy/context.ts";
import { discordWebhookOf, postToDiscord } from "../discord-webhook.ts";
import { organizationsOf } from "./views.ts";

/** The digest's cron (wrangler.jsonc): weekdays, at 06:00 and 07:00 UTC. */
export const digestCron = "0 6,7 * * 1-5";

/** The hour in Berlin the digest is posted at. */
const digestHour = 8;

const berlinClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The day (YYYY-MM-DD) and the hour it is in Berlin at `at`. */
const berlinAt = (at: Date): { day: string; hour: number } => {
  const parts = new Map(
    berlinClock.formatToParts(at).map(({ type, value }) => [type, value])
  );
  return {
    day: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    hour: Number(parts.get("hour")),
  };
};

/** The webhook the digest is posted to; null while there is none, or it isn't Discord's. */
const digestWebhook = async (env: Env): Promise<URL | null> => {
  const stored = await ifStored(
    async () => await storeSecret(env, "DISCORD_DIGEST_WEBHOOK")
  );
  if (stored === null) {
    return null;
  }
  const url = discordWebhookOf(stored);
  if (url === null) {
    log.warn("digest.not_discord", {});
  }
  return url;
};

/**
 * Posts the morning digest to Discord when the digest's cron fires at
 * 08:00 in Berlin; at its other hour, or without a webhook, does nothing.
 * Throws when Discord doesn't take it, so the run shows as failed.
 */
export const sendMorningDigest = async (
  env: Env,
  scheduledAt: Date
): Promise<void> => {
  const { day, hour } = berlinAt(scheduledAt);
  if (hour !== digestHour) {
    return;
  }
  const webhook = await digestWebhook(env);
  if (webhook === null) {
    return;
  }
  const domain = env.CLIENT_DOMAIN ?? "";
  if (domain === "") {
    log.warn("digest.no_client_domain", {});
    return;
  }
  const admins = await clientAdmins(env, {
    email: `digest@${domain}`,
    sub: "",
  });
  const views = organizationsOf(admins).flatMap(({ view }) =>
    view === null ? [] : [view]
  );
  const posted = await postToDiscord(webhook, digestOf(views, day));
  if (!posted.ok) {
    throw new Error(`Discord refused the morning digest: ${posted.status}`);
  }
  log.info("digest.posted", { organizations: views.length });
};
