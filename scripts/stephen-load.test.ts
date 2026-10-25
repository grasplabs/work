import { describe, expect, it } from "vite-plus/test";

import { judged, markOf, summaryOf } from "./stephen-load.ts";
import type { Turn } from "./stephen-load.ts";

// GRA-732's staging run fails when an answer reaches the wrong person, one
// is lost, or the p90 goes past the bar. These read what it decides from:
// each answer's mark, and the turns it saw.

/** A turn of `email`, ended `end`, its answer after `answerMs`. */
const turn = (end: Turn["end"], answerMs: number | null): Turn => ({
  email: "load-1@acme.test",
  mark: markOf(1, "abc"),
  end,
  firstMs: answerMs === null ? null : answerMs / 2,
  answerMs,
  cost: 0.001,
  ...(end === "refused" ? { reason: "Your daily limit is reached." } : {}),
});

describe("Stephen's load run", () => {
  it("tells an answer to its own question from one that reached the wrong person", () => {
    const mine = markOf(1, "abc");
    expect({
      own: judged(mine, `Here it is: ${mine}`),
      theirs: judged(mine, `Here it is: ${markOf(2, "abc")}`),
      both: judged(mine, `${mine} ${markOf(12, "abc")}`),
      none: judged(mine, "I can't help with that."),
    }).toStrictEqual({
      own: "answered",
      theirs: "wrong-person",
      both: "wrong-person",
      none: "failed",
    });
  });

  it("passes only with no answer to the wrong person, none lost, and the p90 within its bar; refusals are counted, not failed", () => {
    const steady = [
      turn("answered", 4000),
      turn("answered", 6000),
      turn("refused", null),
    ];
    expect({
      steady: summaryOf(steady, 12_000),
      leak: summaryOf([...steady, turn("wrong-person", 5000)], 12_000).passed,
      lost: summaryOf([...steady, turn("lost", null)], 12_000).passed,
      slow: summaryOf(steady, 5000).passed,
    }).toStrictEqual({
      steady: {
        turns: 3,
        ends: {
          answered: 2,
          "wrong-person": 0,
          refused: 1,
          failed: 0,
          lost: 0,
        },
        first: { p50Ms: 2000, p90Ms: 3000 },
        answer: { p50Ms: 4000, p90Ms: 6000 },
        costUsd: 0.003,
        reasons: { "Your daily limit is reached.": 1 },
        passed: true,
      },
      leak: false,
      lost: false,
      slow: false,
    });
  });
});
