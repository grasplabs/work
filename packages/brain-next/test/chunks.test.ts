import { describe, expect, it } from "vite-plus/test";

import { chunkMax, chunkTarget, chunksOf } from "../src/chunks.ts";
import { foldForSearch } from "../src/words.ts";

/** The words of `texts`, in order, whatever whitespace parts them. */
const wordsOf = (...texts: string[]): string[] =>
  texts.join(" ").split(/\s+/u).filter(Boolean);

describe("cutting a text into chunks", () => {
  it("joins short paragraphs into one chunk", () => {
    expect(chunksOf("One.\n\nTwo.\n  \nThree.")).toStrictEqual([
      "One.\n\nTwo.\n\nThree.",
    ]);
  });

  it("starts a new chunk when the next paragraph would pass the target", () => {
    const paragraph = "word ".repeat(chunkTarget / 10).trim();
    const text = [paragraph, paragraph, paragraph].join("\n\n");

    const chunks = chunksOf(text);

    expect(chunks).toStrictEqual([`${paragraph}\n\n${paragraph}`, paragraph]);
  });

  it("cuts a paragraph longer than the most a chunk holds at whitespace, losing no word", () => {
    const text = Array.from({ length: 1000 }, (_, index) => `w${index}`).join(
      " "
    );

    const chunks = chunksOf(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(chunkMax);
    }
    expect(wordsOf(...chunks)).toStrictEqual(wordsOf(text));
  });

  it("cuts a text with no whitespace at the most a chunk holds, never inside a character", () => {
    // Each "𝔸" is two UTF-16 code units; one more puts a pair on the edge.
    const text = `a${"𝔸".repeat(chunkMax)}`;

    const chunks = chunksOf(text);

    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(chunkMax);
      expect(chunk.isWellFormed()).toBeTruthy();
    }
  });

  it("keeps every chunk within the bound as the word index takes it, for text that grows when folded", () => {
    // "ﷺ" is one character, and 18 as indexed.
    for (const text of ["ﷺ".repeat(1000), "ﷺ ".repeat(1000)]) {
      const chunks = chunksOf(text);

      expect(chunks.join("").replaceAll(/\s/gu, "")).toBe(
        text.replaceAll(/\s/gu, "")
      );
      expect(
        chunks.filter((chunk) => foldForSearch(chunk).length > chunkMax)
      ).toStrictEqual([]);
    }
  });

  it("gives no chunks for a text of whitespace only", () => {
    expect(chunksOf(" \n\n\t ")).toStrictEqual([]);
  });
});
