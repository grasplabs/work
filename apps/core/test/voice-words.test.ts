import { describe, expect, it } from "vite-plus/test";

import { wordsOf } from "../src/voice-models.ts";

// The words of a line as written, from the words the voice aligned
// (voice-models.ts): pure. The voice reads a number out as several words
// and passes over what it can't say, while the page lights up the line's
// own words, one for one.

describe("the words of a line as written", () => {
  it("times a number by all the words said for it, and passes a symbol nothing is said for at once", () => {
    // "About 12,000 ★ visitors." said as "About twelve thousand visitors."
    const words = wordsOf("About 12,000 ★ visitors.", [
      { startMs: 0, endMs: 290, from: 0, to: 5 },
      { startMs: 310, endMs: 640, from: 6, to: 12 },
      { startMs: 650, endMs: 1080, from: 6, to: 12 },
      { startMs: 1100, endMs: 1630, from: 15, to: 24 },
    ]);

    expect(words).toStrictEqual([
      { text: "About", startMs: 0, endMs: 290 },
      { text: "12,000", startMs: 310, endMs: 1080 },
      { text: "★", startMs: 1080, endMs: 1080 },
      { text: "visitors.", startMs: 1100, endMs: 1630 },
    ]);
  });

  it("counts where a word is by code point, as the voice does", () => {
    // The emoji is one code point, two UTF-16 units.
    const words = wordsOf("Hi 👋 there", [
      { startMs: 0, endMs: 200, from: 0, to: 2 },
      { startMs: 300, endMs: 600, from: 5, to: 10 },
    ]);

    expect(words).toStrictEqual([
      { text: "Hi", startMs: 0, endMs: 200 },
      { text: "👋", startMs: 200, endMs: 200 },
      { text: "there", startMs: 300, endMs: 600 },
    ]);
  });

  it("has no words for a line the voice aligned none of", () => {
    expect(wordsOf("Hello there.", [])).toBeUndefined();
  });
});
