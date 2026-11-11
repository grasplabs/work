import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { apiPath } from "@grasp-os/shared/api-path";
import {
  docsMarkdownFile,
  docsPagesSchema,
  docsSearchIndexFile,
} from "@grasp-os/shared/docs";
import type { DocsPage } from "@grasp-os/shared/docs";
import { create, insertMultiple, search } from "@orama/orama";
import { z } from "zod";

import guides from "#agent-docs";

import { fileLines } from "./agent-tools.ts";
import { sharedPrefixEnd } from "./prompt-cache.ts";
import { docsPath } from "./security-headers.ts";

// What the chat's agent knows of building with Grasp: the SDK docs
// (apps/docs) of the release its deployment runs, as people read them at
// /docs. Never the SDK's sources or a blueprint's files: the docs say what
// an App and a workflow are and how to write them, and their API
// reference is generated from the SDK's own types.
//
// Only a person who builds gets them (`TurnContext.builds`). The guides
// go whole into the system prompt, right after the instructions, the
// same text for every chat that builds (build-agent-docs.ts embeds them
// at build time); the section ends where the part of the prompt every
// chat shares ends, which the gateway caches apart (prompt-cache.ts). The
// rest, the API reference above all, the agent finds with `searchDocs`
// and reads with `readDocs`, from the release's own docs among core's
// static files, the files docs.ts serves, read at each call: no chat
// shares a cache or anything else of another's.

/** The docs section of the system prompt: the guides, and how to read on. */
export const docsSection = [
  "<docs>",
  "How to build Apps and workflows with Grasp: the docs of the release this deployment runs. The guides are below in full; follow them, and never guess a shape that they or the API reference don't show. Find anything else with `searchDocs`, which answers the matching lines of each page it finds, and read a page with `readDocs`, from a line on when you know where: the API reference (`/reference` lists a page for each module App code imports), or a page a guide links to, such as `/guides/data`. The brain holds none of this: never search it for Grasp's docs or code.",
  guides,
  sharedPrefixEnd,
].join("\n");

/** A file of the release's docs, among core's static files. */
const assetUrl = (file: string): string => `https://assets${docsPath}${file}`;

/** What a docs tool says when the release's docs can't be read. */
const unreadable = "This deployment's docs aren't there to read.";

/**
 * The pages' full-text index: Orama's, as the docs' own search box builds
 * it over the same file, with the same weights (`searchDocs`).
 */
const indexOf = async (pages: readonly DocsPage[]) => {
  const index = create({
    schema: { title: "string", description: "string", content: "string" },
  });
  await insertMultiple(index, [...pages]);
  return index;
};

/**
 * The release's docs' pages, read from its static files at each call:
 * nothing of one chat's reads is kept for another's.
 */
const pagesOf = async (assets: Fetcher): Promise<DocsPage[]> => {
  const response = await assets.fetch(assetUrl(docsSearchIndexFile));
  // A file the release lacks answers with the frontend's page.
  const isJson =
    response.headers.get("content-type")?.includes("application/json") ?? false;
  if (!(response.ok && isJson)) {
    await response.body?.cancel();
    throw new Error(unreadable);
  }
  const pages = docsPagesSchema.safeParse(await response.json());
  if (!pages.success) {
    throw new Error(unreadable);
  }
  return pages.data;
};

/** A page's Markdown, refused when the static files answer with the frontend's page instead. */
const markdownOf = async (assets: Fetcher, route: string): Promise<string> => {
  // A route the docs' index lists, a segment at a time.
  const [, ...file] = docsMarkdownFile(route).split("/");
  const response = await assets.fetch(
    `https://assets${docsPath}${apiPath(...file)}`
  );
  const isHtml =
    response.headers.get("content-type")?.includes("text/html") ?? false;
  if (!response.ok || isHtml) {
    await response.body?.cancel();
    throw new Error(`The page ${route} isn't there to read.`);
  }
  return await response.text();
};

/**
 * `path` as the docs' pages are keyed: a link as the docs write it
 * (`/docs/reference/server.md#query`) reads as `/reference/server`.
 */
export const docsRoute = (path: string): string => {
  const route = path
    .replace(/#.*$/u, "")
    .replace(/^\/docs(?=\/|$)/u, "")
    .replace(/\.md$/u, "")
    .replace(/\/+$/u, "");
  if (route === "" || route === "/index") {
    return "/";
  }
  return route.startsWith("/") ? route : `/${route}`;
};

/** Most pages `searchDocs` answers with. */
const maxHits = 5;

/** Most lines of a page `searchDocs` answers with. */
const maxLinesPerPage = 8;

/** Most characters of a line `searchDocs` answers with. */
const maxLineChars = 200;

/** Most characters of a page's text a hit without a description shows. */
const excerptChars = 200;

/** What a hit says of its page, as Blume's own docs search tool says it. */
const excerptOf = ({ description, content }: DocsPage): string => {
  if (description !== "") {
    return description;
  }
  const head = content.slice(0, excerptChars).trim();
  return content.length > excerptChars ? `${head}…` : head;
};

/** A query's words, as a line is matched by them: any of two letters or more. */
const wordsOf = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .filter((word) => word.length > 1);

/**
 * The lines of `markdown` that hold the query, as `line: text` (from 1):
 * those with the whole query first, then those with most of its words.
 */
const matchingLines = (markdown: string, query: string): string[] => {
  const phrase = query.toLowerCase();
  const words = wordsOf(query);
  return markdown
    .split("\n")
    .map((text, at) => {
      const lower = text.toLowerCase();
      const found = words.filter((word) => lower.includes(word)).length;
      return {
        line: at + 1,
        text,
        score: lower.includes(phrase) ? words.length + 1 : found,
      };
    })
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, maxLinesPerPage)
    .toSorted((a, b) => a.line - b.line)
    .map(({ line, text }) => `${line}: ${text.trim().slice(0, maxLineChars)}`);
};

/**
 * The lines of the page at `route` that hold the query; none when the page
 * can't be read, which `readDocs` then says.
 */
const linesOf = async (
  assets: Fetcher,
  route: string,
  query: string
): Promise<string[]> => {
  try {
    return matchingLines(await markdownOf(assets, route), query);
  } catch {
    return [];
  }
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

/**
 * Finds the docs' pages for a query, best first, as the docs' search
 * does, each with its lines that match.
 */
export const searchDocs = (
  assets: Fetcher
): AgentTool<typeof searchParameters> => ({
  name: "searchDocs",
  label: "Search the docs",
  description: `Searches Grasp's docs (the guides and the API reference) and answers with the best pages, at most ${maxHits}: each one's \`path\`, which \`readDocs\` reads, its title, what it covers, and its \`lines\` that match, each as \`line: text\`, so \`readDocs\` can read on from there with \`fromLine\`.`,
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
    const index = await indexOf(await pagesOf(assets));
    const { hits } = await search<typeof index, DocsPage>(index, {
      term: query,
      properties: ["title", "description", "content"],
      boost: { title: 3, description: 2 },
      limit: maxHits,
    });
    const found = await Promise.all(
      hits.map(async ({ document: page }) => ({
        path: page.route,
        title: page.title,
        excerpt: excerptOf(page),
        lines: await linesOf(assets, page.route, query),
      }))
    );
    const text =
      found.length === 0
        ? "No page of the docs matches. Try other words, or read the API reference's index (`/reference`)."
        : JSON.stringify(found);
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const readParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "The page, by its path in the docs or a link to it as the docs write it: `/reference/server`, `/guides/data`, `/docs/reference/server.md#query`.",
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
    const pages = await pagesOf(assets);
    // Only a page the docs list, by its own file: never another of core's
    // static files.
    const route = docsRoute(path);
    const page = pages.find((listed) => listed.route === route);
    if (page === undefined) {
      throw new Error(
        `No page ${path} in the docs. Their pages: ${pages
          .map((listed) => listed.route)
          .toSorted()
          .join(", ")}.`
      );
    }
    return {
      content: [
        {
          type: "text",
          text: fileLines(
            await markdownOf(assets, page.route),
            fromLine,
            toLine
          ),
        },
      ],
      details: undefined,
    };
  },
});
