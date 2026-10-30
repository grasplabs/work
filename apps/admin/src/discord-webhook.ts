/**
 * Posting to a channel of Grasp's own Discord through a webhook, as the
 * morning digest (src/admin/discord-digest.ts) does. The webhook's URL names the channel and is its
 * credential, so it's kept in Secrets Store; a URL that isn't a Discord
 * webhook is never posted to, since what's posted names clients.
 */

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

/** `text` as one Discord message, cut short when it's longer than one takes. */
const asMessage = (text: string): string =>
  text.length <= discordMessageMax
    ? text
    : `${text.slice(0, discordMessageMax - 1)}…`;

/**
 * Posts `text` to `webhook` as one message, nobody pinged: a client's name
 * is never a mention. Discord's answer's status, and whether it took it.
 */
export const postToDiscord = async (
  webhook: URL,
  text: string
): Promise<{ ok: boolean; status: number }> => {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: asMessage(text),
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(discordTimeoutMs),
  });
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
};
