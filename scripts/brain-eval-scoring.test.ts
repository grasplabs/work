import { describe, expect, it } from "vite-plus/test";

import {
  comparable,
  compareRuns,
  estimate,
  questionResultSchema,
  report,
  signTest,
  summarize,
} from "./brain-eval-scoring.ts";
import type { QuestionResult } from "./brain-eval-scoring.ts";

/**
 * An answerable Dutch question over a Dutch source of one passage, found
 * at the ranks given (its source first returned there too).
 */
const result = (
  id: string,
  brainRank: number | null,
  grepRank: number | null = brainRank,
  overrides: Partial<QuestionResult> = {}
): QuestionResult => ({
  id,
  digest: `digest-${id}`,
  language: "nl",
  sourceLanguage: "nl",
  expects: "answer",
  way: "words",
  long: false,
  lookalike: false,
  brain: {
    rank: brainRank,
    sourceRank: brainRank,
    returned: 10,
    leaks: [],
    ms: 3,
  },
  grep: { rank: grepRank, sourceRank: grepRank, returned: 10 },
  ...overrides,
});

/**
 * An answerable question over a long document: the passage that answers
 * at `rank`, the first passage of its source at `sourceRank`, per arm.
 */
const overLong = (
  id: string,
  brain: { rank: number | null; sourceRank: number | null },
  grep: { rank: number | null; sourceRank: number | null },
  overrides: Partial<QuestionResult> = {}
): QuestionResult =>
  result(id, brain.rank, grep.rank, {
    long: true,
    brain: { ...brain, returned: 10, leaks: [], ms: 3 },
    grep: { ...grep, returned: 10 },
    ...overrides,
  });

const many = (count: number, rank: number | null, prefix = "q") =>
  Array.from({ length: count }, (_, index) =>
    result(`${prefix}${index}`, rank)
  );

const group = (results: readonly QuestionResult[], name: string) =>
  summarize(results).groups.find((each) => each.group === name);

const unchanged = { judged: true };

describe("the Brain evaluation's scoring", () => {
  it("gives the same interval for the same values, around their mean", () => {
    const values = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1];
    const first = estimate(values);
    expect(first).toStrictEqual(estimate(values));
    expect(first?.mean).toBeCloseTo(0.7);
    expect(first?.low).toBeLessThan(0.7);
    expect(first?.high).toBeGreaterThan(0.7);
    expect(estimate([])).toBeNull();
  });

  it("tests paired outcomes exactly, on the questions that changed", () => {
    expect(signTest(0, 4)).toStrictEqual({
      gained: 0,
      lost: 4,
      p: 0.125,
      verdict: "same",
    });
    expect(signTest(2, 0).p).toBe(0.5);
    expect(signTest(0, 6)).toMatchObject({ p: 0.03125, verdict: "worse" });
    expect(signTest(9, 1)).toMatchObject({ verdict: "better" });
    expect(signTest(0, 0)).toMatchObject({ p: 1, verdict: "same" });
  });

  it("counts a source as recalled only within the result budget, and ranks it by its reciprocal", () => {
    const scored = group(
      [
        result("first", 1),
        result("fifth", 5),
        result("sixth", 6),
        result("missed", null),
      ],
      "All answerable"
    );
    expect(scored?.brain.recall?.mean).toBe(0.5);
    expect(scored?.brain.mrr?.mean).toBeCloseTo((1 + 1 / 5 + 1 / 6) / 4);
  });

  it("reports a language on its own documents apart from questions across languages, and ways only within a language", () => {
    const results = [
      result("dutch", 1),
      result("dutch-on-german", null, null, { sourceLanguage: "de" }),
    ];
    expect(group(results, "Dutch (written in Dutch)")?.questions).toBe(1);
    expect(group(results, "Same language")?.questions).toBe(1);
    expect(group(results, "Across languages")?.questions).toBe(1);
    expect(group(results, "German")?.questions).toBe(0);
    expect(group(results, "Way: words")?.questions).toBe(1);
  });

  it("scores questions over long documents in their own groups and keeps them out of every other", () => {
    const results = [
      result("dutch", 1),
      overLong(
        "dutch-handbook",
        { rank: null, sourceRank: null },
        { rank: null, sourceRank: null }
      ),
      overLong(
        "dutch-on-english-minutes",
        { rank: 1, sourceRank: 1 },
        { rank: 1, sourceRank: 1 },
        { sourceLanguage: "en", way: "paraphrase" }
      ),
    ];
    for (const name of ["All answerable", "Same language", "Way: words"]) {
      expect(group(results, name)).toMatchObject({ questions: 1 });
      expect(group(results, name)?.brain.recall?.mean).toBe(1);
    }
    expect(group(results, "Dutch (written in Dutch)")?.questions).toBe(1);
    expect(group(results, "Across languages")?.questions).toBe(0);
    expect(group(results, "Way: paraphrase")?.questions).toBe(0);
    const long = group(results, "Long documents");
    expect(long?.questions).toBe(2);
    expect(long?.brain.recall?.mean).toBe(0.5);
  });

  it("scores answers with a look-alike passage in a group of their own among the long documents", () => {
    const results = [
      overLong("plain", { rank: 1, sourceRank: 1 }, { rank: 1, sourceRank: 1 }),
      overLong(
        "lookalike",
        { rank: null, sourceRank: 1 },
        { rank: 2, sourceRank: 1 },
        { lookalike: true }
      ),
      result("short-lookalike-free", 1),
    ];
    const lookalike = group(results, "Long documents: look-alike");
    expect(lookalike?.questions).toBe(1);
    expect(lookalike?.brain.recall?.mean).toBe(0);
    expect(lookalike?.grep.recall?.mean).toBe(1);
    expect(group(results, "Long documents")?.questions).toBe(2);
  });

  it("counts how often each arm returned the right source within the budget but not the passage that answers", () => {
    const results = [
      overLong(
        "other-passage",
        { rank: null, sourceRank: 2 },
        { rank: 1, sourceRank: 1 }
      ),
      overLong(
        "answer-below-budget",
        { rank: 7, sourceRank: 3 },
        { rank: null, sourceRank: null }
      ),
      overLong(
        "answer-first",
        { rank: 1, sourceRank: 1 },
        { rank: null, sourceRank: 4 }
      ),
      overLong(
        "source-below-budget",
        { rank: null, sourceRank: 6 },
        { rank: null, sourceRank: null }
      ),
    ];
    const long = group(results, "Long documents");
    expect(long?.brain.sourceNotPassage?.mean).toBe(0.5);
    expect(long?.grep.sourceNotPassage?.mean).toBe(0.25);
  });

  it("reads a result written before long documents as over a source of one passage", () => {
    const before = questionResultSchema.parse({
      id: "nl-verlof",
      digest: "abc",
      language: "nl",
      sourceLanguage: "nl",
      expects: "answer",
      way: "words",
      brain: { rank: 2, returned: 10, leaks: [], ms: 4 },
      grep: { rank: null, returned: 10 },
    });
    expect(before).toMatchObject({
      long: false,
      lookalike: false,
      brain: { rank: 2, sourceRank: null },
      grep: { rank: null, sourceRank: null },
    });
    expect(group([before], "All answerable")?.questions).toBe(1);
  });

  it("reports long documents in a table of their own, with how often only the source was returned", () => {
    const text = report(
      summarize([
        result("short", 1),
        overLong(
          "other-passage",
          { rank: null, sourceRank: 1 },
          { rank: 1, sourceRank: 1 }
        ),
      ]),
      null
    );
    const lines = text.split("\n");
    const [oneSourceHeader] = lines;
    expect(oneSourceHeader).not.toContain("source, not passage");
    expect(
      lines.some((line) => line.startsWith("All answerable "))
    ).toBeTruthy();
    const longHeader = lines.find((line) =>
      line.includes("Brain source, not passage")
    );
    expect(longHeader).toContain("grep source, not passage");
    const longRow = lines.find((line) => line.startsWith("Long documents "));
    expect(longRow).toMatch(/1\.00 ±0\.00\s+0\.00 ±0\.00\s*$/u);
  });

  it("judges the Brain against grep by the questions only one of them found", () => {
    const scored = group(
      [
        result("both", 1, 1),
        result("brain-only", 1, null),
        result("grep-only", 7, 2),
      ],
      "All answerable"
    );
    expect(scored?.brainOverGrep).toMatchObject({
      gained: 1,
      lost: 1,
      verdict: "same",
    });
  });

  it("keeps questions with no answer and hidden answers out of recall, and lists every leak", () => {
    const summary = summarize([
      result("answered", 1),
      result("nowhere", null, null, {
        expects: "absent",
        way: null,
        sourceLanguage: null,
        brain: { rank: null, sourceRank: null, returned: 0, leaks: [], ms: 1 },
      }),
      result("hidden", null, null, {
        expects: "hidden",
        way: null,
        brain: {
          rank: null,
          sourceRank: null,
          returned: 2,
          leaks: ["secret:3.980"],
          ms: 1,
        },
      }),
    ]);
    expect(summary.groups[0]?.questions).toBe(1);
    expect(summary.absent).toStrictEqual({
      questions: 1,
      brainEmpty: 1,
      grepEmpty: 0,
    });
    expect(summary.leaks).toStrictEqual([
      { id: "hidden", leaks: ["secret:3.980"] },
    ]);
  });

  it("calls a run worse than the last only when the loss is more than chance", () => {
    const before = many(13, 1);
    const fourLost = [...many(4, null), ...many(13, 1).slice(4)];
    expect(compareRuns(fourLost, before, unchanged)[0]).toMatchObject({
      gained: 0,
      lost: 4,
      verdict: "same",
    });
    expect(compareRuns(many(13, null), before, unchanged)[0]?.verdict).toBe(
      "worse"
    );
  });

  it("calls a run better than the last only when the gain is more than chance", () => {
    const before = many(30, null);
    const twoGained = [...many(2, 1), ...many(30, null).slice(2)];
    expect(compareRuns(twoGained, before, unchanged)[0]?.verdict).toBe("same");
    expect(compareRuns(many(30, 1), before, unchanged)[0]?.verdict).toBe(
      "better"
    );
  });

  it("pairs only questions that are unchanged since the last run", () => {
    const before = [result("same", null), result("changed", null)];
    const now = [
      result("same", 1),
      result("changed", 1, 1, { digest: "rewritten" }),
      result("new", 1),
    ];
    expect(compareRuns(now, before, unchanged)[0]?.paired).toBe(1);
  });

  it("shows changes without a verdict when the set changed between the runs", () => {
    const [all] = compareRuns(many(30, 1), many(30, null), {
      judged: false,
    });
    expect(all).toMatchObject({ gained: 30, lost: 0, judged: false });
  });

  it("compares runs only on the same set, cut the same way, result limit and result budget", () => {
    const measure = {
      setDigest: "set",
      passagesDigest: "cut",
      recallLimit: 10,
      resultBudget: 5,
    };
    expect(comparable(measure, { ...measure })).toBeTruthy();
    expect(comparable(measure, { ...measure, setDigest: "other" })).toBeFalsy();
    expect(
      comparable(measure, { ...measure, passagesDigest: "recut" })
    ).toBeFalsy();
    expect(comparable(measure, { ...measure, recallLimit: 20 })).toBeFalsy();
    expect(comparable(measure, { ...measure, resultBudget: 3 })).toBeFalsy();
  });

  it("never judges against a run that doesn't record how the set was cut", () => {
    const measure = { setDigest: "set", recallLimit: 10, resultBudget: 5 };
    expect(
      comparable(measure, { ...measure, passagesDigest: "cut" })
    ).toBeFalsy();
    expect(comparable(measure, { ...measure })).toBeFalsy();
  });
});
