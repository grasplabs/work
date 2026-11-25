import type { DrawnWork } from "@grasp-os/shared/admin/org-record";

// What the team already told about a piece of work, as the next interview
// about it is given it (store.ts `#contextOf`): how the work goes, from its
// drawing, so Stephen builds on it instead of starting blind. The
// interviewer knows what was said, never who said it. How a name could get
// through, and what stops it:
//
// - The drawing says who told what (`from`, `told`, `heard`): none of it is
//   read here.
// - A step's `who` is meant to be a role, but a model wrote it: left out.
// - A model wrote a colleague's name into a line ("Ask Noor when the number
//   is missing."): a line that holds a word of anyone's name on the staff
//   list is left out whole.
// - Someone's own list and what they use AI for (`own`, `ai`) can point at
//   the one person who has them: left out.
// - Each person's own numbers stay theirs: no number is read here.
//
// A name that is not on the staff list (a customer, someone who left) is
// not known here and is not stopped: the drawing's own rule, roles and
// never names, is all that holds it back.

/** The most lines and letters the brief gets of it: it is context, not the interview. */
const toldLinesMost = 12;
const toldLettersMost = 1200;

const notWord = /[^\p{L}\p{N}]+/u;

/**
 * Whether a line holds a word of someone's name. A name of three letters
 * or more counts in any capitals; one of two ("Mo", "Jo") only as it is
 * written, or half of all lines would hold one; a single letter never.
 */
const namesIn = (names: readonly string[]): ((line: string) => boolean) => {
  const parts = names.flatMap((name) => name.split(notWord));
  const long = new Set(
    parts.filter((part) => part.length > 2).map((part) => part.toLowerCase())
  );
  const short = new Set(parts.filter((part) => part.length === 2));
  return (line) =>
    line
      .split(notWord)
      .some((word) => long.has(word.toLowerCase()) || short.has(word));
};

/**
 * What the team already told about `work`, for the brief of the next
 * interview about it: its drawing's lines of how it goes, and what the
 * drawing left open, with no line that holds a name from `names` (everyone
 * on the staff list). Empty when nothing of it may be told.
 */
export const toldAbout = (
  work: string,
  drawn: DrawnWork,
  names: readonly string[]
): string => {
  const named = namesIn(names);
  const kept = (lines: readonly string[]): string[] =>
    lines.filter((line) => line.trim() !== "" && !named(line));
  const lines = kept([
    drawn.starts,
    ...drawn.steps.map(({ text, tool }) =>
      tool === "" ? text : `${text} (${tool})`
    ),
    ...drawn.waits.map((wait) => `It waits: ${wait}`),
    ...drawn.differently.map(({ when, does }) =>
      does === "" ? `Sometimes ${when}.` : `When ${when}: ${does}`
    ),
    ...(drawn.decides === "" ? [] : [`They decide by: ${drawn.decides}`]),
    ...(drawn.next === "" ? [] : [`After them: ${drawn.next}`]),
    ...(drawn.right === "" ? [] : [`Done right: ${drawn.right}`]),
    ...(drawn.ask === "" ? [] : [`They stop and ask: ${drawn.ask}`]),
  ]).slice(0, toldLinesMost);
  const open = kept(drawn.open);
  if (lines.length === 0 && open.length === 0) {
    return "";
  }
  const told = [
    ...(lines.length === 0
      ? []
      : [
          `What the team already told about ${work} (how it goes, no names):`,
          ...lines.map((line) => `- ${line}`),
        ]),
    ...(open.length === 0 ? [] : [`Still open about it: ${open.join(" ")}`]),
  ];
  // Whole lines only, as many as fit: half a line says something else.
  const fitting: string[] = [];
  let letters = 0;
  for (const line of told) {
    letters += line.length + 1;
    if (letters > toldLettersMost) {
      break;
    }
    fitting.push(line);
  }
  return fitting.join("\n");
};
