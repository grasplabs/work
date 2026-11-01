/**
 * `compare` (round.ts) on two runs of the next-question bench: the noise
 * is what runs of the first one's Stephen differ by, so two runs of the
 * same text are called noise, never better or worse.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Result } from "./results.ts";
import { comparison } from "./round.ts";

const run = (id: string, talks: string, right: number[]): Result => ({
  id,
  at: "2026-10-23T09:00:00.000Z",
  label: id,
  bench: "ask",
  set: "open",
  stephen: {
    interviewer: "stephen",
    own: "o",
    lead: "l",
    talks,
    draws: "d",
    commit: "",
  },
  via: { quick: "q", careful: "c" },
  cases: right.map((value, at) => ({
    id: `m${at}`,
    scores: { right: value, single: 1 },
  })),
  spent: "",
});

describe("comparing two runs", () => {
  it("calls what two runs of the same text differ by noise", () => {
    const first = run("1-base", "same", [1, 1, 0, 1, 0, 1, 1, 1]);
    const again = run("2-base", "same", [1, 0, 1, 1, 1, 1, 0, 1]);
    const lines = comparison([first, again], first, again)
      .join("\n")
      .split("\n");
    expect({
      right: lines.some(
        (line) => line.startsWith("right") && line.endsWith("no difference")
      ),
      sameStephen: lines.includes(
        "Both runs are of the same Stephen: what they differ by is the noise itself."
      ),
    }).toStrictEqual({ right: true, sameStephen: true });
  });

  it("gives no verdict while there is one run of the first Stephen, and says how to measure the noise", () => {
    const first = run("1-base", "before", [1, 0]);
    const after = run("2-change", "after", [1, 1]);
    const lines = comparison([first, after], first, after)
      .join("\n")
      .split("\n");
    expect({
      unjudged: lines
        .filter((line) => line.endsWith("noise not measured"))
        .map((line) => line.split(" ")[0]),
      told: lines.includes(
        "Noise is not measured: run the same bench twice on Stephen before first."
      ),
    }).toStrictEqual({ unjudged: ["right", "single"], told: true });
  });
});
