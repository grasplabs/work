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
 *
 * Only a member's message in their own private chat with the bot reaches
 * the Chat SDK, with who they are, and its conversation is kept
 * (`channel_conversations`) so a later message, and the answer, find it.
 * It is answered in the person's own chat for the platform (answer.ts).
 *
 * Teams' adapter sends through axios, which workerd refuses as it builds
 * its requests: `@grasp-os/chat/workerd` puts the fix in, so it is
 * imported before any adapter loads.
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
import { answerInChat } from "./answer.ts";
import type { ConnectedTeamsAdapter } from "./teams-adapter.ts";
import { teamsAdapter, verifiedTeamsRequest } from "./teams.ts";
import type { TeamsKeys } from "./teams.ts";
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
});

/** A platform the door has an adapter for. */
type Platform = keyof ReturnType<typeof channelAdapters>;

/**
 * Whether the deployment set `platform` up: Teams once it has the bot's id
 * and the client's Entra tenant, without which every request would be
 * refused anyway.
 */
const isSetUp = (env: Env, platform: string): platform is Platform =>
  platform === "teams" &&
  env.TEAMS_BOT_ID !== undefined &&
  env.TEAMS_BOT_ID !== "" &&
  signInConfig(env)?.entra?.tenantId !== undefined;

/** Largest request a platform may post: a Teams activity is far smaller. */
const maxBodyBytes = 256 * 1024;

/**
 * Messages one person may send: ten at once, then one every three
 * seconds. Someone typing fast stays well inside it; a script doesn't.
 */
const messageRate = { burst: 10, perMinute: 20 };

/** How often a person over the limit is told so: once a minute. */
const toldRate = { burst: 1, perMinute: 1 };

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

/** A Teams activity, as far as the door reads it: never its text. */
const activitySchema = z.object({
  type: z.string(),
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

/** Sends one of Stephen's lines to the conversation `activity` came from. */
const sendLine = async (
  adapter: ConnectedTeamsAdapter,
  activity: Activity,
  line: DoorLine
): Promise<void> => {
  const threadId = adapter.encodeThreadId({
    conversationId: activity.conversation.id,
    serviceUrl: activity.serviceUrl,
    conversationType: activity.conversation.conversationType,
  });
  try {
    await adapter.postMessage(threadId, say(line, localeOf(activity.locale)));
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
 * What the door does with a message before the Chat SDK sees it: the line
 * it sends and nothing more, or the member it is from.
 */
const gate = async (
  env: Env,
  state: StateAdapter,
  adapter: ConnectedTeamsAdapter,
  activity: Activity
): Promise<{ line?: DoorLine; userId?: string }> => {
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
  const writer = await writerOf(env, "teams", activity.from.aadObjectId);
  switch (writer.kind) {
    case "member": {
      return { userId: writer.userId };
    }
    case "removed": {
      return { line: "removed" };
    }
    case "unknown": {
      return { line: await unknownLine(env, adapter, activity) };
    }
    default: {
      return writer satisfies never;
    }
  }
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
  const { line, userId } = await gate(env, state, adapter, activity);
  if (line !== undefined) {
    ctx.waitUntil(sendLine(adapter, activity, line));
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
  const takeOn = handoff ?? answerInChat(env);
  chat.onDirectMessage(async (thread, message) => {
    await keepConversation(env, platform, thread.id, userId);
    await takeOn({ platform, userId, thread, message });
  });
  // Answered at once: the platform gives up on a webhook long before an
  // answer is ready, and sends it again. The message is handled after,
  // as the request's background work.
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
  background(
    chat.webhooks.teams(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body,
      }),
      { waitUntil: background }
    )
  );
  return new Response(null, { status: 200 });
};
