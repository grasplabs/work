// The one place that knows a colleague's name in a text: what the Brain
// keeps of a team's claims and drawings, the company's opinions, and what
// the next interview is told of a piece of work all go through it. It is a
// backstop, not a guarantee: it knows only the names on the staff list, so
// a customer's name, someone who left or a pet name nobody's name starts
// with passes. What holds a name back first is what is told at all (only
// what several people said) and the prompts that ask for roles, never
// names.

const wordOf = /[\p{L}\p{N}\p{M}]+/gu;
const notWord = /[^\p{L}\p{N}\p{M}]+/u;
const marks = /\p{M}/gu;
const capital = /^\p{Lu}/u;
/** What a sentence ends with, or a line of a list starts with, before its first word. */
const sentenceStart = /(?:^|[.!?:…]\s+|\n\s*(?:[-*]\s+)?)$/u;

/** How far back from a word is read to see whether it starts its sentence. */
const beforeWord = 8;

/** A word without its accents: "José" is written "Jose" as often as not. */
const folded = (word: string): string =>
  word.normalize("NFD").replace(marks, "");

/**
 * A name of this many letters or more is one in any capitals; a shorter
 * one ("Will", "An", "Mo") only written as a name, or every "will" and
 * "an" would go.
 */
const anyCaseFrom = 5;
/** The fewest letters a word of a name, or a short form of one, has. */
const nameLettersMin = 2;
/** A short form is at least this much shorter than the name: one letter less is another word. */
const shortBy = 2;

/**
 * Whether a word of a text is a name on the staff list, as a function of
 * the word and whether it starts its sentence. It is one when it is
 *
 * - a word of someone's name, also without its accents, and also with the
 *   "s" of "Noors desk";
 * - the start of someone's first name, written with a capital inside a
 *   sentence ("Mo" for Mohamed, "Alex" for Alexander). At the start of a
 *   sentence every word has a capital, and "An", "In" and "The" start
 *   too many names.
 */
const nameTest = (
  names: readonly string[]
): ((word: string, starts: boolean) => boolean) => {
  const exact = new Set<string>();
  const anyCase = new Set<string>();
  const firsts: string[] = [];
  for (const name of names) {
    const words = name
      .split(notWord)
      .map(folded)
      .filter((word) => word.length >= nameLettersMin);
    for (const word of words) {
      exact.add(word);
      if (word.length >= anyCaseFrom) {
        anyCase.add(word.toLowerCase());
      }
    }
    const [first] = words;
    if (first !== undefined) {
      firsts.push(first);
    }
  }
  const whole = (word: string): boolean =>
    exact.has(word) || anyCase.has(word.toLowerCase());
  return (written, starts) => {
    const word = folded(written);
    if (word.length < nameLettersMin) {
      return false;
    }
    if (whole(word) || (word.endsWith("s") && whole(word.slice(0, -1)))) {
      return true;
    }
    return (
      !starts &&
      capital.test(word) &&
      firsts.some(
        (first) =>
          first.length >= word.length + shortBy && first.startsWith(word)
      )
    );
  };
};

/**
 * Takes the names on the staff list out of a text: each becomes "someone"
 * (`nameTest` says what counts as one). A word that is also a name
 * ("Mark") goes too: better a word lost than a name kept.
 */
export const withoutNames = (
  names: readonly string[]
): ((text: string) => string) => {
  const named = nameTest(names);
  return (text) => {
    const said = text.replaceAll(wordOf, (word, at: number) =>
      named(
        word,
        sentenceStart.test(text.slice(Math.max(0, at - beforeWord), at))
      )
        ? "someone"
        : word
    );
    // A sentence that started with a name starts with a capital still.
    return said.startsWith("someone") && !text.startsWith("someone")
      ? `S${said.slice(1)}`
      : said;
  };
};
