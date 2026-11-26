import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Infer } from "@grasp-os/sdk/connector";

import {
  checkIds,
  graphId,
  graphPage,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";

// SharePoint lists, in one site per call, as `/sites/{site}`, so a call's
// capability binds every request to its site. Graph answers with the
// person's own SharePoint rights (the token is delegated): a site they
// can't open is refused by Graph, whatever the permission says.
//
// Many registers (contracts, suppliers, assets) are lists rather than
// workbooks. Their items are read, added, and changed only from what was
// read, as an Excel table's rows are: never deleted.

const itemsRoute = "/sites/{site}/lists/{list}/items";
const itemRoute = "/sites/{site}/lists/{list}/items/{item}";
const fieldsRoute = "/sites/{site}/lists/{list}/items/{item}/fields";

/**
 * A site, as Graph's ID gives it: `<host>,<site collection ID>,<web ID>`.
 * Only that one spelling, never a host and path (`host:/sites/Finance:`),
 * which the egress refuses, or `root`, so a site has one name a
 * capability can bind. `checkSite` holds it to that.
 */
const site = v.string().min(5).max(256);

const sitePattern = /^[\w.-]+,[\w-]+,[\w-]+$/u;

/**
 * A list: its ID, or its name as Graph takes it in place of one. As a
 * path parameter the API client holds it to one segment, never `.` or `..`.
 */
const list = v.string().min(1).max(256);

/**
 * A column's internal name (`Status`, `Renewal_x0020_date`), as Graph names
 * it under an item's `fields`: letters, digits and underscores only, so it
 * can't carry anything into the filter it stands in. `checkColumns` holds
 * it to that.
 */
const column = v.string().min(1).max(128);

const columnPattern = /^[A-Za-z_]\w*$/u;

/** Refuses, before anything is sent, a site that isn't a site's ID. */
const checkSite = (value: string): void => {
  if (!sitePattern.test(value)) {
    throw new ToolError("Invalid input: site isn't a SharePoint site's ID", {
      code: "invalid",
    });
  }
};

/**
 * Refuses, before anything is sent, a column that isn't an internal name,
 * and a column named twice.
 */
const checkColumns = (name: string, columns: readonly string[]): void => {
  const wrong = columns.find((each) => !columnPattern.test(each));
  if (wrong !== undefined) {
    throw new ToolError(
      `Invalid input: ${name} names ${JSON.stringify(wrong)}, which isn't a column's internal name`,
      { code: "invalid" }
    );
  }
  if (new Set(columns).size !== columns.length) {
    throw new ToolError(`Invalid input: ${name} names a column twice`, {
      code: "invalid",
    });
  }
};

/**
 * One condition on a column. Graph's `$filter` is built from these, never
 * taken as OData text, so no input can widen it: a value is always a
 * literal.
 */
const condition = v.object({
  column,
  is: v.enum(["eq", "ne", "gt", "ge", "lt", "le"]),
  value: v.union(v.string().max(1024), v.number()),
});

/** A value as an OData literal: a number as is, text quoted, a quote doubled. */
const literalOf = (value: string | number): string =>
  typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;

/** Graph's `$filter` for items whose fields meet every condition. */
const filterOf = (conditions: readonly Infer<typeof condition>[]): string =>
  conditions
    .map(
      ({ column: name, is, value }) =>
        `fields/${name} ${is} ${literalOf(value)}`
    )
    .join(" and ");

/**
 * Lets Graph filter on a column that isn't indexed. It does so for a list
 * of up to 5,000 items; past that it refuses the request, and says why.
 */
const nonIndexedFilter = {
  prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
};

/** An item's columns (Graph's fieldValueSet): any JSON, by column. */
const Fields = v.record(v.json());
type FieldsValue = Infer<typeof Fields>;

const listItemFields = {
  id: v.string(),
  webUrl: v.string().nullable().optional(),
  createdDateTime: v.string().nullable().optional(),
  lastModifiedDateTime: v.string().nullable().optional(),
  fields: Fields.nullable().optional(),
};

/** A list item (Graph's listItem), narrowed to these fields. */
const ListItem = v.object(listItemFields);

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

/** An item's columns: the list's own, and any `select` asked for. */
const ownFields = (
  fields: FieldsValue | null | undefined,
  select: readonly string[] = []
): FieldsValue =>
  Object.fromEntries(
    Object.entries(fields ?? {}).filter(
      ([name]) => isOwnColumn(name) || select.includes(name)
    )
  );

/** A value a column is written as: text, a number, a yes/no, or empty. */
const writtenValue = v.union(
  v.string().max(64 * 1024),
  v.number(),
  v.boolean(),
  v.null()
);
type WrittenValue = Infer<typeof writtenValue>;

/**
 * An item's columns, as written: a column and its value each, every column
 * once. A list, not a map, as a tool's arguments name every key.
 */
const fieldValues = v
  .array(v.object({ column, value: writtenValue }))
  .min(1)
  .max(64);
type FieldValues = Infer<typeof fieldValues>;

/** The fields Graph is sent for `values`. */
const fieldsOf = (values: FieldValues): Record<string, WrittenValue> =>
  Object.fromEntries(values.map(({ column: name, value }) => [name, value]));

/** Whether every column of `values`, as `fields` holds it, stands as given. */
const holdsAll = (fields: FieldsValue, values: FieldValues): boolean =>
  values.every(({ column: name, value }) => (fields[name] ?? null) === value);

/**
 * Refuses, before anything is sent, values that aren't columns, name one
 * twice, or set one of SharePoint's own columns.
 */
const checkWritable = (name: string, values: FieldValues): void => {
  const columns = values.map(({ column: each }) => each);
  checkColumns(name, columns);
  const unwritable = columns.filter((each) => !isOwnColumn(each));
  if (unwritable.length > 0) {
    throw new ToolError(
      `Only a list's own columns are written: ${unwritable.join(", ")}`,
      { code: "invalid" }
    );
  }
};

/** An item's columns as `values` names them, as the item holds them. */
const asHeld = (fields: FieldsValue | null | undefined, values: FieldValues) =>
  values.map(({ column: name }) => ({
    column: name,
    value: fields?.[name] ?? null,
  }));

/**
 * SharePoint list tools, by name: each named from its route
 * (`POST /sites/{site}/lists/{list}/items` is `sites.lists.items.create`).
 */
export const listTools = {
  "sites.lists.items.list": tool({
    description:
      "Lists the items of a SharePoint list in a site, a page at a time, each with its columns by internal name; SharePoint's own bookkeeping columns are left out unless selected. A filter keeps the items that meet every condition on a column; select reads only those columns.",
    readOnly: true,
    reach: "company",
    scopes: ["Sites.Read.All"],
    resource: "site",
    routes: [`GET ${itemsRoute}`],
    args: {
      site,
      list,
      filter: v.array(condition).min(1).max(8).optional(),
      select: v.array(column).min(1).max(32).optional(),
      top,
      next,
    },
    returns: page(ListItem),
    handler: async (args, api) => {
      const { filter, select } = args;
      checkSite(args.site);
      checkColumns(
        "filter",
        (filter ?? []).map(({ column: name }) => name)
      );
      checkColumns("select", select ?? []);
      const answer = await api.get(itemsRoute, {
        path: { site: args.site, list: args.list },
        query: {
          $select: itemFields,
          $expand:
            select === undefined
              ? "fields"
              : `fields($select=${select.join(",")})`,
          $filter: filter === undefined ? undefined : filterOf(filter),
          $top: args.top ?? 50,
          ...positionOf(args.next),
        },
        ...(filter === undefined ? {} : { headers: nonIndexedFilter }),
        returns: graphPage(ListItem),
      });
      return {
        items: answer.value.map((item) => ({
          ...item,
          fields: ownFields(item.fields, select),
        })),
        next: nextOf(answer["@odata.nextLink"]),
      };
    },
  }),
  "sites.lists.items.create": tool({
    description:
      "Adds an item to a SharePoint list in a site: a value for each column it sets, by the column's internal name, empty as null. SharePoint's own columns aren't set.",
    readOnly: false,
    reach: "company",
    scopes: ["Sites.ReadWrite.All"],
    resource: "site",
    // No recovery: an item carries no column of ours to find it by, and the
    // same values may rightly be added twice, so an item of unknown outcome
    // stays unknown, for its person to say what became of it.
    routes: [`POST ${itemsRoute}`],
    args: { site, list, fields: fieldValues },
    returns: ListItem,
    describe: {
      title: "Add an item to a SharePoint list",
      fields: [
        { label: "Site", arg: "site" },
        { label: "List", arg: "list" },
        { label: "Item", arg: "fields" },
      ],
    },
    handler: async (args, api, call) => {
      checkSite(args.site);
      checkWritable("fields", args.fields);
      const added = await api.post(itemsRoute, {
        path: { site: args.site, list: args.list },
        body: { fields: fieldsOf(args.fields) },
        returns: ListItem,
      });
      call.changed({ before: null, after: asHeld(added.fields, args.fields) });
      return { ...added, fields: ownFields(added.fields) };
    },
  }),
  "sites.lists.items.fields.update": tool({
    description:
      "Changes columns of an item of a SharePoint list: its columns as read (before), and as they will stand (fields), each by its internal name. Refused when the item no longer holds what was read, or someone changes it before the write.",
    readOnly: false,
    reach: "company",
    scopes: ["Sites.ReadWrite.All"],
    resource: "site",
    routes: [`PATCH ${fieldsRoute}`, `GET ${itemRoute}`],
    args: {
      site,
      list,
      item: graphId,
      before: fieldValues,
      fields: fieldValues,
    },
    returns: ListItem,
    // The write sets the columns, and a repeat finds the item already
    // standing as asked and writes nothing. One whose item someone changed
    // meanwhile is refused as any changed item is.
    repeatable: true,
    describe: {
      title: "Change an item of a SharePoint list",
      fields: [
        { label: "Site", arg: "site" },
        { label: "List", arg: "list" },
        { label: "Item", arg: "item" },
        { label: "Now", arg: "before" },
        { label: "Will be", arg: "fields" },
      ],
    },
    handler: async (args, api, call) => {
      const { before, fields } = args;
      checkSite(args.site);
      checkIds({ item: args.item });
      checkColumns(
        "before",
        before.map(({ column: name }) => name)
      );
      checkWritable("fields", fields);
      const path = { site: args.site, list: args.list, item: args.item };
      const found = await api.get(itemRoute, {
        path,
        query: { $select: itemFields, $expand: "fields" },
        returns: v.object({
          ...listItemFields,
          "@odata.etag": v.string().nullable().optional(),
        }),
      });
      const { "@odata.etag": etag, ...item } = found;
      const held = item.fields ?? {};
      if (holdsAll(held, fields)) {
        // Already as asked: a repeat of this call, or a change to what is.
        // Nothing is written, so no change is said.
        return { ...item, fields: ownFields(held) };
      }
      if (!holdsAll(held, before)) {
        throw new ToolError(
          "The item no longer holds what was read: read it again",
          { code: "conflict" }
        );
      }
      // Only the item as it was checked: if anyone changed it since, Graph
      // refuses the write (412) instead.
      const written = await api.patch(fieldsRoute, {
        path,
        body: fieldsOf(fields),
        ...(etag === null || etag === undefined
          ? {}
          : { headers: { "if-match": etag } }),
        returns: Fields,
      });
      call.changed({
        before: asHeld(held, fields),
        after: asHeld(written, fields),
      });
      return { ...item, fields: ownFields(written) };
    },
  }),
};
