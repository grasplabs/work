import { describe, expect, it } from "vite-plus/test";

import {
  lengthOf,
  narrationOf,
  readingTiming,
  saidBy,
  timingOf,
  wordsOf,
} from "./timing.ts";

// How a line's words are timed, from the voice or at the pace of speech.

describe(narrationOf, () => {
  it.each([
    [
      "Hi Ann, I’m Stephen",
      "Which language?",
      "Hi Ann, I’m Stephen. Which language?",
      21,
    ],
    ["Who’s who?", "A staff list.", "Who’s who? A staff list.", 11],
    ["Ready", "  ", "Ready", 5],
  ])("joins %j and %j as one line", (title, sentence, line, from) => {
    expect(narrationOf(title, sentence)).toStrictEqual({ line, from });
  });
});

describe(timingOf, () => {
  it("lights each word over the time the voice says it, and passes the space after it at once", () => {
    const timing = timingOf("Hi Ann", [
      { text: "Hi", startMs: 0, endMs: 200 },
      { text: "Ann", startMs: 300, endMs: 600 },
    ]);
    expect({
      chars: timing.starts.length,
      saidAt: [0.05, 0.25, 0.35, 0.65].map((at) => saidBy(timing, at)),
      length: Math.round(lengthOf(timing) * 1000),
    }).toStrictEqual({ chars: 6, saidAt: [1, 3, 4, 6], length: 600 });
  });

  it("stretches the pace of speech over how long the voice spoke when it counted the words otherwise", () => {
    const line = "Well, twenty-one.";
    const timing = timingOf(line, [
      { text: "Well,", startMs: 0, endMs: 300 },
      { text: "twenty", startMs: 300, endMs: 600 },
      { text: "one.", startMs: 600, endMs: 900 },
    ]);
    expect({
      chars: timing.starts.length,
      length: Math.round(lengthOf(timing) * 1000),
    }).toStrictEqual({ chars: line.length, length: 900 });
  });
});

describe(readingTiming, () => {
  it("takes longer after a full stop than after a comma, and longer after a comma than a letter", () => {
    const stop = lengthOf(readingTiming("."));
    const comma = lengthOf(readingTiming(","));
    const letter = lengthOf(readingTiming("a"));
    expect({
      stopLonger: stop > comma,
      commaLonger: comma > letter,
    }).toStrictEqual({ stopLonger: true, commaLonger: true });
  });
});

describe(wordsOf, () => {
  it("gives each word where it starts and ends, without the space after it", () => {
    expect(wordsOf("Hi  Ann.")).toStrictEqual([
      { word: "Hi  ", start: 0, end: 2 },
      { word: "Ann.", start: 4, end: 8 },
    ]);
  });
});
