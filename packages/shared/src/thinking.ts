import { z } from "zod";

import { WEEKS_PER_MONTH } from "./admin/hours.ts";
import type { WorkflowDrawing } from "./brain.ts";

// Grasp's thinking, shown in the brain while it answers (the chat agent's
// `show_thinking` tool, apps/core/src/agent-thinking.ts): a step at a time,
// each a short sentence of what Grasp does, the brain's notes it looks at,
// and the shape the brain takes. Two shapes, each with its moves in order:
// whether the same pain hurts more than one team (the teams, what they
// said, the teams that said the same pulled together), and where the
// hours go (the workflows, each weighed by its hours a week, the ones that
// take most). A shape's last move is its finding. A step names only what
// is in the brain as the asker may read it, each by the id core resolves
// it to; the brain plays the steps (apps/web/src/brain/thinking/*).

/** The shapes the brain takes while Grasp thinks. */
export const thinkingShapes = ["same-pain", "hours"] as const;
export type ThinkingShape = (typeof thinkingShapes)[number];

/** Each shape's moves, in their order; the last says what Grasp found. */
export const thinkingMoves = {
  "same-pain": ["teams", "said", "together"],
  hours: ["work", "hours", "most"],
} as const satisfies Record<ThinkingShape, readonly string[]>;
export type ThinkingMove = (typeof thinkingMoves)[ThinkingShape][number];

/** What a step may name, by its shape: teams and statements, or workflows. */
export type ThinkingNoteKind = "team" | "statement" | "workflow";

export const thinkingNoteKinds: Record<
  ThinkingShape,
  readonly ThinkingNoteKind[]
> = {
  "same-pain": ["team", "statement"],
  hours: ["workflow"],
};

/** One step of Grasp's thinking, as core accepted it. */
export interface ThinkingStep {
  /** What Grasp does, or at the last move what it found, in one short sentence. */
  text: string;
  /** The brain's notes it looks at, by id: teams, statements or workflows. */
  notes: string[];
  shape: ThinkingShape;
  move: ThinkingMove;
}

/** The most a step says, in characters, and the most notes it names. */
export const thinkingStepMost = { text: 160, notes: 60 } as const;

/** A step as core keeps it with the answer: what the page reads back. */
export const thinkingStepSchema = z
  .strictObject({
    text: z.string().min(1).max(thinkingStepMost.text),
    notes: z.array(z.string().min(1)).max(thinkingStepMost.notes),
    shape: z.enum(thinkingShapes),
    move: z.enum(["teams", "said", "together", "work", "hours", "most"]),
  })
  .refine(({ shape, move }) =>
    thinkingMoves[shape].some((each: string) => each === move)
  );

/** Whether a step says what Grasp found: the last move of its shape. */
export const isFinding = (
  step: Pick<ThinkingStep, "shape" | "move">
): boolean => thinkingMoves[step.shape].at(-1) === step.move;

const diacritics = /\p{Mn}/gu;
const notWord = /[^\p{L}\p{N}]+/gu;
const edgeDashes = /^-+|-+$/gu;

/**
 * A name as a model may make an id of it: "Handing a complete file to
 * mortgage advice" as "handing-a-complete-file-to-mortgage-advice", in
 * lower case, without accents.
 */
export const nameKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(diacritics, "")
    .toLowerCase()
    .replaceAll(notWord, "-")
    .replaceAll(edgeDashes, "");

/**
 * A step as the model sent it, checked: a sentence, a shape and a move
 * there are, and only notes of its shape's kinds that are in the brain,
 * each as the id `resolve` finds for it; otherwise a reason the model can
 * act on.
 */
export const checkThinkingStep = (
  input: unknown,
  resolve: (
    name: string,
    kinds: readonly ThinkingNoteKind[]
  ) => string | undefined
): { step: ThinkingStep } | { refused: string } => {
  const fields: Record<string, unknown> =
    typeof input === "object" && input !== null ? { ...input } : {};
  const { step, shape, move, notes } = fields;
  if (typeof step !== "string" || step.trim() === "") {
    return { refused: 'Say in "step" what you do now, in one short sentence.' };
  }
  if (step.trim().length > thinkingStepMost.text) {
    return {
      refused: `Keep "step" to one short sentence, at most ${thinkingStepMost.text} characters.`,
    };
  }
  const shaped = thinkingShapes.find((each) => each === shape);
  if (shaped === undefined) {
    return {
      refused: `There is no shape "${String(shape)}". Use one of: ${thinkingShapes.join(", ")}.`,
    };
  }
  const moves: readonly ThinkingMove[] = thinkingMoves[shaped];
  const moved = moves.find((each) => each === move);
  if (moved === undefined) {
    return {
      refused: `The shape "${shaped}" has no move "${String(move)}". Use one of: ${moves.join(", ")}.`,
    };
  }
  if (
    !Array.isArray(notes) ||
    notes.length === 0 ||
    notes.some((each) => typeof each !== "string")
  ) {
    return { refused: 'Name in "notes" what this step looks at.' };
  }
  const named = [...new Set(notes.map(String))].slice(
    0,
    thinkingStepMost.notes
  );
  const kinds = thinkingNoteKinds[shaped];
  const resolved = named.map((name) => ({ name, id: resolve(name, kinds) }));
  const unknown = resolved.filter(({ id }) => id === undefined);
  if (unknown.length > 0) {
    const what =
      shaped === "hours"
        ? "a workflow by its id or its name"
        : "a team by its id or its name, and what a team said by its statement id";
    return {
      refused: `Not in the brain as the person may read it: ${unknown.map(({ name }) => name).join(", ")}. Name ${what}.`,
    };
  }
  return {
    step: {
      text: step.trim(),
      notes: [...new Set(resolved.flatMap(({ id }) => id ?? []))],
      shape: shaped,
      move: moved,
    },
  };
};

const middle = (low: number, high: number): number => (low + high) / 2;

/**
 * A workflow's hours a week today, from the brain's own numbers: how often
 * the team does it, over everyone who said, by its newest drawing, times
 * how long one takes. Null while they are not known: it is not drawn yet,
 * nobody said how long one takes, or only how often each person does it,
 * which counts nothing for the team without how many do it.
 */
export const hoursPerWeek = (workflow: {
  drawings?: readonly Pick<WorkflowDrawing, "volumes" | "takes">[];
}): number | null => {
  const drawing = workflow.drawings?.at(-1);
  const volume = drawing?.volumes.find(({ of }) => of === "team");
  const takes = drawing?.takes;
  if (volume === undefined || takes === null || takes === undefined) {
    return null;
  }
  const perWeek =
    middle(volume.low, volume.high) /
    (volume.per === "month" ? WEEKS_PER_MONTH : 1);
  const hoursEach =
    middle(takes.quickest, takes.longest) / (takes.unit === "minutes" ? 60 : 1);
  return Math.round(perWeek * hoursEach * 10) / 10;
};
