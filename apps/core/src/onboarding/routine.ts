import type { WorkflowVersionRecord } from "@grasp-os/shared/brain-records";

import type { StandingDrawing } from "./store.ts";

// A team's routine, as the Brain keeps it (GRA-1749): the drawing of one
// of its pieces of work (brain-intake.ts) as a `routine` entity, each of
// its facts a memory filed under one of the routine's attributes. What a
// routine holds is only what its drawing holds: the parts five or more of
// its people were checked to have told, each figure a median over five or
// more who gave it, and no one's name. Code writes it, line by line, from
// the drawing's structure: a model named and described the steps when it
// drew the work, and adds nothing here.
//
// The drawing's text is these lines (`drawingText`), and each memory
// quotes its own line, so every fact rests on the drawing's version word
// for word and falls with it.

/** A routine's attributes a line of its drawing files a fact under. */
type RoutineAttribute =
  | "team"
  | "evidence"
  | "frequency"
  | "duration"
  | "step"
  | "variant"
  | "wait";

/** One fact of a routine: the line of its drawing it rests on, what it says, and its value. */
export interface RoutineFact {
  attribute: RoutineAttribute;
  /** Its value, for an attribute that isn't a relation (`team` is one). */
  value?: string;
  statement: string;
  /** The line of the drawing's text it rests on, word for word. */
  line: string;
}

/**
 * A drawing as its routine is drawn from it: its words as noted, never
 * its team's name, which the staff list may change while a hand-over is
 * tried again: its text and its routine are the same on every attempt,
 * and the team is named by its identifier alone (new-brain.ts).
 */
export type RoutineDrawing = Pick<
  StandingDrawing,
  "name" | "local" | "drawing"
>;

/** The count of how often, as it is said: "about 30" or "30 to 40". */
const between = (low: number, high: number): string =>
  low === high ? `about ${low}` : `${low} to ${high}`;

/** Whose count a figure of how often is, as said after it. */
const whose: Record<WorkflowVersionRecord["volumes"][number]["of"], string> = {
  me: ", each by their own count",
  team: ", for the whole team",
  unknown: "",
};

/**
 * How often, every count the drawing gives in one value: `frequency` holds
 * one value, so two counts filed apart would end each other.
 */
const frequencyOf = (
  drawing: WorkflowVersionRecord
): { value: string; line: string } | null => {
  const counts = drawing.volumes.map(({ of, per, low, high, people }) => ({
    said: `${between(low, high)} a ${per}${whose[of]}`,
    people,
  }));
  if (counts.length === 0) {
    return null;
  }
  return {
    value: counts.map(({ said }) => said).join("; "),
    line: `How often: ${counts.map(({ said, people }) => `${said}, as ${people} of them said`).join("; ")}.`,
  };
};

/**
 * The lines of `routine`'s drawing in order, each with the fact it files:
 * the drawing's text, for recall, and its routine's facts, for the Brain.
 * Written in English, like the rest of Grasp's own words to a model.
 */
export const routineLines = ({
  name,
  local,
  drawing,
}: RoutineDrawing): {
  /** The heading, filed as the team that does it and the evidence. */
  title: string;
  /** Every other line of the text, in order; those of no fact too. */
  lines: readonly { line: string; fact?: RoutineFact }[];
} => {
  const called = `${name}${local === undefined ? "" : ` (${local})`}`;
  const title = `How a team does ${called}, as ${drawing.people} of its people told it.`;
  const steps = drawing.steps.map(({ text, who, tool, minutes }, at) => {
    const about = [
      who,
      tool,
      minutes === null ? "" : `about ${minutes.normal} minutes`,
    ].filter((part) => part !== "");
    const value = `${at + 1}. ${text}`;
    return {
      line: `${value}${about.length === 0 ? "" : ` (${about.join(", ")})`}`,
      fact: {
        attribute: "step",
        value,
        statement: `Step ${at + 1} of ${name}: ${text}`,
      } as const,
    };
  });
  const variants = drawing.differently.map(({ when, outOfTen, after }) => {
    const share = outOfTen === null ? "" : `, about ${outOfTen} in 10`;
    const value = `After step ${after + 1}, when ${when}${share}`;
    return {
      line: `Off the normal path: ${value}.`,
      fact: {
        attribute: "variant",
        value,
        statement: `${name} goes off its normal path after step ${after + 1} when ${when}${share}.`,
      } as const,
    };
  });
  const { takes, wrong } = drawing;
  const frequency = frequencyOf(drawing);
  const duration =
    takes === null
      ? []
      : [
          {
            value: `${between(takes.quickest, takes.longest)} ${takes.unit}`,
            people: takes.people,
          },
        ];
  const lines = [
    ...(drawing.starts === ""
      ? []
      : [{ line: `What starts one: ${drawing.starts}` }]),
    ...(steps.length === 0 ? [] : [{ line: "Its steps:" }, ...steps]),
    ...(frequency === null
      ? []
      : [
          {
            line: frequency.line,
            fact: {
              attribute: "frequency",
              value: frequency.value,
              statement: `${name} is done ${frequency.value}.`,
            } as const,
          },
        ]),
    ...duration.map(({ value, people }) => ({
      line: `How long one takes: ${value}, as ${people} of them said.`,
      fact: {
        attribute: "duration",
        value,
        statement: `One ${name} takes ${value}.`,
      } as const,
    })),
    ...variants,
    ...(wrong === null
      ? []
      : [
          {
            line: `Comes in wrong or incomplete: ${between(wrong.low, wrong.high)} in 10, as ${wrong.people} of them said.`,
            fact: {
              attribute: "variant",
              value: `Comes in wrong or incomplete, ${between(wrong.low, wrong.high)} in 10`,
              statement: `${between(wrong.low, wrong.high)} in 10 of ${name} come in wrong or incomplete.`,
            } as const,
          },
        ]),
    ...drawing.waits.map((wait) => ({
      line: `Where it waits: ${wait}`,
      fact: {
        attribute: "wait",
        value: wait,
        statement: `${name} waits: ${wait}`,
      } as const,
    })),
  ];
  return {
    title,
    lines: lines.map(({ line, fact }) =>
      fact === undefined ? { line } : { line, fact: { ...fact, line } }
    ),
  };
};

/**
 * Drawing `routine` as the Brain's source text, for recall and for its
 * routine's facts to quote: a heading, then a line each (`routineLines`).
 */
export const drawingText = (routine: RoutineDrawing): string => {
  const { title, lines } = routineLines(routine);
  return [title, ...lines.map(({ line }) => line)].join("\n");
};

/**
 * Every fact of `routine`: the team that does it and how many people it
 * rests on, from its heading, then one for each line that files one. None
 * when no step stands: a routine is its steps, and a drawing with none is
 * no routine.
 */
export const routineFacts = (routine: RoutineDrawing): RoutineFact[] => {
  const { title, lines } = routineLines(routine);
  const facts = lines.flatMap(({ fact }) => (fact === undefined ? [] : [fact]));
  if (!facts.some(({ attribute }) => attribute === "step")) {
    return [];
  }
  const { name, drawing } = routine;
  return [
    {
      attribute: "team",
      statement: `${name} is done by the team it is drawn for.`,
      line: title,
    },
    {
      attribute: "evidence",
      value: `described by ${drawing.people} people in interviews`,
      statement: `${name} is described by ${drawing.people} people of its team in interviews.`,
      line: title,
    },
    ...facts,
  ];
};
