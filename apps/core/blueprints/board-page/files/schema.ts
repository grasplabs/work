import { defineSchema, defineTable, v } from "@grasp-os/sdk";

// The board page's store: the snapshots it took, each a dated freeze of
// the workflow map's numbers and the improvement signals of the App
// workflows the map links to, with the maturity then, the decision it
// asks for and its narrative. A snapshot's figures are its own rows
// (`figures`), one per workflow, written before the snapshot itself, so
// a snapshot is listed only once all of them are. Everyone who may open
// the App reads it; only its builders (an admin is one on every App)
// take snapshots and write their narratives (app.ts).

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

export default defineSchema({
  snapshots: defineTable({
    take: v.string().min(1).max(64),
    title: v.string().max(titleMax),
    date: v.string().min(10).max(10),
    maturity: v.number().integer().min(0).max(maturityMax),
    windowDays: v.number().integer().min(1).max(366),
    // How many figures it holds: each written before it was.
    figures: v.number().integer().min(0).max(figuresMax),
    signals: v.array(signalFields).max(signalsMax),
    decisionNeeded: v.string().trim().max(decisionMax),
    narrative: v.string().max(narrativeMax),
  }).index("by_created", ["_createdAt"]),
  figures: defineTable(figureFields).index("by_take", ["take", "at"]),
  // Holds nothing: only the App's builders may read it, which is how the
  // page asks whether someone may take a snapshot (operations/access.ts).
  builders: defineTable({ none: v.null() }),
});
