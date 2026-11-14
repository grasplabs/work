import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { chatAudiences } from "./db/core/schema.ts";
import type { WorkContext } from "./restricted.ts";

// Who is in a chat others share (a group chat or channel on a chat
// platform), as core keeps it before each turn from the platform's roster
// (`chat_audiences`): core's own record, read by today's Knowledge
// (knowledge/access.ts) and by the new Brain's recall in such a chat
// (turn-recall.ts, history-access.ts) alike, so neither rests on the other.

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
      workspaceId: chatAudiences.workspaceId,
      members: chatAudiences.members,
      outsiders: chatAudiences.outsiders,
    })
    .from(chatAudiences)
    .where(eq(chatAudiences.chatId, context.chatId))
    .limit(1);
  if (row === undefined) {
    return undefined;
  }
  // Kept by another Workspace object's chat of that id: read as nothing.
  if (row.workspaceId !== context.workspaceId) {
    return { members: [], outsiders: true };
  }
  return { members: row.members, outsiders: row.outsiders };
};

/**
 * Keeps who is in the chat `chatId`, held by the Workspace object
 * `workspaceId`, for its agent's reads from now on: the person who asked
 * always among them.
 */
export const keepAudience = async (
  env: Env,
  { workspaceId, chatId }: { workspaceId: string; chatId: string },
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
    .values({ chatId, workspaceId, ...kept })
    .onConflictDoUpdate({ target: chatAudiences.chatId, set: kept });
};
