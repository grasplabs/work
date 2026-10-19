import type { Id } from "@grasp-os/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  draftChanged,
  draftProblem,
  draftOf,
  toSave,
} from "../blueprints/workflow-map/files/components/record.ts";
import { recordOf } from "../blueprints/workflow-map/files/components/store.ts";
import type { Workflow } from "../blueprints/workflow-map/files/components/store.ts";
import { expectedGain } from "../blueprints/workflow-map/files/components/totals.ts";
import type {
  Step,
  WorkflowRecord,
} from "../blueprints/workflow-map/files/components/totals.ts";

// What the workflow map's editor saves from what it holds: pure logic, so
// tested on its own. What can go wrong: a field cleared in the editor
// survives from the stored workflow; a designed workflow's gain is lost
// when no drawn version is beside it; a drawn one keeps a gain; the link
// to an App workflow is sent (the store keeps it, and refuses a save that
// sends it); and the editor thinks nothing changed when it did, or that
// something did when only the order of its fields did.

const estimated = (value: number) => ({ value, basis: "estimated" as const });

const drawnSteps: Step[] = [
  {
    name: "Match",
    handover: true,
    numbers: {
      frequency: estimated(30),
      minutes: estimated(10),
      people: estimated(2),
    },
  },
];

const designedSteps: Step[] = [
  {
    name: "Match",
    handover: false,
    kind: "automated",
    numbers: { frequency: estimated(30), minutes: estimated(1) },
  },
];

/** A test's ID of `Table`: the editor never looks inside one. */
const idOf = <Table extends string>(id: string): Id<Table> =>
  // SAFETY: a test's ID; nothing here reads what, if anything, it names.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  id as Id<Table>;

const finance = idOf<"teams">("team-finance");

/** A designed workflow as the map reads it: linked, in a team, with a gain. */
const stored: WorkflowRecord = {
  type: "workflow",
  title: "Pay",
  state: "designed",
  team: finance,
  steps: designedSteps,
  parameters: [],
  gain: { hoursPerWeek: 7 },
  app: { appId: "app-1", workflowId: "pay" },
};

const workflow: Workflow = {
  id: idOf<"workflows">("workflow-1"),
  revision: 3,
  version: 3,
  record: stored,
  body: "Pay what we owe.",
};

describe("what the workflow map saves", () => {
  it("takes what the map edits from the editor alone, so clearing the team clears it, and sends no link", () => {
    const draft = { ...draftOf(recordOf(workflow)), team: null };
    const saved = toSave(stored, draft, workflow.body, "designed");
    expect({
      team: saved.team,
      app: "app" in saved,
      notes: saved.notes,
    }).toStrictEqual({ team: null, app: false, notes: "Pay what we owe." });
  });

  it("works out a designed workflow's gain from the drawn steps, keeps it without them, and drops it for a drawn one", () => {
    const draft = draftOf(recordOf(workflow));
    expect({
      beside: toSave(stored, draft, "", "designed", drawnSteps).gain,
      alone: toSave(stored, draft, "", "designed").gain,
      drawn: toSave(stored, draft, "", "drawn").gain,
    }).toStrictEqual({
      beside: { hoursPerWeek: 9.5 },
      alone: { hoursPerWeek: 7 },
      drawn: null,
    });
  });

  it("sees any change to the draft or the description as unsaved, and a number set again in another order as none", () => {
    const draft = draftOf(recordOf(workflow));
    // The step's numbers as the editor leaves them after minutes were
    // cleared and typed again: the same, in another order.
    const [step] = designedSteps;
    const retyped = step?.numbers?.minutes;
    const reordered =
      step === undefined || retyped === undefined
        ? draft
        : {
            ...draft,
            steps: [
              {
                ...step,
                numbers: {
                  minutes: retyped,
                  frequency: step.numbers?.frequency ?? retyped,
                },
              },
            ],
          };
    expect({
      same: draftChanged(draft, workflow.body, workflow),
      reordered: draftChanged(reordered, workflow.body, workflow),
      title: draftChanged(
        { ...draft, title: "Pay all" },
        workflow.body,
        workflow
      ),
      body: draftChanged(draft, "Pay it all.", workflow),
      fresh: draftChanged(draftOf(), ""),
      typed: draftChanged({ ...draftOf(), title: "New" }, ""),
    }).toStrictEqual({
      same: false,
      reordered: false,
      title: true,
      body: true,
      fresh: false,
      typed: true,
    });
  });

  it("says why a draft can't be saved, the gain its numbers make above the map's limit included, rather than letting the save fail", () => {
    const draft = draftOf(recordOf(workflow));
    // Each number within its own limit, and still a gain of 200,000 hours
    // a week: more than the map's 100,000.
    const big: Step[] = [
      {
        name: "Match",
        handover: false,
        numbers: {
          frequency: estimated(10_000),
          minutes: estimated(600),
          people: estimated(2),
        },
      },
    ];
    const none: Step[] = [{ name: "Match", handover: false }];
    const bigGain = expectedGain(big, none);
    expect({
      fine: draftProblem(draft, 9.5),
      noTitle: draftProblem({ ...draft, title: " " }),
      unnamed: draftProblem({
        ...draft,
        steps: [{ name: "", handover: false }],
      }),
      tooMany: draftProblem({
        ...draft,
        steps: [
          {
            name: "Match",
            handover: false,
            numbers: { minutes: estimated(10_001) },
          },
        ],
      }),
      bigGain,
      tooMuchGain: draftProblem({ ...draft, steps: none }, bigGain),
      atTheLimit: draftProblem({ ...draft, steps: none }, 100_000),
    }).toStrictEqual({
      fine: undefined,
      noTitle: "Give the workflow a title.",
      unnamed: "Give each step a name.",
      tooMany: "Each number is between 0 and 10,000.",
      bigGain: 200_000,
      tooMuchGain:
        "The expected gain is over 100,000 hours a week, more than the map takes: check the numbers.",
      atTheLimit: undefined,
    });
  });
});
