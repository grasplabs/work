import { defineSchema, defineTable, v } from "@grasp-os/sdk";

// The workflow map's store: its teams, its workflows as they run now
// (drawn) or as they should (designed), and every version of each, kept
// as each save and link commits it, so a designed workflow is set beside
// the version of it last drawn. Everyone who may open the App reads it;
// only its builders (an admin is one on every App) change it (app.ts).

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

/** A workflow as it is kept: what is edited, and what only the map sets. */
const workflowFields = {
  ...editedFields,
  // Its version: one more with each save and link.
  version: v.number().integer().min(1),
  // For a designed one, the version of it last drawn: set by `save` alone.
  drawnVersion: v.number().integer().min(1).nullable(),
  // Once built, the App workflow that runs it: set by `link` alone.
  app: appLink.nullable(),
};

export default defineSchema({
  teams: defineTable({
    title: v.string().trim().min(1).max(shortTextMax),
  }).index("by_title", ["title"]),
  workflows: defineTable(workflowFields)
    .index("by_title", ["title"])
    // An order no save changes: another App reads every workflow a page
    // at a time in it (operations/figures.ts), so none moves between pages.
    .index("by_created", ["_createdAt"]),
  workflowVersions: defineTable({
    ...workflowFields,
    workflow: v.id("workflows"),
  }).index("by_workflow", ["workflow", "version"]),
  // Holds nothing: only the App's builders may read it, which is how the
  // screen asks whether someone may change the map (operations/access.ts).
  builders: defineTable({ none: v.null() }),
});
