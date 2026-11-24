import { describe, expect, it } from "vite-plus/test";

import { kernOf } from "./article-kern.ts";
import type { StatementRow } from "./article-kern.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";
import { placeOf } from "./transcript.ts";

// The prototype's tests of a note's kern, on the brain's test company: the
// same assertions, with its counts where the company differs.

describe(kernOf, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const rowsOf = (noteId: string): StatementRow[] =>
    (
      brain.notes.find((note) => note.id === noteId)?.statementIds ?? []
    ).flatMap((id) => {
      const statement = ws.statements.find((each) => each.id === id);
      const place = statement ? placeOf(statement, ws.sources) : undefined;
      return statement && place ? [{ statement, place }] : [];
    });

  it("counts the statements by kind, in the order kinds are counted elsewhere", () => {
    const kern = kernOf("team-finance", rowsOf("team-finance"));
    expect(kern.counts).toStrictEqual([
      { kind: "timeSink", count: 5 },
      { kind: "blocker", count: 1 },
      { kind: "wish", count: 2 },
      { kind: "goal", count: 1 },
    ]);
  });

  it("says when the team was last heard", () => {
    const kern = kernOf("team-finance", rowsOf("team-finance"));
    expect(kern.lastHeard).toBe("2026-09-20");
  });

  it("names everyone interviewed once, the stakeholder first, numbered where several share a role", () => {
    const people = kernOf("team-finance", rowsOf("team-finance")).interviewed;
    expect(people.map((person) => person.initials)).toStrictEqual([
      "C",
      "FA1",
      "FA2",
      "B1",
    ]);
    expect(people[0]).toMatchObject({
      label: "Controller",
      role: "Controller",
      stakeholder: true,
      how: "Live",
    });
    expect(people[1]).toMatchObject({
      label: "Finance assistant 1",
      role: "Finance assistant",
      stakeholder: false,
    });
  });

  it("names only the team’s own people, not those of other teams who name it", () => {
    const people = kernOf("team-mortgage", rowsOf("team-mortgage")).interviewed;
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({
      role: "Team lead mortgage advice",
      stakeholder: true,
    });
    expect(
      people.every(
        (person) =>
          ws.sources
            .find((source) => source.id === person.sourceId)
            ?.teamIds?.includes("team-mortgage") === true
      )
    ).toBeTruthy();
  });

  it("counts the rules a team works by as a kind of their own", () => {
    expect(
      kernOf("team-compliance", rowsOf("team-compliance")).counts.some(
        ({ kind }) => kind === "rule"
      )
    ).toBeTruthy();
  });
});
