import { v } from "@grasp-os/runtime";

// The workflow map's store: its teams, its workflows as they run now
// (drawn) or as they should (designed), and every version of each, kept
// as each save and link commits it, so a designed workflow is set beside
// the version of it last drawn. Everyone who may open the App reads it;
// only its builders (an admin is one on every App) change it (its tables' access).

/** Largest number a step has: times a week, minutes or people. */
export const stepNumberMax = 10_000;

/** Most hours a week a workflow may be expected to save. */
export const gainMaxHoursPerWeek = 100_000;

/** Most steps one workflow has. */
export const stepsMax = 100;

/** Most parameters one workflow has. */
export const parametersMax = 50;

/** Longest a name, a role or a tool is, in characters. */
export const shortTextMax = 200;

/** Longest a parameter's value is, in characters. */
export const parameterValueMax = 1000;

/** Longest a workflow's notes are, in characters. */
export const notesMax = 30_000;

export const workflowStates = ["drawn", "designed"] as const;

export const stepKinds = [
  "automated",
  "ai_checked",
  "tool",
  "instruction",
] as const;

const stepNumber = v
  .object({
    value: v.number().min(0).max(stepNumberMax),
    basis: v.enum(["estimated", "observed"]),
  })
  .optional();

export const stepFields = v.object({
  name: v.string().trim().min(1).max(shortTextMax),
  who: v.string().trim().min(1).max(shortTextMax).optional(),
  tool: v.string().trim().min(1).max(shortTextMax).optional(),
  // Whether the work passes to someone else after this step.
  handover: v.boolean().default(false),
  // How a designed step is done.
  kind: v.enum(stepKinds).optional(),
  numbers: v
    .object({
      // Times a week, minutes each time, people each time.
      frequency: stepNumber,
      minutes: stepNumber,
      people: stepNumber,
    })
    .optional(),
});

export const parameterFields = v.object({
  name: v.string().trim().min(1).max(shortTextMax),
  value: v.string().trim().max(parameterValueMax).optional(),
});

/** The App workflow that runs a designed workflow, by IDs. */
export const appLink = v.object({
  appId: v.string().min(1).max(256),
  workflowId: v.string().min(1).max(256),
});

/** What a person edits of a workflow: everything a save takes. */
export const editedFields = {
  title: v.string().trim().min(1).max(shortTextMax),
  state: v.enum(workflowStates),
  team: v.id("teams").nullable(),
  steps: v.array(stepFields).max(stepsMax),
  parameters: v.array(parameterFields).max(parametersMax),
  // What it is expected to save, for a designed one.
  gain: v
    .object({ hoursPerWeek: v.number().min(0).max(gainMaxHoursPerWeek) })
    .nullable(),
  notes: v.string().max(notesMax),
};

// What the board page keeps (server/schema.ts, generated from the App's
// definition): the snapshots it took, each a dated freeze of
// the workflow map's numbers and the improvement signals of the App
// workflows the map links to, with the maturity then, the decision it
// asks for and its narrative. A snapshot's figures are its own rows
// (`figures`), one per workflow, written before the snapshot itself, so
// a snapshot is listed only once all of them are. Everyone who may open
// the App reads it; only its builders (an admin is one on every App)
// take snapshots and write their narratives.

/** Most workflows one snapshot holds. */
export const figuresMax = 250;

/** Most improvement signals one snapshot holds. */
export const signalsMax = 50;

/** Longest a title or a team is, in characters. */
export const titleMax = 200;

/** Longest the decision a snapshot asks for is, in characters. */
export const decisionMax = 1000;

/** Longest a snapshot's narrative is, in characters. */
export const narrativeMax = 30_000;

/** Most hours a week a snapshot holds for one workflow. */
export const hoursMax = 100_000;

/** The highest maturity level. */
export const maturityMax = 5;

/** A version of a workflow, and the hours a week its steps take. */
const versionHours = v.object({
  version: v.number().integer().min(1),
  hoursPerWeek: v.number().min(0).max(hoursMax),
  basis: v.enum(["estimated", "observed"]),
});

/** What a snapshot froze of one workflow of the map. */
export const figureFields = {
  // The snapshot it belongs to, by the ID its take gave it.
  take: v.string().min(1).max(64),
  // Its place among the snapshot's figures.
  at: v.number().integer().min(0),
  // The workflow, by its ID in the map.
  workflow: v.string().min(1).max(256),
  title: v.string().max(titleMax),
  team: v.string().max(titleMax).nullable(),
  state: v.enum(["drawn", "designed"]),
  drawn: versionHours.nullable(),
  designed: versionHours.nullable(),
  // Whether the runs of the App workflow it links to couldn't be read:
  // unknown, never none.
  unavailable: v.boolean(),
  // Its designed steps at the runs a week observed.
  running: v
    .object({
      appId: v.string().min(1).max(256),
      workflowId: v.string().min(1).max(256),
      runs: v.number().integer().min(1),
      hoursPerWeek: v.number().min(0).max(hoursMax),
    })
    .nullable(),
};

/** An improvement signal of a linked App workflow, by the map's workflow. */
export const signalFields = v.object({
  workflow: v.string().min(1).max(256),
  kind: v.string().min(1).max(64),
  value: v.number().min(0),
});
