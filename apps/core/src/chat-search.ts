import type { Message } from "@earendil-works/pi-ai";
import type { ChatSearchSnippet } from "@grasp-os/shared/chat";

import { chatMessageOf } from "./chat-messages.ts";

// Finding a person's chat by what was said in it (`ChatsApi.search`): the
// words of their questions and of Grasp's answers, as plain text. Code,
// its results and what the model thought stay out: they were never said.
// A chat matches when every word searched for is in its title, its
// project's name or what was said; one found only by what was said shows
// the stretch around where it was said.

/** Most words a search goes by; the rest of a longer one is left out. */
export const searchWordsMax = 8;

/** Longest search, in characters, before it is cut. */
export const searchMaxLength = 200;

/** Characters around a match a snippet keeps, after it (a third before). */
const snippetRoom = 70;

/** Markdown's own marks, which a person never reads as words. */
const markdownMarks = /[*_`#>|]+/gu;

const whitespace = /\s+/gu;

/** `text` folded as a search compares it: lower case, in any script. */
export const foldOf = (text: string): string => text.toLowerCase();

/** The words of `search`, folded, each once, at most {@link searchWordsMax}. */
export const searchWordsOf = (search: string): string[] =>
  [
    ...new Set(
      foldOf(search.slice(0, searchMaxLength))
        .split(whitespace)
        .filter((word) => word !== "")
    ),
  ].slice(0, searchWordsMax);

/** Whether every word of `search` is somewhere in `texts`. */
export const hasEvery = (search: string, ...texts: string[]): boolean => {
  const hay = foldOf(texts.join(" "));
  return searchWordsOf(search).every((word) => hay.includes(word));
};

/** `text` as one line of plain words: Markdown's marks and line breaks gone. */
export const plainOf = (text: string): string =>
  text.replaceAll(markdownMarks, " ").replaceAll(whitespace, " ").trim();

/**
 * What `message` said, as plain text: a question's words, or an answer's
 * as the person reads them (its links to notes as their text); nothing
 * for a step's result or for core's own bookkeeping.
 */
export const saidOf = (message: Message): string => {
  const shown = chatMessageOf(0, message, new Date(0));
  return shown?.role === "user" || shown?.role === "assistant"
    ? plainOf(shown.text)
    : "";
};

/**
 * Where in `text` a search is found: a short stretch around the whole
 * search as typed, else around its first word that is there, cut at a
 * word's start before it; null when none of its words is in it.
 */
export const snippetOf = (
  text: string,
  search: string
): ChatSearchSnippet | null => {
  const folded = foldOf(text);
  const phrase = foldOf(search.slice(0, searchMaxLength))
    .trim()
    .replaceAll(whitespace, " ");
  const word = [phrase, ...searchWordsOf(search)].find(
    (each) => each !== "" && folded.includes(each)
  );
  if (word === undefined) {
    return null;
  }
  // Folding keeps each character's place for nearly every script; where it
  // didn't, the stretch is cut a character off, never out of the text.
  const at = folded.indexOf(word);
  // From the start of the word the room before it reaches into.
  const early = Math.max(0, at - Math.round(snippetRoom / 3));
  const from = early > 0 ? text.lastIndexOf(" ", early - 1) + 1 : 0;
  const to = Math.min(text.length, at + word.length + snippetRoom);
  return {
    before: `${from > 0 ? "…" : ""}${text.slice(from, at).trimStart()}`,
    found: text.slice(at, at + word.length),
    after: `${text.slice(at + word.length, to).trimEnd()}${to < text.length ? "…" : ""}`,
  };
};
