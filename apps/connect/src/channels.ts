import type { AuditDetailValue } from "@grasp-os/shared/audit";
import {
  channelAnswer,
  channelCredentialPlaceholder,
  channelHeader,
  channelPlatformSchema,
} from "@grasp-os/shared/connect";
import type { ChannelAnswer } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { recordEvents } from "./audit.ts";

// Sending as a client's own bot on a chat platform, Teams and Slack. Core's
// chat adapters (the Chat SDK's) run in core and send through one fetch,
// which hands each request here as it is (`channelFetch`); connect sends
// it on as the bot, or refuses it. Core never holds the bot's secret or
// its token: its adapters are built with a placeholder credential
// (`channelCredentialPlaceholder`), which connect swaps for the real one.
// What could go wrong, and what stops it:
//
// - Being sent elsewhere. Only the platform's own hosts are reached, over
//   HTTPS on their own port without credentials in the URL, and on the Bot
//   Connector only its conversations API. A `serviceUrl` a verified Teams
//   message names is never trusted for being named: its host must be on
//   the list. Redirects aren't followed (one would take the token along).
//   Connect's `global_fetch_strictly_public` keeps a public name that
//   resolves to a private address unreachable.
// - Core sending a credential of its own, or reading the bot's. A request
//   must carry the placeholder exactly where the credential goes, or it is
//   refused before anything is fetched; nothing else of core's headers
//   but its content type goes on. The token request Microsoft's Teams SDK
//   sends is answered here with the placeholder as the token: Entra is
//   asked for the real one only by connect, with the bot's secret, and the
//   real token never goes back to core. The SDK's sign-in metadata reads
//   (`login.microsoftonline.com`'s discovery and OpenID configuration) are
//   public and go on with nothing of core's request.
// - Another app's token, or the bot's for another API. The token request is
//   answered only for the bot's own app ID, the client-credentials grant,
//   and the Bot Connector's scope; Graph and anything else is refused until
//   a platform needs it and adds it here.
// - A bot that isn't set up: until the console sets the bot's ID, tenant
//   and secret, every request is refused as `unconfigured`.
//
// Slack: only Slack's Web API (`https://slack.com/api/<method>`), and of
// it only the methods an adapter needs to answer in a chat: posting,
// changing and removing its own messages, and reading who it is and
// whom it writes to (`slackMethods`). Each must carry the placeholder as
// its bearer token, which connect swaps for the app's bot token
// (`SLACK_BOT_TOKEN`); Slack's token never goes back to core.
//
// WhatsApp: only the Cloud API's messages endpoint of the client's own
// business number (`https://graph.facebook.com/v<n>/<phone number id>/
// messages`), posted, with the placeholder as its bearer token, which
// connect swaps for the client's system user token
// (`WHATSAPP_ACCESS_TOKEN`). Media, templates, the number's settings and
// every other Graph path are refused, and so is another number's id.
//
// The token is cached in this isolate until shortly before it expires,
// keyed by the bot's app, tenant and a hash of its secret, so rotating the
// secret takes a new token at once. Only the token is cached, never a
// promise of one: a fetch begun for one request can't be awaited by
// another in workerd. Two sends at once may each fetch one; both are good.
//
// Every send, edit or delete that leaves, and every refusal, is recorded
// in connect's audit outbox as `channel.call`, by platform, method, host
// and status: never the path (it names the conversation), the body or a
// header. Typing indicators are only logged: they say nothing a person
// sent, and would double the log.

/** One platform's bot, from connect's secrets. */
interface Bot {
  id: string;
  tenant: string;
  secret: string;
}

/** The Teams bot, if the console set it up. */
const teamsBotOf = (env: Env): Bot | undefined => {
  const {
    TEAMS_BOT_ID: id,
    TEAMS_BOT_TENANT_ID: tenant,
    TEAMS_BOT_SECRET: secret,
  } = env;
  if (
    id === undefined ||
    id === "" ||
    tenant === undefined ||
    tenant === "" ||
    secret === undefined ||
    secret === ""
  ) {
    return undefined;
  }
  return { id, tenant, secret };
};

/** Where Entra issues the bot's token. */
const loginHost = "login.microsoftonline.com";

/**
 * The Bot Connector's hosts, where a Teams activity's `serviceUrl` points:
 * Microsoft's public cloud, the only one Grasp's European clients use. The
 * US government clouds' hosts (`smba.infra.gcc.teams.microsoft.com` and
 * the like) are left off on purpose.
 */
const botConnectorHosts: ReadonlySet<string> = new Set([
  "smba.trafficmanager.net",
]);

/** The Bot Connector's conversations API, under a `serviceUrl`'s path. */
const conversationsPath = /^(?:\/[\w.-]+)*\/v3\/conversations(?:\/|$)/u;

/** The scope of the bot's token: the Bot Connector, and nothing else. */
const botFrameworkScope = "https://api.botframework.com/.default";

/** A tenant as it may stand in a sign-in path: an ID or a domain. */
const tenantSegment = String.raw`[\w.-]+`;

const tokenPath = new RegExp(
  String.raw`^/${tenantSegment}/oauth2/v2\.0/token$`,
  "u"
);

/** The sign-in metadata Microsoft's SDK reads, public to anyone. */
const metadataPaths: readonly RegExp[] = [
  /^\/common\/discovery\/instance$/u,
  new RegExp(
    String.raw`^/${tenantSegment}/v2\.0/\.well-known/openid-configuration$`,
    "u"
  ),
];

/** Methods an adapter sends to the Bot Connector. */
const botConnectorMethods: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
]);

/** Slack's Web API, where every one of its methods is a path. */
const slackHost = "slack.com";

/** A Slack Web API method's path. */
const slackMethodPath = /^\/api\/(?<method>[a-z]+\.[a-zA-Z.]+)$/u;

/**
 * The Slack methods an adapter may call, and whether each changes
 * something at Slack, recorded as Teams' writes are.
 */
const slackMethods: ReadonlyMap<string, { write: boolean }> = new Map([
  ["chat.postMessage", { write: true }],
  ["chat.update", { write: true }],
  ["chat.delete", { write: true }],
  ["auth.test", { write: false }],
  ["users.info", { write: false }],
  ["conversations.info", { write: false }],
]);

/** Meta's Graph API, where WhatsApp's Cloud API is. */
const whatsAppHost = "graph.facebook.com";

/** A message sent from a business number: the one path WhatsApp needs. */
const whatsAppMessagesPath =
  /^\/v\d{1,3}\.\d{1,3}\/(?<number>\d{1,32})\/messages$/u;

/** Methods that change something at the platform, recorded. */
const writeMethods: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE"]);

/** Core's request headers that go on: none of its credentials or cookies. */
const forwardedHeaders: readonly string[] = ["content-type", "accept"];

/** Response headers that no longer hold for the body as passed on. */
const responseHeadersDropped: readonly string[] = [
  "content-encoding",
  "content-length",
  "set-cookie",
  channelHeader,
];

/** Largest request an adapter may send: a Teams activity is far smaller. */
export const maxChannelRequestBytes = 1024 * 1024;

/** Largest platform answer passed back. */
const maxChannelResponseBytes = 4 * 1024 * 1024;

/** How long one request to a platform may take. */
const requestTimeoutMs = 15_000;

/** How often a throttled or failing send is tried, in all. */
const maxAttempts = 3;

/**
 * The longest connect waits before trying again. A platform that asks for
 * longer gets its answer passed back, with its `retry-after`, for the
 * adapter's caller to wait on.
 */
const maxRetryWaitMs = 10_000;

/** The wait before trying again when the platform names none. */
const baseRetryWaitMs = 500;

/** How long before its expiry a token is no longer used. */
const tokenMarginMs = 5 * 60_000;

/** How long the placeholder token connect hands the adapter says it lasts. */
const placeholderTokenLifetimeSeconds = 24 * 60 * 60;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** The bots' tokens in this isolate, by app, tenant and secret hash. */
const tokens = new Map<string, CachedToken>();

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

/** Why a request is refused, as the audit log and the logs say it. */
type RefusedReason =
  | "platform"
  | "request"
  | "host"
  | "path"
  | "method"
  | "credential"
  | "token_request"
  | "too_large"
  | "unconfigured";

/** One channel request, as far as connect got with it. */
interface ChannelRecord {
  platform: string;
  outcome: "ok" | "failed" | "removed" | "refused";
  method: string;
  /** The host, if it is one of the platform's; `other` if it isn't. */
  host: string;
  status?: number;
  reason?: RefusedReason;
  attempts?: number;
}

const knownMethods: ReadonlySet<string> = new Set([
  ...botConnectorMethods,
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

/** A request's method and host as logs may hold them: never one core made up. */
const statedOf = (
  method: string,
  url: URL | undefined
): { method: string; host: string } => ({
  method: knownMethods.has(method) ? method : "other",
  host:
    url !== undefined &&
    (url.hostname === loginHost ||
      url.hostname === slackHost ||
      url.hostname === whatsAppHost ||
      botConnectorHosts.has(url.hostname))
      ? url.hostname
      : "other",
});

/** Records a channel request; one that can't be recorded is logged. */
const record = async (env: Env, entry: ChannelRecord): Promise<void> => {
  const { platform, ...fields } = entry;
  const detail: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      detail[key] = value;
    }
  }
  try {
    await recordEvents(env, [
      {
        actor: { type: "system" },
        action: "channel.call",
        target: { type: "channel", id: platform },
        detail,
      },
    ]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/** Connect's own answer to a channel request, marked as such. */
const ownAnswer = (
  kind: ChannelAnswer,
  status: number,
  body: string | null = null
): Response =>
  new Response(body, { status, headers: { [channelHeader]: kind } });

/** Refuses a request, recorded and logged, before anything left. */
const refuse = async (
  env: Env,
  platform: string,
  reason: RefusedReason,
  stated: { method: string; host: string }
): Promise<Response> => {
  log.warn("channel.refused", { platform, reason, ...stated });
  await record(env, { platform, outcome: "refused", reason, ...stated });
  return reason === "unconfigured"
    ? ownAnswer(
        channelAnswer.unconfigured,
        503,
        "The client's bot isn't set up on connect"
      )
    : ownAnswer(channelAnswer.refused, 403, "Refused by connect");
};

/** A failure on the way, after connect may have sent something. */
const failed = (): Response => ownAnswer(channelAnswer.failed, 502);

/**
 * A body's bytes, counted as they arrive and cut off past `maxBytes`:
 * `undefined` then. Never taken from what `content-length` claims.
 */
const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array | undefined> => {
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
};

/**
 * The platform's answer, passed back with its body read to the limit and
 * without headers that no longer hold or that connect's own answers use;
 * `kind` marks it, for one connect reads as removed. A body that breaks
 * off after its headers (a timeout, a dropped connection) is a failed
 * answer too, not an error thrown back over RPC.
 */
const passedBack = async (
  response: Response,
  kind?: ChannelAnswer
): Promise<Response> => {
  let body: Uint8Array | undefined;
  try {
    body = await readCapped(response.body, maxChannelResponseBytes);
  } catch {
    return failed();
  }
  if (body === undefined) {
    return failed();
  }
  const headers = new Headers(response.headers);
  for (const name of responseHeadersDropped) {
    headers.delete(name);
  }
  if (kind !== undefined) {
    headers.set(channelHeader, kind);
  }
  const { status, statusText } = response;
  const empty = status === 204 || status === 304 || body.byteLength === 0;
  return new Response(empty ? null : body, { status, statusText, headers });
};

/** The bot's token: cached, or fetched from its tenant with its secret. */
const botToken = async (bot: Bot): Promise<string | undefined> => {
  const key = `${bot.tenant}\n${bot.id}\n${await sha256Hex(bot.secret)}`;
  const cached = tokens.get(key);
  if (cached !== undefined && cached.expiresAt - tokenMarginMs > Date.now()) {
    return cached.value;
  }
  tokens.delete(key);
  let response: Response;
  try {
    response = await fetch(
      `https://${loginHost}/${encodeURIComponent(bot.tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: bot.id,
          client_secret: bot.secret,
          scope: botFrameworkScope,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      }
    );
  } catch {
    log.warn("channel.token_failed", { platform: "teams" });
    return undefined;
  }
  const answer = tokenAnswerSchema.safeParse(
    response.ok ? await response.json().catch(() => null) : null
  );
  if (!answer.success) {
    // An OK answer was read as JSON already, and its body can't be cancelled.
    if (!response.bodyUsed) {
      await response.body?.cancel().catch((error: unknown) => {
        log.warn("channel.cancel_failed", errorFields(error));
      });
    }
    log.warn("channel.token_failed", {
      platform: "teams",
      status: response.status,
    });
    return undefined;
  }
  const token = {
    value: answer.data.access_token,
    expiresAt: Date.now() + answer.data.expires_in * 1000,
  };
  tokens.set(key, token);
  return token.value;
};

/** Drops the bot's cached token, which the platform no longer takes. */
const dropToken = async (bot: Bot): Promise<void> => {
  tokens.delete(`${bot.tenant}\n${bot.id}\n${await sha256Hex(bot.secret)}`);
};

/**
 * How long a `retry-after` says to wait, in seconds or as a date, in ms;
 * the backoff for `attempt` without one.
 */
const retryWaitMs = (header: string | null, attempt: number): number => {
  const backoff = baseRetryWaitMs * 2 ** (attempt - 1);
  if (header === null) {
    return backoff;
  }
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : backoff;
};

/**
 * Whether a send is tried again. A 429, and a 503 that names its wait,
 * say the platform turned the request away. Any other 5xx leaves it open
 * whether the platform carried it out: an edit or a removal is the same
 * done twice, but a POST would post the message twice, so it is passed
 * back instead.
 */
const isRetried = (method: string, response: Response): boolean => {
  const { status } = response;
  if (status === 429) {
    return true;
  }
  if (method === "POST") {
    return status === 503 && response.headers.has("retry-after");
  }
  return status >= 500 && status <= 599;
};

/**
 * The adapter's token request, answered here: with the placeholder as the
 * bot's token, for the bot's own app and the Bot Connector's scope, and
 * the placeholder as its secret. The tenant it names isn't checked:
 * connect asks only the client's for the real token, whichever the SDK
 * names (Bot Framework's, for a multi-tenant bot).
 */
const answerTokenRequest = async (
  bot: Bot,
  request: Request
): Promise<boolean> => {
  if (request.method !== "POST") {
    return false;
  }
  const bytes = await readCapped(request.body, maxChannelRequestBytes);
  if (bytes === undefined) {
    return false;
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  return (
    form.get("grant_type") === "client_credentials" &&
    form.get("client_id") === bot.id &&
    form.get("client_secret") === channelCredentialPlaceholder &&
    form.get("scope") === botFrameworkScope
  );
};

/**
 * Whether a Teams request only shows typing: logged, not recorded. Only a
 * POST posts a typing activity; an edit or a removal is recorded whatever
 * its body says, or a caller could hide one behind `{"type":"typing"}`.
 */
const isTyping = (method: string, body: Uint8Array): boolean => {
  if (method !== "POST") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "typing"
    );
  } catch {
    return false;
  }
};

/**
 * Sends one request on to the Bot Connector with the bot's token, tried
 * again while it is throttled or failing (`isRetried`) and the wait is
 * short, and once
 * more with a new token if the cached one is no longer taken.
 */
const sendToBotConnector = async (
  bot: Bot,
  url: URL,
  method: string,
  headers: Headers,
  body: Uint8Array | null
): Promise<
  { response: Response; attempts: number } | { response: undefined }
> => {
  let renewed = false;
  let attempts = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one try after another
    const token = await botToken(bot);
    if (token === undefined) {
      return { response: undefined };
    }
    headers.set("authorization", `Bearer ${token}`);
    attempts += 1;
    let response: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { response: undefined };
    }
    if (response.status === 401 && !renewed) {
      renewed = true;
      attempts -= 1;
      // oxlint-disable-next-line no-await-in-loop -- once, then again
      await Promise.all([response.body?.cancel(), dropToken(bot)]);
      continue;
    }
    if (!isRetried(method, response) || attempts >= maxAttempts) {
      return { response, attempts };
    }
    const waitMs = retryWaitMs(response.headers.get("retry-after"), attempts);
    if (waitMs > maxRetryWaitMs) {
      return { response, attempts };
    }
    // oxlint-disable-next-line no-await-in-loop -- once, then again
    await response.body?.cancel();
    // oxlint-disable-next-line no-await-in-loop -- the wait it asked for
    await scheduler.wait(waitMs);
  }
};

/**
 * Whether `url` is one of Teams' own: one of its hosts, over HTTPS on its
 * own port, without credentials in the URL.
 */
const isTeamsUrl = (url: URL): boolean =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.port === "" &&
  (url.hostname === loginHost || botConnectorHosts.has(url.hostname));

type Stated = ReturnType<typeof statedOf>;

/**
 * A request to Entra from Microsoft's SDK: its token request answered
 * here with the placeholder, its sign-in metadata read passed on with
 * nothing of core's request, anything else refused.
 */
const signIn = async (
  env: Env,
  bot: Bot,
  request: Request,
  url: URL,
  stated: Stated
): Promise<Response> => {
  if (tokenPath.test(url.pathname)) {
    if (!(await answerTokenRequest(bot, request))) {
      return await refuse(env, "teams", "token_request", stated);
    }
    return Response.json({
      token_type: "Bearer",
      expires_in: placeholderTokenLifetimeSeconds,
      ext_expires_in: placeholderTokenLifetimeSeconds,
      access_token: channelCredentialPlaceholder,
    });
  }
  const isMetadata =
    request.method === "GET" &&
    metadataPaths.some((path) => path.test(url.pathname));
  if (!isMetadata) {
    return await refuse(env, "teams", "path", stated);
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    log.info("channel.request", {
      platform: "teams",
      ...stated,
      status: response.status,
    });
    return await passedBack(response);
  } catch {
    return failed();
  }
};

/**
 * Why a Bot Connector request is refused, or its body (empty for a read):
 * only the conversations API, a method an adapter sends, the placeholder
 * as its credential, and a body within the limit.
 */
const checkedBotConnectorRequest = async (
  request: Request,
  url: URL
): Promise<{ refused: RefusedReason } | { body: Uint8Array }> => {
  if (!conversationsPath.test(url.pathname)) {
    return { refused: "path" };
  }
  if (!botConnectorMethods.has(request.method)) {
    return { refused: "method" };
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${channelCredentialPlaceholder}`) {
    return { refused: "credential" };
  }
  if (request.method === "GET") {
    return { body: new Uint8Array() };
  }
  const body = await readCapped(request.body, maxChannelRequestBytes);
  return body === undefined ? { refused: "too_large" } : { body };
};

/** How a Bot Connector answer ends, for the audit log. */
const outcomeOf = (response: Response): ChannelRecord["outcome"] => {
  if (response.status === 403) {
    return "removed";
  }
  return response.ok ? "ok" : "failed";
};

/** A Bot Connector request, sent on as the bot or refused. */
const botConnectorFetch = async (
  env: Env,
  bot: Bot,
  request: Request,
  url: URL,
  stated: Stated
): Promise<Response> => {
  const platform = "teams";
  const checked = await checkedBotConnectorRequest(request, url);
  if ("refused" in checked) {
    return await refuse(env, platform, checked.refused, stated);
  }
  const { body } = checked;
  const { method } = request;
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const sent = await sendToBotConnector(
    bot,
    url,
    method,
    headers,
    method === "GET" ? null : body
  );
  const recorded = writeMethods.has(method) && !isTyping(method, body);
  if (sent.response === undefined) {
    log.warn("channel.failed", { platform, ...stated });
    if (recorded) {
      await record(env, { platform, outcome: "failed", ...stated });
    }
    return failed();
  }
  const { response, attempts } = sent;
  const { status } = response;
  log.info("channel.request", { platform, ...stated, status, attempts });
  // Teams refuses the bot where it was removed: from the person's chat,
  // the group chat or the team. Said so, for core to stop sending there.
  const outcome = outcomeOf(response);
  if (recorded) {
    await record(env, {
      platform,
      outcome,
      ...stated,
      status,
      attempts: attempts > 1 ? attempts : undefined,
    });
  }
  // 304 Not Modified goes nowhere; every other 3xx would.
  if (status >= 300 && status < 400 && status !== 304) {
    await response.body?.cancel();
    return failed();
  }
  return await passedBack(
    response,
    outcome === "removed" ? channelAnswer.removed : undefined
  );
};

/** A Teams request: answered here, sent on as the bot, or refused. */
const teamsFetch = async (
  env: Env,
  request: Request,
  url: URL
): Promise<Response> => {
  const stated = statedOf(request.method, url);
  if (!isTeamsUrl(url)) {
    return await refuse(env, "teams", "host", stated);
  }
  const bot = teamsBotOf(env);
  if (bot === undefined) {
    return await refuse(env, "teams", "unconfigured", stated);
  }
  return url.hostname === loginHost
    ? await signIn(env, bot, request, url, stated)
    : await botConnectorFetch(env, bot, request, url, stated);
};

/**
 * Sends one request on to Slack with the bot's token, tried again while
 * Slack rate limits it and asks for a short wait.
 */
const sendToSlack = async (
  token: string,
  url: URL,
  headers: Headers,
  body: Uint8Array
): Promise<
  { response: Response; attempts: number } | { response: undefined }
> => {
  headers.set("authorization", `Bearer ${token}`);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let response: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { response: undefined };
    }
    if (response.status !== 429 || attempts >= maxAttempts) {
      return { response, attempts };
    }
    const waitMs = retryWaitMs(response.headers.get("retry-after"), attempts);
    if (waitMs > maxRetryWaitMs) {
      return { response, attempts };
    }
    // oxlint-disable-next-line no-await-in-loop -- once, then again
    await response.body?.cancel();
    // oxlint-disable-next-line no-await-in-loop -- the wait it asked for
    await scheduler.wait(waitMs);
  }
};

/**
 * `body` without the token Slack's client also puts in it (`token`, the
 * placeholder): Slack would read a token in the body before the bearer
 * connect sets. A body carrying any other token is refused (undefined).
 */
const withoutBodyToken = (
  contentType: string | null,
  body: Uint8Array
): Uint8Array | undefined => {
  const text = new TextDecoder().decode(body);
  if (contentType?.includes("application/x-www-form-urlencoded") === true) {
    const form = new URLSearchParams(text);
    const token = form.get("token");
    if (token !== null && token !== channelCredentialPlaceholder) {
      return undefined;
    }
    form.delete("token");
    return new TextEncoder().encode(form.toString());
  }
  if (contentType?.includes("application/json") === true) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return body;
    }
    if (typeof parsed !== "object" || parsed === null || !("token" in parsed)) {
      return body;
    }
    const { token, ...rest } = parsed;
    return token === channelCredentialPlaceholder
      ? new TextEncoder().encode(JSON.stringify(rest))
      : undefined;
  }
  return body;
};

/**
 * Why a Slack request is refused, or the bot's token, whether its method
 * changes something, and its body: only Slack's Web API over HTTPS, one of
 * the methods an adapter may call (`slackMethods`), posted, with the
 * placeholder as its token, within the size limit, and only while the
 * client's app is set up.
 */
const checkedSlackRequest = async (
  env: Env,
  request: Request,
  url: URL
): Promise<
  | { refused: RefusedReason }
  | { token: string; write: boolean; body: Uint8Array }
> => {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname !== slackHost
  ) {
    return { refused: "host" };
  }
  const token = env.SLACK_BOT_TOKEN;
  if (token === undefined || token === "") {
    return { refused: "unconfigured" };
  }
  const method = slackMethodPath.exec(url.pathname)?.groups?.method;
  const allowed = method === undefined ? undefined : slackMethods.get(method);
  if (allowed === undefined || url.search !== "") {
    return { refused: "path" };
  }
  if (request.method !== "POST") {
    return { refused: "method" };
  }
  if (
    request.headers.get("authorization") !==
    `Bearer ${channelCredentialPlaceholder}`
  ) {
    return { refused: "credential" };
  }
  const body = await readCapped(request.body, maxChannelRequestBytes);
  if (body === undefined) {
    return { refused: "too_large" };
  }
  const sent = withoutBodyToken(request.headers.get("content-type"), body);
  return sent === undefined
    ? { refused: "credential" }
    : { token, write: allowed.write, body: sent };
};

/**
 * A Slack request: one of the Web API methods an adapter may call, sent on
 * as the bot, or refused (`checkedSlackRequest`).
 */
const slackFetch = async (
  env: Env,
  request: Request,
  url: URL
): Promise<Response> => {
  const platform = "slack";
  const stated = statedOf(request.method, url);
  const checked = await checkedSlackRequest(env, request, url);
  if ("refused" in checked) {
    return await refuse(env, platform, checked.refused, stated);
  }
  const { token, write, body } = checked;
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const sent = await sendToSlack(token, url, headers, body);
  if (sent.response === undefined) {
    log.warn("channel.failed", { platform, ...stated });
    if (write) {
      await record(env, { platform, outcome: "failed", ...stated });
    }
    return failed();
  }
  const { response, attempts } = sent;
  const { status } = response;
  log.info("channel.request", { platform, ...stated, status, attempts });
  if (write) {
    await record(env, {
      platform,
      outcome: response.ok ? "ok" : "failed",
      ...stated,
      status,
      attempts: attempts > 1 ? attempts : undefined,
    });
  }
  if (status >= 300 && status < 400 && status !== 304) {
    await response.body?.cancel();
    return failed();
  }
  return await passedBack(response);
};

/**
 * Why a WhatsApp request is refused, or the client's token and its body:
 * only the Cloud API's messages endpoint of the client's own number, over
 * HTTPS, posted, with the placeholder as its token, within the size limit,
 * and only while the client's number is set up.
 */
const checkedWhatsAppRequest = async (
  env: Env,
  request: Request,
  url: URL
): Promise<
  { refused: RefusedReason } | { token: string; body: Uint8Array }
> => {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname !== whatsAppHost
  ) {
    return { refused: "host" };
  }
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const number = env.WHATSAPP_PHONE_NUMBER_ID;
  if (
    token === undefined ||
    token === "" ||
    number === undefined ||
    number === ""
  ) {
    return { refused: "unconfigured" };
  }
  const named = whatsAppMessagesPath.exec(url.pathname)?.groups?.number;
  if (named !== number || url.search !== "") {
    return { refused: "path" };
  }
  if (request.method !== "POST") {
    return { refused: "method" };
  }
  if (
    request.headers.get("authorization") !==
    `Bearer ${channelCredentialPlaceholder}`
  ) {
    return { refused: "credential" };
  }
  const body = await readCapped(request.body, maxChannelRequestBytes);
  return body === undefined ? { refused: "too_large" } : { token, body };
};

/**
 * A WhatsApp request: a message from the client's own number, sent on with
 * the client's token, or refused (`checkedWhatsAppRequest`). Every one is
 * a write, recorded as Teams' and Slack's are.
 */
const whatsAppFetch = async (
  env: Env,
  request: Request,
  url: URL
): Promise<Response> => {
  const platform = "whatsapp";
  const stated = statedOf(request.method, url);
  const checked = await checkedWhatsAppRequest(env, request, url);
  if ("refused" in checked) {
    return await refuse(env, platform, checked.refused, stated);
  }
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // Sent as Slack's are: posted with the token, a short 429 waited out.
  const sent = await sendToSlack(checked.token, url, headers, checked.body);
  if (sent.response === undefined) {
    log.warn("channel.failed", { platform, ...stated });
    await record(env, { platform, outcome: "failed", ...stated });
    return failed();
  }
  const { response, attempts } = sent;
  const { status } = response;
  log.info("channel.request", { platform, ...stated, status, attempts });
  await record(env, {
    platform,
    outcome: response.ok ? "ok" : "failed",
    ...stated,
    status,
    attempts: attempts > 1 ? attempts : undefined,
  });
  if (status >= 300 && status < 400 && status !== 304) {
    await response.body?.cancel();
    return failed();
  }
  return await passedBack(response);
};

/**
 * Sends a chat adapter's request on to its platform as the client's own
 * bot (`ChannelApi.channelFetch`), or refuses it.
 */
export const channelFetch = async (
  env: Env,
  platform: unknown,
  request: unknown
): Promise<Response> => {
  const parsed = channelPlatformSchema.safeParse(platform);
  const named = parsed.success ? parsed.data : "other";
  if (!(request instanceof Request)) {
    return await refuse(env, named, "request", {
      method: "other",
      host: "other",
    });
  }
  // A Request's URL is always absolute and parsed.
  const url = new URL(request.url);
  if (!parsed.success) {
    return await refuse(env, named, "platform", statedOf(request.method, url));
  }
  const sendingTo = parsed.data;
  switch (sendingTo) {
    case "slack": {
      return await slackFetch(env, request, url);
    }
    case "whatsapp": {
      return await whatsAppFetch(env, request, url);
    }
    case "teams": {
      return await teamsFetch(env, request, url);
    }
    default: {
      return sendingTo satisfies never;
    }
  }
};
