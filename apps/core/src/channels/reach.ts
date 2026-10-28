import "@grasp-os/chat/workerd";
import { durableObjectState } from "@grasp-os/chat/state";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { signInConfig } from "../auth/config.ts";
import { channelConversations } from "../db/core/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import { teamsAdapter } from "./teams.ts";
import { channelLocales } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// Messages to people through Stephen, in their own chat app (GRA-753): a
// workflow step that waits for a person (a decision) tells them in their
// private Teams chat with him, once, with the link to where they decide.
// Only people who wrote to him there have a chat to be told in: the door
// keeps each member's conversation (`channel_conversations`), and never
// starts one. Everyone else finds it in Grasp's own inbox, as before.
//
// The ways it can fail, which the tests start from: a person told twice of
// one thing, as a step is replayed or asked again; someone told in a chat
// that isn't their own; a message that fails holding up, or failing, the
// workflow that asked; a message saying more than where to go.

/** How long a person told of something isn't told of it again. */
const toldTtlMs = 30 * 24 * 60 * 60 * 1000;

/** Whether the deployment set Teams up: the bot's id and the Entra tenant. */
const teamsSetUp = (env: Env): boolean =>
  env.TEAMS_BOT_ID !== undefined &&
  env.TEAMS_BOT_ID !== "" &&
  signInConfig(env)?.entra?.tenantId !== undefined;

/** The person's private Teams chat with Stephen they wrote in last. */
const teamsChatOf = async (env: Env, userId: string) =>
  await drizzle(env.DB)
    .select({
      threadId: channelConversations.threadId,
      locale: channelConversations.locale,
    })
    .from(channelConversations)
    .where(
      and(
        eq(channelConversations.platform, "teams"),
        eq(channelConversations.userId, userId)
      )
    )
    .orderBy(desc(channelConversations.lastMessageAt))
    .get();

/**
 * Tells the member `userId` in their own Teams chat with Stephen, once per
 * `about`: `line` says it in their language. Whether they were told now;
 * not when they have no such chat, were told of it before, or the send
 * failed, which is logged and never thrown, so whatever told them goes on.
 */
export const tellInChat = async (
  env: Env,
  userId: string,
  about: string,
  line: (locale: ChannelLocale) => string
): Promise<boolean> => {
  if (!teamsSetUp(env)) {
    return false;
  }
  try {
    const chat = await teamsChatOf(env, userId);
    if (chat === undefined) {
      return false;
    }
    const state = durableObjectState(inJurisdiction(env, env.CHAT_STATE));
    const first = await state.setIfNotExists(
      `told:teams:${userId}:${about}`,
      true,
      toldTtlMs
    );
    if (!first) {
      return false;
    }
    const locale = channelLocales.find((each) => each === chat.locale) ?? "en";
    const adapter = await teamsAdapter(env);
    await adapter.postMessage(chat.threadId, line(locale));
    return true;
  } catch (error) {
    log.warn("channel.tell_failed", {
      platform: "teams",
      ...errorFields(error),
    });
    return false;
  }
};
