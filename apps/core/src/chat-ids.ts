import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatId } from "@grasp-os/shared/ids";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { chatIds } from "./db/core/schema.ts";

// Whose each chat's ID is, company-wide (`chat_ids`): a page names a new
// chat itself (`ChatStart`), as T3 Code and the AI SDK's chat template do,
// and the Workspace object that makes it takes the ID here first. An ID
// is taken once: by another person, by another start of the same person,
// or by a chat deleted since, it is refused as if there were no such
// chat (`agent.chat_not_found`), the answer a malformed ID gets, so a
// refusal says nothing of anyone else's chats. A chat core names itself
// (a chat app's, a wake-up's) takes its random ID here too, with no key,
// which no start then matches.

/**
 * Takes chat ID `id` for `personId`'s new chat, made by the start with
 * `key` (`ChatStart.key`; null for a chat core names itself). Taking it
 * again for the same start is no change, so a start cut short after this
 * (the object reset) is made on its repeat; anything else is refused.
 */
export const takeChatId = async (
  env: Env,
  id: ChatId,
  personId: string,
  key: string | null
): Promise<void> => {
  // One statement: a row already there answers as it stands, untouched.
  const taken = await drizzle(env.DB)
    .insert(chatIds)
    .values({ id, personId, requestKey: key, createdAt: new Date() })
    .onConflictDoUpdate({
      target: chatIds.id,
      set: { id: sql`${chatIds.id}` },
    })
    .returning({ personId: chatIds.personId, requestKey: chatIds.requestKey })
    .get();
  if (taken.personId !== personId || taken.requestKey !== key) {
    throw agentErrors.create("agent.chat_not_found");
  }
};

/**
 * Keeps deleted chat `id`'s ID taken for good: no start matches it any
 * more, so none makes a chat under it again, its person's no more than
 * anyone's.
 */
export const retireChatId = async (env: Env, id: ChatId): Promise<void> => {
  await drizzle(env.DB)
    .update(chatIds)
    .set({ requestKey: null })
    .where(eq(chatIds.id, id));
};
