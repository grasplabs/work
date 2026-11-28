import type { ChatRef } from "@grasp-os/shared/ids";
import { drizzle } from "drizzle-orm/d1";

import { chatRefOf, ofChat } from "./chat-ref.ts";
import { chatAudiences } from "./db/core/schema.ts";
import type { WorkContext } from "./restricted.ts";

// Who is in a chat others share (a group chat or channel on a chat
// platform), as core keeps it before each turn from the platform's roster
// (`chat_audiences`): core's own record, read by the Brain's recall in
// such a chat (turn-recall.ts, history-access.ts).

/** Who is in a chat others share, as `chat_audiences` keeps them. */
export interface Audience {
  members: readonly string[];
  /** Someone Grasp can't name as one of the organization's members. */
  outsiders: boolean;
}

/**
 * The most members an audience is read for: past it, the chat reads
 * nothing, as if someone in it couldn't be named. A Teams channel's whole
 * team can be thousands; deciding for each is no answer's work.
 */
export const audienceMaxMembers = 1000;

/** The audience of the chat `context` is, if others share it. */
export const audienceOf = async (
  env: Env,
  context: WorkContext
): Promise<Audience | undefined> => {
  if (context.type !== "chat") {
    return undefined;
  }
  const [row] = await drizzle(env.DB)
    .select({
      members: chatAudiences.members,
      outsiders: chatAudiences.outsiders,
    })
    .from(chatAudiences)
    .where(ofChat(chatAudiences, context))
    .limit(1);
  return row;
};

/**
 * Keeps who is in chat `chat` for its agent's reads from now on: the
 * person who asked always among them. Until the table's key moves onto
 * the ref (db/core/schema.ts), another workspace's chat under the same ID
 * refuses it; a chat that keeps an audience is a chat app's, whose ID core
 * makes at random.
 */
export const keepAudience = async (
  env: Env,
  chat: ChatRef,
  asker: string,
  { members, outsiders }: Audience
): Promise<void> => {
  const kept = {
    members: [...new Set([asker, ...members])],
    outsiders,
    updatedAt: new Date(),
  };
  await drizzle(env.DB)
    .insert(chatAudiences)
    .values({ ...chatRefOf(chat), ...kept })
    .onConflictDoUpdate({
      target: [chatAudiences.workspaceId, chatAudiences.chatId],
      set: kept,
    });
};
