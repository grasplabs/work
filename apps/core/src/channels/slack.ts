/**
 * Slack as a door into core: the Chat SDK's Slack adapter, with every
 * request it is handed checked here, before anything of it reaches a
 * handler, as really sent by Slack for this client's app.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. Every request must carry Slack's
 *   signature (`x-slack-signature`): `v0=` and the HMAC-SHA256, under the
 *   client's app's signing secret (`SLACK_SIGNING_SECRET`), of `v0:`, the
 *   request's timestamp, `:` and its body exactly as sent. One without it,
 *   or with another, is refused; the comparison is the platform's own
 *   constant-time verify.
 * - A captured request sent again. Its timestamp
 *   (`x-slack-request-timestamp`) is signed with it and must be within
 *   five minutes of core's clock; within that window the door takes each
 *   event once, by its `event_id`.
 * - Another workspace's app. Only this client's signing secret signs: a
 *   request any other Slack app was sent fails its check.
 * - Misconfiguration. Without `SLACK_SIGNING_SECRET` the door answers 404
 *   and every request would be refused: nothing falls back to accepting.
 * - The adapter's own check. The adapter is always given this verifier,
 *   which takes precedence over everything else it would check with.
 *
 * Everything the adapter sends goes out through connect, which holds the
 * bot's token: core builds the adapter with the placeholder connect swaps
 * for it (`channelCredentialPlaceholder`).
 */
import { SlackAdapter } from "@chat-adapter/slack";
import { channelCredentialPlaceholder } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import type { Logger } from "chat";

import { throughConnect } from "./through-connect.ts";

/** How far a request's timestamp may be from core's clock. */
const toleranceSeconds = 5 * 60;

const signaturePattern = /^v0=(?<mac>[0-9a-f]{64})$/u;
const timestampPattern = /^\d{1,12}$/u;

/** Bytes from lowercase hex. */
const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));

/** Why a Slack request was refused, as the log says it. */
type Refusal = "unconfigured" | "signature" | "timestamp" | "mac";

/** Why `request` isn't Slack's, signed for this client's app, or undefined. */
const refusalOf = async (
  env: Env,
  request: Request,
  body: string,
  now: number
): Promise<Refusal | undefined> => {
  const secret = env.SLACK_SIGNING_SECRET;
  if (secret === undefined || secret === "") {
    return "unconfigured";
  }
  const mac = signaturePattern.exec(
    request.headers.get("x-slack-signature") ?? ""
  )?.groups?.mac;
  if (mac === undefined) {
    return "signature";
  }
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  if (
    !timestampPattern.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds
  ) {
    return "timestamp";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = await crypto.subtle.verify(
    "HMAC",
    key,
    hexBytes(mac),
    new TextEncoder().encode(`v0:${timestamp}:${body}`)
  );
  return signed ? undefined : "mac";
};

/**
 * Whether `request`, with `body` as it was sent, is Slack's, signed for
 * this client's app within the last five minutes. A refusal is logged by
 * its reason, never with anything the request carried.
 */
export const verifiedSlackRequest = async (
  env: Env,
  request: Request,
  body: string,
  now = Date.now()
): Promise<boolean> => {
  const refusal = await refusalOf(env, request, body, now);
  if (refusal !== undefined) {
    log.info("channel.refused", { platform: "slack", reason: refusal });
    return false;
  }
  return true;
};

/**
 * Chat SDK's logs stay out of core's but for what fails, as for Teams
 * (teams.ts): only the message of a warning or an error is kept.
 */
const silent = (): void => undefined;
const slackLogger: Logger = {
  child: () => slackLogger,
  debug: silent,
  info: silent,
  warn: (message) => {
    log.warn("channel.slack", { message });
  },
  error: (message) => {
    log.error("channel.slack", { message });
  },
};

/** Sends one of the adapter's requests through connect, as the client's bot. */
const viaConnect =
  (env: Env) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    await env.CONNECT.channelFetch("slack", new Request(input, init));

/**
 * Slack's adapter for this client's app, every request it is handed checked
 * by {@link verifiedSlackRequest}. Slack's Web API client sends through
 * axios, and every request it makes is handed to connect
 * ({@link throughConnect}), which sends it on with the bot's token in
 * place of the placeholder, or refuses it. Connect waits out
 * Slack's rate limits itself, so the client tries nothing again; nor does
 * the adapter stream, which Slack's streaming methods would need.
 */
export const slackAdapter = (env: Env): SlackAdapter => {
  const send = viaConnect(env);
  return new SlackAdapter({
    webhookVerifier: async (request, body) =>
      await verifiedSlackRequest(env, request, body),
    botToken: channelCredentialPlaceholder,
    fetch: send,
    nativeStreaming: false,
    userName: "Stephen",
    logger: slackLogger,
    webClientOptions: {
      retryConfig: { retries: 0 },
      requestInterceptor: (config) => throughConnect(config, send),
    },
  });
};
