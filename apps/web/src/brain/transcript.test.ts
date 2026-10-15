import { describe, expect, it } from "vite-plus/test";

import { testWorkspace } from "./test-workspace.ts";
import {
  chapterOfTurns,
  highlightsOf,
  placeLabel,
  placeOf,
  position,
  searchHits,
  turnParts,
  voices,
} from "./transcript.ts";
import type { Statement, Transcript } from "./workspace.ts";

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

  it("puts each turn in the chapter whose minute it falls after", () => {
    expect(position("12:26")).toBe(746);
    expect(position("37")).toBe(37);
    expect(chapterOfTurns(transcript)).toStrictEqual([0, 0, 1, 1]);
  });

  it("finds every place a search matches, ignoring case, and nothing for one letter", () => {
    expect(searchHits(transcript.turns, "documents")).toStrictEqual([
      { turn: 1, start: 19 },
      { turn: 2, start: 6 },
    ]);
    expect(searchHits(transcript.turns, "d")).toStrictEqual([]);
  });

  it("splits a turn at its highlight and at a search hit inside it", () => {
    const highlights = highlightsOf({ id: "src-a", transcript }, [
      statement("a", "Checking documents takes all week"),
    ]);
    const parts = turnParts(
      transcript.turns[1]?.text ?? "",
      highlights,
      [{ start: 19, index: 0 }],
      "documents".length
    );
    expect(
      parts.map((part) => [
        part.text,
        part.statement?.id ?? null,
        part.hit ?? null,
      ])
    ).toStrictEqual([
      ["Honestly? ", null, null],
      ["Checking ", "a", null],
      ["documents", "a", 0],
      [" takes all week", "a", null],
      [". And chasing.", null, null],
    ]);
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

  it("keeps a recorded conversation whole: every turn in order, no silent minutes, up to the end of the recording", () => {
    const minutesSaid = /(?<minutes>\d+) minutes/u;
    const flaws = testWorkspace().sources.flatMap((source) => {
      if (!source.transcript || source.transcript.unit !== undefined) {
        return [];
      }
      const minutes = Number(
        minutesSaid.exec(source.how ?? "")?.groups?.minutes
      );
      const at = source.transcript.turns.map((each) => position(each.at));
      const gaps = at
        .slice(1)
        .map((second, index) => second - (at[index] ?? 0));
      const chapters = source.transcript.chapters.map((chapter) =>
        position(chapter.at)
      );
      return [
        gaps.some((gap) => gap <= 0) && "a turn out of order",
        // Spoken, a pause of more than a minute and a half means a stretch was left out. Typed, answers take longer.
        Math.max(...gaps) > (minutes ? 90 : 180) && "a silent stretch",
        Boolean(minutes) &&
          (at.at(-1) ?? 0) < (minutes - 3) * 60 &&
          "it stops before the recording ends",
        chapters.some(
          (chapter, index) => index > 0 && chapter < (chapters[index - 1] ?? 0)
        ) && "chapters out of order",
      ]
        .filter(Boolean)
        .map((flaw) => `${source.id}: ${String(flaw)}`);
    });
    expect(flaws).toStrictEqual([]);
  });

  it("gives each person in a conversation a place by when they first speak, leaving Grasp out", () => {
    const vision = testWorkspace().sources.find(
      (source) => source.id === "src-vision"
    )?.transcript;
    expect(voices(vision?.turns ?? [])).toStrictEqual(["CEO", "COO", "CFO"]);
  });
});
