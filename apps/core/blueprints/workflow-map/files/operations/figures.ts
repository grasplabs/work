import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";

import { query } from "#grasp/server";
import type { Doc, QueryCtx } from "#grasp/server";

import { appLink, shortTextMax, workflowStates } from "../schema.ts";
import { teamsMax } from "./teams.ts";

// The map's numbers, for another App to read (the board page, through an
// `app` resource an admin binds to this App): each workflow's hours a
// week as it runs now or as designed, and, for a designed one, as the
// version of it last drawn ran; with the minutes one pass through its
// steps takes, which its runs a week turn into hours as it runs. Worked
// out here, where the steps are, so a reader is sent numbers, not steps,
// and a page of them stays small. It reads as whoever calls, under the
// map's own roles: everyone the map is shared with.

/**
 * Most workflows one page holds, whatever the page asks for. A figure at
 * its longest is about 2.2 KB of JSON: a title and a team's of 200
 * characters, 3 bytes each at most (text.ts refuses what JSON writes
 * longer), two IDs of 256 ASCII characters, and its numbers. 50 of them
 * are about 110 KB, well within the 256 KiB a query answers.
 */
const pageMax = 50;

const minutesPerHour = 60;

/** Most hours a week a workflow's figures hold. */
const hoursMax = 100_000;

type Basis = "estimated" | "observed";

/** A workflow's hours a week, whether its numbers were observed, and a pass's minutes. */
const hours = v.object({
  version: v.number().integer().min(1),
  hoursPerWeek: v.number().min(0).max(hoursMax),
  basis: v.enum(["estimated", "observed"]),
  minutesPerPass: v.number().min(0),
});

/** What a page holds of a workflow. */
export const figure = v.object({
  id: v.string(),
  title: v.string().max(shortTextMax),
  team: v.string().max(shortTextMax).nullable(),
  state: v.enum(workflowStates),
  current: hours,
  drawn: hours.nullable(),
  app: appLink.nullable(),
});

/** Hours to a tenth, and no more than the figures hold. */
const tenths = (value: number): number =>
  Math.min(Math.round(value * 10) / 10, hoursMax);

/** The hours of `steps` at `version`, as `hours` holds them. */
const hoursOf = (version: number, steps: Doc<"workflows">["steps"]) => {
  let minutes = 0;
  let minutesPerPass = 0;
  for (const { numbers } of steps) {
    const each = (numbers?.minutes?.value ?? 0) * (numbers?.people?.value ?? 1);
    minutesPerPass += each;
    minutes += (numbers?.frequency?.value ?? 0) * each;
  }
  const all = steps.flatMap(({ numbers }) =>
    [numbers?.frequency, numbers?.minutes, numbers?.people].filter(
      (number) => number !== undefined
    )
  );
  const basis: Basis =
    all.length > 0 && all.every((number) => number.basis === "observed")
      ? "observed"
      : "estimated";
  return {
    version,
    hoursPerWeek: tenths(minutes / minutesPerHour),
    basis,
    minutesPerPass,
  };
};

/** The version of a designed workflow last drawn, as it was saved. */
const drawnOf = async (ctx: QueryCtx, workflow: Doc<"workflows">) => {
  if (workflow.state !== "designed" || workflow.drawnVersion === null) {
    return null;
  }
  const [found] = await ctx.db
    .query("workflowVersions")
    .withIndex("by_workflow", (range) =>
      range
        .eq("workflow", workflow._id)
        .eq("version", workflow.drawnVersion ?? 0)
    )
    .take(1);
  return found === undefined || found.state !== "drawn"
    ? null
    : hoursOf(found.version, found.steps);
};

/** What a page holds of `workflow`: its team's title, and its hours. */
const figureOf = async (
  ctx: QueryCtx,
  teams: ReadonlyMap<string, string>,
  workflow: Doc<"workflows">
) => ({
  id: workflow._id,
  title: workflow.title,
  team: workflow.team === null ? null : (teams.get(workflow.team) ?? null),
  state: workflow.state,
  current: hoursOf(workflow.version, workflow.steps),
  drawn: await drawnOf(ctx, workflow),
  app: workflow.app,
});

/** Every workflow's figures, a page at a time, by title. */
export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(figure),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workflows")
      .withIndex("by_title")
      .paginate({
        cursor: args.pagination.cursor,
        pageSize: Math.min(args.pagination.pageSize, pageMax),
      });
    // Every team in one read, and a page's drawn versions one read each:
    // within the reads one call may make (a page, the teams, and 50).
    const listedTeams = await ctx.db.query("teams").take(teamsMax);
    const teams = new Map<string, string>(
      listedTeams.map(({ _id, title }) => [_id, title])
    );
    const items = [];
    for (const workflow of page.items) {
      // oxlint-disable-next-line no-await-in-loop -- a page's reads, one after another
      items.push(await figureOf(ctx, teams, workflow));
    }
    return { ...page, items };
  },
});
