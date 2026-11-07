import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { agentGuides, guidesDir } from "./agent-guides.ts";

// The guides as core's build embeds them in the chat's agent's system
// prompt (apps/core/build-agent-docs.ts): every guide, whole, by its
// title and path. A guide the agent's copy can't read fails here, in the
// pull request that wrote it, not in core's build.

/** A guide file's Markdown, after its frontmatter. */
const bodyOf = (file: string): string => {
  const page = readFileSync(path.join(guidesDir, file), "utf-8");
  return page.slice(page.indexOf("\n---\n", 3) + "\n---\n".length).trim();
};

describe("the guides the agent reads", () => {
  it("holds every guide, as written, by its path and title", () => {
    const guides = agentGuides();
    const files = readdirSync(guidesDir).filter((file) => file.endsWith(".md"));

    expect(files.length).toBeGreaterThan(0);
    expect(
      files.filter(
        (file) =>
          !(
            guides.includes(
              `<doc path="/guides/${file.replace(/\.md$/u, "")}"`
            ) && guides.includes(bodyOf(file))
          )
      )
    ).toStrictEqual([]);
  });

  it("puts a guide without a place in the sidebar after those with one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guides-"));
    try {
      writeFileSync(
        path.join(dir, "loose.md"),
        "---\ntitle: Loose\n---\n\nNo place.\n"
      );
      writeFileSync(
        path.join(dir, "first.md"),
        "---\ntitle: First\nsidebar:\n  order: 1\n---\n\nFirst place.\n"
      );

      const guides = agentGuides(dir);

      expect(guides.indexOf('title="First"')).toBeLessThan(
        guides.indexOf('title="Loose"')
      );
      expect(guides).toContain("No place.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
