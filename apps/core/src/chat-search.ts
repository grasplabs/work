import type { Message } from "@earendil-works/pi-ai";
import type { ChatSearchSnippet } from "@grasp-os/shared/chat";
import {
  foldOf,
  searchPhraseOf,
  searchWordsOf,
} from "@grasp-os/shared/chat-search";

import { chatMessageOf } from "./chat-messages.ts";

// Finding a person's chat by what was said in it (`ChatsApi.search`): the
// words of their questions and of Grasp's answers, as plain text. Code,
// its results and what the model thought stay out: they were never said.
// A chat matches when every word searched for is in its title, its
// project's name or what was said; one found only by what was said shows
// the stretch around where it was said.

/**
 * Longest stretch of one message a search looks through, in characters:
 * its row, the text twice over, stays far below the 2 MB a Durable
 * Object's SQLite keeps in one row.
 */
export const saidMax = 100_000;

/** Characters around a match a snippet keeps, after it (a third before). */
const snippetRoom = 70;

/**
 * Characters a search reads of a message on each side of where it was
 * found: room enough for a snippet, and for the start of the word it
 * begins at.
 */
export const snippetReach = 2 * snippetRoom;

/** Markdown's own marks, which a person never reads as words. */
const markdownMarks = /[*_`#>|]+/gu;

const whitespace = /\s+/gu;

/** `text` as one line of plain words: Markdown's marks and line breaks gone. */
export const plainOf = (text: string): string =>
  text.replaceAll(markdownMarks, " ").replaceAll(whitespace, " ").trim();

/**
 * What `message` said, as plain text: a question's words, or an answer's
 * as the person reads them (its links to notes as their text); nothing
 * for a step's result or for core's own bookkeeping. At most
 * {@link saidMax} characters, the start of it.
 */
export const saidOf = (message: Message): string => {
  const shown = chatMessageOf(0, message, new Date(0));
  return shown?.role === "user" || shown?.role === "assistant"
    ? plainOf(shown.text).slice(0, saidMax)
    : "";
};

/**
 * What a search looks for in what was said, in turn: the whole search as
 * typed, then each of its words. The first that is there is shown.
 */
export const searchTermsOf = (search: string): string[] =>
  [searchPhraseOf(search), ...searchWordsOf(search)].filter(
    (term) => term !== ""
  );

/**
 * Where in `text` a search is found: a short stretch around the whole
 * search as typed, else around its first word that is there, cut at a
 * word's start before it; null when none of its words is in it. `text`
 * may be a stretch of what was said: `cut` says which of its ends were
 * cut, so they carry an ellipsis too.
 */
export const snippetOf = (
  text: string,
  search: string,
  cut?: { before: boolean; after: boolean }
): ChatSearchSnippet | null => {
  // Folding keeps each character where it was: a place in it is the same
  // place in `text`.
  const folded = foldOf(text);
  const term = searchTermsOf(search).find((each) => folded.includes(each));
  if (term === undefined) {
    return null;
  }
  const at = folded.indexOf(term);
  // From the start of the word the room before it reaches into.
  const early = Math.max(0, at - Math.round(snippetRoom / 3));
  const from = early > 0 ? text.lastIndexOf(" ", early - 1) + 1 : 0;
  const to = Math.min(text.length, at + term.length + snippetRoom);
  const cutBefore = from > 0 || cut?.before === true;
  const cutAfter = to < text.length || cut?.after === true;
  return {
    before: `${cutBefore ? "…" : ""}${text.slice(from, at).trimStart()}`,
    found: text.slice(at, at + term.length),
    after: `${text.slice(at + term.length, to).trimEnd()}${cutAfter ? "…" : ""}`,
  };
};
