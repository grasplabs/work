import { describe, expect, it } from "vite-plus/test";

import { wordsOf } from "../src/voice-models.ts";

// When each word of a line is said, worked out from how long its audio
// is: pure logic, tried on its own.
describe("the words of a line said", () => {
  it("shares the audio's length over the words by their letters, with a wait after a comma, and ends the last with the audio", () => {
    // "Hello," is 6 letters, then a space and a comma's wait, 3 more;
    // "there." is 6: 15 parts over 300 ms.
    expect(wordsOf("Hello, there.", 0.3)).toStrictEqual([
      { text: "Hello,", startMs: 0, endMs: 120 },
      { text: "there.", startMs: 180, endMs: 300 },
    ]);
  });

  it("gives a direction in brackets no time: it isn't said", () => {
    expect(wordsOf("[emotion=warm]Hello, there.", 0.3)).toStrictEqual(
      wordsOf("Hello, there.", 0.3)
    );
  });

  it("has no words for a line of none", () => {
    expect(wordsOf("  ", 1)).toStrictEqual([]);
  });
});
