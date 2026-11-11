import { describe, expect, it } from "vite-plus/test";

import { compareRuns, estimate, summarize } from "./brain-eval-scoring.ts";
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
  grep: { rank: grepRank, returned: 10, leaks: [] },
  ...overrides,
});

const many = (count: number, rank: number | null, prefix = "q") =>
  Array.from({ length: count }, (_, index) =>
    result(`${prefix}${index}`, rank)
  );

const group = (results: readonly QuestionResult[], name: string) =>
  summarize(results).groups.find((each) => each.group === name);

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

  it("reports a language on its own documents apart from questions across languages", () => {
    const results = [
      result("dutch", 1),
      result("dutch-on-german", null, null, { sourceLanguage: "de" }),
    ];
    expect(group(results, "Dutch (written in Dutch)")?.questions).toBe(1);
    expect(group(results, "Across languages")?.questions).toBe(1);
    expect(group(results, "German")?.questions).toBe(0);
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

  it("calls a run better or worse than the last only beyond the margin", () => {
    const before = [...many(30, null), ...many(30, 1, "kept")];
    expect(
      compareRuns([...many(30, 1), ...many(30, 1, "kept")], before)[0]?.verdict
    ).toBe("better");
    expect(
      compareRuns([...many(30, null), ...many(30, null, "kept")], before)[0]
        ?.verdict
    ).toBe("worse");
    const oneMore = [
      result("q0", 1),
      ...many(30, null).slice(1),
      ...many(30, 1, "kept"),
    ];
    expect(compareRuns(oneMore, before)[0]?.verdict).toBe("same");
  });

  it("pairs only questions that are unchanged since the last run", () => {
    const before = [result("same", null), result("changed", null)];
    const now = [
      result("same", 1),
      result("changed", 1, 1, { digest: "rewritten" }),
      result("new", 1),
    ];
    expect(compareRuns(now, before)[0]?.paired).toBe(1);
  });
});
