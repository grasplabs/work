// An App's AGENTS.md in its code, the one memory file left: its size
// limit, until it goes (GRA-1834). No chat loads it: a chat's instruction
// files are the new Brain's (core's instruction-files.ts).

/** An App's AGENTS.md's size limit, in tokens. */
export const appAgentsMaxTokens = 2000;

// How the Brain counts tokens, without a tokenizer: a recall's budget,
// and the limits on what an agent keeps in its context.

/** Characters per token, as estimated. */
export const memoryCharactersPerToken = 4;

/** Tokens `text` takes, as estimated. */
export const memoryTokens = (text: string): number =>
  Math.ceil(text.length / memoryCharactersPerToken);
