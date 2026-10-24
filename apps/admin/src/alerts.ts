/**
 * Telling Grasp's staff when something about a client needs a person:
 * one alert, posted to one channel, with the client, what kind of alert
 * it is and a link to the client's page in the admin.
 *
 * The channel is the webhook in Secrets Store (`STAFF_ALERTS_WEBHOOK`),
 * a Discord webhook as the morning digest's is (src/discord-webhook.ts),
 * which names the channel. Until someone puts it there, an alert is only
 * logged, by its client and kind.
 *
 * Threat model, and how each is closed:
 *
 * - A person's content leaking into the channel. An alert's words are
 *   fixed per kind (`alertKinds`); all a caller adds is numbers
 *   (`AlertNumbers`), so no message, name of a file or anything a person
 *   wrote can reach it. The client is named by its id and its name as the
 *   admin keeps it, both of which staff see everywhere already.
 * - A storm. An alert of the same client and kind within its kind's window
 *   isn't sent again: claiming the send is one statement (`claim`), so ten
 *   at once send one.
 * - A send that fails. The claim is given back, so the next alert of the
 *   kind tries again rather than staying silent for a window.
 * - A webhook that isn't Discord's. Never posted to (src/discord-webhook.ts).
 * - Pinging people. Nobody is mentioned (`allowed_mentions`).
 */
import { log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";

import { ifStored } from "./clients/grid.ts";
import { adminDatabase } from "./db/act.ts";
import { clients, staffAlerts } from "./db/schema.ts";
import { storeSecret } from "./deploy/context.ts";
import { discordWebhookOf, postToDiscord } from "./discord-webhook.ts";

/** What a caller may add to an alert: numbers alone, never words. */
export type AlertNumbers = Readonly<Record<string, number>>;

/** A kind of alert: its title, its sentence from its numbers, and its window. */
interface AlertKind {
  title: string;
  words: (numbers: AlertNumbers) => string;
  /** How long after one is sent another of the same client is held back. */
  windowMs: number;
}

/** Every kind of alert's name. */
export type AlertKindName = "test";

/** Every kind of alert, by name. */
export const alertKinds: Readonly<Record<AlertKindName, AlertKind>> = {
  /** Sent by staff, to see the channel works. */
  test: {
    title: "Test alert",
    words: () => "A test from the admin: staff alerts reach this channel.",
    windowMs: 60 * 1000,
  },
};

/** An alert about client `clientId`. */
export interface StaffAlert {
  clientId: string;
  kind: AlertKindName;
  numbers?: AlertNumbers;
}

/** What became of an alert. */
export type AlertOutcome =
  /** Posted to the channel. */
  | "sent"
  /** One of the same client and kind went out within its window. */
  | "held"
  /** No channel is set, or it isn't a Discord webhook: only logged. */
  | "no_channel"
  /** The channel refused it; the next one tries again. */
  | "failed";

/** The channel's webhook; null while there is none, or it isn't Discord's. */
const alertsWebhook = async (env: Env): Promise<URL | null> => {
  const stored = await ifStored(
    async () => await storeSecret(env, "STAFF_ALERTS_WEBHOOK")
  );
  if (stored === null) {
    return null;
  }
  const url = discordWebhookOf(stored);
  if (url === null) {
    log.warn("alerts.not_discord", {});
  }
  return url;
};

/**
 * Claims the send of `alert` at `now`: true when none of its client and
 * kind went out within its window, recording this one as sent. One
 * statement, so of alerts racing each other only one claims it.
 */
const claim = async (
  env: Env,
  { clientId, kind }: StaffAlert,
  now: Date
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const since = now.getTime() - alertKinds[kind].windowMs;
  const claimed = await db
    .insert(staffAlerts)
    .values({ clientId, kind, sentAt: now })
    .onConflictDoUpdate({
      target: [staffAlerts.clientId, staffAlerts.kind],
      set: { sentAt: now },
      setWhere: sql`${staffAlerts.sentAt} <= ${since}`,
    })
    .returning({ kind: staffAlerts.kind });
  return claimed.length > 0;
};

/** Gives back the claim of `alert` made at `at`, unless a later one replaced it. */
const release = async (
  env: Env,
  { clientId, kind }: StaffAlert,
  at: Date
): Promise<void> => {
  const db = adminDatabase(env.DB);
  await db
    .delete(staffAlerts)
    .where(
      and(
        eq(staffAlerts.clientId, clientId),
        eq(staffAlerts.kind, kind),
        eq(staffAlerts.sentAt, at)
      )
    );
};

/** Client `clientId`'s page in the admin; null while the admin has no hostname of its own. */
const clientPage = (env: Env, clientId: string): string | null => {
  const host = env.ADMIN_HOST ?? "";
  return host === ""
    ? null
    : `https://${host}/organizations/${encodeURIComponent(clientId)}/setup`;
};

/** `alert` about the client named `name` as its message. */
const messageOf = (
  env: Env,
  alert: StaffAlert,
  name: string | null
): string => {
  const kind = alertKinds[alert.kind];
  const client = name === null ? alert.clientId : `${name} (${alert.clientId})`;
  const page = clientPage(env, alert.clientId);
  return [
    `**${kind.title}**: ${client}`,
    kind.words(alert.numbers ?? {}),
    ...(page === null ? [] : [page]),
  ].join("\n");
};

/**
 * Tells staff `alert` at `now`, in the alerts' channel, unless one of the
 * same client and kind went out within its window. What became of it;
 * never throws for the channel, so whatever raised the alert goes on.
 */
export const sendStaffAlert = async (
  env: Env,
  alert: StaffAlert,
  now = new Date()
): Promise<AlertOutcome> => {
  const fields = { client: alert.clientId, kind: alert.kind };
  const webhook = await alertsWebhook(env);
  if (webhook === null) {
    log.warn("alerts.no_channel", fields);
    return "no_channel";
  }
  if (!(await claim(env, alert, now))) {
    return "held";
  }
  const [client] = await adminDatabase(env.DB)
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, alert.clientId));
  try {
    const posted = await postToDiscord(
      webhook,
      messageOf(env, alert, client?.name ?? null)
    );
    if (posted.ok) {
      log.info("alerts.sent", fields);
      return "sent";
    }
    log.warn("alerts.refused", { ...fields, status: posted.status });
  } catch {
    // Nothing of the webhook's URL: it's the channel's credential.
    log.warn("alerts.unreachable", fields);
  }
  await release(env, alert, now);
  return "failed";
};
