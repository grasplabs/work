import { describe, expect, it } from "vite-plus/test";

import {
  comparable,
  compareRuns,
  estimate,
  signTest,
  summarize,
} from "./brain-eval-scoring.ts";
import type { QuestionResult } from "./brain-eval-scoring.ts";

/** An answerable Dutch question over a Dutch source, found at the ranks given. */
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
  brain: { rank: brainRank, returned: 10, leaks: [], ms: 3 },
  grep: { rank: grepRank, returned: 10 },
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
        brain: { rank: null, returned: 0, leaks: [], ms: 1 },
      }),
      result("hidden", null, null, {
        expects: "hidden",
        way: null,
        brain: { rank: null, returned: 2, leaks: ["secret:3.980"], ms: 1 },
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

  it("compares runs only on the same set, result limit and result budget", () => {
    const measure = { setDigest: "set", recallLimit: 10, resultBudget: 5 };
    expect(comparable(measure, { ...measure })).toBeTruthy();
    expect(comparable(measure, { ...measure, setDigest: "other" })).toBeFalsy();
    expect(comparable(measure, { ...measure, recallLimit: 20 })).toBeFalsy();
    expect(comparable(measure, { ...measure, resultBudget: 3 })).toBeFalsy();
  });
});
