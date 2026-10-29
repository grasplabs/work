import { describe, expect, it } from "vite-plus/test";

import {
  compareRecallArms,
  lagSummary,
  recallAdoption,
  recallBudgets,
  recallTopK,
  scoreRecall,
  summarizeRecallArm,
} from "./brain-recall-scoring.ts";
import type { RecallObservation, RecallScore } from "./brain-recall-scoring.ts";
import type { BrainRecallCase } from "./fixtures/brain-recall-cases.ts";

// Experiment E02's scoring and decision, as pure logic: where an arm ranks
// a case's evidence, what blocks it, and when a policy may replace
// full-text search. The harness that observes recalls is tested in workerd
// (brain-recall-e02.test.ts).

const lease: BrainRecallCase = {
  id: "lease",
  kind: "exact",
  language: "en",
  persona: "ana",
  window: "t0",
  question: "Who owns CR-1?",
  keywords: "CR-1",
  marker: "Owner: Marta Ruiz",
  forbidden: ["Owner: Tomas Okafor"],
};

const notAllowed: BrainRecallCase = {
  id: "budget",
  kind: "unauthorized",
  language: "nl",
  persona: "ana",
  window: "t0",
  question: "Hoe groot is het budget?",
  keywords: "budget",
  forbidden: ["CANARY-FIN"],
};

const observed = (
  changes: Partial<RecallObservation> & { texts: readonly string[] }
): RecallObservation => ({
  caseId: "lease",
  arm: "hybrid:keywords",
  repeat: 0,
  phase: "cold",
  cited: true,
  latencyMs: 100,
  costMicros: 0,
  degraded: false,
  ...changes,
});

const filler = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `Unrelated section ${index}.`);

/** A cold score of `caseId` under `arm` with reciprocal rank `rr`. */
const ranked = (
  arm: string,
  caseId: string,
  reciprocalRank: number,
  changes: Partial<RecallScore> = {}
): RecallScore => ({
  caseId,
  arm,
  repeat: 0,
  phase: "cold",
  kind: "keyword",
  language: "en",
  rank: reciprocalRank === 0 ? null : 1 / reciprocalRank,
  reciprocalRank,
  hit: reciprocalRank >= 1 / recallTopK,
  cited: true,
  leaks: [],
  latencyMs: 100,
  costMicros: 0,
  degraded: false,
  ...changes,
});

describe("a scored recall", () => {
  it("is ranked by the first result quoting its evidence, and missed below the top K", () => {
    const second = scoreRecall(
      lease,
      observed({ texts: ["Contract register.", "Owner: Marta Ruiz."] })
    );
    const deep = scoreRecall(
      lease,
      observed({ texts: [...filler(recallTopK), "Owner: Marta Ruiz."] })
    );
    const absent = scoreRecall(lease, observed({ texts: filler(3) }));

    expect(
      [second, deep, absent].map(({ rank, reciprocalRank, hit }) => ({
        rank,
        reciprocalRank,
        hit,
      }))
    ).toStrictEqual([
      { rank: 2, reciprocalRank: 0.5, hit: true },
      {
        rank: recallTopK + 1,
        reciprocalRank: 1 / (recallTopK + 1),
        hit: false,
      },
      { rank: null, reciprocalRank: 0, hit: false },
    ]);
  });

  it("leaks whatever forbidden text any result quotes, an outdated version as much as an unreadable one", () => {
    const stale = scoreRecall(
      lease,
      observed({ texts: ["Owner: Marta Ruiz.", "Owner: Tomas Okafor."] })
    );
    const unreadable = scoreRecall(
      notAllowed,
      observed({ caseId: "budget", texts: ["Reference: CANARY-FIN."] })
    );

    expect({
      stale: [stale.rank, stale.leaks],
      unreadable: [unreadable.reciprocalRank, unreadable.hit, unreadable.leaks],
    }).toStrictEqual({
      stale: [1, ["Owner: Tomas Okafor"]],
      unreadable: [null, null, ["CANARY-FIN"]],
    });
  });
});

describe("an arm's summary", () => {
  it("counts quality over cold recalls only, and a warm one that ranked otherwise as unstable", () => {
    const summary = summarizeRecallArm("hybrid:keywords", [
      ranked("hybrid:keywords", "a", 1),
      ranked("hybrid:keywords", "a", 0.5, { phase: "warm", rank: 2 }),
      ranked("hybrid:keywords", "b", 0, { language: "nl", latencyMs: 900 }),
      ranked("hybrid:keywords", "b", 0, { phase: "warm", latencyMs: 20 }),
    ]);

    expect({
      mrr: summary.mrr,
      hitRate: summary.hitRate,
      byLanguage: summary.byLanguage,
      unstable: summary.unstable,
      latencyMs: summary.latencyMs,
    }).toStrictEqual({
      mrr: 0.5,
      hitRate: 0.5,
      byLanguage: {
        en: { mrr: 1, hitRate: 1 },
        nl: { mrr: 0, hitRate: 0 },
      },
      unstable: 1,
      latencyMs: { coldP95: 900, warmP95: 100 },
    });
  });
});

describe("a comparison with full-text search", () => {
  const cases = ["a", "b", "c", "d", "e", "f"];

  it("pairs by case, averaging repeats, and is better only when the interval clears 0 by the gain", () => {
    const candidate = cases.flatMap((caseId) => [
      ranked("hybrid:keywords", caseId, 1),
      ranked("hybrid:keywords", caseId, 1, { repeat: 1 }),
    ]);
    const baseline = cases.map((caseId) =>
      ranked("fullText:keywords", caseId, caseId < "d" ? 0 : 1)
    );
    const tie = cases.map((caseId) => ranked("hybrid:keywords", caseId, 1));

    const {
      cases: paired,
      meanDifference,
      decision,
    } = compareRecallArms(
      { arm: "hybrid:keywords", scores: candidate },
      { arm: "fullText:keywords", scores: baseline },
      0.05
    );

    expect({
      better: { paired, meanDifference, decision },
      same: compareRecallArms(
        { arm: "hybrid:keywords", scores: tie },
        { arm: "hybrid:keywords", scores: tie },
        0.05
      ).decision,
    }).toStrictEqual({
      better: { paired: 6, meanDifference: 0.5, decision: "better" },
      same: "equivalent",
    });
  });

  it("is blocked when either arm leaked, whatever its quality", () => {
    const candidate = cases.map((caseId) =>
      ranked("hybrid:keywords", caseId, 1, {
        leaks: caseId === "a" ? ["CANARY-FIN"] : [],
      })
    );
    const baseline = cases.map((caseId) =>
      ranked("fullText:keywords", caseId, 0)
    );

    expect(
      compareRecallArms(
        { arm: "hybrid:keywords", scores: candidate },
        { arm: "fullText:keywords", scores: baseline },
        0.05
      ).decision
    ).toBe("blocked");
  });
});

const summaryOf = (scores: RecallScore[]) =>
  summarizeRecallArm("hybridRerank:keywords", scores);

describe("adopting a policy", () => {
  const better = compareRecallArms(
    {
      arm: "hybridRerank:keywords",
      scores: ["a", "b", "c", "d"].map((caseId) =>
        ranked("hybridRerank:keywords", caseId, 1)
      ),
    },
    {
      arm: "fullText:keywords",
      scores: ["a", "b", "c", "d"].map((caseId) =>
        ranked("fullText:keywords", caseId, 0)
      ),
    },
    0.05
  );
  const within = summaryOf([ranked("hybridRerank:keywords", "a", 1)]);
  const costly = summaryOf([
    ranked("hybridRerank:keywords", "a", 1, {
      costMicros: recallBudgets.costMicrosPerRecall + 1,
      latencyMs: recallBudgets.coldP95Ms + 1,
    }),
  ]);

  it("waits for a real model's run however good a stub made it look", () => {
    expect(recallAdoption(within, better, { measured: false })).toStrictEqual({
      arm: "hybridRerank:keywords",
      decision: "needs-real-model",
      reasons: [],
    });
  });

  it("adopts a better policy within its budgets, and keeps full-text search for one past them", () => {
    expect([
      recallAdoption(within, better, { measured: true }),
      recallAdoption(costly, better, { measured: true }),
    ]).toStrictEqual([
      { arm: "hybridRerank:keywords", decision: "adopt", reasons: [] },
      {
        arm: "hybridRerank:keywords",
        decision: "keep-baseline",
        reasons: ["latency.cold-p95", "cost.per-recall"],
      },
    ]);
  });
});

describe("update lag", () => {
  it("counts the arms that caught up, those that never did, and the slowest that did", () => {
    expect([
      lagSummary([
        { caseId: "a", arm: "x", firstAskedAfterMs: 5, lagMs: 0 },
        { caseId: "b", arm: "x", firstAskedAfterMs: 9, lagMs: 300 },
        { caseId: "c", arm: "x", firstAskedAfterMs: 2, lagMs: null },
      ]),
      lagSummary([]),
    ]).toStrictEqual([
      { caughtUp: 2, never: 1, worstMs: 300 },
      { caughtUp: 0, never: 0, worstMs: null },
    ]);
  });
});
