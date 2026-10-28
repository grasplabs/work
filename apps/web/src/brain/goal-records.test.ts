import type { Goal } from "@grasp-os/shared/brain";
import { brainRecordsSchema } from "@grasp-os/shared/brain-records";
import { describe, expect, it } from "vite-plus/test";

import {
  newGoalRecords,
  relinkedRecords,
  rewordedRecords,
} from "./goal-records.ts";

// The records an admin's change to the board's goals sends core
// (goal-records.ts): each takes the day's own source with it, and core's
// own schema for `brain.addRecords` takes every one.

const day = "2026-10-27";

const goal: Goal = {
  id: "goal-close",
  versions: [
    {
      title: "Close the books in three days",
      howWeNotice: "",
      sourceId: "src-board",
      date: "2026-10-01",
    },
  ],
  workflows: [
    { app: "invoices", workflow: "chase" },
    { app: "invoices", workflow: "remind" },
  ],
};

describe("an admin's change to the board's goals", () => {
  it("sets a goal and words one again under the day's source, trimmed, as core takes them", () => {
    const set = newGoalRecords(
      { title: "  Answer within a day ", howWeNotice: " Nobody waits. " },
      day,
      "goal-answer"
    );
    const reworded = rewordedRecords(
      goal.id,
      { title: "Close the books in two days", howWeNotice: "" },
      day
    );
    expect({
      valid: [set, reworded].map(
        (records) => brainRecordsSchema.safeParse(records).success
      ),
      set: set.map((record) => [record.type, record.id]),
      wording: set[1],
      // The same source each change of the day: core keeps it once.
      sameSource: JSON.stringify(set[0]) === JSON.stringify(reworded[0]),
      reworded: reworded[1]?.type,
    }).toStrictEqual({
      valid: [true, true],
      set: [
        ["source", `src-goals-${day}`],
        ["goal", "goal-answer"],
      ],
      wording: {
        type: "goal",
        id: "goal-answer",
        title: "Answer within a day",
        howWeNotice: "Nobody waits.",
        sourceId: `src-goals-${day}`,
        date: day,
      },
      sameSource: true,
      reworded: "goalVersion",
    });
  });

  it("links what was chosen anew and takes off what no longer is, and sends nothing when nothing changed", () => {
    const records = relinkedRecords(
      goal,
      [
        { app: "invoices", workflow: "chase" },
        { app: "ledger", workflow: "book" },
      ],
      day
    );
    expect({
      valid: brainRecordsSchema.safeParse(records).success,
      links: records.map((record) =>
        record.type === "goalLink"
          ? [record.app, record.workflow, record.linked]
          : record.type
      ),
      unchanged: relinkedRecords(goal, goal.workflows, day),
    }).toStrictEqual({
      valid: true,
      links: [
        ["ledger", "book", true],
        ["invoices", "remind", false],
      ],
      unchanged: [],
    });
  });
});
