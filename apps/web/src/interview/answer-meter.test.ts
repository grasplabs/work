import { describe, expect, it } from "vite-plus/test";

import { answerMeter, atShare, waitedOf } from "./answer-meter.ts";
import type { Measured } from "./answer-meter.ts";

// The prototype's `turnMeter` (`lib/interview-telemetry.ts`), as an
// interview goes: each answer from the end of what they said to his first
// sound.

const metered = () => {
  const answers: Measured[] = [];
  const meter = answerMeter((answer) => {
    answers.push(answer);
  });
  return { answers, meter };
};

describe("an answer of his", () => {
  it("is measured from their last word to his first sound", () => {
    const { answers, meter } = metered();
    meter.quiet(1000);
    meter.words(1200);
    meter.line(2500);
    meter.voice(3300);
    expect(answers).toStrictEqual([
      { by: "talk", words: 200, line: 1500, voice: 2300, again: 0 },
    ]);
  });

  it("counts from where they stop again when they talk on, keeping what was asked again", () => {
    const { answers, meter } = metered();
    meter.quiet(1000);
    meter.again();
    meter.quiet(4000);
    meter.line(5000);
    meter.voice(5500);
    expect(answers).toStrictEqual([
      { by: "talk", words: null, line: 1000, voice: 1500, again: 1 },
    ]);
  });

  it("counts as far as it went without a sound, and isn't sent to core", () => {
    const { answers, meter } = metered();
    meter.sent(1000);
    meter.line(1800);
    meter.stop();
    expect({
      answers,
      waited: answers.map((answer) => waitedOf(answer)),
    }).toStrictEqual({
      answers: [{ by: "type", words: null, line: 800, voice: null, again: 0 }],
      waited: [undefined],
    });
  });

  it("is measured once, by the first sound only", () => {
    const { answers, meter } = metered();
    meter.quiet(0);
    meter.voice(2000);
    meter.voice(2600);
    expect(answers.map(({ voice }) => voice)).toStrictEqual([2000]);
  });

  it("is sent to core as the longest wait core takes at most", () => {
    expect(
      waitedOf({ by: "talk", words: null, line: 1, voice: 90_000, again: 0 })
    ).toBe(60_000);
  });
});

describe("the middle answer", () => {
  it.each([
    [[], 0.5, null],
    [[2300], 0.5, 2300],
    [[3000, 1000, 2000], 0.5, 2000],
    [[4000, 1000, 3000, 2000], 0.5, 2000],
    [[5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 0.9, 9],
  ])("of %o at %d is %o", (values, share, expected) => {
    expect(atShare(values, share)).toBe(expected);
  });
});
