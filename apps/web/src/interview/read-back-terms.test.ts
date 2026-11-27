import { describe, expect, it } from "vite-plus/test";

import { storyPieces } from "./read-back-terms.ts";

const named = (text: string, marked: string[] = []): string[] =>
  storyPieces(text, marked).flatMap(({ term, text: words }) =>
    term === null ? [] : [words]
  );

describe("the things a line of the read-back names", () => {
  it("finds tools as whole words, in any case, the longest first", () => {
    expect(
      named("You keep the excel sheet in Google Drive, not in Excellent.")
    ).toStrictEqual(["excel", "Google Drive"]);
  });

  it("takes a tool that is also an everyday word only as the tool writes it", () => {
    expect(named("Other teams use Teams; I word it in Word.")).toStrictEqual([
      "Teams",
      "Word",
    ]);
  });

  it("finds what was marked in their words, and keeps every letter of the line", () => {
    const text = "You check the stock list (twice) in Excel.";
    const pieces = storyPieces(text, ["stock list", "(twice"]);
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
    expect(named(text, ["stock list"])).toStrictEqual(["stock list", "Excel"]);
  });
});
