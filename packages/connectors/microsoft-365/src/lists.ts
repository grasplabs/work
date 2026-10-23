import { defineTool } from "@grasp-os/connector-kit/connector";
import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  graphHost,
  graphJson,
  graphUrl,
  nextPageOf,
  pageOf,
  pageSchema,
  topSchema,
  v1,
} from "./graph.ts";

// SharePoint lists, in one site per call, as `/sites/{site}`, so a call's
// capability binds every request to its site. Graph answers with the
// person's own SharePoint rights (the token is delegated): a site they
// can't open is refused by Graph, whatever the permission says.
//
// Many registers (contracts, suppliers, assets) are lists rather than
// workbooks; reading their items is what this adds. Changing them is not.

const sites = `${v1}/sites/{site}`;

/**
 * A site, as Graph's ID gives it: `<host>,<site collection ID>,<web ID>`.
 * Only that one spelling, never a host and path (`host:/sites/Finance:`),
 * which the egress refuses, or `root`, so a site has one name a
 * capability can bind.
 */
const siteSchema = z
  .string()
  .min(5)
  .max(256)
  .regex(/^[\w.-]+,[\w-]+,[\w-]+$/u);

/** A list: its ID, or its name as Graph takes it in place of one. */
const listSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(segmentValuePattern)
  .refine((list) => list !== "." && list !== "..", {
    message: "Not a list",
  });

/**
 * A column's internal name (`Status`, `Renewal_x0020_date`), as Graph names
 * it under an item's `fields`: letters, digits and underscores only, so it
 * can't carry anything into the filter it stands in.
 */
const columnSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][\w]*$/u);

const comparisons = ["eq", "ne", "gt", "ge", "lt", "le"] as const;

/**
 * One condition on a column. The filter is built from these, never taken
 * as OData text, so no input can widen it: a value is always a literal.
 */
const conditionSchema = z.strictObject({
  column: columnSchema,
  is: z.enum(comparisons),
  value: z.union([z.string().max(1024), z.number()]),
});
type Condition = z.infer<typeof conditionSchema>;

/** A value as an OData literal: a number as is, text quoted, a quote doubled. */
const literalOf = (value: string | number): string =>
  typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;

/** Graph's `$filter` for items whose fields meet every condition. */
const filterOf = (conditions: readonly Condition[]): string =>
  conditions
    .map(
      ({ column, is, value }) => `fields/${column} ${is} ${literalOf(value)}`
    )
    .join(" and ");

/**
 * Lets Graph filter on a column that isn't indexed. It does so for a list
 * of up to 5,000 items; past that it refuses the request, and says why.
 */
const nonIndexedFilter: HeadersInit = {
  prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
};

const graphListItem = z.object({
  id: z.string(),
  webUrl: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  fields: z.record(z.string(), z.json()).nullish(),
});
type GraphListItem = z.infer<typeof graphListItem>;

const itemFields = "id,webUrl,createdDateTime,lastModifiedDateTime";

/**
 * Columns every list has that say nothing about its items: SharePoint's
 * own bookkeeping and the views' links. Kept out, so a page holds the
 * list's own columns.
 */
const bookkeeping = new Set([
  "ContentType",
  "Edit",
  "LinkTitle",
  "LinkTitleNoMenu",
  "ItemChildCount",
  "FolderChildCount",
  "DocIcon",
  "AppAuthorLookupId",
  "AppEditorLookupId",
]);

/**
 * How SharePoint writes a character a name can't start with or hold in its
 * internal name: `_x0032_` for a leading "2", `_x0020_` for a space. A
 * column named "2nd signatory" is `_x0032_nd_x0020_signatory`, the list's
 * own, not one of SharePoint's `_`-named columns.
 */
const encodedCharacter = /^_x[\da-fA-F]{4}_/u;

const isOwnColumn = (name: string): boolean =>
  !(
    name.startsWith("@") ||
    (name.startsWith("_") && !encodedCharacter.test(name)) ||
    bookkeeping.has(name)
  );

const itemSchema = z.strictObject({
  id: z.string(),
  fields: z.record(z.string(), z.json()),
  createdAt: z.string().nullable(),
  lastModifiedAt: z.string().nullable(),
  webUrl: z.string().nullable(),
});

/** An item, with its own columns and any column `columns` asked for. */
const itemOf = (
  item: GraphListItem,
  columns: readonly string[] = []
): z.infer<typeof itemSchema> => ({
  id: item.id,
  fields: Object.fromEntries(
    Object.entries(item.fields ?? {}).filter(
      ([name]) => isOwnColumn(name) || columns.includes(name)
    )
  ),
  createdAt: item.createdDateTime ?? null,
  lastModifiedAt: item.lastModifiedDateTime ?? null,
  webUrl: item.webUrl ?? null,
});

const listItems = defineTool({
  name: "lists.items",
  description:
    "Reads the items of a SharePoint list in a site, a page at a time: each item's columns, by their internal names. Give conditions on columns to read only the items that meet all of them, and columns to read only those.",
  input: z.strictObject({
    site: siteSchema,
    list: listSchema,
    where: z.array(conditionSchema).min(1).max(8).optional(),
    columns: z.array(columnSchema).min(1).max(32).optional(),
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    site: z.string(),
    list: z.string(),
    items: z.array(itemSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "company",
  resource: "site",
  routes: [
    { method: "GET", host: graphHost, path: `${sites}/lists/{list}/items` },
  ],
  run: async ({ site, list, where, columns, top, page }) => {
    const url = atPage(
      graphUrl(`/sites/${segment(site)}/lists/${segment(list)}/items`, {
        $select: itemFields,
        $expand:
          columns === undefined
            ? "fields"
            : `fields($select=${columns.join(",")})`,
        $filter: where === undefined ? undefined : filterOf(where),
        $top: String(top ?? 50),
      }),
      page
    );
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      url,
      pageOf(graphListItem),
      where === undefined ? {} : { headers: nonIndexedFilter }
    );
    return {
      output: {
        site,
        list,
        items: value.map((item) => itemOf(item, columns)),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

export const listTools = [listItems];
