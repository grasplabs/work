import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";

// What the board page reads of the workflow map: the map's `figures.list`
// (blueprints/workflow-map/files/server/figures.ts), exactly as the
// map declares it, so an admin binds the page's `map` resource only to an
// App that serves it.

/** A workflow's hours a week, whether its numbers were observed, and a pass's minutes. */
const hours = v.object({
  version: v.number().integer().min(1),
  hoursPerWeek: v.number().min(0).max(100_000),
  basis: v.enum(["estimated", "observed"]),
  minutesPerPass: v.number().min(0),
});

/** What a page of the map's figures holds of a workflow. */
export const mapFigure = v.object({
  id: v.string(),
  title: v.string().max(200),
  team: v.string().max(200).nullable(),
  state: v.enum(["drawn", "designed"]),
  current: hours,
  drawn: hours.nullable(),
  app: v
    .object({
      appId: v.string().min(1).max(256),
      workflowId: v.string().min(1).max(256),
    })
    .nullable(),
});

/** The map's `figures.list`, as the page calls it. */
export const mapFigures = {
  kind: "query",
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(mapFigure),
} as const;

// What the board page's store holds (server/schema.ts, generated from its
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
