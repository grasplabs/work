/**
 * Telegram as a door into core: the Chat SDK's Telegram adapter (the Bot
 * API, by webhook), with every request it is handed checked here, before
 * anything of it reaches a handler, as really sent by Telegram for this
 * client's bot.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. Telegram signs nothing; it sends
 *   the secret the webhook was registered with
 *   (`x-telegram-bot-api-secret-token`). Every request must carry the
 *   client's (`TELEGRAM_WEBHOOK_SECRET`), compared in constant time; one
 *   without it, or with another, is refused.
 * - A captured request sent again. Each update is taken once, by its
 *   `update_id`, for a day.
 * - Other bots, groups and channels. Messages from bots are dropped; one
 *   in a group or a channel gets a single line, and nothing in it is read.
 * - A Telegram name standing for a person. Anyone can name themselves
 *   anything: a sender is only ever their numeric Telegram id, matched to
 *   a Grasp person through an account they linked themselves (who.ts).
 * - Misconfiguration. Without the webhook secret the door answers 404 and
 *   every request would be refused.
 * - The adapter's own check. The adapter is given the same secret, so it
 *   checks every request again, and runs in webhook mode only: it never
 *   polls Telegram for updates.
 *
 * Everything the adapter sends goes out through connect, which holds the
 * bot's token: core builds every Bot API address with the placeholder in
 * the token's place (`channelCredentialPlaceholder`), which connect swaps
 * for the real one. The adapter's file downloads aren't used: Stephen reads
 * text only.
 */
import { TelegramAdapter } from "@chat-adapter/telegram";
import { channelCredentialPlaceholder } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import type { Logger } from "chat";

/** Telegram's Bot API. */
export const telegramApi = "https://api.telegram.org";

/** The header Telegram sends the webhook's secret in. */
const secretHeader = "x-telegram-bot-api-secret-token";

/** Whether the deployment set Telegram up: its webhook's secret. */
export const telegramSetUp = (env: Env): boolean =>
  env.TELEGRAM_WEBHOOK_SECRET !== undefined &&
  env.TELEGRAM_WEBHOOK_SECRET !== "";

/** Whether `a` and `b` are the same text, compared in constant time. */
const sameText = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return (
    left.byteLength === right.byteLength &&
    crypto.subtle.timingSafeEqual(left, right)
  );
};

/**
 * Whether `request` is Telegram's, carrying this client's webhook secret.
 * A refusal is logged by its reason, never with anything it carried.
 */
export const verifiedTelegramRequest = (
  env: Env,
  request: Request
): boolean => {
  const secret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const sent = request.headers.get(secretHeader);
  let reason: "unconfigured" | "secret" | undefined;
  if (secret === "") {
    reason = "unconfigured";
  } else if (sent === null || !sameText(sent, secret)) {
    reason = "secret";
  }
  if (reason !== undefined) {
    log.info("channel.refused", { platform: "telegram", reason });
    return false;
  }
  return true;
};

/**
 * Chat SDK's logs stay out of core's but for what fails, as for Teams
 * (teams.ts): only the message of a warning or an error is kept.
 */
const silent = (): void => undefined;
const telegramLogger: Logger = {
  child: () => telegramLogger,
  debug: silent,
  info: silent,
  warn: (message) => {
    log.warn("channel.telegram", { message });
  },
  error: (message) => {
    log.error("channel.telegram", { message });
  },
};

/** The Bot API's answer, as far as the adapter reads it. */
interface BotAnswer<TResult> {
  ok?: boolean;
  result?: TResult;
}

/**
 * Telegram's adapter, sending every Bot API call through connect: the
 * SDK's adapter sends with the global fetch, so its one sender is replaced
 * here.
 */
class ConnectedTelegramAdapter extends TelegramAdapter {
  readonly #env: Env;

  constructor(env: Env) {
    super({
      botToken: channelCredentialPlaceholder,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET ?? "",
      apiUrl: telegramApi,
      mode: "webhook",
      userName: "Stephen",
      logger: telegramLogger,
    });
    this.#env = env;
  }

  // oxlint-disable-next-line grasp/no-unbounded-rpc-target -- an SDK adapter, never an RPC target: the SDK's own hook
  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData
  ): Promise<TResult> {
    if (payload instanceof FormData) {
      throw new TypeError("Stephen sends Telegram no files");
    }
    const response = await this.#env.CONNECT.channelFetch(
      "telegram",
      new Request(
        `${telegramApi}/bot${channelCredentialPlaceholder}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        }
      )
    );
    let answer: BotAnswer<TResult> | undefined;
    try {
      answer = await response.json<BotAnswer<TResult>>();
    } catch {
      answer = undefined;
    }
    if (!response.ok || answer?.ok !== true || answer.result === undefined) {
      throw new Error(`Telegram refused ${method} (${response.status})`);
    }
    return answer.result;
  }
}
export type { ConnectedTelegramAdapter };

/** Telegram's adapter for this client's bot. */
export const telegramAdapter = (env: Env): ConnectedTelegramAdapter =>
  new ConnectedTelegramAdapter(env);
