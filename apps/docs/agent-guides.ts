/**
 * The guides as the chat's agent reads them, whole, in its system prompt:
 * core's build embeds them (apps/core/build-agent-docs.ts), in the order
 * the sidebar lists them. Each guide's frontmatter gives its title and
 * place; its Markdown is kept as written, links and examples included: a
 * link such as `/guides/data` is a path the agent's `readDocs` reads.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

/** The guides, as the docs keep them. */
export const guidesDir = path.join(import.meta.dirname, "content/guides");

/**
 * A guide's frontmatter, as far as the agent's copy reads it: a guide
 * without a place in the sidebar comes after those with one, as Blume
 * lists it.
 */
const frontmatterSchema = z.object({
  title: z.string().min(1),
  sidebar: z
    .object({ order: z.number().default(Number.POSITIVE_INFINITY) })
    .default({ order: Number.POSITIVE_INFINITY }),
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
 * The guides in `dir`, in the sidebar's order (then by path), each as a
 * `<doc>` element holding its Markdown: the text of the agent's docs
 * section.
 */
export const agentGuides = (dir: string = guidesDir): string =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => guideOf(dir, file))
    .toSorted((a, b) => a.order - b.order || a.path.localeCompare(b.path))
    .map(
      ({ path: page, title, body }) =>
        `<doc path="${page}" title=${JSON.stringify(title)}>\n${body}\n</doc>`
    )
    .join("\n\n");
