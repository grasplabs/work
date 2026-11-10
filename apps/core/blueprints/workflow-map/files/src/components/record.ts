// What the editor holds of a workflow, and what it saves from it.

import type { Id } from "@grasp-os/sdk";

import { recordOf } from "./store";
import type { Workflow } from "./store";
import { expectedGain, gainMaxHoursPerWeek, stepNumberMax } from "./totals";
import type { Parameter, Step, WorkflowRecord } from "./totals";

/** What the editor holds of a workflow. */
export interface Draft {
  title: string;
  team: Id<"teams"> | null;
  steps: Step[];
  parameters: Parameter[];
}

/** The draft of a stored workflow, or of a new one. */
export const draftOf = (stored?: WorkflowRecord): Draft => ({
  title: stored?.title ?? "",
  team: stored?.team ?? null,
  steps: stored?.steps ?? [],
  parameters: stored?.parameters ?? [],
});

/** `value` as JSON with each object's keys in order, so key order doesn't count. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) =>
    typeof part === "object" && part !== null && !Array.isArray(part)
      ? Object.fromEntries(
          Object.entries(part).toSorted(([a], [b]) => (a < b ? -1 : 1))
        )
      : part
  );

/**
 * Whether `draft` and `body` differ from what `current` holds (from a new
 * workflow's empty draft, when there is none), whatever order its fields
 * were set in.
 */
export const draftChanged = (
  draft: Draft,
  body: string,
  current?: Workflow
): boolean =>
  canonical(draft) !==
    canonical(draftOf(current === undefined ? undefined : recordOf(current))) ||
  body !== (current?.body ?? "");

/** A step as the store takes it: empty text left out. */
const cleanStep = (step: Step, designed: boolean): Step => {
  const who = step.who?.trim() ?? "";
  const tool = step.tool?.trim() ?? "";
  return {
    name: step.name.trim(),
    ...(who === "" ? {} : { who }),
    ...(tool === "" ? {} : { tool }),
    handover: step.handover,
    ...(designed && step.kind !== undefined ? { kind: step.kind } : {}),
    ...(step.numbers === undefined ? {} : { numbers: step.numbers }),
  };
};

/**
 * Why `draft` can't be saved as it is, for the person editing it, or
 * undefined when it can: every step named, every number in range, and a
 * designed workflow's gain (`gain`, as it would be saved) within the
 * store's limit. The inputs' own limits (lengths, how many steps and
 * parameters) the editor's fields keep.
 */
export const draftProblem = (
  draft: Draft,
  gain?: number
): string | undefined => {
  if (draft.title.trim() === "") {
    return "Give the workflow a title.";
  }
  if (draft.steps.some(({ name }) => name.trim() === "")) {
    return "Give each step a name.";
  }
  const outOfRange = draft.steps.some((step) =>
    Object.values(step.numbers ?? {}).some(
      (number) =>
        number !== undefined &&
        (number.value < 0 || number.value > stepNumberMax)
    )
  );
  if (outOfRange) {
    return `Each number is between 0 and ${stepNumberMax.toLocaleString("en")}.`;
  }
  if (gain !== undefined && gain > gainMaxHoursPerWeek) {
    return `The expected gain is over ${gainMaxHoursPerWeek.toLocaleString("en")} hours a week, more than the map takes: check the numbers.`;
  }
  return undefined;
};

/** Parameters as the store takes them: named ones, empty values left out. */
const cleanParameters = (parameters: Parameter[]): Parameter[] =>
  parameters
    .map(({ name, value }) => ({
      name: name.trim(),
      ...(value === undefined || value.trim() === ""
        ? {}
        : { value: value.trim() }),
    }))
    .filter(({ name }) => name !== "");

/** What a save sends of a workflow: everything it edits. */
export interface Saved {
  title: string;
  state: WorkflowRecord["state"];
  team: Id<"teams"> | null;
  steps: Step[];
  parameters: Parameter[];
  gain: { hoursPerWeek: number } | null;
  notes: string;
}

/**
 * What to save from `draft` and `body`, in `state`. What the map edits
 * comes from the draft alone, so clearing a field (no team) clears it; a
 * workflow's link to an App workflow and the version of it last drawn are
 * the store's to keep. A designed workflow's gain is worked out against
 * `baseline`, the drawn steps it was designed from; without one (no drawn
 * version found), it keeps the gain `stored` has. A drawn one has none.
 */
export const toSave = (
  stored: WorkflowRecord | undefined,
  draft: Draft,
  body: string,
  state: WorkflowRecord["state"],
  baseline?: Step[]
): Saved => {
  const designed = state === "designed";
  const keptGain = designed ? (stored?.gain ?? null) : null;
  return {
    title: draft.title.trim(),
    state,
    team: draft.team,
    steps: draft.steps.map((step) => cleanStep(step, designed)),
    parameters: cleanParameters(draft.parameters),
    gain:
      designed && baseline !== undefined
        ? { hoursPerWeek: expectedGain(baseline, draft.steps) }
        : keptGain,
    notes: body,
  };
};
