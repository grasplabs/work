import { z } from "zod";

// What the SDK docs' build (apps/docs) writes for the chat's agent, as
// core reads it from a release's static files (apps/core/src/agent-docs.ts)
// and the docs' own build test holds the build to it.

/**
 * The docs' pages, as the search index the build writes holds them
 * (Blume's `blume-search.json`): each one's path, title, description and
 * text. Blume writes more of each, which nothing here reads.
 */
export const docsPagesSchema = z.array(
  z.object({
    route: z.string().startsWith("/"),
    title: z.string(),
    description: z.string(),
    content: z.string(),
  })
);

export type DocsPage = z.output<typeof docsPagesSchema>[number];

/** Where the search index is among the docs' files. */
export const docsSearchIndexFile = "/blume-search.json";

/** A page's Markdown file among the docs' files, by its path: `/` is the first page. */
export const docsMarkdownFile = (route: string): string =>
  route === "/" ? "/index.md" : `${route}.md`;
