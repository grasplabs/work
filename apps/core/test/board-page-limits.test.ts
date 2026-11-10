import { describe, expect, it } from "vite-plus/test";

import {
  boardPageOf,
  codeOf,
  listed,
  saveWorkflow,
  take,
} from "./board-page.ts";
import { mockIdp } from "./idp.ts";

// The board page of the built-in workflow map
// (apps/core/blueprints/workflow-map/): it takes snapshots of the map's
// numbers, in the App's own store, shows the newest, and saves its
// narrative and the decision it asks for, keeping what the snapshot froze.
// A snapshot freezes each workflow's hours as drawn, designed and as it
// runs, read from the map's own `figures.list`, and the improvement
// signals of the App workflows the map links to, read from the platform's
// statistics (bound to the permission an admin grants). These tests go in
// through the App's functions, as its pages call them, and start from the
// ways it can fail: a number that isn't what the map and the runs say (a
// run outside the window counted, the designed version taken for the
// drawn one); a later save, run or day of signals changing a snapshot
// taken before it; a save of the narrative changing what it froze; a
// signal's subject (a person) or another App's signals frozen; part of a
// snapshot frozen; and someone who isn't one of its builders taking or
// writing one.

const idp = mockIdp();

const { setUp } = boardPageOf(idp);

describe("the board page", { timeout: 90_000 }, () => {
  it("refuses a map of more workflows than a snapshot holds", async () => {
    const { admin, app, map } = await setUp({ bindStatistics: false });
    const add = async (index: number): Promise<void> => {
      await saveWorkflow(admin, map, {
        title: `Workflow ${index}`,
        state: "drawn",
        steps: [],
      });
    };
    for (let index = 0; index < 301; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time
      await add(index);
    }
    expect({
      taken: codeOf(await take(admin, app)),
      listed: await listed(admin, app),
    }).toStrictEqual({
      taken: "board.too_many_workflows",
      listed: [],
    });
  });
});
