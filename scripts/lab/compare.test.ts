/**
 * How two runs compare (compare.ts): the noise is what runs of the same
 * Stephen differ by, measured, never assumed; a change counts only when it
 * is larger than that. Pure logic, tested on its own.
 */
import { describe, expect, it } from "vite-plus/test";

import { compare, meansOf, noiseOf } from "./compare.ts";
import type { CaseScore } from "./results.ts";

const run = (
  scores: Record<string, Record<string, number>>
): { cases: CaseScore[] } => ({
  cases: Object.entries(scores).map(([id, numbers]) => ({
    id,
    scores: numbers,
  })),
});

const first = run({
  one: { written: 0.9, repeats: 0.2, notes: 30 },
  two: { written: 0.7, repeats: 0.1, notes: 20 },
});
const again = run({
  one: { written: 0.94, repeats: 0.2, notes: 31 },
  two: { written: 0.7, repeats: 0.12, notes: 20 },
});
const changed = run({
  one: { written: 1, repeats: 0.05, notes: 24 },
  two: { written: 0.9, repeats: 0.05, notes: 18 },
});

describe("what two runs differ by", () => {
  it("takes the mean of every number over the cases that have it", () => {
    const means = meansOf([
      ...first.cases,
      { id: "three", scores: { right: 1 } },
    ]);
    expect({
      written: means.written?.toFixed(2),
      right: means.right,
    }).toStrictEqual({ written: "0.80", right: 1 });
  });

  it("measures the noise from runs of the same Stephen, and has none from one run", () => {
    const noise = noiseOf([first, again]);
    expect({
      alone: noiseOf([first]),
      written: noise?.written?.toFixed(3),
      repeats: noise?.repeats?.toFixed(3),
    }).toStrictEqual({ alone: null, written: "0.020", repeats: "0.010" });
  });

  it("counts a change only when it is larger than the noise, knows that fewer repeats is better, and judges no count", () => {
    const noise = noiseOf([first, again]);
    const found = compare(first, changed, noise);
    const of = (metric: string) => found.find((each) => each.metric === metric);
    expect({
      written: of("written"),
      repeats: of("repeats")?.verdict,
      notes: of("notes")?.verdict,
      sameStephen: compare(first, again, noise).find(
        (each) => each.metric === "written"
      )?.verdict,
    }).toStrictEqual({
      written: {
        metric: "written",
        cases: 2,
        before: 0.8,
        after: 0.95,
        change: 0.15000000000000002,
        up: 2,
        down: 0,
        noise: 0.019999999999999962,
        verdict: "better",
      },
      repeats: "better",
      notes: "not judged",
      sameStephen: "no difference",
    });
  });

  it("gives no verdict while the noise is not measured, and compares only the cases both runs have", () => {
    expect(compare(first, run({ one: { written: 1 } }), null)).toStrictEqual([
      {
        metric: "written",
        cases: 1,
        before: 0.9,
        after: 1,
        change: 0.09999999999999998,
        up: 1,
        down: 0,
        noise: null,
        verdict: "noise not measured",
      },
    ]);
  });
});
