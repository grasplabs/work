import { describe, expect, it } from "vite-plus/test";

import { filesToRead } from "./document-files.ts";

const file = (name: string, size = 100, lastModified = 1) => ({
  name,
  size,
  lastModified,
});

describe("the files of a drop that are read", () => {
  it("are those of a kind Grasp reads, with the others counted as refused", () => {
    const { fresh, refused } = filesToRead([
      file("Procedures.PDF"),
      file("photo.jpg"),
      file("notes.md"),
      file("handbook.html"),
      file("deck.pptx"),
      file("old.doc"),
      file("archive.zip"),
    ]);
    expect(fresh.map((each) => each.name)).toStrictEqual([
      "Procedures.PDF",
      "notes.md",
      "handbook.html",
      "deck.pptx",
      "old.doc",
    ]);
    expect(refused).toBe(2);
  });

  it("include two files of the same name, and the same file only once", () => {
    const { fresh } = filesToRead([
      file("Procedures.pdf", 100, 1),
      file("Procedures.pdf", 100, 1),
      file("Procedures.pdf", 2400, 7),
    ]);
    expect(fresh.map((each) => each.size)).toStrictEqual([100, 2400]);
  });
});
