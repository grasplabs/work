// How the Brain counts tokens without a tokenizer: a recall's budget, and
// the host's limits on what it keeps in an agent's context.

/** Characters per token, as estimated. */
export const charactersPerToken = 4;

/** Tokens `text` takes, as estimated. */
export const tokensOf = (text: string): number =>
  Math.ceil(text.length / charactersPerToken);
