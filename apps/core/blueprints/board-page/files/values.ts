import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";

// What the board page reads of the workflow map: the map's `figures.list`
// (blueprints/workflow-map/files/operations/figures.ts), exactly as the
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
