import { sequenceOf } from "./words.ts";

// Whether a quote is in a text, word for word as the Brain folds words
// (words.ts `sequenceOf`): what extraction checks of a quote the model
// gives, and what a re-check (recheck.ts) asks of a newer version, so a
// quote that held when it was drawn holds against the same text again.
// The text's words are indexed once by where each is written; a quote is
// then looked for from its rarest word only, so checking one costs its
// own words and that word's places in the text, never a pass over the
// whole text per quote.

/** A text, indexed once, to check quotes against. */
export interface QuoteIndex {
  /** Whether `quote` is in the text as consecutive words: at least one word. */
  holds: (quote: string) => boolean;
}

/** `text`, indexed by where each of its words is written. */
export const quoteIndexOf = (text: string): QuoteIndex => {
  const words = sequenceOf(text);
  const places = new Map<string, number[]>();
  for (const [at, word] of words.entries()) {
    const held = places.get(word);
    if (held === undefined) {
      places.set(word, [at]);
    } else {
      held.push(at);
    }
  }
  return {
    holds: (quote) => {
      const run = sequenceOf(quote);
      let fewest: readonly number[] | undefined;
      let offset = 0;
      for (const [index, word] of run.entries()) {
        const at = places.get(word);
        if (at === undefined) {
          return false;
        }
        if (fewest === undefined || at.length < fewest.length) {
          fewest = at;
          offset = index;
        }
      }
      return (fewest ?? []).some((at) => {
        const start = at - offset;
        return (
          start >= 0 &&
          start + run.length <= words.length &&
          run.every((word, index) => words[start + index] === word)
        );
      });
    },
  };
};
