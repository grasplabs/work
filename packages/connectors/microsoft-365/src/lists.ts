import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
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
// workbooks. Their items are read, added, and changed only from what was
// read, as an Excel table's rows are: never deleted.

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

/**
 * A column's value as an item gives it: text, a number, a yes/no, nothing,
 * or a choice of several (a list of text). A value Graph gives as an object
 * (a link, a place) is its JSON text: a contract's schema says what each
 * value can be, and arbitrary JSON says nothing.
 */
const fieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
type FieldValue = z.infer<typeof fieldValue>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const valueOf = (value: unknown): FieldValue => {
  const plain = scalar.safeParse(value);
  if (plain.success) {
    return plain.data;
  }
  const choices = z.array(z.union([z.string(), z.number()])).safeParse(value);
  if (choices.success) {
    return choices.data.map(String);
  }
  return JSON.stringify(value);
};

const itemSchema = z.strictObject({
  id: z.string(),
  // A map of columns to values. As a record, its schema would name its keys
  // with `propertyNames`, which a contract may not use.
  fields: z.object({}).catchall(fieldValue),
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
    Object.entries(item.fields ?? {})
      .filter(([name]) => isOwnColumn(name) || columns.includes(name))
      .map(([name, value]) => [name, valueOf(value)])
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

/** A value a column is written as: text, a number, a yes/no, or empty. */
const writtenValue = z.union([
  z.string().max(64 * 1024),
  z.number(),
  z.boolean(),
  z.null(),
]);
type WrittenValue = z.infer<typeof writtenValue>;

/**
 * An item's columns, as written: a column and its value each, every column
 * once. A list, not a map, so the input's JSON Schema names every key.
 */
const valuesSchema = z
  .array(z.strictObject({ column: columnSchema, value: writtenValue }))
  .min(1)
  .max(64)
  .refine(
    (values) =>
      new Set(values.map(({ column }) => column)).size === values.length,
    "A column is named twice"
  );
type Values = z.infer<typeof valuesSchema>;

/** The fields Graph is sent for `values`. */
const fieldsOf = (values: Values): Record<string, WrittenValue> =>
  Object.fromEntries(values.map(({ column, value }) => [column, value]));

/** Whether a column, as an item holds it, stands as `value`. */
const holds = (held: unknown, value: WrittenValue): boolean =>
  (held ?? null) === value;

/** Columns a write may not set: SharePoint's own, and the views' links. */
const unwritable = (values: Values): string[] =>
  values.map(({ column }) => column).filter((column) => !isOwnColumn(column));

const refuseUnwritable = (values: Values): void => {
  const columns = unwritable(values);
  if (columns.length > 0) {
    throw new ToolError(
      `Only a list's own columns are written: ${columns.join(", ")}`,
      { code: invalidCode }
    );
  }
};

/** An item's columns as `values` names them, as the item holds them. */
const asHeld = (
  fields: Record<string, unknown> | null | undefined,
  values: Values
): Values =>
  values.map(({ column }) => {
    const parsed = writtenValue.safeParse(fields?.[column] ?? null);
    return {
      column,
      value: parsed.success ? parsed.data : JSON.stringify(fields?.[column]),
    };
  });

const itemPath = (site: string, list: string): string =>
  `/sites/${segment(site)}/lists/${segment(list)}/items`;

const addItem = defineTool({
  name: "lists.addItem",
  description:
    "Adds an item to a SharePoint list in a site: a value for each column it sets, by the column's internal name, empty as null.",
  input: z.strictObject({
    site: siteSchema,
    list: listSchema,
    values: valuesSchema,
  }),
  output: z.strictObject({
    site: z.string(),
    list: z.string(),
    item: itemSchema,
  }),
  readOnly: false,
  reach: "company",
  destructive: false,
  resource: "site",
  // Recovery `none`: an item carries no column of ours to find it by, and
  // the same values may rightly be added twice, so an item of unknown
  // outcome stays unknown, for its person to say what became of it.
  routes: [
    { method: "POST", host: graphHost, path: `${sites}/lists/{list}/items` },
  ],
  describe: {
    title: "Add an item to a SharePoint list",
    fields: [
      { label: "Site", input: "site" },
      { label: "List", input: "list" },
      { label: "Item", input: "values" },
    ],
  },
  run: async ({ site, list, values }) => {
    refuseUnwritable(values);
    const added = await graphJson(
      graphUrl(itemPath(site, list)),
      graphListItem,
      jsonBody({ fields: fieldsOf(values) })
    );
    const item = itemOf(added);
    return {
      output: { site, list, item },
      change: { before: null, after: asHeld(added.fields, values) },
    };
  },
});

const updateItem = defineTool({
  name: "lists.updateItem",
  description:
    "Changes columns of an item of a SharePoint list: the columns as read (before), and as they will stand (after), each by its internal name. Refused when the item no longer holds what was read.",
  input: z.strictObject({
    site: siteSchema,
    list: listSchema,
    item: idSchema,
    before: valuesSchema,
    after: valuesSchema,
  }),
  output: z.strictObject({
    site: z.string(),
    list: z.string(),
    item: itemSchema,
  }),
  readOnly: false,
  reach: "company",
  destructive: true,
  resource: "site",
  // Recovery `repeat`: the write sets the columns, and a repeat finds the
  // item already standing as asked and writes nothing. One whose item
  // someone changed meanwhile is refused as any changed item is.
  repeatable: true,
  routes: [
    {
      method: "GET",
      host: graphHost,
      path: `${sites}/lists/{list}/items/{item}`,
    },
    {
      method: "PATCH",
      host: graphHost,
      path: `${sites}/lists/{list}/items/{item}/fields`,
    },
  ],
  describe: {
    title: "Change an item of a SharePoint list",
    fields: [
      { label: "Site", input: "site" },
      { label: "List", input: "list" },
      { label: "Item", input: "item" },
      { label: "Now", input: "before" },
      { label: "Will be", input: "after" },
    ],
  },
  run: async ({ site, list, item: id, before, after }) => {
    refuseUnwritable(after);
    const path = `${itemPath(site, list)}/${segment(id)}`;
    const found = await graphJson(
      graphUrl(path, { $select: itemFields, $expand: "fields" }),
      graphListItem.extend({ "@odata.etag": z.string().nullish() })
    );
    const fields = found.fields ?? {};
    if (after.every(({ column, value }) => holds(fields[column], value))) {
      // Already as asked: a repeat of this call, or a change to what is.
      // Nothing is written, so no change is said.
      return { output: { site, list, item: itemOf(found) } };
    }
    if (!before.every(({ column, value }) => holds(fields[column], value))) {
      throw new ToolError(
        "The item no longer holds what was read: read it again",
        { code: "conflict" }
      );
    }
    // Only the item as it was checked: if anyone changed it since, Graph
    // refuses the write (412) instead.
    const etag = found["@odata.etag"];
    const written = await graphJson(
      graphUrl(`${path}/fields`),
      z.record(z.string(), z.json()),
      {
        ...jsonBody(fieldsOf(after)),
        method: "PATCH",
        ...(etag === null || etag === undefined
          ? {}
          : {
              headers: { "content-type": "application/json", "if-match": etag },
            }),
      }
    );
    return {
      output: { site, list, item: itemOf({ ...found, fields: written }) },
      change: {
        before: asHeld(fields, after),
        after: asHeld(written, after),
      },
    };
  },
});

export const listTools = [listItems, addItem, updateItem];
