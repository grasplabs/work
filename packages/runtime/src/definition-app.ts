import { AppDefinitionError } from "./app-definition-error.ts";
import type { App, AppManifest, AppPermissions } from "./app-types.ts";
import { defineApp, inspectApp, registerApp } from "./app.ts";
import { refuser } from "./declaration.ts";
import { defineSchema } from "./define-schema.ts";
import { defineTable } from "./define-table.ts";
import { canonicalDefinition, parseDefinition } from "./definition-json.ts";
import { peoplePermission } from "./definition-types.ts";
import type {
  AppDefinition,
  DefinedField,
  DefinedRule,
  DefinedTable,
} from "./definition-types.ts";
import { readPermissionDeclaration } from "./permission-read.ts";
import type { AnyTable, SchemaDefinition } from "./schema-types.ts";
import type { RowRule, TableAccess } from "./table-access.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// A definition is checked whole, by declaring it as code would
// (`definitionApp`): the builders check every name, type, index, rule and
// permission exactly as they check code, so a definition that reads is
// one the generated files declare.

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

/** A field's schema, its descriptor sealed again as a manifest's is. */
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

/**
 * Refuses a recorded workflow binding under an alias no workflow
 * permission of the definition has, or two under one alias.
 */
const requireDeclaredBindings = (definition: AppDefinition): void => {
  const bound = new Set<string>();
  for (const { alias } of definition.workflowBindings ?? []) {
    if (bound.has(alias)) {
      refuse(`Two workflow versions are bound as \`${alias}\`.`);
    }
    bound.add(alias);
    if (
      !definition.permissions.some(
        (held) => held.alias === alias && held["~permission"] === "workflows"
      )
    ) {
      refuse(
        `The definition binds a workflow as \`${alias}\`, which it doesn't declare.`
      );
    }
  }
};

/** The App a definition declares: its config and its schema, as code would. */
const definitionApp = (
  declared: AppDefinition
): { config: App; schema: SchemaDefinition } => {
  const definition = canonicalDefinition(declared);
  requireUniqueIds(definition.tables, "tables");
  for (const table of definition.tables) {
    requireUniqueIds(table.fields, `fields of \`${table.name}\``);
  }
  const functions = definition.functions ?? [];
  requireUniqueIds(functions, "functions");
  const named = new Set<string>();
  for (const { name } of functions) {
    if (named.has(name)) {
      refuse(`Two functions are named \`${name}\`.`);
    }
    named.add(name);
  }
  requireDeclaredBindings(definition);
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
 * The definition `data` is, checked whole (`definitionManifest`): throws
 * `AppDefinitionError`, or the builders' own errors, for data that isn't
 * one. Its size is checked first, on its JSON, before anything else
 * reads it.
 */
export const readDefinition = (data: unknown): AppDefinition => {
  const definition = parseDefinition(data);
  definitionManifest(definition);
  return canonicalDefinition(definition);
};
