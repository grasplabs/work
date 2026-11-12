import { sha256Hex } from "@grasp-os/shared/encoding";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import {
  appAgentsMaxTokens,
  memoryCharactersPerToken,
  memoryTokens,
} from "@grasp-os/shared/memory";

// What is left of Knowledge's memory files: an App's AGENTS.md in its
// code, with its size limit, until it goes too (GRA-1834); and the ID a
// personal purge looks for a person's Personal collection under, which
// nothing makes any more, until the purge goes with Knowledge (GRA-1735).
// No chat reads any of them: a chat's instruction files are the new
// Brain's (instruction-files.ts).

/**
 * The ID a person's Personal collection had: made from their ID, hashed
 * so it is identifier-sized. Nothing makes one now; a personal purge
 * still asks for it (rpc.ts `personalCollection`), and finds none.
 */
export const personalCollectionId = async (
  userId: string
): Promise<CollectionId> =>
  collectionIdSchema.parse(`personal:${await sha256Hex(userId)}`);

/** Where an App's AGENTS.md is in its code. */
export const appMemoryPath = "AGENTS.md";

/**
 * Refuses `text` for an App's AGENTS.md when it is over its limit, with
 * `knowledge.memory_too_large`: how large it is and may be, in tokens and
 * about as many characters.
 */
export const requireWithinLimit = (text: string): void => {
  const tokens = memoryTokens(text);
  if (tokens > appAgentsMaxTokens) {
    throw knowledgeErrors.create("knowledge.memory_too_large", {
      file: appMemoryPath,
      tokens,
      maxTokens: appAgentsMaxTokens,
      maxCharacters: appAgentsMaxTokens * memoryCharactersPerToken,
    });
  }
};
