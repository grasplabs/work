// An App's AGENTS.md in its code, the one memory file left: its size
// limit, until it goes (GRA-1834). No chat loads it: a chat's instruction
// files are the new Brain's (core's instruction-files.ts).

/** An App's AGENTS.md's size limit, in tokens. */
export const appAgentsMaxTokens = 2000;

// How the Brain counts tokens (@grasp-os/brain/tokens).
export {
  charactersPerToken as memoryCharactersPerToken,
  tokensOf as memoryTokens,
} from "@grasp-os/brain/tokens";
