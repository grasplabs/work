/**
 * The two ways an alert reaches staff (src/alerts/alert.ts), each a sender
 * that takes one message and says whether it went: mail through
 * Cloudflare's Email Sending, from and to the one mailbox the deploy binds
 * `ALERTS_MAIL` to (cf-worker.ts), and a post to Grasp's Discord through
 * the webhook in Secrets Store (`DISCORD_ALERTS_WEBHOOK`). A channel
 * whose binding or webhook isn't there has no sender: it isn't set up,
 * which its part on Platform's Maintenance page says.
 *
 * Threat model, and how each is closed:
 *
 * - Customer data reaching a channel. A message is built from identifiers,
 *   a code and the organization's name as the admin keeps it
 *   (`messageOf`, src/alerts/alert.ts): nothing anyone wrote in Grasp.
 * - Mail going anywhere else. The binding may send from one address to
 *   one mailbox, as the deploy restricts it; Cloudflare refuses any other.
 * - The webhook leaking. It's a credential: read from Secrets Store at
 *   send time, never stored in the database, logged or sent to a page.
 *   One that isn't a Discord webhook is never posted to. Its token is in
 *   its URL's path, which the Worker's traces record for every fetch
 *   (`url.full`, `url.path`; only the query is redacted): whoever reads
 *   the admin's traces in Grasp's Cloudflare account can read it. That is
 *   accepted: it can only post to that one channel, and deleting the
 *   webhook in Discord revokes it.
 * - Pinging people. Nobody is mentioned (`allowed_mentions`), so an
 *   organization named "@everyone" pings nobody.
 * - A channel that hangs or fails. A send never throws, and Discord's has
 *   a time limit: the caller gets a code, logs it and tries again later.
 */
import "@tanstack/react-start/server-only";
import { ifStored, storeSecret } from "../deploy/context.ts";
import type { AlertChannel } from "./alert-channels.ts";

/** One alert as a channel sends it: a subject line and its text. */
export interface AlertMessage {
  subject: string;
  text: string;
}

/**
 * A message of this stage's admin: staging's subjects say so, and a link
 * to place `path` in the admin follows the text on a line of its own, by
 * the admin's own hostname, while it has one.
 */
export const messageFor = (
  env: Env,
  { subject, text, path }: AlertMessage & { path: string }
): AlertMessage => ({
  subject: env.STAGE === "production" ? subject : `[${env.STAGE}] ${subject}`,
  text:
    env.ADMIN_HOST === "" ? text : `${text}\nhttps://${env.ADMIN_HOST}${path}`,
});

/** Sends a message: null once the channel took it, else a code saying why not. Never throws. */
export type AlertSender = (message: AlertMessage) => Promise<string | null>;

/** The hosts a Discord webhook URL is served from. */
const discordHosts = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);
const webhookPath = "/api/webhooks/";

/** The most characters Discord takes in a message. */
const discordMessageMax = 2000;

/** How long Discord may take to take a message. */
const discordTimeoutMs = 10_000;

/** `stored` as a Discord webhook's URL; null when it isn't one. */
export const discordWebhookOf = (stored: string): URL | null => {
  const url = URL.parse(stored.trim());
  const isDiscord =
    url?.protocol === "https:" &&
    discordHosts.has(url.hostname) &&
    url.pathname.startsWith(webhookPath);
  return isDiscord ? url : null;
};

/** `message` as one Discord message, cut short when it's longer than one takes. */
const discordContent = ({ subject, text }: AlertMessage): string => {
  const content = `**${subject}**\n${text}`;
  return content.length <= discordMessageMax
    ? content
    : `${content.slice(0, discordMessageMax - 1)}…`;
};

/** The Discord channel's sender; null while its webhook isn't in Secrets Store, or isn't Discord's. */
const discordSender = async (env: Env): Promise<AlertSender | null> => {
  const stored = await ifStored(
    async () => await storeSecret(env, "DISCORD_ALERTS_WEBHOOK")
  );
  const webhook = stored === null ? null : discordWebhookOf(stored);
  if (webhook === null) {
    return null;
  }
  const post: AlertSender = async (message) => {
    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: discordContent(message),
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(discordTimeoutMs),
        // Discord answers a post itself: a redirect is a refusal, never
        // followed with the message.
        redirect: "manual",
      });
      await response.body?.cancel();
      return response.ok ? null : `discord_${response.status}`;
    } catch {
      // Nothing of the URL: it's the channel's credential.
      return "discord_unreachable";
    }
  };
  return post;
};

/** The `E_…` code Email Sending threw with, if it has one. */
const mailCodeOf = (error: unknown): string => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" && /^E_[A-Z_]+$/u.test(code)
    ? code
    : "mail_unreachable";
};

/**
 * The mail channel's sender; null until a deploy bound `ALERTS_MAIL`,
 * which it does only once the stage's 1Password Environment has both
 * addresses (`ALERTS_MAIL_FROM`, `ALERTS_MAIL_TO`).
 */
const mailSender = (env: Env): AlertSender | null => {
  const binding = env.ALERTS_MAIL;
  const from = env.ALERTS_MAIL_FROM;
  const to = env.ALERTS_MAIL_TO;
  if (binding === undefined || from === undefined || to === undefined) {
    return null;
  }
  const mail: AlertSender = async ({ subject, text }) => {
    try {
      await binding.send({
        from: { name: "Grasp admin", email: from },
        to,
        subject,
        text,
      });
      return null;
    } catch (error) {
      return mailCodeOf(error);
    }
  };
  return mail;
};

/** Channel `channel`'s sender; null while it isn't set up. */
export const senderOf = async (
  env: Env,
  channel: AlertChannel
): Promise<AlertSender | null> =>
  channel === "mail" ? mailSender(env) : await discordSender(env);
