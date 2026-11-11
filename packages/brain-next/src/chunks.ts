import { foldForSearch } from "./words.ts";

// How a source version's text is cut into chunks: the passages the word
// index holds and recall returns. Plain and deterministic, so the same
// text always gives the same chunks: paragraphs (split at blank lines)
// are joined until the next would pass `chunkTarget`; a paragraph longer
// than `chunkMax` is cut at the last whitespace that keeps the first part
// within it, or, with none, at the last character that does. Later issues
// may refine the cutting (by tokens, by headings); the store only asks for
// `chunksOf`.
//
// A chunk's size is the larger of its length as given and as the word
// index holds it (words.ts `foldForSearch`): folding can grow a text
// (compatibility forms such as "ﷺ" become many letters), and both the
// chunk the store keeps and the words it indexes stay within the bounds.

/** Size a chunk grows to before the next paragraph starts another. */
export const chunkTarget = 1200;

/** Size no chunk ever passes, as given or as indexed. */
export const chunkMax = 2000;

/** A blank line, possibly holding spaces: where paragraphs part. */
const paragraphBreak = /\n[^\S\n]*\n\s*/u;

const whitespace = /\s/u;

/** `text`'s size: its length as given or as indexed, whichever is larger. */
const sizeOf = (text: string): number =>
  Math.max(text.length, foldForSearch(text).length);

/** `end`, or one less when it would part a surrogate pair. */
const atCharacter = (text: string, end: number): number =>
  (text.codePointAt(end - 1) ?? 0) > 0xff_ff ? end - 1 : end;

/**
 * Where to cut `text`, too big for one chunk, so the first part fits: at
 * the last whitespace before the longest start that fits, or, with none,
 * at that start's end. Always past the first character, which alone fits.
 */
const cutOf = (text: string): number => {
  // The longest start that fits, among the first `chunkMax` code units:
  // a start's size only grows with it.
  let fits = 0;
  let tooBig = Math.min(text.length, chunkMax) + 1;
  while (tooBig - fits > 1) {
    const middle = Math.floor((fits + tooBig) / 2);
    if (sizeOf(text.slice(0, middle)) <= chunkMax) {
      fits = middle;
    } else {
      tooBig = middle;
    }
  }
  const end = atCharacter(text, fits);
  for (let index = end; index > 0; index -= 1) {
    if (whitespace.test(text.charAt(index))) {
      return index;
    }
  }
  return end > 0 ? end : String.fromCodePoint(text.codePointAt(0) ?? 0).length;
};

/** `paragraph` in pieces that each fit a chunk. */
const piecesOf = (paragraph: string): string[] => {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > 0) {
    if (rest.length <= chunkMax && sizeOf(rest) <= chunkMax) {
      pieces.push(rest);
      break;
    }
    const cut = cutOf(rest);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return pieces;
};

/** `text`'s chunks, in order: none when it holds only whitespace. */
export const chunksOf = (text: string): string[] => {
  const pieces = text
    .split(paragraphBreak)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap(piecesOf);
  const chunks: string[] = [];
  let current = "";
  let currentSize = 0;
  for (const piece of pieces) {
    const size = sizeOf(piece);
    if (current === "") {
      current = piece;
      currentSize = size;
    } else if (currentSize + 2 + size <= chunkTarget) {
      current = `${current}\n\n${piece}`;
      currentSize += 2 + size;
    } else {
      chunks.push(current);
      current = piece;
      currentSize = size;
    }
  }
  if (current !== "") {
    chunks.push(current);
  }
  return chunks;
};
