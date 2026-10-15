import { describe, expect, it } from "vite-plus/test";

import { noteFileName, noteMarkdown } from "./brain-markdown.ts";
import { buildBrain } from "./brain.ts";
import type { Note } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The prototype's tests of the Markdown export, on the brain's test
// company: the same assertions, with dates as the app writes them.

describe(noteMarkdown, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const note = (id: string): Note => {
    const found = brain.notes.find((candidate) => candidate.id === id);
    if (!found) {
      throw new Error(`No note ${id}`);
    }
    return found;
  };
  const options = {
    baseUrl: "https://grasp.example",
    exportedOn: "2026-09-24",
  };

  it("starts with what the note is, then its points with links back into Grasp", () => {
    const text = noteMarkdown(note("goal-numbers"), options);
    expect(
      text.startsWith(
        "---\nid: goal-numbers\nkind: Goal\nfolder: 1 Vision / Goals\n"
      )
    ).toBeTruthy();
    expect(text).toContain("exported: 2026-09-24");
    expect(text).toContain(
      "# The board sees this week’s numbers by 9:00 on Monday"
    );
    expect(text).toContain(
      "- **Before:** The board sees this week’s numbers on Monday morning"
    );
    expect(text).toContain(
      "[Monthly check-in with the board, Sep 23, 2026](https://grasp.example/brain/src-board-checkin)"
    );
  });

  it("keeps the full history, and links a quote to where it was said in its source", () => {
    const team = note("team-service");
    const text = noteMarkdown(team, options);
    const events = text
      .split("\n")
      .filter((line) => /^- \*\*\w{3} \d{1,2}, \d{4}\*\*/u.test(line));
    expect(events).toHaveLength(team.timeline.length);
    expect(events[0]).toContain("Desk research: website, vacancies and news");
    expect(text).toContain("Size changed to 15");
    expect(text).toContain(
      "  - [“About 600 emails a week land in one shared inbox, and every one is routed by hand”](https://grasp.example/brain/src-service#st-inbox)"
    );
  });

  it("includes an interview’s article and its transcript by topic, and workflows link to the Workflows page", () => {
    const source = ws.sources.find(
      (candidate) => candidate.id === "src-compliance"
    );
    const text = noteMarkdown(note("src-compliance"), {
      ...options,
      transcript: source?.transcript,
    });
    expect(text).toContain("## Article\n\nComplaints are registered by hand");
    const chapters = source?.transcript?.chapters ?? [];
    const turns = source?.transcript?.turns ?? [];
    expect(text).toContain(
      `## Transcript\n\n### ${chapters[0]?.title} · 00:00\n\n**${turns[0]?.at} · ${turns[0]?.speaker}:** ${turns[0]?.text}`
    );
    expect(text).toContain(`### ${chapters[1]?.title} · ${chapters[1]?.at}`);
    expect(noteMarkdown(note("cand-email"), options)).toContain(
      "(https://grasp.example/workflows/email-triage)"
    );
  });

  it("names the file after the note", () => {
    expect(noteFileName(note("goal-numbers"))).toBe(
      "the-board-sees-this-week-s-numbers-by-9-00-on-monday"
    );
    expect(noteFileName(note("cand-file-handover")).length).toBeLessThanOrEqual(
      60
    );
  });
});
