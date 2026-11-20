import type { Statement, Transcript } from "@grasp-os/shared/brain";
import { describe, expect, it } from "vite-plus/test";

import { testWorkspace } from "./test-workspace.ts";
import { highlightsOf, placeLabel, placeOf } from "./transcript.ts";

// The prototype's tests of statements as highlights in their
// transcripts, on the brain's test company where they read its records.

const statement = (
  id: string,
  text: string,
  sourceId = "src-a"
): Statement => ({
  id,
  kind: "timeSink",
  text,
  sourceId,
  teamIds: [],
  toolIds: [],
});

const transcript: Transcript = {
  chapters: [
    { title: "Start", at: "00:00" },
    { title: "Documents", at: "05:00" },
  ],
  turns: [
    { at: "00:10", speaker: "Consultant", text: "What takes the most time?" },
    {
      at: "00:20",
      speaker: "Head",
      text: "Honestly? Checking documents takes all week. And chasing.",
    },
    { at: "05:00", speaker: "Consultant", text: "Which documents?" },
    { at: "05:30", speaker: "Head", text: "IDs, mostly." },
  ],
};

const statementIn = (id: string): Statement => {
  const found = testWorkspace().statements.find((each) => each.id === id);
  if (!found) {
    throw new Error(`No statement ${id}`);
  }
  return found;
};

describe("transcripts", () => {
  it("finds every statement from a transcribed conversation in its transcript, word for word", () => {
    const ws = testWorkspace();
    for (const source of ws.sources.filter(
      (candidate) => candidate.transcript
    )) {
      const said = ws.statements.filter(
        (candidate) => candidate.sourceId === source.id
      );
      expect(
        highlightsOf(source, said)
          .map((highlight) => highlight.statement.id)
          .toSorted()
      ).toStrictEqual(said.map((candidate) => candidate.id).toSorted());
    }
  });

  it("finds a statement ignoring case, where it starts mid-sentence, and leaves out what is not there", () => {
    const found = highlightsOf({ id: "src-a", transcript }, [
      statement("a", "Checking documents takes all week"),
      statement("b", "Never said"),
      statement("c", "x", "src-b"),
    ]);
    expect(found).toStrictEqual([
      {
        statement: statement("a", "Checking documents takes all week"),
        turn: 1,
        start: 10,
        end: 43,
      },
    ]);
  });

  it("places every statement in the brain in the words of its source, so none is left as a loose note", () => {
    const ws = testWorkspace();
    const unplaced = ws.statements
      .filter((each) => placeOf(each, ws.sources)?.at === undefined)
      .map((each) => each.id);
    expect(unplaced).toStrictEqual([]);
  });

  it("writes a place in the transcript’s own unit: a minute or a passage", () => {
    expect(placeLabel({}, "12:26")).toBe("12:26");
    expect(placeLabel({ unit: "passage" }, "3")).toBe("§ 3");
    const { sources } = testWorkspace();
    expect(placeOf(statementIn("st-allowed"), sources)?.at).toBe("01:51");
    expect(placeOf(statementIn("st-procedure"), sources)?.at).toBe("§ 2");
  });

  it("places a statement at its minute, with the turn before and after it", () => {
    const { sources } = testWorkspace();
    const place = placeOf(statementIn("st-check"), sources);
    const turns =
      sources.find((source) => source.id === "src-onboarding")?.transcript
        ?.turns ?? [];
    const own = turns.findIndex((turn) =>
      turn.text.toLowerCase().includes("checking id and income documents")
    );
    expect(place?.source.id).toBe("src-onboarding");
    expect(place?.at).toBe(turns[own]?.at);
    expect(place?.context).toStrictEqual(turns.slice(own - 1, own + 2));
    expect(place?.own).toBe(1);
  });
});
