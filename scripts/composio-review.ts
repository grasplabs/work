import { z } from "zod";

/**
 * Prints a Composio toolkit's tools as a review table, one tool a line
 * (tab-separated): its name, whether Composio says it only reads, the
 * class this release gives it, the class the review is asked to give it,
 * and Composio's description. The table goes on the toolkit's review
 * page, outside the repo; once a person has classed every tool there,
 * the tools they classed go into `apps/connect/src/composio-classes.ts`.
 * A tool nobody classed stays out: it is never offered or run.
 *
 *   op run --env-file composio.env -- node scripts/composio-review.ts hubspot > hubspot.tsv
 *
 * where `composio.env` holds `COMPOSIO_API_KEY=op://<vault>/<item>/<field>`.
 * Reads the key from the environment, never from the command line.
 *
 * The suggestion is only a start, and never a class: Composio's
 * `readOnlyHint` is best-effort, every CRM record is the company's, and a
 * tool the Never rule refuses (`apps/connect/src/never.ts`) is `never`
 * whatever anyone classes it.
 */
import { composioClasses } from "../apps/connect/src/composio-classes.ts";
import type { ComposioClasses } from "../apps/connect/src/composio-classes.ts";
import { isNeverTool } from "../apps/connect/src/never.ts";

/** One of Composio's tools, as the review reads it. */
export interface ListedTool {
  slug: string;
  description: string;
  readOnly: boolean;
}

/** A row of the review table. */
export interface ReviewRow {
  tool: string;
  composioSaysRead: boolean;
  /** The class this release gives it; empty while nobody classed it. */
  shipped: string;
  /** What the review is asked to class it, until a person decides. */
  suggested: string;
  description: string;
}

/**
 * The review table of `toolkit`'s `tools`, by name. A tool the release
 * classed keeps its class as the suggestion; a Never one is `never`; the
 * rest are a company read when Composio says they only read, and a
 * company change otherwise, each to be confirmed.
 */
export const reviewRows = (
  toolkit: string,
  tools: readonly ListedTool[],
  classes: ComposioClasses
): ReviewRow[] => {
  const shipped = Object.hasOwn(classes, toolkit) ? classes[toolkit] : {};
  return tools
    .toSorted((first, second) => first.slug.localeCompare(second.slug))
    .map(({ slug, description, readOnly }) => {
      const given =
        shipped !== undefined && Object.hasOwn(shipped, slug)
          ? shipped[slug]
          : undefined;
      let suggested: string;
      if (isNeverTool(slug)) {
        suggested = "never";
      } else if (given === undefined) {
        suggested = readOnly ? "read-company?" : "change-company?";
      } else {
        suggested = given;
      }
      return {
        tool: slug,
        composioSaysRead: readOnly,
        shipped: given ?? "",
        suggested,
        description,
      };
    });
};

/** Composio's REST API, as connect calls it (composio.ts). */
const composioApiBase = "https://backend.composio.dev/api/v3.1";

/** Most pages of tools read: a toolkit longer than that isn't reviewed. */
const maxPages = 25;

/** One page of Composio's tools, as far as the review reads it. */
const toolsPageSchema = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      description: z.string().nullish(),
      tags: z.array(z.string()).nullish(),
    })
  ),
  next_cursor: z.string().nullish(),
});

/** Every tool of `toolkit`, as Composio lists it now. */
const listTools = async (
  key: string,
  toolkit: string
): Promise<ListedTool[]> => {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ toolkit_slug: toolkit, limit: "200" });
    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    const response = await fetch(
      `${composioApiBase}/tools?${query.toString()}`,
      {
        headers: { "x-api-key": key, accept: "application/json" },
        redirect: "manual",
      }
    );
    if (!response.ok) {
      throw new Error(`Composio answered ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    const listed = toolsPageSchema.parse(await response.json());
    for (const { slug, description, tags } of listed.items) {
      tools.push({
        slug,
        description: (description ?? "").replaceAll(/\s+/gu, " "),
        readOnly: tags?.includes("readOnlyHint") === true,
      });
    }
    cursor = listed.next_cursor ?? undefined;
    if (cursor === undefined) {
      return tools;
    }
  }
  throw new Error(`${toolkit} has more tools than the review reads`);
};

const main = async (): Promise<void> => {
  const [toolkit] = process.argv.slice(2);
  const key = process.env.COMPOSIO_API_KEY;
  if (toolkit === undefined || !/^[a-z0-9_]+$/u.test(toolkit)) {
    throw new Error("Usage: node scripts/composio-review.ts <toolkit>");
  }
  if (key === undefined || key === "") {
    throw new Error("COMPOSIO_API_KEY is not set");
  }
  const rows = reviewRows(
    toolkit,
    await listTools(key, toolkit),
    composioClasses
  );
  const lines = [
    "tool\tcomposio says read\tclass now\tsuggested\tdescription",
    ...rows.map((row) =>
      [
        row.tool,
        row.composioSaysRead ? "yes" : "no",
        row.shipped,
        row.suggested,
        row.description,
      ].join("\t")
    ),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

if (import.meta.main) {
  await main();
}
