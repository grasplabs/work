import type { WorkflowVersionRecord } from "@grasp-os/shared/brain-records";
import type { FactTag } from "@grasp-os/shared/interview-turn";

import { namedIn } from "./names.ts";

// What the team already told about a piece of work, as the next interview
// about it is given it (store.ts `#contextOf`): how the work goes, so
// Stephen builds on it instead of starting blind. The interviewer knows
// what was said, never who said it. How a colleague could be pointed at
// all the same, and what stops it:
//
// - A line a model wrote that nobody said, or that it says someone told
//   who did not: nothing is read from the drawing as drawn. What is told
//   is the Brain's standing drawing of the work (brain-intake.ts
//   `versionOf`): only the parts a check of each person's own lines backed
//   (drawing-support.ts), in bare words, with no doer of a step, no tool,
//   no number of anyone's and no question for the next interview. It is
//   what every member of the team reads on the Brain page already.
// - One colleague's account told to a teammate, who knows whose it is: the
//   store tells nothing until two people besides the listener told how the
//   work goes, counted from their own agreed lines (`toldByEnough`,
//   `tellsHowItGoes`), never from who the drawing's model says told it.
// - Someone's own list and what they use AI for (`own`, `ai`) can point at
//   the one person who has them: left out.
// - A colleague's name in a line all the same: the Brain took the staff's
//   names out, and a line that still holds a word of one (names.ts) is
//   left out whole. A backstop behind the rules above, not a guarantee.

/** How many people besides the listener must have told how a piece of work goes before any of it is told on. */
export const toldByEnough = 2;

/**
 * The kinds of line that say how the work goes: what a drawing's parts are
 * drawn from. A wish, what someone uses AI for, their own list, a number, a
 * word or an example alone tell no part of it.
 */
const howItGoes: ReadonlySet<FactTag> = new Set([
  "step",
  "system",
  "handoff",
  "wait",
  "exception",
  "rule",
  "judgment",
  "next",
  "done",
  "stop",
]);

/** Whether someone's agreed, shared lines tell anything of how their work goes. */
export const tellsHowItGoes = (facts: readonly { tag: FactTag }[]): boolean =>
  facts.some(({ tag }) => howItGoes.has(tag));

/** The most lines and letters the brief gets of it: it is context, not the interview. */
const toldLinesMost = 12;
const toldLettersMost = 1200;

/** The parts of the Brain's drawing that are told on. */
export type ToldParts = Pick<
  WorkflowVersionRecord,
  | "starts"
  | "steps"
  | "waits"
  | "differently"
  | "decides"
  | "next"
  | "right"
  | "ask"
>;

/**
 * What the team already told about `work`, for the brief of the next
 * interview about it: the lines of the Brain's standing drawing of how it
 * goes, with no line that holds a name from `names` (everyone on the staff
 * list). Empty when nothing of it may be told.
 */
export const toldAbout = (
  work: string,
  drawing: ToldParts,
  names: readonly string[]
): string => {
  const named = namedIn(names);
  const lines = [
    drawing.starts,
    ...drawing.steps.map(({ text }) => text),
    ...drawing.waits.map((wait) => `It waits: ${wait}`),
    ...drawing.differently.map(({ when }) => `Sometimes ${when}.`),
    ...(drawing.decides === "" ? [] : [`They decide by: ${drawing.decides}`]),
    ...(drawing.next === "" ? [] : [`After them: ${drawing.next}`]),
    ...(drawing.right === "" ? [] : [`Done right: ${drawing.right}`]),
    ...(drawing.ask === "" ? [] : [`They stop and ask: ${drawing.ask}`]),
  ]
    .filter((line) => line.trim() !== "" && !named(line))
    .slice(0, toldLinesMost);
  if (lines.length === 0) {
    return "";
  }
  const told = [
    `What the team already told about ${work} (how it goes, no names):`,
    ...lines.map((line) => `- ${line}`),
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
