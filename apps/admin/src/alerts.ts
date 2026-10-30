/**
 * Telling Grasp's staff when something about a client needs a person:
 * one alert, posted to one channel, with the client, what kind of alert
 * it is and a link to the client's page in the admin.
 *
 * The channel is the webhook in Secrets Store (`STAFF_ALERTS_WEBHOOK`),
 * a Discord webhook as the morning digest's is (src/discord-webhook.ts),
 * which names the channel. Until someone adds it to the stage's 1Password
 * Environment and runs Deploy platform, which binds it, an alert is only
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
export type AlertKindName =
  | "test"
  | "teams_bot_secret_expiring"
  | "stephen_refused"
  | "stephen_failing"
  | "stephen_slow"
  | "stephen_over_budget"
  | "stephen_busy"
  | "stephen_sends_failing"
  | "stephen_uninstalled"
  | "stephen_connections_again"
  | "release_rolled_back"
  | "release_rollback_failed"
  | "hosting_check_failed";

/**
 * How long one of the watch's alerts holds back the next of its kind: as
 * long as it takes, since the watch clears it once the signal is back
 * under its bar (`clearStaffAlert`, src/clients/watch.ts). One alert as a
 * signal goes over; another only once it went back and over again.
 */
const untilClearedMs = 400 * 24 * 60 * 60 * 1000;

/** Milliseconds as seconds, to one decimal. */
const secondsOf = (ms: number): string => (ms / 1000).toFixed(1);

/** Every kind of alert, by name. */
export const alertKinds: Readonly<Record<AlertKindName, AlertKind>> = {
  /** Sent by staff, to see the channel works. */
  test: {
    title: "Test alert",
    words: () => "A test from the admin: staff alerts reach this channel.",
    windowMs: 60 * 1000,
  },
  /**
   * Its Teams bot's secret runs out soon (src/clients/teams-bot-expiry.ts):
   * `days` left, none or fewer once it has. Sent once for each stage of
   * each expiry day, which its subject names.
   */
  teams_bot_secret_expiring: {
    title: "Teams bot secret expiring",
    words: ({ days = 0 }) => {
      const action =
        "Mint a new client secret for its bot in its own Entra and set it on its Setup, with the day it expires.";
      if (days > 1) {
        return `Its Teams bot's secret expires in ${days} days. ${action}`;
      }
      if (days === 1) {
        return `Its Teams bot's secret expires tomorrow. ${action}`;
      }
      if (days === 0) {
        return `Its Teams bot's secret expires today: Stephen stops answering in Teams once it has. ${action}`;
      }
      return `Its Teams bot's secret has expired: Stephen can't answer in Teams. ${action}`;
    },
    // Each stage of an expiry day is its own subject: once is enough.
    windowMs: 400 * 24 * 60 * 60 * 1000,
  },
  // Stephen in the chat apps, over the last day, as the watch reads it.
  stephen_refused: {
    title: "Stephen: requests refused",
    words: ({ refused = 0 }) =>
      `Its door refused ${refused} requests in the last day as not sent by Teams for its bot. If its people are writing, check its bot's app id and tenant on its Setup.`,
    windowMs: untilClearedMs,
  },
  stephen_failing: {
    title: "Stephen: turns failing",
    words: ({ failed = 0, turns = 0 }) =>
      `${failed} of ${turns} turns in the last day ended in Stephen's line for a failure.`,
    windowMs: untilClearedMs,
  },
  stephen_slow: {
    title: "Stephen: answers slow",
    words: ({ p90Ms = 0 }) =>
      `9 in 10 answers in the last day took up to ${secondsOf(p90Ms)} s, over the bar of 12 s.`,
    windowMs: untilClearedMs,
  },
  stephen_over_budget: {
    title: "Stephen: over budget",
    words: ({ overBudget = 0 }) =>
      `${overBudget} turns in the last day were refused for the company's AI budget.`,
    windowMs: untilClearedMs,
  },
  stephen_busy: {
    title: "Stephen: busy",
    words: ({ busy = 0 }) =>
      `${busy} turns in the last day were turned away as the model or the agent was busy.`,
    windowMs: untilClearedMs,
  },
  stephen_sends_failing: {
    title: "Stephen: sends failing",
    words: ({ failed = 0 }) =>
      `Teams didn't take ${failed} of Stephen's answers or lines in the last day, besides any for an uninstalled app.`,
    windowMs: untilClearedMs,
  },
  stephen_uninstalled: {
    title: "Stephen: app uninstalled",
    words: ({ uninstalled = 0 }) =>
      `Teams refused ${uninstalled} of Stephen's answers in the last day as his app is no longer installed for those people.`,
    windowMs: untilClearedMs,
  },
  /**
   * A release failed its probe once its code was live, and the client was
   * rolled back to the release before on its own (src/hosting/operation.ts).
   */
  /**
   * Provisioning read back a database or bucket outside the jurisdiction
   * its hosting policy requires: it stopped, and the destination takes no
   * one until a person looks (src/hosting/provision.ts).
   */
  hosting_check_failed: {
    title: "Hosting check failed",
    words: () =>
      "Provisioning found a database or bucket outside the jurisdiction its hosting policy requires, and stopped. Nothing more is placed in that destination until someone checks it.",
    windowMs: untilClearedMs,
  },
  release_rolled_back: {
    title: "Release rolled back",
    words: () =>
      "A release failed its probe once live, so the client was rolled back to the release before. Look at the release before releasing it again.",
    windowMs: 60 * 1000,
  },
  /** As `release_rolled_back`, but the rollback didn't finish: it may serve broken. */
  release_rollback_failed: {
    title: "Release failed, rollback didn't finish",
    words: () =>
      "A release failed its probe once live, and rolling the client back didn't finish: it may be serving the broken release. Look at its Setup now.",
    windowMs: 60 * 1000,
  },
  stephen_connections_again: {
    title: "Stephen: connections need a new sign-in",
    words: ({ company = 0, personal = 0 }) =>
      `${company} of the company's connections and ${personal} of people's own need a new sign-in before Stephen can use them.`,
    windowMs: untilClearedMs,
  },
};

/** An alert about client `clientId`. */
export interface StaffAlert {
  clientId: string;
  kind: AlertKindName;
  /**
   * What of the client it's about, when one kind can be about several
   * things in turn, such as the stage of a secret's expiry: alerts of
   * another subject aren't held back by this one's. An identifier, never
   * shown.
   */
  subject?: string;
  numbers?: AlertNumbers;
}

/** What `alert` is held back by: its kind, and its subject if it has one. */
const heldBy = ({ kind, subject }: StaffAlert): string =>
  subject === undefined ? kind : `${kind}/${subject}`;

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
  alert: StaffAlert,
  now: Date
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const since = now.getTime() - alertKinds[alert.kind].windowMs;
  const claimed = await db
    .insert(staffAlerts)
    .values({ clientId: alert.clientId, kind: heldBy(alert), sentAt: now })
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
  alert: StaffAlert,
  at: Date
): Promise<void> => {
  const db = adminDatabase(env.DB);
  await db
    .delete(staffAlerts)
    .where(
      and(
        eq(staffAlerts.clientId, alert.clientId),
        eq(staffAlerts.kind, heldBy(alert)),
        eq(staffAlerts.sentAt, at)
      )
    );
};

/**
 * Clears what holds back the next `kind` alert about client `clientId`:
 * the watch's alerts, once their signal is back under its bar, so the next
 * time it goes over is told again. Whether one was held.
 */
export const clearStaffAlert = async (
  env: Env,
  clientId: string,
  kind: AlertKindName
): Promise<boolean> => {
  const cleared = await adminDatabase(env.DB)
    .delete(staffAlerts)
    .where(and(eq(staffAlerts.clientId, clientId), eq(staffAlerts.kind, kind)))
    .returning({ kind: staffAlerts.kind });
  return cleared.length > 0;
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
