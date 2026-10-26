// What a team's claim (team-claims.ts) and a drawn part
// (drawing-support.ts) may be made of (GRA-1084).
//
// A claim is held to a strict allowlist, after the single-script
// restriction of Unicode's UTS #39, narrowed to what our clients'
// languages (English, Dutch, German, French, Spanish) write: once
// normalized (NFKC, then NFC), only A to Z and a to z, the letters of
// Latin-1 Supplement (U+00C0 to U+00FF, not × and ÷) and of Latin
// Extended-A (U+0100 to U+017F, not the dotless ı, which reads as an i),
// ASCII digits, ASCII spaces, commas and hyphens, and one full stop,
// exclamation or question mark at its end, with no space before it. A
// mark left after NFC, or any default-ignorable code point, refuses it:
// nothing can hide in a claim five people visibly support, nor read as
// something else.

/** The letters a claim may hold. */
const letters = /^[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F]$/u;
/** A letter in those ranges that reads as another. */
const lookalike = "\u0131";
/** What a claim may hold besides its letters. */
const asciiAllowed = /^[0-9 ,-]$/u;
/** What a claim ends with. */
export const terminal = /^[.!?]$/u;
/** A mark NFC left on its own, or a code point that shows nothing. */
export const hidden = /[\p{M}\p{Default_Ignorable_Code_Point}]/u;

/** Whether `character` may be in a claim, before its end. */
export const allowed = (character: string): boolean =>
  asciiAllowed.test(character) ||
  (letters.test(character) && character !== lookalike);

/**
 * A drawn part's words, when every character is one a claim may hold
 * (the same allowlist, GRA-1084): normalized, at most `most` characters,
 * starting with a letter or digit, no two spaces together, and at most
 * one full stop, exclamation or question mark, at the end. Unlike a
 * claim, a part needn't end in one: a case is "the client number is
 * missing", a term one word. None when it holds anything else.
 */
export const plainPart = (value: string, most = 300): string | null => {
  const line = value.normalize("NFKC").normalize("NFC").trim();
  if (line === "" || line.length > most || hidden.test(line)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-misused-spread -- whole code points, as Unicode's properties name them
  const characters = [...line];
  const body = terminal.test(characters.at(-1) ?? "")
    ? characters.slice(0, -1)
    : characters;
  const [first = ""] = body;
  return body.length > 0 &&
    body.at(-1) !== " " &&
    first !== " " &&
    first !== "," &&
    first !== "-" &&
    !line.includes("  ") &&
    body.every(allowed)
    ? line
    : null;
};
