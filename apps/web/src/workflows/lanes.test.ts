import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { TodayRun, WorkflowsToday } from "@grasp-os/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import {
  handovers,
  hoursOf,
  journeyOf,
  laneDay,
  laterDay,
  listedRuns,
  placeOf,
  waiting,
} from "./lanes.ts";

// Today's lanes, as the page draws them from what core served: a lane a
// workflow, its runs in time with what each came to, an item followed
// across lanes by its lineage, and the hours of the day marked.

const hour = 3_600_000;
// Friday 16 October 2026, 15:00 in Amsterdam.
const now = Date.parse("2026-10-16T13:00:00Z");
const from = now - 8 * hour;

const run = (
  id: string,
  at: number,
  more: Partial<TodayRun> = {}
): TodayRun => ({
  id,
  startedAt: new Date(at).toISOString(),
  endedAt: new Date(at + 1000).toISOString(),
  status: "completed",
  went: "alone",
  waits: null,
  waitsOnOthers: false,
  from: null,
  ...more,
});

const dayOf = (
  lanes: { id: string; runs: TodayRun[] }[],
  unseen = 0
): WorkflowsToday => ({
  from: new Date(from).toISOString(),
  now: new Date(now).toISOString(),
  timeZone: "Europe/Amsterdam",
  lanes: lanes.map(({ id, runs }) => ({
    kind: "independent" as const,
    id,
    name: id.toUpperCase(),
    runs,
  })),
  cutOff: 0,
  unseen,
});

describe(laneDay, () => {
  it("lays each workflow's runs on its lane in time, with what each came to", () => {
    const day = laneDay(
      dayOf([
        {
          id: "a",
          runs: [
            run("2", now - hour, { went: "people" }),
            run("1", now - 3 * hour),
            run("3", now - 30 * 60_000, {
              endedAt: null,
              status: "running",
              waits: {
                decision: "d",
                on: { kind: "role", role: "admin" },
                since: new Date(now - 20 * 60_000).toISOString(),
                asks: "Book it?",
              },
            }),
          ],
        },
        {
          id: "b",
          runs: [
            run("4", now - 10 * 60_000, {
              endedAt: null,
              status: "running",
              waitsOnOthers: true,
            }),
          ],
        },
      ])
    );
    expect(
      day.lanes.map((lane) => [
        lane.name,
        lane.running,
        lane.runs.map(({ id, state }) => `${id} ${state}`),
      ])
    ).toStrictEqual([
      ["A", true, ["1 done", "2 toPerson", "3 waits"]],
      ["B", true, ["4 waitsElsewhere"]],
    ]);
    expect(
      waiting(day).map(({ id, at, waitsSince }) => ({ id, at, waitsSince }))
    ).toStrictEqual([
      // Its wait from when it began asking, not from when the run started.
      { id: "3", at: now - 30 * 60_000, waitsSince: now - 20 * 60_000 },
    ]);
  });

  it("says a run that ended without its result failed or was cancelled, alone or with people", () => {
    const day = laneDay(
      dayOf([
        {
          id: "a",
          runs: [
            run("1", now - 3 * hour, { status: "failed" }),
            run("2", now - 2 * hour, { status: "cancelled", went: "people" }),
            run("3", now - hour, { status: "completed" }),
          ],
        },
      ])
    );
    expect(
      day.lanes.flatMap(({ runs }) =>
        runs.map(({ id, state, run: { went } }) => `${id} ${state} ${went}`)
      )
    ).toStrictEqual(["1 failed alone", "2 cancelled people", "3 done alone"]);
  });

  it("draws the day core served last, whether the page's read or a refresh", () => {
    const earlier = dayOf([{ id: "a", runs: [run("1", now - hour)] }]);
    const later = {
      ...dayOf([{ id: "a", runs: [run("1", now - hour), run("2", now)] }]),
      now: new Date(now + 30_000).toISOString(),
    };
    expect({
      none: laterDay(earlier),
      refreshed: laterDay(earlier, later),
      stale: laterDay(later, earlier),
    }).toStrictEqual({ none: earlier, refreshed: later, stale: later });
  });

  it("keeps every run waiting on the reader on a narrow lane, however many came after it", () => {
    const asks = run("w", now - 5 * hour, {
      endedAt: null,
      status: "running",
      waits: {
        decision: "d",
        on: { kind: "you" },
        since: new Date(now - 5 * hour).toISOString(),
        asks: "Book it?",
      },
    });
    const later = Array.from({ length: 13 }, (_, index) =>
      run(`r${index}`, now - 4 * hour + index * 60_000)
    );
    const [lane] = laneDay(dayOf([{ id: "a", runs: [asks, ...later] }])).lanes;
    if (lane === undefined) {
      throw new Error("No lane.");
    }
    expect(listedRuns(lane, 12).map(({ id }) => id)).toStrictEqual([
      "w",
      ...later.slice(-12).map(({ id }) => id),
    ]);
  });

  it("names an App's lane by its App and workflow", () => {
    const day = laneDay({
      ...dayOf([]),
      lanes: [
        {
          kind: "app",
          app: appIdSchema.parse("app-1"),
          appName: "Invoices",
          workflow: workflowIdSchema.parse("approve"),
          runs: [run("1", now - hour)],
        },
      ],
    });
    expect(day.lanes.map(({ name }) => name)).toStrictEqual([
      "Invoices · approve",
    ]);
  });

  it("follows one item across the lanes, and draws a line where it was passed on", () => {
    const day = laneDay(
      dayOf([
        {
          id: "a",
          runs: [run("1", now - 3 * hour), run("3", now - hour)],
        },
        {
          id: "b",
          runs: [
            run("2", now - 2 * hour, { from: "1" }),
            // From a run the reader doesn't see: an item of its own.
            run("4", now - 20 * 60_000, { from: "elsewhere" }),
          ],
        },
      ])
    );
    expect(journeyOf(day, "1").map(({ id }) => id)).toStrictEqual(["1", "2"]);
    expect(journeyOf(day, "4").map(({ id }) => id)).toStrictEqual(["4"]);
    expect(
      handovers(day).map(({ from: one, to }) => [one.id, to.id])
    ).toStrictEqual([["1", "2"]]);
  });
});

describe("the day's time", () => {
  it("places a moment on the day, from its start to now", () => {
    const day = { from, now };
    expect(placeOf(now - 4 * hour, day)).toBeCloseTo(0.5);
    expect(placeOf(now + hour, day)).toBe(1);
    expect(placeOf(from - hour, day)).toBe(0);
  });

  it("marks whole hours, no more than asked", () => {
    const day = { from, now };
    // Nine whole hours from its start to now.
    expect(hoursOf(day, 10)).toHaveLength(9);
    expect(hoursOf(day).length).toBeLessThanOrEqual(8);
    expect(hoursOf(day, 3)).toHaveLength(3);
  });
});
