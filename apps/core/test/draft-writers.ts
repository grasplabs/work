import { env } from "cloudflare:workers";

import { memberOf } from "../src/auth/identity.ts";
import type { DraftWriter } from "../src/drafts.ts";

/**
 * The agent of `person`'s chat `chatId` writing a draft for them, in turn
 * `turnId` and code step `callId`, as agent-builds.ts writes one: as the
 * person, with their role and teams read now.
 */
export const agentWriting = async (
  person: { userId: string },
  chatId: string,
  {
    turnId = null,
    callId = null,
  }: { turnId?: string | null; callId?: string | null } = {}
): Promise<DraftWriter> => {
  const by = await memberOf(env.DB, person.userId);
  if (by === undefined) {
    throw new Error("No such member.");
  }
  return { by, chat: { chatId, turnId, callId } };
};
