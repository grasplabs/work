import { stableIdPattern } from "@grasp-os/shared/store-limits";
import { z } from "zod";

import { AppDefinitionError } from "./app-definition-error.ts";
import type { App, AppManifest, AppPermissions } from "./app-types.ts";
import { defineApp, inspectApp, registerApp } from "./app.ts";
import { isOverBytes, refuser } from "./declaration.ts";
import { defineSchema } from "./define-schema.ts";
import { defineTable } from "./define-table.ts";
import { readPermissionDeclaration } from "./permission-read.ts";
import type { AnyTable, SchemaDefinition } from "./schema-types.ts";
import type {
  AccessMode,
  RowRole,
  RowRule,
  TableAccess,
} from "./table-access.ts";
import type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// An App's definition: what it is, as data. Its name, the
// permissions it needs, and its data model:
// tables, their fields, indexes and access, and its answers for a change
// of the schema. Grasp stores it with the App's files (`definition.json`)
// and generates the App's config (`grasp.config.ts`) and schema
// (`server/schema.ts`) from it (definition-source.ts): what it does is
// code, and only code runs, is sealed and is exported.
//
// Every table and field has an ID that never changes. A rename changes a
// name only; indexes, row rules and answers name fields by their IDs, so
// a rename never leaves one pointing at nothing.
//
// A definition is checked whole, by declaring it as code would
// (`definitionApp`): the builders check every name, type, index, rule and
// permission exactly as they check code, so a definition that reads is
// one the generated files declare.

/** A table's field: its ID, its name and its type. */
export interface DefinedField {
  readonly id: string;
  readonly name: string;
  readonly type: ValueDescriptor;
}

/** An index: its name, and the fields it orders by, by ID (or `_createdAt`, `_updatedAt`). */
interface DefinedIndex {
  readonly name: string;
  readonly fields: readonly string[];
}

/** A row rule, its field (for `person` and `team`) by ID. */
export type DefinedRule =
  | { readonly kind: "owner" }
  | { readonly kind: "person" | "team"; readonly field: string }
  | { readonly kind: "role"; readonly role: RowRole };

/** A table's access: its modes, and its row rules. */
interface DefinedAccess {
  readonly read: AccessMode;
  readonly write: AccessMode;
  readonly rows?: {
    readonly read?: readonly DefinedRule[];
    readonly write?: readonly DefinedRule[];
  };
}

/** A table: its ID, its name, its fields, its indexes and its access. */
export interface DefinedTable {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly DefinedField[];
  readonly indexes: readonly DefinedIndex[];
  /** The text fields its search index covers, by ID; none without one. */
  readonly searchIndex?: readonly string[];
  readonly sensitive?: true;
  readonly access: DefinedAccess;
}

/** A value for the records that lack a field (`SchemaAnswer`), by IDs. */
export interface DefinedAnswer {
  readonly table: string;
  readonly field: string;
  readonly value: FrozenJson;
}

/**
 * A permission, as a declaration's data (`permission.*` makes it), or
 * `{ "~permission": "people" }`: the App reads the organization's people.
 */
export type DefinedPermission = Readonly<Record<string, FrozenJson>>;

/** An App's definition (see the header). */
export interface AppDefinition {
  readonly name: string;
  readonly permissions: readonly DefinedPermission[];
  readonly tables: readonly DefinedTable[];
  readonly answers: readonly DefinedAnswer[];
}

/** Where an App's definition is, among its files. */
export const definitionPath = "definition.json";

/** The files generated from an App's definition, which only Grasp writes. */
export const generatedFiles = {
  config: "grasp.config.ts",
  schema: "server/schema.ts",
} as const;

/** The most bytes of a definition's text. */
const definitionMaxBytes = 1024 * 1024;

/** The kind of the permission that says the App reads people. */
export const peoplePermission = "people";

/** An ID: what a definition names a table or field by, forever. */
const idSchema = z.string().regex(stableIdPattern);

const ruleSchema = z.union([
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.enum(["person", "team"]), field: idSchema }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.enum(["builder", "user"]),
  }),
]);

const fieldSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  type: z.unknown(),
});

const modeSchema = z.enum(["owner", "appMembers", "appBuilders", "none"]);

const json: z.ZodType<FrozenJson> = z.json();

/** A permission's data, as a declaration is: JSON, by key. */
export const permissionDataSchema = z.record(z.string(), json);

const definitionSchema = z.strictObject({
  name: z.string(),
  permissions: z.array(permissionDataSchema),
  tables: z.array(
    z.strictObject({
      id: idSchema,
      name: z.string(),
      fields: z.array(fieldSchema),
      indexes: z.array(
        z.strictObject({ name: z.string(), fields: z.array(z.string()) })
      ),
      searchIndex: z.array(idSchema).optional(),
      sensitive: z.literal(true).optional(),
      access: z.strictObject({
        read: modeSchema,
        write: modeSchema,
        rows: z
          .strictObject({
            read: z.array(ruleSchema).optional(),
            write: z.array(ruleSchema).optional(),
          })
          .optional(),
      }),
    })
  ),
  answers: z.array(
    z.strictObject({ table: idSchema, field: idSchema, value: json })
  ),
});

const refuse: (message: string) => never = refuser(AppDefinitionError);

/** The one item of `items` with ID `id`, or a refusal naming `what`. */
const byId = <Item extends { readonly id: string }>(
  items: readonly Item[],
  id: string,
  what: string
): Item =>
  items.find((item) => item.id === id) ??
  refuse(`The definition names ${what} \`${id}\`, which it doesn't have.`);

/** Refuses two of `items` with one ID. */
const requireUniqueIds = (
  items: readonly { readonly id: string }[],
  what: string
): void => {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) {
      refuse(`Two ${what} have ID \`${id}\`.`);
    }
    seen.add(id);
  }
};

/** The managed fields an index may name by their own names. */
const managedIndexFields: ReadonlySet<string> = new Set([
  "_createdAt",
  "_updatedAt",
]);

/** A field's name, from its ID or a managed field's name. */
const fieldName = (table: DefinedTable, field: string): string =>
  managedIndexFields.has(field)
    ? field
    : byId(table.fields, field, `in \`${table.name}\` field`).name;

/** A row rule with its field named, as `rows` makes it. */
const ruleOf = (table: DefinedTable, rule: DefinedRule): RowRule =>
  rule.kind === "person" || rule.kind === "team"
    ? { kind: rule.kind, field: fieldName(table, rule.field) }
    : rule;

/** A table's access as `.access` takes it, its fields named. */
export const accessOf = (table: DefinedTable): TableAccess => {
  const { read, write, rows } = table.access;
  if (rows === undefined) {
    return { read, write };
  }
  const named = (list: readonly DefinedRule[] | undefined) =>
    list?.map((rule) => ruleOf(table, rule));
  const readRules = named(rows.read);
  const writeRules = named(rows.write);
  // SAFETY: `.access` checks the rules (at least one a direction) at run
  // time, as it checks code's.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return {
    read,
    write,
    rows: {
      ...(readRules === undefined ? {} : { read: readRules }),
      ...(writeRules === undefined ? {} : { write: writeRules }),
    },
  } as TableAccess;
};

/** A descriptor's schema, its structure checked as a manifest's is. */
const typeOf = (field: DefinedField): AnySchema =>
  schemaOf(readDescriptor(field.type, 1, { nodes: 0 }));

/** An index's or search index's fields, named. */
export const indexFieldNames = (
  table: DefinedTable,
  fields: readonly string[]
): string[] => fields.map((field) => fieldName(table, field));

/** The fields of `fields` by name, as schemas. */
const shapeOf = (
  fields: readonly DefinedField[]
): Record<string, AnySchema> => {
  const shape: Record<string, AnySchema> = {};
  for (const field of fields) {
    if (Object.hasOwn(shape, field.name)) {
      refuse(`Two fields are named \`${field.name}\`.`);
    }
    Object.defineProperty(shape, field.name, {
      enumerable: true,
      value: typeOf(field),
    });
  }
  return shape;
};

/** A table loose enough to chain as a manifest's are declared. */
interface ChainedTable extends AnyTable {
  readonly index: (name: string, fields: readonly string[]) => ChainedTable;
  readonly searchIndex: (fields: readonly string[]) => ChainedTable;
  readonly sensitive: () => ChainedTable;
  readonly access: (access: TableAccess) => ChainedTable;
}

// SAFETY: `defineTable` and its chain check at run time all their types
// check: a definition's names are only known then.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const declareTable = defineTable as (
  fields: Readonly<Record<string, AnySchema>>
) => ChainedTable;

/** A table of the definition, declared as `server/schema.ts` declares it. */
const tableOf = (table: DefinedTable): AnyTable => {
  let declared = declareTable(shapeOf(table.fields));
  for (const index of table.indexes) {
    declared = declared.index(index.name, indexFieldNames(table, index.fields));
  }
  if (table.searchIndex !== undefined) {
    declared = declared.searchIndex(indexFieldNames(table, table.searchIndex));
  }
  if (table.sensitive === true) {
    declared = declared.sensitive();
  }
  return declared.access(accessOf(table));
};

/** The definition's permissions, by kind, as `defineApp` takes them. */
const definedPermissions = (definition: AppDefinition): AppPermissions => {
  const permissions: Record<string, unknown> = {};
  const listed = new Map<string, unknown[]>();
  for (const data of definition.permissions) {
    if (data["~permission"] === peoplePermission) {
      permissions.people = true;
      continue;
    }
    const declared = readPermissionDeclaration(data);
    const kind = declared["~permission"];
    if (kind === "connections" || kind === "workflows") {
      const list = listed.get(kind) ?? [];
      list.push(declared);
      listed.set(kind, list);
      permissions[kind] = list;
    } else if (permissions[kind] === undefined) {
      permissions[kind] = declared;
    } else {
      refuse(`The App holds one \`${kind}\` permission.`);
    }
  }
  // `defineApp` checks every kind and declaration at run time.
  return permissions;
};

/** The definition's answers, their table and field named. */
export const answersOf = (definition: AppDefinition) =>
  definition.answers.map(({ table, field, value }) => {
    const defined = byId(definition.tables, table, "table");
    return {
      table: defined.name,
      field: byId(defined.fields, field, `in \`${defined.name}\` field`).name,
      value,
    };
  });

/** The App a definition declares: its config and its schema, as code would. */
export const definitionApp = (
  definition: AppDefinition
): { config: App; schema: SchemaDefinition } => {
  requireUniqueIds(definition.tables, "tables");
  for (const table of definition.tables) {
    requireUniqueIds(table.fields, `fields of \`${table.name}\``);
  }
  const tables: Record<string, AnyTable> = {};
  for (const table of definition.tables) {
    if (Object.hasOwn(tables, table.name)) {
      refuse(`Two tables are named \`${table.name}\`.`);
    }
    Object.defineProperty(tables, table.name, {
      enumerable: true,
      value: tableOf(table),
    });
  }
  const answers = answersOf(definition);
  const config = defineApp({
    name: definition.name,
    permissions: definedPermissions(definition),
    ...(answers.length === 0 ? {} : { answers }),
  });
  // SAFETY: `defineSchema` checks the tables, and their references, at
  // run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const schema = defineSchema(tables as never) as SchemaDefinition;
  return { config, schema };
};

/**
 * The manifest of what a definition declares, with no functions: what its
 * schema plans compare (core's schema-changes.ts). Throws the builders' errors for
 * a definition that isn't coherent.
 */
export const definitionManifest = (definition: AppDefinition): AppManifest =>
  inspectApp(
    registerApp({ ...definitionApp(definition), modules: {}, migrations: [] })
  ).manifest;

/**
 * The definition `text` holds, checked whole (`definitionManifest`):
 * throws `AppDefinitionError`, or the builders' own errors, for text that
 * isn't one.
 */
export const readDefinition = (text: string): AppDefinition => {
  if (isOverBytes(text, definitionMaxBytes)) {
    return refuse(`A definition is at most ${definitionMaxBytes} bytes.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse(`${definitionPath} isn't JSON.`);
  }
  const parsed = definitionSchema.safeParse(data);
  if (!parsed.success) {
    return refuse(
      `${definitionPath} isn't a definition: ${z.prettifyError(parsed.error)}`
    );
  }
  // SAFETY: its structure was just checked, and every type is read and
  // checked as a descriptor when it is declared, just below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const definition = parsed.data as AppDefinition;
  definitionManifest(definition);
  return definition;
};

/** A definition's text, as `definition.json` holds it. */
export const definitionText = (definition: AppDefinition): string =>
  `${JSON.stringify(definition, null, 2)}\n`;

/** The definition of a new App named `name`: nothing in it yet. */
export const emptyDefinition = (name: string): AppDefinition => ({
  name,
  permissions: [],
  tables: [],
  answers: [],
});
