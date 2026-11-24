// How a search for a person's chats reads its words (`ChatsApi.search`),
// the same in core, which looks through what was said, and in the ⌘K
// window, which narrows by title at once while core looks.

/** Most words a search goes by; the rest of a longer one is left out. */
export const searchWordsMax = 8;

/** Longest search, in characters, before it is cut. */
export const searchMaxLength = 200;

const whitespace = /\s+/gu;

/**
 * `text` folded as a search compares it: each character in lower case,
 * in any script, but one whose lower case is longer (the dotted İ) as it
 * is, so the folded text keeps every character where it was and a place
 * found in it is the same place in `text`.
 */
export const foldOf = (text: string): string => {
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
};

/** The words of `search`, folded, each once, at most {@link searchWordsMax}. */
export const searchWordsOf = (search: string): string[] =>
  [
    ...new Set(
      foldOf(search.slice(0, searchMaxLength))
        .split(whitespace)
        .filter((word) => word !== "")
    ),
  ].slice(0, searchWordsMax);

/** `search` as one phrase, folded, its spaces one each. */
export const searchPhraseOf = (search: string): string =>
  foldOf(search.slice(0, searchMaxLength)).trim().replaceAll(whitespace, " ");

/** Whether every word of `search` is somewhere in `texts`. */
export const hasEvery = (search: string, ...texts: string[]): boolean => {
  const hay = foldOf(texts.join(" "));
  return searchWordsOf(search).every((word) => hay.includes(word));
};
