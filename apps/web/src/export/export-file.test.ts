import { describe, expect, it } from "vite-plus/test";

import { noteMarkdown } from "../brain/brain-markdown.ts";
import { buildBrain } from "../brain/brain.ts";
import type { Note } from "../brain/brain.ts";
import { testWorkspace } from "../brain/test-workspace.ts";
import { withoutFrontmatter } from "./export-file.tsx";

// The page an export prints starts after the file's frontmatter: a brain
// note's Markdown opens with one (brain-markdown.ts), which only the file
// needs.

const options = {
  baseUrl: "https://grasp.example",
  exportedOn: "2026-11-14",
};

const noteOf = (id: string): Note => {
  const found = buildBrain(testWorkspace()).notes.find(
    (note) => note.id === id
  );
  if (!found) {
    throw new Error(`No note ${id}`);
  }
  return found;
};

describe(withoutFrontmatter, () => {
  it("leaves out a note's frontmatter, and keeps its text from its title on", () => {
    const note = noteOf("goal-numbers");
    expect(withoutFrontmatter(noteMarkdown(note, options))).toMatch(
      /^\n# The board sees this week’s numbers by 9:00 on Monday\n/u
    );
  });

  it("leaves out a frontmatter whose names hold a line or paragraph separator", () => {
    const note = noteOf("goal-numbers");
    const lineSeparator = String.fromCodePoint(0x20_28);
    const paragraphSeparator = String.fromCodePoint(0x20_29);
    const named = {
      ...note,
      tags: [`one${lineSeparator}two`, `three${paragraphSeparator}four`],
    };
    const printed = withoutFrontmatter(noteMarkdown(named, options));
    expect(printed.startsWith("\n# ")).toBeTruthy();
    expect(printed).not.toContain("exported: 2026-11-14");
  });

  it("keeps text that opens a frontmatter it never closes whole", () => {
    const text = "---\nid: one\n\n# Never closed\n";
    expect(withoutFrontmatter(text)).toBe(text);
  });
});
