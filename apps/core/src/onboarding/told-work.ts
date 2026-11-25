import type { DrawnWork, Told } from "@grasp-os/shared/admin/org-record";

import { namedIn } from "./names.ts";

// What the team already told about a piece of work, as the next interview
// about it is given it (store.ts `#contextOf`): how the work goes, from its
// drawing, so Stephen builds on it instead of starting blind. The
// interviewer knows what was said, never who said it. How a colleague
// could be pointed at all the same, and what stops it:
//
// - One colleague's account told to a teammate, who knows whose it is: the
//   store tells nothing until two people besides the listener told
//   something of the work (`toldByEnough`, `toldSomething`), so no line is
//   one known person's. Someone a drawing was made with who said nothing
//   of this work does not count.
// - The drawing says who told what (`from`, `told`, `heard`): none of it is
//   read here.
// - A step's `who` is meant to be a role, but a model wrote it: left out.
// - Someone's own list and what they use AI for (`own`, `ai`) can point at
//   the one person who has them: left out.
// - Each person's own numbers stay theirs: no number is read here.
// - A model wrote a colleague's name into a line ("Ask Noor when the number
//   is missing."): a line that holds a word of a name on the staff list
//   (names.ts) is left out whole. That is a backstop behind the rules above
//   and the drawing's own "roles, never names", not a guarantee.

/** How many people besides the listener must have told a piece of work before any of it is told on. */
export const toldByEnough = 2;

/**
 * Whether someone told anything of how the work goes: any of what
 * `toldAbout` reads from its drawing. Their numbers, own list or AI use
 * alone are not told on, so they do not count.
 */
export const toldSomething = (told: Told | undefined): boolean =>
  told !== undefined &&
  (told.start ||
    told.steps.length > 0 ||
    told.waits.length > 0 ||
    told.differently.length > 0 ||
    told.decides ||
    told.next ||
    told.right ||
    told.ask);

/** The most lines and letters the brief gets of it: it is context, not the interview. */
const toldLinesMost = 12;
const toldLettersMost = 1200;

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
  const named = namedIn(names);
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
  const told =
    lines.length === 0
      ? [`Still open about ${work}: ${open.join(" ")}`]
      : [
          `What the team already told about ${work} (how it goes, no names):`,
          ...lines.map((line) => `- ${line}`),
          ...(open.length === 0
            ? []
            : [`Still open about it: ${open.join(" ")}`]),
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
