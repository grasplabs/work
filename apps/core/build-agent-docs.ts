/**
 * Embeds the SDK docs' guides (apps/docs/content/guides/) into
 * dist/agent-docs.js, which core imports as `#agent-docs`
 * (src/agent-docs.d.ts): the chat's agent reads them whole in its system
 * prompt (src/agent-docs.ts), in the order the docs' sidebar lists them.
 * Core's build runs it, and its tests' setup, so the agent always reads
 * the guides of the release it runs: nothing is copied by hand, and
 * nothing can be stale.
 *
 * Each guide's frontmatter gives its title and place; its Markdown is
 * kept as written, links and examples included: a link such as
 * `/guides/data` is a path the agent's `readDocs` reads.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

/** The guides, as the docs keep them. */
export const guidesDir = path.join(
  import.meta.dirname,
  "../docs/content/guides"
);

/** The module core imports as `#agent-docs`. */
export const agentDocsModule = path.join(
  import.meta.dirname,
  "dist/agent-docs.js"
);

/** A guide's frontmatter, as far as the agent's copy reads it. */
const frontmatterSchema = z.object({
  title: z.string().min(1),
  sidebar: z.object({ order: z.number() }),
});

/** A page's frontmatter (YAML between `---` lines at its start), and its body. */
const pageParts = /^---\n(?<frontmatter>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u;

interface Guide {
  path: string;
  title: string;
  order: number;
  body: string;
}

const guideOf = (dir: string, file: string): Guide => {
  const parts = pageParts.exec(readFileSync(path.join(dir, file), "utf-8"));
  if (parts?.groups === undefined) {
    throw new Error(`The guide ${file} has no frontmatter.`);
  }
  const { frontmatter = "", body = "" } = parts.groups;
  const { title, sidebar } = frontmatterSchema.parse(parse(frontmatter));
  return {
    path: `/guides/${file.replace(/\.md$/u, "")}`,
    title,
    order: sidebar.order,
    body: body.trim(),
  };
};

/**
 * The guides in `dir`, in the sidebar's order, each as a `<doc>` element
 * holding its Markdown: the text of the agent's docs section.
 */
export const agentGuides = (dir: string = guidesDir): string =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => guideOf(dir, file))
    .toSorted((a, b) => a.order - b.order)
    .map(
      ({ path: page, title, body }) =>
        `<doc path="${page}" title=${JSON.stringify(title)}>\n${body}\n</doc>`
    )
    .join("\n\n");

/**
 * Writes the guides into `out`, leaving an unchanged module as it is, so
 * its time stays the same.
 */
export const writeAgentDocs = (out: string = agentDocsModule): void => {
  const text = `export default ${JSON.stringify(agentGuides())};\n`;
  if (existsSync(out) && readFileSync(out, "utf-8") === text) {
    return;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
};

if (import.meta.main) {
  writeAgentDocs();
  console.info("Embedded the SDK docs' guides for the agent");
}
