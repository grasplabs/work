// Whether a line holds a colleague's name, for what the next interview is
// told of a piece of work (told-work.ts): a line that does is left out
// whole. It is strict on purpose, and so loses lines that hold an ordinary
// word someone is also called ("will", "price"): a told line lost costs
// the interviewer one hint, a name kept points at a colleague. That is why
// it is not the Brain's filter (brain-intake.ts `withoutNames`), which
// rewrites text people read and must leave their words alone.
//
// It is a backstop, not a guarantee: it knows only the names on the staff
// list, so a customer's name, someone who left or a pet name passes. What
// holds a name back first is that nothing is told until two colleagues
// told the work, and that the drawing is asked for roles, never names.

const notWord = /[^\p{L}\p{N}\p{M}]+/u;
const marks = /\p{M}/gu;

/** A word as it is compared: without its accents ("José" is written "Jose" as often as not), in small letters. */
const folded = (word: string): string =>
  word.normalize("NFD").replace(marks, "").toLowerCase();

const wordsOf = (text: string): string[] =>
  text
    .split(notWord)
    .map(folded)
    .filter((word) => word !== "");

/**
 * Whether a line holds a word of a name in `names`: any word of anyone's
 * name, whatever its capitals or accents, also with the "s" of "Noors
 * list".
 */
export const namedIn = (
  names: readonly string[]
): ((line: string) => boolean) => {
  // A single letter is an initial, and half of all lines hold one.
  const known = new Set(
    names.flatMap(wordsOf).filter((word) => word.length > 1)
  );
  return (line) =>
    wordsOf(line).some(
      (word) =>
        known.has(word) || (word.endsWith("s") && known.has(word.slice(0, -1)))
    );
};
