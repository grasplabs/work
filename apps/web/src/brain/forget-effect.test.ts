import { describe, expect, it } from "vite-plus/test";

import { buildBrain } from "./brain.ts";
import { forgetEffect, withoutPreviewed } from "./forget-effect.ts";
import { testWorkspace } from "./test-workspace.ts";

// What taking something out of the brain takes with it, as the question
// says it before the yes: core's preview, and the notes the brain, built
// again without what goes, no longer has.

describe(forgetEffect, () => {
  const workspace = testWorkspace();
  const brain = buildBrain(workspace);

  it("names the notes that rest only on a source, never the source itself", () => {
    const target = { source: "src-compliance" };
    const preview = {
      source: "src-compliance",
      statements: ["st-allowed", "st-complaints"],
      workflows: [],
    };

    expect(forgetEffect(workspace, brain, target, preview)).toStrictEqual({
      statements: 2,
      notes: [],
      workflows: [],
    });
  });

  it("names the workflows whose numbers lose their source", () => {
    const preview = {
      source: "src-service",
      statements: [],
      workflows: ["email-triage"],
    };

    expect(
      forgetEffect(workspace, brain, { source: "src-service" }, preview)
        .workflows
    ).toStrictEqual(["Email triage"]);
  });
});

describe(withoutPreviewed, () => {
  it("leaves what followed a statement up standing on its own, and the source as removed", () => {
    const base = testWorkspace();
    const workspace = {
      ...base,
      statements: [
        ...base.statements,
        {
          id: "st-complaints-again",
          kind: "timeSink" as const,
          text: "Complaints still go into the spreadsheet",
          sourceId: "src-procedure",
          teamIds: ["team-compliance"],
          toolIds: [],
          followsUp: "st-complaints",
        },
      ],
    };
    const after = withoutPreviewed(workspace, {
      source: "src-compliance",
      statements: ["st-allowed", "st-complaints"],
      workflows: [],
    });

    expect({
      left: after.statements.some(
        ({ sourceId }) => sourceId === "src-compliance"
      ),
      followsUp: after.statements.find(({ id }) => id === "st-complaints-again")
        ?.followsUp,
      title: buildBrain(after).notes.find(({ id }) => id === "src-compliance")
        ?.title,
    }).toStrictEqual({
      left: false,
      followsUp: undefined,
      title: "Removed from the brain",
    });
  });
});
