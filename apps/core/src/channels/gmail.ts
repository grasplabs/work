/**
 * Gmail as a door into core: Stephen's own mailbox (people email Stephen),
 * through the Chat SDK's Gmail adapter. Gmail tells the door of new mail
 * with a Pub/Sub push; the adapter then reads the mailbox's history and
 * its new messages, and replies, all through connect, which holds the
 * mailbox's token.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. A push must carry a token Google
 *   signed (RS256, under a key Google publishes, fetched through connect:
 *   `channelSigningKeys("gmail")`), issued by Google, for this deployment's
 *   push audience (`GMAIL_PUBSUB_AUDIENCE`), by the push subscription's own
 *   service account (`GMAIL_PUBSUB_SERVICE_ACCOUNT`, its email verified),
 *   for this deployment's subscription (`GMAIL_PUBSUB_SUBSCRIPTION`) and
 *   Stephen's own mailbox. Anything else is refused before its body is
 *   read as anything. A push names no mail: the adapter reads what is new
 *   from Gmail itself.
 * - A push sent again. Its Pub/Sub message id is taken once; the adapter
 *   delivers each mail once whatever pushes name it.
 * - Someone writing as someone else. An email's From is whatever its
 *   sender typed, so it is never taken as who wrote (Jakob, 24 October
 *   2026): only an address a person linked to themselves (#1112's links,
 *   as Slack's people) is known, and the link proves they read that
 *   mailbox, as it is sent to it. What spoofs a linked address is left to
 *   Gmail, which files mail failing its sender's own checks as spam: the
 *   adapter reads the inbox only.
 * - Backscatter. Someone unknown is sent the link once a day, and only to
 *   an address on one of the client's own sign-in domains: a forged From
 *   elsewhere gets nothing back. Nothing they wrote is read or echoed.
 * - A reply carried elsewhere. The adapter replies to a mail's Reply-To,
 *   which its sender chooses: mail whose Reply-To names anyone but its
 *   sender is dropped, and the link goes in a mail of its own to the
 *   sender's address, never as a reply (door.ts).
 * - Misconfiguration. Until the mailbox and its push are set, the door
 *   answers 404 and every push would be refused: nothing falls back to
 *   accepting.
 *
 * Everything the adapter sends goes out through connect, which swaps the
 * placeholder token for the mailbox's own (connect's channels.ts).
 */
import { GmailAdapter } from "@chat-adapter/gmail";
import { durableObjectState } from "@grasp-os/chat/state";
import type { ChannelSigningKey } from "@grasp-os/shared/channel-keys";
import { channelCredentialPlaceholder } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { Chat } from "chat";
import type { Logger } from "chat";
import { importJWK, jwtVerify } from "jose";
import type { JWTHeaderParameters } from "jose";
import { z } from "zod";

import { inJurisdiction } from "../durable-objects.ts";
import { channelKeys, keyFor as channelKeyFor } from "./signing-keys.ts";
import type { ChannelKeys } from "./signing-keys.ts";

/** Who issues the tokens Pub/Sub pushes with. */
const googleIssuers = ["https://accounts.google.com", "accounts.google.com"];

/** How far a token's times may be from core's clock. */
const clockToleranceSeconds = 5 * 60;

const bearerPattern = /^Bearer (?<token>[\w-]+\.[\w-]+\.[\w-]+)$/u;

/** Stephen's mailbox and its push, as the deployment set them up. */
export interface GmailSetUp {
  mailbox: string;
  audience: string;
  serviceAccount: string;
  subscription: string;
  topic: string | undefined;
}

/** The mailbox and its push, if all of them are set. */
export const gmailSetUp = (env: Env): GmailSetUp | undefined => {
  const {
    GMAIL_MAILBOX: mailbox,
    GMAIL_PUBSUB_AUDIENCE: audience,
    GMAIL_PUBSUB_SERVICE_ACCOUNT: serviceAccount,
    GMAIL_PUBSUB_SUBSCRIPTION: subscription,
    GMAIL_PUBSUB_TOPIC: topic,
  } = env;
  if (
    mailbox === undefined ||
    mailbox === "" ||
    audience === undefined ||
    audience === "" ||
    serviceAccount === undefined ||
    serviceAccount === "" ||
    subscription === undefined ||
    subscription === ""
  ) {
    return undefined;
  }
  return {
    mailbox: mailbox.toLowerCase(),
    audience,
    serviceAccount,
    subscription,
    topic: topic === "" ? undefined : topic,
  };
};

/** A push, as far as its check reads it: never what it names but the mailbox. */
const pushSchema = z.object({
  message: z.object({
    data: z.string().min(1).max(4096),
    messageId: z.string().min(1).max(256),
  }),
  subscription: z.string().min(1).max(512),
});

/** What a push's data says: whose mailbox changed. */
const notificationSchema = z.object({
  emailAddress: z.string().min(3).max(320),
});

/** The keys an isolate holds for Gmail (signing-keys.ts). */
export type GmailKeys = ChannelKeys;

/** Keys not yet fetched. */
export const gmailKeys = (): GmailKeys => channelKeys();

/** This isolate's keys, which every push it serves checks against. */
const isolateKeys = gmailKeys();

/** The published key `kid` names, as Teams' (signing-keys.ts). */
const keyFor = async (
  env: Env,
  keys: GmailKeys,
  kid: string
): Promise<ChannelSigningKey | undefined> =>
  await channelKeyFor(
    async () => {
      const fetched = await env.CONNECT.channelSigningKeys("gmail");
      return fetched.keys;
    },
    keys,
    kid
  );

/** Why a push was refused, for the log: never anything of its own. */
class RefusalError extends Error {
  override name = "RefusalError";
}

const verificationKey =
  (env: Env, keys: GmailKeys) =>
  async (header: JWTHeaderParameters): Promise<CryptoKey> => {
    if (header.alg !== "RS256") {
      throw new RefusalError("algorithm");
    }
    if (typeof header.kid !== "string" || header.kid === "") {
      throw new RefusalError("no_kid");
    }
    const key = await keyFor(env, keys, header.kid);
    if (key === undefined) {
      throw new RefusalError("unknown_kid");
    }
    const imported = await importJWK(
      { kty: key.kty, n: key.n, e: key.e },
      "RS256"
    );
    if (!(imported instanceof CryptoKey)) {
      throw new RefusalError("key");
    }
    return imported;
  };

/** The data of a push, decoded: base64, as Pub/Sub sends it. */
const decoded = (data: string): unknown => {
  try {
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(data), (char) => char.codePointAt(0) ?? 0)
      )
    );
  } catch {
    return undefined;
  }
};

/** Whether `request` is a push for Stephen's mailbox; throws why not. */
const checkPush = async (
  env: Env,
  keys: GmailKeys,
  request: Request,
  body: string
): Promise<string> => {
  const setUp = gmailSetUp(env);
  if (setUp === undefined) {
    throw new RefusalError("unconfigured");
  }
  const token = bearerPattern.exec(request.headers.get("authorization") ?? "")
    ?.groups?.token;
  if (token === undefined) {
    throw new RefusalError("no_token");
  }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, verificationKey(env, keys), {
      algorithms: ["RS256"],
      issuer: googleIssuers,
      audience: setUp.audience,
      clockTolerance: clockToleranceSeconds,
      requiredClaims: ["exp", "iat", "email", "email_verified"],
    }));
  } catch (error) {
    if (error instanceof RefusalError) {
      throw error;
    }
    const code =
      error instanceof Error && "code" in error ? String(error.code) : "token";
    throw new RefusalError(code);
  }
  if (
    payload.email !== setUp.serviceAccount ||
    payload.email_verified !== true
  ) {
    throw new RefusalError("identity");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = undefined;
  }
  const push = pushSchema.safeParse(parsedBody);
  if (!push.success) {
    throw new RefusalError("body");
  }
  if (push.data.subscription !== setUp.subscription) {
    throw new RefusalError("subscription");
  }
  const notification = notificationSchema.safeParse(
    decoded(push.data.message.data)
  );
  if (notification.data?.emailAddress.toLowerCase() !== setUp.mailbox) {
    throw new RefusalError("mailbox");
  }
  return push.data.message.messageId;
};

/**
 * The Pub/Sub message id of `request`, if it is a push Google signed for
 * Stephen's mailbox and this deployment's subscription; `undefined`, and a
 * refusal logged by its reason, otherwise.
 */
export const verifiedGmailPush = async (
  env: Env,
  request: Request,
  body: string,
  keys: GmailKeys = isolateKeys
): Promise<string | undefined> => {
  try {
    return await checkPush(env, keys, request, body);
  } catch (error) {
    const reason = error instanceof RefusalError ? error.message : "check";
    log.info("channel.refused", { platform: "gmail", reason });
    return undefined;
  }
};

/** Chat SDK's logs stay out of core's but for what fails, as for Slack. */
const silent = (): void => undefined;
const gmailLogger: Logger = {
  child: () => gmailLogger,
  debug: silent,
  info: silent,
  warn: (message) => {
    log.warn("channel.gmail", { message });
  },
  error: (message) => {
    log.error("channel.gmail", { message });
  },
};

/**
 * The adapter's request as connect takes it over RPC: its method, URL,
 * headers and body. Not its `redirect: "error"`, which workerd doesn't
 * take (connect follows no redirect whatever a request says), nor its
 * abort signal, which RPC can't carry (connect times every request out).
 */
const forConnect = (input: RequestInfo | URL, init?: RequestInit): Request => {
  const request = new Request(input, { ...init, redirect: "manual" });
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });
};

/**
 * Gmail's adapter for Stephen's mailbox, reading its inbox: every request
 * it sends goes through connect with the placeholder token, and every push
 * it is handed is checked again by {@link verifiedGmailPush}. Each setting
 * is passed, so the adapter reads none from the environment.
 */
export const gmailAdapter = (
  env: Env,
  setUp: GmailSetUp,
  keys: GmailKeys = isolateKeys
): GmailAdapter =>
  new GmailAdapter({
    mailbox: setUp.mailbox,
    labelId: "INBOX",
    accessToken: channelCredentialPlaceholder,
    subscription: setUp.subscription,
    pubsubAudience: setUp.audience,
    pubsubServiceAccountEmail: setUp.serviceAccount,
    ...(setUp.topic === undefined ? {} : { topicName: setUp.topic }),
    replyAll: false,
    webhookVerifier: async (request: Request) =>
      (await verifiedGmailPush(env, request, await request.text(), keys)) !==
      undefined,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      await env.CONNECT.channelFetch("gmail", forConnect(input, init)),
    logger: gmailLogger,
  });

/**
 * The domain of `address`, lowercase, if it is one of the client's own
 * sign-in domains: the only addresses Stephen sends a link to.
 */
export const ownDomainOf = (
  address: string,
  domains: readonly string[]
): string | undefined => {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domains.includes(domain) ? domain : undefined;
};

/** How often the mailbox's watch is renewed: Gmail ends one after a week. */
const watchEveryMs = 24 * 60 * 60 * 1000;

/**
 * Keeps Gmail telling the door of Stephen's new mail: once a day, renews
 * the mailbox's watch on its Pub/Sub topic, which also gives the adapter
 * where its history starts. Nothing while the mailbox or its topic isn't
 * set up. For core's clock.
 */
export const renewGmailWatch = async (env: Env): Promise<void> => {
  const setUp = gmailSetUp(env);
  if (setUp?.topic === undefined) {
    return;
  }
  const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
  if (!(await state.setIfNotExists("gmail:watch", true, watchEveryMs))) {
    return;
  }
  const adapter = gmailAdapter(env, setUp);
  const chat = new Chat({
    userName: "Stephen",
    adapters: { gmail: adapter },
    state,
    logger: "silent",
  });
  try {
    await chat.initialize();
    await adapter.watch(setUp.topic);
  } catch (error) {
    // Tried again at the next tick, not a day later.
    await state.delete("gmail:watch");
    log.warn("channel.gmail_watch_failed", errorFields(error));
  }
};
