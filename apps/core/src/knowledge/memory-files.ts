import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import {
  appAgentsMaxTokens,
  memoryCharactersPerToken,
  memoryTokens,
} from "@grasp-os/shared/memory";

// What is left of Knowledge's memory files: an App's AGENTS.md in its
// code, with its size limit, until it goes too (GRA-1834). No chat reads
// it: a chat's instruction files are the new Brain's (instruction-files.ts).

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
