// How a source version's text is cut into chunks: the passages the word
// index holds and recall returns. Plain and deterministic, so the same
// text always gives the same chunks: paragraphs (split at blank lines)
// are joined until the next would pass `chunkTarget`; a paragraph longer
// than `chunkMax` is cut at the last whitespace before it, or, with none,
// at `chunkMax` itself. Later issues may refine the cutting (by tokens,
// by headings); the store only asks for `chunksOf`.

/** Characters a chunk grows to before the next paragraph starts another. */
export const chunkTarget = 1200;

/** Characters no chunk ever passes. */
export const chunkMax = 2000;

/** A blank line, possibly holding spaces: where paragraphs part. */
const paragraphBreak = /\n[^\S\n]*\n\s*/u;

const whitespace = /\s/u;

/** Where to cut `text`, longer than `chunkMax`, so the first part fits. */
const cutOf = (text: string): number => {
  for (let index = chunkMax; index > 0; index -= 1) {
    if (whitespace.test(text.charAt(index))) {
      return index;
    }
  }
  // No whitespace: cut at the limit, never between a surrogate pair.
  // A code point past U+FFFF at the last place is the first half of one.
  const last = text.codePointAt(chunkMax - 1) ?? 0;
  return last > 0xff_ff ? chunkMax - 1 : chunkMax;
};

/** `paragraph` in pieces of at most `chunkMax` characters. */
const piecesOf = (paragraph: string): string[] => {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > chunkMax) {
    const cut = cutOf(rest);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    pieces.push(rest);
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
  for (const piece of pieces) {
    if (current === "") {
      current = piece;
    } else if (current.length + 2 + piece.length <= chunkTarget) {
      current = `${current}\n\n${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current !== "") {
    chunks.push(current);
  }
  return chunks;
};
