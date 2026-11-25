import { describe, expect, it } from "vite-plus/test";

import {
  medianOf,
  replyTimes,
  withSegment,
} from "../src/admin/voice-lab-heard.ts";
import type { Segment } from "../src/admin/voice-lab-heard.ts";

// What the Voice Lab makes of a session's events: the conversation as it
// grows, and how long each answer took to begin.

const theirs = (id: string, content: string, final = false): Segment => ({
  id,
  role: "user",
  content,
  final,
});

describe(withSegment, () => {
  it("lets a stretch's later words take the place of its earlier ones, where it stands", () => {
    const said = [theirs("a", "I open", false), theirs("b", "Then", false)];
    expect(
      withSegment(said, theirs("a", "I open the invoice.", true))
    ).toStrictEqual([
      theirs("a", "I open the invoice.", true),
      theirs("b", "Then", false),
    ]);
  });

  it("puts a new stretch after the last", () => {
    expect(
      withSegment([theirs("a", "Yes.", true)], theirs("b", "And"))
    ).toStrictEqual([theirs("a", "Yes.", true), theirs("b", "And")]);
  });
});

describe(replyTimes, () => {
  it("times each answer from their last words settling to his voice", () => {
    expect(
      replyTimes([
        // His first line answers nothing.
        { at: 100, what: "speaks" },
        { at: 5000, what: "said" },
        // They went on: the answer counts from where they stopped again.
        { at: 6200, what: "said" },
        { at: 6850.4, what: "speaks" },
        { at: 12_000, what: "said" },
        { at: 12_900, what: "speaks" },
        // Said again after being cut off, with nothing new of theirs.
        { at: 15_000, what: "speaks" },
      ])
    ).toStrictEqual([650, 900]);
  });
});

describe(medianOf, () => {
  it.each([
    [[], null],
    [[700], 700],
    [[900, 500, 700], 700],
    [[400, 1000, 600, 800], 700],
  ])("finds the middle of %j: %j", (times, middle) => {
    expect(medianOf(times)).toBe(middle);
  });
});
