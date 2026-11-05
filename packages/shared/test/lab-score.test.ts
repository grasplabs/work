/**
 * The Stephen Score (lab-score.ts): six parts out of 10, a weighted
 * average, and a goal that needs the average at its target, every part at
 * its floor and every limit held, so one good number never hides a bad
 * one. And when a change may be kept: the score up by more than the noise,
 * no part down by more than its own.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  firstGoal,
  keepsChange,
  scoreParts,
  standingOf,
} from "../src/lab-score.ts";
import type { ScoredRun } from "../src/lab-score.ts";

/** Runs of every bench, every part and limit measured, each part at `share` unless set. */
const runsAt = (
  share: number,
  set: Partial<Record<string, number>> = {}
): ScoredRun[] => [
  {
    bench: "whole",
    means: {
      heard: set.heard ?? share,
      handled: set.handled ?? share,
      contradictions: set.contradictions ?? share,
      taken: set.taken ?? 0,
      agreed: set.agreed ?? 1,
    },
  },
  {
    bench: "ask",
    means: { right: set.right ?? share, mistakes: set.mistakes ?? 0 },
  },
  {
    bench: "draw",
    means: {
      found: set.found ?? share,
      order: set.order ?? share,
      numbers: set.numbers ?? share,
    },
  },
  {
    bench: "notes",
    means: {
      written: set.written ?? share,
      supported: set.supported ?? share,
      notSaid: set.notSaid ?? 0,
    },
  },
];

describe("the Stephen Score", () => {
  it("has six parts whose weights add up to one", () => {
    expect(scoreParts.map((part) => part.label)).toStrictEqual([
      "Heard",
      "Hard turns",
      "Next question",
      "Workflow drawing",
      "Notes",
      "Contradictions",
    ]);
    expect(
      Math.round(scoreParts.reduce((sum, part) => sum + part.weight, 0) * 1000)
    ).toBe(1000);
  });

  it("is the weighted average of the parts out of 10, each part the mean of its numbers", () => {
    const standing = standingOf(runsAt(0.9, { numbers: 0.6 }));
    const drawing = standing.parts.find((part) => part.id === "drawing");

    // Found, order and numbers: (0.9 + 0.9 + 0.6) / 3 = 0.8.
    expect(drawing?.value).toBe(8);
    // 0.85 × 9 + 0.15 × 8 = 8.85.
    expect(standing.score).toBe(8.9);
    expect(standing.lowest?.label).toBe("Workflow drawing");
  });

  it("reaches the goal only with the average at its target and every part at its floor", () => {
    const allNine = standingOf(runsAt(0.92));
    // The average is still above 9, but one part is under the floor.
    const oneLow = standingOf(runsAt(0.95, { contradictions: 0.8 }));

    expect(allNine.reached).toBeTruthy();
    expect(oneLow.score).toBeGreaterThanOrEqual(firstGoal.target);
    expect(oneLow.lowest?.label).toBe("Contradictions");
    expect(oneLow.reached).toBeFalsy();
  });

  it("holds the floor that is asked for: 9.5 with none under 9.3", () => {
    const goal = { target: 9.5, floor: 9.3 };

    expect(standingOf(runsAt(0.96), goal).reached).toBeTruthy();
    expect(
      standingOf(runsAt(0.97, { handled: 0.92 }), goal).reached
    ).toBeFalsy();
  });

  it("doesn't reach the goal while a limit is broken, however high the score", () => {
    const standing = standingOf(runsAt(0.97, { mistakes: 0.05, agreed: 0.6 }));

    expect(
      standing.limits.filter((limit) => !limit.holds).map((limit) => limit.id)
    ).toStrictEqual(["ruleBroken", "stayed"]);
    expect(standing.reached).toBeFalsy();
  });

  it("has no score while a part was never measured, and says which", () => {
    const standing = standingOf(
      runsAt(0.95).filter((run) => run.bench !== "draw")
    );

    expect(standing.score).toBeNull();
    expect(standing.missing).toStrictEqual(["Workflow drawing"]);
    expect(standing.reached).toBeFalsy();
  });

  it("averages several runs of a bench before it holds them to the floor", () => {
    const [whole, ...rest] = runsAt(0.95);
    const standing = standingOf([
      ...rest,
      { bench: "whole", means: { ...whole?.means, heard: 0.8 } },
      { bench: "whole", means: { ...whole?.means, heard: 1 } },
    ]);
    const heard = standing.parts.find((part) => part.id === "heard");

    expect(heard).toMatchObject({ value: 9, runs: 2 });
  });
});

describe("whether a change may be kept", () => {
  const noise = { score: 0.1 };

  it("keeps a change that raised the score by more than the noise and lowered nothing", () => {
    expect(
      keepsChange(
        standingOf(runsAt(0.85)),
        standingOf(runsAt(0.85, { heard: 0.95 })),
        noise
      )
    ).toStrictEqual({ keep: true, why: "The score rose by 0.3." });
  });

  it("undoes a change that bought one part with another, even when the score rose", () => {
    const decision = keepsChange(
      standingOf(runsAt(0.85)),
      standingOf(runsAt(0.85, { right: 1, contradictions: 0.7 })),
      noise
    );

    expect(decision.keep).toBeFalsy();
    expect(decision.why).toContain("Contradictions");
  });

  it("undoes a change within the noise, or one that broke a limit", () => {
    expect(
      keepsChange(
        standingOf(runsAt(0.85)),
        standingOf(runsAt(0.85, { heard: 0.87 })),
        noise
      ).keep
    ).toBeFalsy();
    expect(
      keepsChange(
        standingOf(runsAt(0.85)),
        standingOf(runsAt(0.85, { heard: 0.99, taken: 0.2 })),
        noise
      ).keep
    ).toBeFalsy();
  });

  it("on the hidden set, keeps a change that held without rising, and undoes one that fell", () => {
    const before = standingOf(runsAt(0.9));

    expect(
      keepsChange(before, standingOf(runsAt(0.9)), noise, { mustRise: false })
        .keep
    ).toBeTruthy();
    expect(
      keepsChange(before, standingOf(runsAt(0.85)), noise, { mustRise: false })
        .keep
    ).toBeFalsy();
  });
});
