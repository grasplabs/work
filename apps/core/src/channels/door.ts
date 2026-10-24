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
 *   or a phone number. Other companies, guests, removed people and people
 *   Grasp doesn't know each get one line, in the language their app is set
 *   to, and nothing they wrote is read. The lines go out through connect
 *   like every send.
 * - Talk in a group chat or channel that isn't for Stephen: only a message
 *   that @mentions the bot is taken; the rest is dropped unread, uncounted
 *   and unanswered.
 * - One of the client's own people Grasp hasn't seen yet (Teams' roster
 *   says they are of the client's tenant, and no guest) is sent a link to
 *   the deployment's own sign-in, once a day: it carries no token and
 *   binds nothing, as their sign-in's ID token names them by the object
 *   id their messages carry. Their first question is kept for the hour,
 *   and answered with their next message once they have signed in.
 *   Nobody from outside the tenant is ever sent the link.
 *
 * Only a member's message reaches the Chat SDK, with who they are: in their
 * own private chat with the bot, whose conversation is kept
 * (`channel_conversations`) so a later message, and the answer, find it;
 * or one that @mentions the bot in a group chat or channel, with who is
 * in it, read from the platform's roster then (`audienceIn`). It is
 * answered in the person's own chat for the platform, or their one chat
 * for that group or channel thread, whose agent reads only what everyone
 * in it may (answer.ts, knowledge/access.ts).
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
import { audienceMaxMembers } from "../knowledge/access.ts";
import type { Audience } from "../knowledge/access.ts";
import { boundedText, jsonOf } from "../request-body.ts";
import { answerInChat } from "./answer.ts";
import { signInCard } from "./cards.tsx";
import type { ConnectedTeamsAdapter } from "./teams-adapter.ts";
import { teamsAdapter, verifiedTeamsRequest } from "./teams.ts";
import type { TeamsKeys } from "./teams.ts";
import { teamsMembers, writerOf } from "./who.ts";
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
type DoorLine = "tooFast" | "otherCompany" | "guest" | "removed" | "signIn";

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
  entities: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        mentioned: z.object({ id: z.string().optional() }).optional(),
      })
    )
    .optional(),
});
type Activity = z.infer<typeof activitySchema>;

/** The language `locale` (`nl-NL`, `de`) names, or English. */
const localeOf = (locale: string | undefined): ChannelLocale => {
  const language = locale?.split("-")[0]?.toLowerCase();
  return channelLocales.find((each) => each === language) ?? "en";
};

/** Where a member asked in a chat others share, as the door hands it on. */
export interface SharedPlace {
  kind: "group" | "channel";
  /** Who is in it, as the platform's roster says now. */
  audience: Audience;
}

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
  /** Where they asked, when it was a group chat or channel. */
  shared?: SharedPlace;
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

/**
 * Whether `activity` @mentions the client's bot, as Teams marks a mention:
 * by the bot's id, alone or after its `28:` prefix.
 */
const mentionsBot = (env: Env, activity: Activity): boolean =>
  (activity.entities ?? []).some(
    ({ type, mentioned }) =>
      type === "mention" &&
      mentioned?.id !== undefined &&
      env.TEAMS_BOT_ID !== undefined &&
      env.TEAMS_BOT_ID !== "" &&
      (mentioned.id === env.TEAMS_BOT_ID ||
        mentioned.id.endsWith(`:${env.TEAMS_BOT_ID}`))
  );

/**
 * Who is in the group chat or channel `activity` came from, read from the
 * conversation's roster (a channel's: its team's, or a private channel's
 * own): its members Grasp knows as the organization's active people, and
 * whether anyone else is in it, a guest, another tenant's, someone Grasp
 * hasn't seen, or anyone at all when the roster can't be read or is too
 * large. Whoever is not named narrows what the answer reads to nothing.
 */
const audienceIn = async (
  env: Env,
  adapter: ConnectedTeamsAdapter,
  activity: Activity
): Promise<Audience> => {
  const nobody = { members: [], outsiders: true };
  // A channel thread's conversation is the channel's, with `;messageid=`.
  const [conversationId = activity.conversation.id] =
    activity.conversation.id.split(";");
  let roster: Awaited<ReturnType<ConnectedTeamsAdapter["rosterOf"]>>;
  try {
    roster = await adapter.rosterOf(
      activity.serviceUrl,
      conversationId,
      audienceMaxMembers
    );
  } catch (error) {
    log.warn("channel.roster_unread", {
      platform: "teams",
      ...errorFields(error),
    });
    return nobody;
  }
  if (roster === undefined) {
    return nobody;
  }
  const tenant = signInConfig(env)?.entra?.tenantId;
  const ours = roster.flatMap(({ aadObjectId, tenantId, userRole }) =>
    aadObjectId !== undefined && tenantId === tenant && userRole !== "guest"
      ? [aadObjectId]
      : []
  );
  const known = await teamsMembers(env, ours);
  return {
    members: [...new Set(known.values())],
    outsiders:
      roster.length === 0 ||
      roster.some(({ aadObjectId }) => !known.has(aadObjectId ?? "")),
  };
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
): Promise<{
  line?: DoorLine;
  userId?: string;
  kept?: string;
  shared?: SharedPlace;
}> => {
  // A message without an id can't be told from its resends: dropped.
  if (activity.id === undefined) {
    return {};
  }
  const { conversationType } = activity.conversation;
  // In a group chat or channel, only what is said to Stephen is his.
  if (conversationType !== "personal" && !mentionsBot(env, activity)) {
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
  if (activity.from.aadObjectId === undefined) {
    return { line: "otherCompany" };
  }
  const oid = activity.from.aadObjectId;
  const writer = await writerOf(env, "teams", oid);
  switch (writer.kind) {
    case "member": {
      const kept = await keptQuestion(state, oid);
      if (conversationType === "personal") {
        return { userId: writer.userId, kept };
      }
      const kind = conversationType === "groupChat" ? "group" : "channel";
      const audience = await audienceIn(env, adapter, activity);
      return { userId: writer.userId, kept, shared: { kind, audience } };
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
  const { line, userId, kept, shared } = await gate(
    env,
    state,
    adapter,
    activity
  );
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
  const takeOn = handoff ?? answerInChat(env);
  const later: (() => Promise<unknown>)[] = [];
  const afterward = (send: () => Promise<unknown>): void => {
    later.push(send);
  };
  chat.onDirectMessage(async (thread, message) => {
    await keepConversation(env, platform, thread.id, userId);
    await takeOn({ platform, userId, thread, message, kept, afterward });
  });
  // A group chat's or channel's: only ever one that @mentioned the bot,
  // which the door let through with who is in it.
  chat.onNewMention(async (thread, message) => {
    if (shared === undefined || thread.isDM) {
      return;
    }
    await takeOn({
      platform,
      userId,
      thread,
      message,
      kept,
      shared,
      afterward,
    });
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
  const handled = async (): Promise<void> => {
    await chat.webhooks.teams(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body,
      }),
      { waitUntil: background }
    );
    for (const send of later) {
      // oxlint-disable-next-line no-await-in-loop -- in the order they were asked for
      await send();
    }
  };
  background(handled());
  return new Response(null, { status: 200 });
};
