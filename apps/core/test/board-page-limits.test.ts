import type { OperationResult } from "@grasp-os/shared/operations";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  boardPageOf,
  call,
  codeOf,
  estimated,
  idSchema,
  listed,
  longId,
  revisionOf,
  saveWorkflow,
  snapshotSchema,
  take,
  valueOf,
} from "./board-page.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring } from "./sign-in.ts";

// The board page, the built-in App (apps/core/blueprints/board-page/):
// it takes snapshots of the workflow map's numbers, in its own store, shows
// the newest, and saves its narrative and the decision it asks for,
// keeping what the snapshot froze. A snapshot freezes each workflow's
// hours as drawn, designed and as it runs, read from the map (an `app`
// resource an admin binds to a workflow map), and the improvement signals
// of the App workflows the map links to, read from the platform's
// statistics (bound to the permission an admin grants). These tests go in
// through the Apps' functions, as their screens call them, and start from
// the ways it can fail: a number that isn't what the map and the runs say
// (a run outside the window counted, the designed version taken for the
// drawn one); a later save, run or day of signals changing a snapshot
// taken before it; a save of the narrative changing what it froze; a
// signal's subject (a person) or another App's signals frozen; part of a
// snapshot frozen; and someone who isn't one of its builders taking or
// writing one, or a snapshot taken from a map nobody bound.

const idp = mockIdp();
const { setUp } = boardPageOf(idp);

describe("the board page", { timeout: 90_000 }, () => {
  it("freezes and shows workflows at their longest, a page at a time within what a query answers", async () => {
    const { admin, app, map } = await setUp({ bindStatistics: false });
    const team = idSchema.parse(
      valueOf(
        await call(admin, map, "teams.add", "mutation", {
          title: "€".repeat(200),
        })
      )
    );
    // Each written as the map's screen would: drawn, designed, linked.
    const worst = async (index: number): Promise<void> => {
      const fields = {
        title: `${index}`.padEnd(200, "€"),
        team,
        steps: [
          {
            name: "Do it",
            numbers: { frequency: estimated(10), minutes: estimated(6) },
          },
        ],
      };
      const id = await saveWorkflow(admin, map, {
        ...fields,
        state: "drawn",
      });
      await saveWorkflow(
        admin,
        map,
        { ...fields, state: "designed" },
        { id, revision: await revisionOf(admin, map, id) }
      );
      valueOf(
        await call(admin, map, "map.link", "mutation", {
          id,
          expectedRevision: await revisionOf(admin, map, id),
          app: { appId: longId(`app${index}-`), workflowId: longId("w-") },
        })
      );
    };
    for (let index = 0; index < 60; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time
      await worst(index);
    }
    const mapPage = await call(admin, map, "figures.list", "query", {
      pagination: { pageSize: 100 },
    });
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const snapshot = snapshotSchema.parse(
      valueOf(await call(admin, app, "snapshots.get", "query", { id: taken }))
    );
    const figuresPage = await call(admin, app, "snapshots.figures", "query", {
      take: snapshot.take,
      pagination: { pageSize: 100 },
    });
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the pages it counts
    const items = (result: OperationResult) =>
      z.object({ items: z.array(z.unknown()) }).parse(valueOf(result)).items
        .length;
    expect({
      mapPage: items(mapPage),
      figures: snapshot.figures,
      figuresPage: items(figuresPage),
    }).toStrictEqual({ mapPage: 50, figures: 60, figuresPage: 50 });
  });

  it("refuses a map of more workflows than a snapshot holds, reading no more of it than it takes to tell", async () => {
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
    let taken = "";
    const events = await auditedDuring(async () => {
      taken = codeOf(await take(admin, app));
    });
    expect({
      taken,
      // Six pages of 50 tell it has more than 250: the seventh isn't read.
      mapReads: events.filter(
        ({ action, target }) => action === "app.call" && target?.id === map
      ).length,
      listed: await listed(admin, app),
    }).toStrictEqual({
      taken: "board.too_many_workflows",
      mapReads: 6,
      listed: [],
    });
  });
});
