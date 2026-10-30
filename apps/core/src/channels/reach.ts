import "@grasp-os/chat/workerd";
import { durableObjectState } from "@grasp-os/chat/state";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { signInConfig } from "../auth/config.ts";
import { channelAccounts, channelConversations } from "../db/core/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import { stephenFor } from "../stephen-reach.ts";
import { slackAdapter } from "./slack.ts";
import { teamsAdapter } from "./teams.ts";
import { channelLocales } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// Messages to people through Stephen, in their own chat app (GRA-753): a
// workflow step that waits for a person (a decision) tells them in their
// private chat with him, in Teams and in Slack, once each, with the link
// to where they decide. Only people who wrote to him there have a chat to
// be told in: the door keeps each member's conversation
// (`channel_conversations`), and never starts one. Everyone else finds it
// in Grasp's own inbox, as before.
//
// The ways it can fail, which the tests start from: a person told twice of
// one thing, as a step is replayed or asked again; someone told in a chat
// that isn't their own; a message that fails holding up, or failing, the
// workflow that asked; a message saying more than where to go. In Slack,
// too: told in a channel rather than their direct message, told after they
// unlinked their Slack account (their chat may be someone else's by then),
// or told where Settings › Stephen has him not answer them.

/** How long a person told of something isn't told of it again. */
const toldTtlMs = 30 * 24 * 60 * 60 * 1000;

/** The chat apps a person is told in. */
type ToldOn = "teams" | "slack";

/** Whether the deployment set Teams up: the bot's id and the Entra tenant. */
const teamsSetUp = (env: Env): boolean =>
  env.TEAMS_BOT_ID !== undefined &&
  env.TEAMS_BOT_ID !== "" &&
  signInConfig(env)?.entra?.tenantId !== undefined;

/** Whether the deployment set Slack up: the app's signing secret. */
const slackSetUp = (env: Env): boolean =>
  env.SLACK_SIGNING_SECRET !== undefined && env.SLACK_SIGNING_SECRET !== "";

/** The person's private chat with Stephen on `platform` they wrote in last. */
const chatOf = async (env: Env, platform: ToldOn, userId: string) =>
  await drizzle(env.DB)
    .select({
      threadId: channelConversations.threadId,
      locale: channelConversations.locale,
    })
    .from(channelConversations)
    .where(
      and(
        eq(channelConversations.platform, platform),
        eq(channelConversations.userId, userId)
      )
    )
    .orderBy(desc(channelConversations.lastMessageAt))
    .get();

/** Whether `userId` has a Slack account linked to them still. */
const slackLinked = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.platform, "slack"),
        eq(channelAccounts.userId, userId)
      )
    )
    .get();
  return row !== undefined;
};

/**
 * Where to tell `userId` in Slack: their direct message with Stephen, as a
 * message of its own rather than a reply in the thread they last wrote in.
 * Nowhere unless Slack is set up, they still have a Slack account linked,
 * he answers them there, and the chat they wrote in is a direct message.
 */
const slackThreadOf = async (
  env: Env,
  userId: string
): Promise<string | undefined> => {
  if (!slackSetUp(env)) {
    return undefined;
  }
  const [chat, linked, reach] = await Promise.all([
    chatOf(env, "slack", userId),
    slackLinked(env, userId),
    stephenFor(env, userId, "slack"),
  ]);
  if (chat === undefined || !linked || !reach.reaches) {
    return undefined;
  }
  const adapter = slackAdapter(env);
  const { channel } = adapter.decodeThreadId(chat.threadId);
  if (!channel.startsWith("D")) {
    return undefined;
  }
  return adapter.encodeThreadId({ channel, threadTs: "" });
};

/**
 * Tells `userId` on `platform`, once per `about`. Whether they were told
 * now; a failed send is logged and never thrown.
 */
const tellOn = async (
  env: Env,
  platform: ToldOn,
  userId: string,
  about: string,
  line: (locale: ChannelLocale) => string
): Promise<boolean> => {
  try {
    let threadId: string | undefined;
    let locale: ChannelLocale = "en";
    if (platform === "teams") {
      const chat = teamsSetUp(env)
        ? await chatOf(env, "teams", userId)
        : undefined;
      threadId = chat?.threadId;
      locale = channelLocales.find((each) => each === chat?.locale) ?? "en";
    } else {
      // Slack names no language a person reads: English, as the rest there.
      threadId = await slackThreadOf(env, userId);
    }
    if (threadId === undefined) {
      return false;
    }
    const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
    const first = await state.setIfNotExists(
      `told:${platform}:${userId}:${about}`,
      true,
      toldTtlMs
    );
    if (!first) {
      return false;
    }
    const adapter =
      platform === "teams" ? await teamsAdapter(env) : slackAdapter(env);
    await adapter.postMessage(threadId, line(locale));
    return true;
  } catch (error) {
    log.warn("channel.tell_failed", { platform, ...errorFields(error) });
    return false;
  }
};

/**
 * Tells the member `userId` in their own chats with Stephen, in Teams and
 * in Slack, once each per `about`: `line` says it in their language.
 * Whether they were told now anywhere; not where they have no such chat,
 * were told of it before, or the send failed, which is logged and never
 * thrown, so whatever told them goes on.
 */
export const tellInChat = async (
  env: Env,
  userId: string,
  about: string,
  line: (locale: ChannelLocale) => string
): Promise<boolean> => {
  const told = await Promise.all([
    tellOn(env, "teams", userId, about, line),
    tellOn(env, "slack", userId, about, line),
  ]);
  return told.includes(true);
};
