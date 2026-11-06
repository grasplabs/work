import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { create, insertMultiple, search } from "@orama/orama";
import { z } from "zod";

import guides from "#agent-docs";

import { fileLines } from "./agent-tools.ts";
import { docsPath } from "./security-headers.ts";

// What the chat's agent knows of building with Grasp: the SDK docs
// (apps/docs) of the release its deployment runs, as people read them at
// /docs. Never the SDK's sources or a blueprint's files: the docs say what
// an App and a workflow are and how to write them, and their API
// reference is generated from the SDK's own types.
//
// The guides go whole into the system prompt, right after the
// instructions: the same text in every chat that builds, so the
// provider's prompt cache keeps it with them (build-agent-docs.ts embeds
// them at build time). The rest, the API reference above all, the agent
// finds with `searchDocs` and reads with `readDocs`, from the release's
// own docs among core's static files, the files docs.ts serves.

/** The APIs a chat builds with: a chat with either reads the docs. */
const buildingApis: ReadonlySet<string> = new Set(["build", "workflowBuild"]);

/** Whether a chat with `apis` builds Apps or workflows. */
export const buildsWith = (apis: readonly { name: string }[]): boolean =>
  apis.some(({ name }) => buildingApis.has(name));

/** The docs section of the system prompt: the guides, and how to read on. */
export const docsSection = [
  "<docs>",
  "How to build Apps and workflows with Grasp: the docs of the release this deployment runs. The guides are below in full; follow them, and never guess a shape that they or the API reference don't show. Find anything else with `searchDocs` and read a page with `readDocs`: the API reference (`/reference` lists a page for each module App code imports), or a page a guide links to, such as `/guides/data`. The brain holds none of this: never search it for Grasp's docs or code.",
  guides,
  "</docs>",
].join("\n");

/** A file of the release's docs, among core's static files. */
const assetUrl = (file: string): string => `https://assets${docsPath}${file}`;

/**
 * The docs' pages, as the search index the docs' build writes holds them
 * (Blume's `blume-search.json`): each one's path, title, description and
 * text.
 */
const pagesSchema = z.array(
  z.object({
    route: z.string().startsWith("/"),
    title: z.string(),
    description: z.string(),
    content: z.string(),
  })
);

type Page = z.output<typeof pagesSchema>[number];

/**
 * The pages' full-text index: Orama's, as the docs' own search box builds
 * it over the same file, with the same weights (`searchDocs`).
 */
const indexOf = async (pages: readonly Page[]) => {
  const index = create({
    schema: { title: "string", description: "string", content: "string" },
  });
  await insertMultiple(index, [...pages]);
  return index;
};

interface Docs {
  pages: readonly Page[];
  index: Awaited<ReturnType<typeof indexOf>>;
}

/**
 * The release's docs, once read: the release's static files never change
 * under an isolate.
 */
let releaseDocs: Docs | undefined;

const docsOf = async (assets: Fetcher): Promise<Docs> => {
  if (releaseDocs !== undefined) {
    return releaseDocs;
  }
  const response = await assets.fetch(assetUrl("/blume-search.json"));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("This deployment's docs aren't there to read.");
  }
  const pages = pagesSchema.parse(await response.json());
  releaseDocs = { pages, index: await indexOf(pages) };
  return releaseDocs;
};

/** Most pages `searchDocs` answers with. */
const maxHits = 5;

/** Most characters of a page's text a hit without a description shows. */
const excerptChars = 200;

/** What a hit says of its page, as Blume's own docs search tool says it. */
const excerptOf = ({ description, content }: Page): string => {
  if (description !== "") {
    return description;
  }
  const head = content.slice(0, excerptChars).trim();
  return content.length > excerptChars ? `${head}…` : head;
};

const searchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "What to look for, in words or by name: `row rules`, `withIndex`, `useWorkflow`.",
    }),
  },
  { additionalProperties: false }
);

const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
});

/** Finds the docs' pages for a query, best first, as the docs' search does. */
export const searchDocs = (
  assets: Fetcher
): AgentTool<typeof searchParameters> => ({
  name: "searchDocs",
  label: "Search the docs",
  description: `Searches Grasp's docs (the guides and the API reference) and answers with the best pages, at most ${maxHits}: each one's \`path\`, which \`readDocs\` reads, its title and what it covers.`,
  parameters: searchParameters,
  prepareArguments: (args) => {
    const input = searchInputSchema.safeParse(args);
    if (!input.success) {
      throw new Error(
        "searchDocs takes one field, `query`: what to look for, at most 200 characters."
      );
    }
    return input.data;
  },
  executionMode: "parallel",
  execute: async (_toolCallId, { query }) => {
    const { index } = await docsOf(assets);
    const { hits } = await search<Docs["index"], Page>(index, {
      term: query,
      properties: ["title", "description", "content"],
      boost: { title: 3, description: 2 },
      limit: maxHits,
    });
    const text =
      hits.length === 0
        ? "No page of the docs matches. Try other words, or read the API reference's index (`/reference`)."
        : JSON.stringify(
            hits.map(({ document: page }) => ({
              path: page.route,
              title: page.title,
              excerpt: excerptOf(page),
            }))
          );
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const readParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "The page, by its path in the docs: `/reference/server`, `/guides/data`.",
    }),
    fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
    toLine: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false }
);

const readInputSchema = z.strictObject({
  path: z.string().min(1).max(200),
  fromLine: z.number().int().min(1).optional(),
  toLine: z.number().int().min(1).optional(),
});

/** A page's Markdown file, by its path: `/` is the docs' first page. */
const markdownFile = (page: string): string =>
  page === "/" ? "/index.md" : `${page}.md`;

/** Reads one page of the docs, as its Markdown. */
export const readDocs = (
  assets: Fetcher
): AgentTool<typeof readParameters> => ({
  name: "readDocs",
  label: "Read the docs",
  description:
    "Reads one page of Grasp's docs as Markdown: all of it, or the lines `fromLine` to `toLine` (from 1). A long page is cut, and then ends with a note of the lines shown and where to read on.",
  parameters: readParameters,
  prepareArguments: (args) => {
    const input = readInputSchema.safeParse(args);
    if (!input.success) {
      throw new Error(
        "readDocs takes `path`, a page's path in the docs, and optionally `fromLine` and `toLine`, whole numbers from 1."
      );
    }
    return input.data;
  },
  executionMode: "parallel",
  execute: async (_toolCallId, { path, fromLine, toLine }) => {
    const { pages } = await docsOf(assets);
    // Only a page the docs list, by its own file: never another of core's
    // static files.
    const wanted = path.length > 1 ? path.replace(/\/$/u, "") : path;
    const page = pages.find(({ route }) => route === wanted);
    if (page === undefined) {
      throw new Error(
        `No page ${path} in the docs. Their pages: ${pages
          .map(({ route }) => route)
          .toSorted()
          .join(", ")}.`
      );
    }
    const response = await assets.fetch(assetUrl(markdownFile(page.route)));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The page ${page.route} isn't there to read.`);
    }
    return {
      content: [
        {
          type: "text",
          text: fileLines(await response.text(), fromLine, toLine),
        },
      ],
      details: undefined,
    };
  },
});
