/**
 * The door chat platforms post to, `/api/channels/<platform>`: each a Chat
 * SDK adapter that checks every request it is handed as really sent by its
 * platform before anything reaches a handler (src/channels/teams.ts).
 * Every adapter here must have such a check: core's tests send each an
 * unsigned request and expect it refused.
 *
 * What comes in through it, and what stops each:
 *
 * - A platform the deployment hasn't set up answers 404, as a path core
 *   has no route for.
 * - A request its platform didn't send for the client's own bot, or from
 *   another tenant, is refused with a 401 before its body is read as
 *   anything (teams.ts).
 * - A resent message (a platform retries a delivery it thinks failed) is
 *   taken once: the door keeps each message's id for a day, before
 *   anything else, so a resend sends no second line and costs no second
 *   token. The Chat SDK dedupes again for its handlers.
 * - A flood from one person. Messages are limited per sender, by the id
 *   the platform verified, before anything is looked up; past the limit
 *   they are dropped, with one line a minute to say so.
 * - Someone writing who isn't one of the client's people: who writes is
 *   only ever the platform's verified id (who.ts), never a name, an email
 *   or a phone number. Group chats and channels, other companies, guests,
 *   removed people and people Grasp doesn't know each get one line, in
 *   the language their app is set to, and nothing they wrote is read.
 *   The lines go out through connect like every send.
 * - One of the client's own people Grasp hasn't seen yet (Teams' roster
 *   says they are of the client's tenant, and no guest) is sent a link to
 *   the deployment's own sign-in, once a day: it carries no token and
 *   binds nothing, as their sign-in's ID token names them by the object
 *   id their messages carry. Their first question is kept for the hour,
 *   and answered with their next message once they have signed in.
 *   Nobody from outside the tenant is ever sent the link.
 *
 * Only a member's message in their own private chat with the bot reaches
 * the Chat SDK, with who they are, and its conversation is kept
 * (`channel_conversations`) so a later message, and the answer, find it.
 * It is answered in the person's own chat for the platform (answer.ts).
 *
 * Slack (slack.ts) comes in the same way, by its own signature and ids:
 * its people are known only by the Slack account they linked to Grasp, and
 * someone who hasn't linked one gets the link, once, and nothing more.
 *
 * Telegram (telegram.ts) does too, by the webhook's secret; its people
 * are known by the Telegram account they linked.
 *
 * WhatsApp (whatsapp.ts) comes in the same way as Slack: by Meta's
 * signature, for the client's own number, its people known only by the
 * WhatsApp account they linked to Grasp.
 *
 * Teams' and Slack's adapters send through axios, which workerd refuses
 * as it builds its requests: `@grasp-os/chat/workerd` puts the fix in, so
 * it is imported before any adapter loads.
 */
import "@grasp-os/chat/workerd";
import { durableObjectState } from "@grasp-os/chat/state";
import { requestErrors } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { TokenBuckets } from "@grasp-os/shared/token-bucket";
import { Chat } from "chat";
import type { Message, StateAdapter, Thread } from "chat";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { channelConversations } from "../db/core/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import { errorResponse } from "../errors.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { offerChannelLink } from "./accounts.ts";
import { answerInChat } from "./answer.ts";
import { signInCard } from "./cards.tsx";
import { slackAdapter, verifiedSlackRequest } from "./slack.ts";
import type { ConnectedTeamsAdapter } from "./teams-adapter.ts";
import { teamsAdapter, verifiedTeamsRequest } from "./teams.ts";
import type { TeamsKeys } from "./teams.ts";
import {
  telegramAdapter,
  telegramSetUp,
  verifiedTelegramRequest,
} from "./telegram.ts";
import {
  verifiedWhatsAppRequest,
  whatsAppAdapter,
  whatsAppSetUp,
  whatsAppSubscription,
} from "./whatsapp.ts";
import { writerOf } from "./who.ts";
import { channelLocales, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

/**
 * Every platform's adapter, keyed by the platform's name, checking
 * against the keys this isolate fetched, or `teamsKeys` when given.
 */
export const channelAdapters = (
  env: Env,
  { teamsKeys }: { teamsKeys?: TeamsKeys } = {}
) => ({
  teams: teamsAdapter(env, teamsKeys),
  slack: slackAdapter(env),
  whatsapp: whatsAppAdapter(env),
  telegram: telegramAdapter(env),
});

/** A platform the door has an adapter for. */
type Platform = keyof ReturnType<typeof channelAdapters>;

/**
 * Whether the deployment set `platform` up: Teams once it has the bot's id
 * and the client's Entra tenant, Slack once it has the app's signing
 * secret, without which every request would be refused anyway.
 */
const isSetUp = (env: Env, platform: string): platform is Platform => {
  if (platform === "whatsapp") {
    return whatsAppSetUp(env);
  }
  if (platform === "telegram") {
    return telegramSetUp(env);
  }
  if (platform === "slack") {
    return (
      env.SLACK_SIGNING_SECRET !== undefined && env.SLACK_SIGNING_SECRET !== ""
    );
  }
  return (
    platform === "teams" &&
    env.TEAMS_BOT_ID !== undefined &&
    env.TEAMS_BOT_ID !== "" &&
    signInConfig(env)?.entra?.tenantId !== undefined
  );
};

/** Largest request a platform may post: a Teams activity is far smaller. */
const maxBodyBytes = 256 * 1024;

/**
 * Messages one person may send: ten at once, then one every three
 * seconds. Someone typing fast stays well inside it; a script doesn't.
 */
const messageRate = { burst: 10, perMinute: 20 };

/** How often a person over the limit is told so: once a minute. */
const toldRate = { burst: 1, perMinute: 1 };

/** How often someone Grasp hasn't seen is sent the sign-in link: once a day. */
const signInEveryMs = 24 * 60 * 60 * 1000;

/** How long a newcomer's first question waits for their sign-in. */
const keptMs = 60 * 60 * 1000;

/** The longest question kept: what a chat message holds, near enough. */
const maxKeptChars = 4000;

/** The web's sign-in page (apps/web/src/routes/sign-in.tsx). */
const signInPath = "/sign-in";

/** Where a newcomer's first question waits, by their object id. */
const keptKey = (oid: string): string => `door:teams:kept:${oid}`;

/** How long the door remembers a message it took, to take a resend once. */
const seenTtlMs = 24 * 60 * 60 * 1000;

/**
 * Each sender's messages and lines, per isolate: a restart starts them
 * full. The router's limit per client address bounds the rest.
 */
const messages = new TokenBuckets(messageRate);
const told = new TokenBuckets(toldRate);

/** The lines the door sends: each instead of reading what was sent. */
type DoorLine =
  | "tooFast"
  | "privateOnly"
  | "otherCompany"
  | "guest"
  | "removed"
  | "signIn";

/**
 * A Teams activity, as far as the door reads it. Its text is read only to
 * keep the first question of one of the client's people Grasp hasn't seen
 * yet, for after their sign-in.
 */
const activitySchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().min(1).max(256).optional(),
  serviceUrl: z.string(),
  locale: z.string().max(64).optional(),
  from: z.object({
    id: z.string().min(1).max(256),
    aadObjectId: z.string().min(1).max(256).optional(),
  }),
  conversation: z.object({
    id: z.string().min(1).max(1024),
    conversationType: z.enum(["personal", "groupChat", "channel"]),
  }),
});
type Activity = z.infer<typeof activitySchema>;

/** The language `locale` (`nl-NL`, `de`) names, or English. */
const localeOf = (locale: string | undefined): ChannelLocale => {
  const language = locale?.split("-")[0]?.toLowerCase();
  return channelLocales.find((each) => each === language) ?? "en";
};

/** A member's message, as the door hands it on. */
export interface ChannelMessage {
  platform: Platform;
  /** The member who wrote it. */
  userId: string;
  thread: Thread;
  message: Message;
  /**
   * What they asked before Grasp knew them, kept since their first
   * message, to be answered first: once, within the hour.
   */
  kept?: string;
  /**
   * Sends `send` once the platform has the reply as it stands: on Teams,
   * after a streamed answer's last words, which Microsoft's SDK sends only
   * once the message's handler has returned.
   */
  afterward: (send: () => Promise<unknown>) => void;
}

/** What takes a member's message on from the door. */
export type ChannelHandoff = (accepted: ChannelMessage) => Promise<void>;

/** Keeps the conversation `userId` wrote in, or notes they wrote again. */
const keepConversation = async (
  env: Env,
  platform: Platform,
  threadId: string,
  userId: string,
  now = new Date()
): Promise<void> => {
  await drizzle(env.DB)
    .insert(channelConversations)
    .values({ platform, threadId, userId, createdAt: now, lastMessageAt: now })
    .onConflictDoUpdate({
      target: [channelConversations.platform, channelConversations.threadId],
      set: { userId, lastMessageAt: now },
    });
};

/**
 * Sends one of Stephen's lines to the conversation `activity` came from:
 * for someone who should sign in, with a button to the deployment's own
 * sign-in page. The link carries nothing of theirs and binds nothing: the
 * sign-in's ID token names them, by the object id their messages carry.
 */
const sendLine = async (
  env: Env,
  adapter: ConnectedTeamsAdapter,
  activity: Activity,
  line: DoorLine
): Promise<void> => {
  const threadId = adapter.encodeThreadId({
    conversationId: activity.conversation.id,
    serviceUrl: activity.serviceUrl,
    conversationType: activity.conversation.conversationType,
  });
  const locale = localeOf(activity.locale);
  const origin = signInConfig(env)?.origin;
  try {
    await adapter.postMessage(
      threadId,
      line === "signIn" && origin !== undefined
        ? signInCard({ locale, url: `${origin}${signInPath}` })
        : say(line, locale)
    );
  } catch (error) {
    log.warn("channel.line_failed", {
      platform: "teams",
      line,
      ...errorFields(error),
    });
  }
};

/**
 * Why a Teams sender Grasp doesn't know can't be helped: a guest in the
 * client's tenant, someone from another company, or one of the client's
 * people who never signed in to Grasp. Read from the conversation's
 * roster; if Teams can't say, they are taken for someone from outside.
 */
const unknownLine = async (
  env: Env,
  adapter: ConnectedTeamsAdapter,
  activity: Activity
): Promise<DoorLine> => {
  try {
    const member = await adapter.memberOf(
      activity.serviceUrl,
      activity.conversation.id,
      activity.from.id
    );
    if (member.userRole === "guest") {
      return "guest";
    }
    const tenant = signInConfig(env)?.entra?.tenantId;
    return member.tenantId === tenant ? "signIn" : "otherCompany";
  } catch (error) {
    log.warn("channel.member_unread", {
      platform: "teams",
      ...errorFields(error),
    });
    return "otherCompany";
  }
};

/**
 * One of the client's own people Grasp hasn't seen: their first question
 * kept for the hour, and the sign-in link once a day, nothing in between.
 */
const newcomer = async (
  state: StateAdapter,
  activity: Activity,
  oid: string
): Promise<{ line?: DoorLine }> => {
  const text = activity.text?.trim().slice(0, maxKeptChars) ?? "";
  if (text !== "") {
    await state.setIfNotExists(keptKey(oid), text, keptMs);
  }
  const offered = await state.setIfNotExists(
    `door:teams:sign-in:${oid}`,
    true,
    signInEveryMs
  );
  return offered ? { line: "signIn" } : {};
};

/** What a member asked before Grasp knew them, if it is still kept: taken once. */
const keptQuestion = async (
  state: StateAdapter,
  oid: string
): Promise<string | undefined> => {
  const kept = await state.get<string>(keptKey(oid));
  if (kept === null) {
    return undefined;
  }
  await state.delete(keptKey(oid));
  return kept;
};

/**
 * What the door does with a message before the Chat SDK sees it: the line
 * it sends and nothing more, or the member it is from.
 */
const gate = async (
  env: Env,
  state: StateAdapter,
  adapter: ConnectedTeamsAdapter,
  activity: Activity
): Promise<{ line?: DoorLine; userId?: string; kept?: string }> => {
  // A message without an id can't be told from its resends: dropped.
  if (activity.id === undefined) {
    return {};
  }
  const first = await state.setIfNotExists(
    `door:teams:${activity.conversation.id}:${activity.id}`,
    true,
    seenTtlMs
  );
  if (!first) {
    return {};
  }
  // Teams always says who wrote by their object id; without one, nobody
  // can be known.
  const sender = activity.from.aadObjectId ?? `id:${activity.from.id}`;
  if (!messages.take(`teams:${sender}`)) {
    log.info("channel.limited", { platform: "teams" });
    return told.take(`teams:${sender}`) ? { line: "tooFast" } : {};
  }
  if (activity.conversation.conversationType !== "personal") {
    return { line: "privateOnly" };
  }
  if (activity.from.aadObjectId === undefined) {
    return { line: "otherCompany" };
  }
  const oid = activity.from.aadObjectId;
  const writer = await writerOf(env, "teams", oid);
  switch (writer.kind) {
    case "member": {
      return { userId: writer.userId, kept: await keptQuestion(state, oid) };
    }
    case "removed": {
      return { line: "removed" };
    }
    case "unknown": {
      const line = await unknownLine(env, adapter, activity);
      return line === "signIn"
        ? await newcomer(state, activity, oid)
        : { line };
    }
    default: {
      return writer satisfies never;
    }
  }
};

/**
 * Hands a member's message on to `chat`, through the platform's webhook
 * (`webhook`), as the request's background work, and answers the platform
 * at once: it gives up on a webhook long before an answer is ready, and
 * sends it again. Its conversation is kept, and what the hand-off asks to
 * send afterward goes once the platform has the reply as it stands.
 */
const handOn = (
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  chat: Chat,
  {
    platform,
    userId,
    kept,
    handoff,
    webhook,
  }: {
    platform: Platform;
    userId: string;
    kept?: string;
    handoff: ChannelHandoff | undefined;
    webhook: (
      waitUntil: (promise: Promise<unknown>) => void
    ) => Promise<unknown>;
  }
): Response => {
  const takeOn = handoff ?? answerInChat(env);
  const later: (() => Promise<unknown>)[] = [];
  const afterward = (send: () => Promise<unknown>): void => {
    later.push(send);
  };
  chat.onDirectMessage(async (thread, message) => {
    await keepConversation(env, platform, thread.id, userId);
    await takeOn({ platform, userId, thread, message, kept, afterward });
  });
  const settled = async (promise: Promise<unknown>): Promise<void> => {
    try {
      await promise;
    } catch (error) {
      log.error("channel.handle_failed", { platform, ...errorFields(error) });
    }
  };
  const background = (promise: Promise<unknown>): void => {
    ctx.waitUntil(settled(promise));
  };
  const handled = async (): Promise<void> => {
    await webhook(background);
    for (const send of later) {
      // oxlint-disable-next-line no-await-in-loop -- in the order they were asked for
      await send();
    }
  };
  background(handled());
  return new Response(null, { status: 200 });
};

/**
 * A Slack request, as far as the door reads one: Slack's URL check, or an
 * event's envelope and who sent it where, never its text.
 */
const slackPayloadSchema = z.object({
  type: z.string(),
  challenge: z.string().min(1).max(256).optional(),
  event_id: z.string().min(1).max(256).optional(),
  event: z
    .object({
      type: z.string(),
      subtype: z.string().optional(),
      bot_id: z.string().optional(),
      user: z.string().min(1).max(64).optional(),
      channel: z.string().min(1).max(64),
      channel_type: z.string().optional(),
      ts: z.string().max(64),
      thread_ts: z.string().max(64).optional(),
    })
    .optional(),
});
type SlackEvent = NonNullable<z.infer<typeof slackPayloadSchema>["event"]>;

/**
 * The thread a Slack message is in, as the adapter names it: a direct
 * message's conversation itself, a channel's message's own thread.
 */
const slackThreadOf = (event: SlackEvent): string => {
  const threadTs =
    event.channel_type === "im"
      ? (event.thread_ts ?? "")
      : (event.thread_ts ?? event.ts);
  return `slack:${event.channel}:${threadTs}`;
};

/**
 * What the door does with a Slack message before the Chat SDK sees it, as
 * `gate` does with Teams': the line it sends and nothing more, a link for
 * someone who hasn't linked their Slack account, or the member it is from.
 * Slack names no language a person reads, so lines are in English.
 */
const slackGate = async (
  env: Env,
  state: StateAdapter,
  eventId: string,
  event: SlackEvent & { user: string }
): Promise<{ line?: DoorLine; link?: true; userId?: string }> => {
  const first = await state.setIfNotExists(
    `door:slack:${eventId}`,
    true,
    seenTtlMs
  );
  if (!first) {
    return {};
  }
  if (!messages.take(`slack:${event.user}`)) {
    log.info("channel.limited", { platform: "slack" });
    return told.take(`slack:${event.user}`) ? { line: "tooFast" } : {};
  }
  if (event.channel_type !== "im") {
    return { line: "privateOnly" };
  }
  const writer = await writerOf(env, "slack", event.user);
  return writer.kind === "member" ? { userId: writer.userId } : { link: true };
};

/** Sends one of Stephen's lines, or a link to sign in by, to `event`'s thread. */
const sendSlackLine = async (
  env: Env,
  origin: string,
  event: SlackEvent & { user: string },
  line: DoorLine | "link"
): Promise<void> => {
  const adapter = slackAdapter(env);
  try {
    if (line === "link") {
      const { path } = await offerChannelLink(env, {
        platform: "slack",
        platformUserId: event.user,
      });
      await adapter.postMessage(
        slackThreadOf(event),
        signInCard({ locale: "en", url: new URL(path, origin).href })
      );
      return;
    }
    await adapter.postMessage(slackThreadOf(event), say(line, "en"));
  } catch (error) {
    log.warn("channel.line_failed", {
      platform: "slack",
      line,
      ...errorFields(error),
    });
  }
};

/**
 * Answers a Slack request whose body the door read: 401 unless Slack
 * signed it for this client's app, the URL check's challenge, and
 * otherwise 200 at once, Slack's event handled in the background.
 */
const slackResponse = async (
  request: Request,
  env: Env,
  body: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  handoff: ChannelHandoff | undefined
): Promise<Response> => {
  if (!(await verifiedSlackRequest(env, request, body))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const parsed = slackPayloadSchema.safeParse(jsonOf(body));
  if (!parsed.success) {
    return new Response(null, { status: 200 });
  }
  const { type, challenge, event_id: eventId, event } = parsed.data;
  if (type === "url_verification" && challenge !== undefined) {
    return Response.json({ challenge });
  }
  // Only a person's new message: the bot's own, edits and the rest are
  // acknowledged and dropped.
  if (
    type !== "event_callback" ||
    eventId === undefined ||
    event?.type !== "message" ||
    event.subtype !== undefined ||
    event.bot_id !== undefined ||
    event.user === undefined
  ) {
    return new Response(null, { status: 200 });
  }
  const from = { ...event, user: event.user };
  const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
  const { line, link, userId } = await slackGate(env, state, eventId, from);
  const { origin } = new URL(request.url);
  if (line !== undefined || link !== undefined) {
    ctx.waitUntil(sendSlackLine(env, origin, from, line ?? "link"));
  }
  if (userId === undefined) {
    return new Response(null, { status: 200 });
  }
  const chat = new Chat({
    userName: "Stephen",
    adapters: { slack: slackAdapter(env) },
    state,
    logger: "silent",
    concurrency: "queue",
  });
  return handOn(env, ctx, chat, {
    platform: "slack",
    userId,
    handoff,
    webhook: async (waitUntil) =>
      await chat.webhooks.slack(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        }),
        { waitUntil }
      ),
  });
};

/**
 * A WhatsApp request, as far as the door reads one: each change's number,
 * and each message's id, sender and kind, never its text. The contacts are
 * kept only to hand a member's message on as Meta sent it.
 */
const whatsAppPayloadSchema = z.object({
  object: z.string().optional(),
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: z.string() }).loose(),
              contacts: z.array(z.object({}).loose()).optional(),
              messages: z
                .array(
                  z
                    .object({
                      id: z.string().min(1).max(256),
                      from: z.string().min(1).max(64),
                      type: z.string(),
                    })
                    .loose()
                )
                .optional(),
            })
            .loose(),
        })
      ),
    })
  ),
});
type WhatsAppPayload = z.infer<typeof whatsAppPayloadSchema>;
type WhatsAppChange = WhatsAppPayload["entry"][number]["changes"][number];
type WhatsAppMessage = NonNullable<WhatsAppChange["value"]["messages"]>[number];

/**
 * What the door does with a WhatsApp message before the Chat SDK sees it,
 * as `slackGate` does with Slack's: the line it sends and nothing more, a
 * link for someone who hasn't linked their WhatsApp account, or the member
 * it is from. WhatsApp is always a private chat with the business number.
 */
const whatsAppGate = async (
  env: Env,
  state: StateAdapter,
  message: WhatsAppMessage
): Promise<{ line?: DoorLine; link?: true; userId?: string }> => {
  const first = await state.setIfNotExists(
    `door:whatsapp:${message.id}`,
    true,
    seenTtlMs
  );
  if (!first) {
    return {};
  }
  if (!messages.take(`whatsapp:${message.from}`)) {
    log.info("channel.limited", { platform: "whatsapp" });
    return told.take(`whatsapp:${message.from}`) ? { line: "tooFast" } : {};
  }
  const writer = await writerOf(env, "whatsapp", message.from);
  return writer.kind === "member" ? { userId: writer.userId } : { link: true };
};

/**
 * Sends one of Stephen's lines, or a link to sign in by, to whoever sent
 * `message`. WhatsApp names no language a person reads: lines are in
 * English, as Slack's are.
 */
const sendWhatsAppLine = async (
  env: Env,
  origin: string,
  message: WhatsAppMessage,
  line: DoorLine | "link"
): Promise<void> => {
  const adapter = whatsAppAdapter(env);
  const threadId = adapter.encodeThreadId({
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    userWaId: message.from,
  });
  try {
    if (line === "link") {
      const { path } = await offerChannelLink(env, {
        platform: "whatsapp",
        platformUserId: message.from,
      });
      await adapter.postMessage(
        threadId,
        signInCard({ locale: "en", url: new URL(path, origin).href })
      );
      return;
    }
    await adapter.postMessage(threadId, say(line, "en"));
  } catch (error) {
    log.warn("channel.line_failed", {
      platform: "whatsapp",
      line,
      ...errorFields(error),
    });
  }
};

/**
 * Answers a WhatsApp request whose body the door read: 401 unless Meta
 * signed it for this client's number, and otherwise 200 at once. Each
 * message is gated on its own; a member's is handed on alone, in a body
 * the door made of it and vouches for to the adapter, so no one else's
 * message in the same delivery reaches the Chat SDK.
 */
const whatsAppResponse = async (
  request: Request,
  env: Env,
  body: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  handoff: ChannelHandoff | undefined
): Promise<Response> => {
  if (!(await verifiedWhatsAppRequest(env, request, body))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const parsed = whatsAppPayloadSchema.safeParse(jsonOf(body));
  if (!parsed.success) {
    return new Response(null, { status: 200 });
  }
  const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
  const { origin } = new URL(request.url);
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      // Delivery receipts, profile and id updates: acknowledged, and
      // dropped.
      if (change.field !== "messages") {
        continue;
      }
      for (const message of change.value.messages ?? []) {
        // oxlint-disable-next-line no-await-in-loop -- one message after another, in order
        const { line, link, userId } = await whatsAppGate(env, state, message);
        if (line !== undefined || link !== undefined) {
          ctx.waitUntil(sendWhatsAppLine(env, origin, message, line ?? "link"));
        }
        if (userId !== undefined) {
          const alone = JSON.stringify({
            object: parsed.data.object,
            entry: [
              {
                id: entry.id,
                changes: [
                  {
                    field: change.field,
                    value: { ...change.value, messages: [message] },
                  },
                ],
              },
            ],
          });
          const chat = new Chat({
            userName: "Stephen",
            adapters: {
              whatsapp: whatsAppAdapter(env, (handed) => handed === alone),
            },
            state,
            logger: "silent",
            concurrency: "queue",
          });
          handOn(env, ctx, chat, {
            platform: "whatsapp",
            userId,
            handoff,
            webhook: async (waitUntil) =>
              await chat.webhooks.whatsapp(
                new Request(request.url, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: alone,
                }),
                { waitUntil }
              ),
          });
        }
      }
    }
  }
  return new Response(null, { status: 200 });
};

/**
 * A Telegram update, as far as the door reads one: its id, and a new
 * message's sender, chat and language, never its text. Edits, channel
 * posts and every other kind are left out, and dropped.
 */
const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      from: z
        .object({
          id: z.number().int(),
          is_bot: z.boolean(),
          language_code: z.string().max(35).optional(),
        })
        .optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
    })
    .optional(),
});
type TelegramMessage = NonNullable<
  z.infer<typeof telegramUpdateSchema>["message"]
>;
type TelegramSent = TelegramMessage & {
  from: NonNullable<TelegramMessage["from"]>;
};

/**
 * What the door does with a Telegram message before the Chat SDK sees it,
 * as `slackGate` does with Slack's: the line it sends and nothing more, a
 * link for someone who hasn't linked their Telegram account, or the member
 * it is from.
 */
const telegramGate = async (
  env: Env,
  state: StateAdapter,
  updateId: number,
  message: TelegramSent
): Promise<{ line?: DoorLine; link?: true; userId?: string }> => {
  const first = await state.setIfNotExists(
    `door:telegram:${updateId}`,
    true,
    seenTtlMs
  );
  if (!first) {
    return {};
  }
  const sender = String(message.from.id);
  if (!messages.take(`telegram:${sender}`)) {
    log.info("channel.limited", { platform: "telegram" });
    return told.take(`telegram:${sender}`) ? { line: "tooFast" } : {};
  }
  if (message.chat.type !== "private") {
    return { line: "privateOnly" };
  }
  const writer = await writerOf(env, "telegram", sender);
  return writer.kind === "member" ? { userId: writer.userId } : { link: true };
};

/**
 * Sends one of Stephen's lines, or a link to sign in by, to the chat
 * `message` came from, in the language the sender's Telegram is set to.
 */
const sendTelegramLine = async (
  env: Env,
  origin: string,
  message: TelegramSent,
  line: DoorLine | "link"
): Promise<void> => {
  const adapter = telegramAdapter(env);
  const threadId = adapter.encodeThreadId({
    chatId: String(message.chat.id),
  });
  const locale = localeOf(message.from.language_code);
  try {
    if (line === "link") {
      const { path } = await offerChannelLink(env, {
        platform: "telegram",
        platformUserId: String(message.from.id),
      });
      await adapter.postMessage(
        threadId,
        signInCard({ locale, url: new URL(path, origin).href })
      );
      return;
    }
    await adapter.postMessage(threadId, say(line, locale));
  } catch (error) {
    log.warn("channel.line_failed", {
      platform: "telegram",
      line,
      ...errorFields(error),
    });
  }
};

/**
 * Answers a Telegram request whose body the door read: 401 unless it
 * carries the client's webhook secret, and otherwise 200 at once, a
 * member's message handled in the background.
 */
const telegramResponse = async (
  request: Request,
  env: Env,
  body: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  handoff: ChannelHandoff | undefined
): Promise<Response> => {
  if (!verifiedTelegramRequest(env, request)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const parsed = telegramUpdateSchema.safeParse(jsonOf(body));
  const message = parsed.success ? parsed.data.message : undefined;
  // Only a person's new message: bots', edits and the rest are
  // acknowledged and dropped.
  if (!parsed.success || message?.from === undefined || message.from.is_bot) {
    return new Response(null, { status: 200 });
  }
  const sent = { ...message, from: message.from };
  const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
  const { line, link, userId } = await telegramGate(
    env,
    state,
    parsed.data.update_id,
    sent
  );
  const { origin } = new URL(request.url);
  if (line !== undefined || link !== undefined) {
    ctx.waitUntil(sendTelegramLine(env, origin, sent, line ?? "link"));
  }
  if (userId === undefined) {
    return new Response(null, { status: 200 });
  }
  const chat = new Chat({
    userName: "Stephen",
    adapters: { telegram: telegramAdapter(env) },
    state,
    logger: "silent",
    concurrency: "queue",
  });
  return handOn(env, ctx, chat, {
    platform: "telegram",
    userId,
    handoff,
    webhook: async (waitUntil) =>
      await chat.webhooks.telegram(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        }),
        { waitUntil }
      ),
  });
};

/** Options the tests set: the keys to check against, and the handoff. */
export interface DoorOptions {
  teamsKeys?: TeamsKeys;
  handoff?: ChannelHandoff;
}

/**
 * Answers a request to `/api/channels/<platform>`: 404 for a platform the
 * deployment hasn't set up, 401 for one its platform didn't send, and
 * otherwise what the platform expects, the rest done in the background.
 */
export const channelResponse = async (
  request: Request,
  env: Env,
  platform: string,
  requestId: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  { teamsKeys, handoff }: DoorOptions = {}
): Promise<Response> => {
  if (!isSetUp(env, platform)) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  // Meta checks the webhook it is subscribed to with a GET.
  if (platform === "whatsapp" && request.method === "GET") {
    return whatsAppSubscription(env, request);
  }
  if (request.method !== "POST") {
    return errorResponse(
      405,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const body = await boundedText(request.body, maxBodyBytes);
  if (body === undefined) {
    return errorResponse(
      413,
      requestErrors.create("request.too_large"),
      requestId
    );
  }
  if (platform === "slack") {
    return await slackResponse(request, env, body, ctx, handoff);
  }
  if (platform === "whatsapp") {
    return await whatsAppResponse(request, env, body, ctx, handoff);
  }
  if (platform === "telegram") {
    return await telegramResponse(request, env, body, ctx, handoff);
  }
  if (!(await verifiedTeamsRequest(env, request, body, teamsKeys))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const parsed = activitySchema.safeParse(jsonOf(body));
  // Verified, but nothing the door takes (a typing indicator has a
  // `from`; an installation update may not): acknowledged, and dropped.
  if (!parsed.success || parsed.data.type !== "message") {
    return new Response(null, { status: 200 });
  }
  const activity = parsed.data;
  const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
  const adapter = teamsAdapter(env, teamsKeys);
  const { line, userId, kept } = await gate(env, state, adapter, activity);
  if (line !== undefined) {
    ctx.waitUntil(sendLine(env, adapter, activity, line));
  }
  if (userId === undefined) {
    return new Response(null, { status: 200 });
  }

  // One turn at a time per conversation: a message sent while one is
  // answered waits for it, in order, rather than being dropped.
  const chat = new Chat({
    userName: "Stephen",
    adapters: { teams: adapter },
    state,
    logger: "silent",
    concurrency: "queue",
  });
  return handOn(env, ctx, chat, {
    platform,
    userId,
    kept,
    handoff,
    webhook: async (waitUntil) =>
      await chat.webhooks.teams(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        }),
        { waitUntil }
      ),
  });
};
