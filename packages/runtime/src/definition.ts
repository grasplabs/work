import {
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/function-limits";
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
import { compactDescriptor, descriptorFromCompact } from "./value-compact.ts";
import { isPlainObject, ValueDefinitionError } from "./value-descriptor.ts";
import type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// An App's definition: what it is, as data. Its name, the
// permissions it needs, and its data model:
// tables, their fields, indexes and access, and its answers for a change
// of the schema. Grasp keeps it apart from the App's files, as each
// version's metadata (its text, `definitionText`), and
// generates the App's config (`grasp.config.ts`) and schema
// (`server/schema.ts`) from it (definition-source.ts), one way only: what
// the App does is code, and only code runs, is sealed and is exported.
// Its IDs never appear in code.
//
// Every type in it, a field's or a permission's, is a descriptor in its
// compact form (value-compact.ts) as the text holds it, and the full
// descriptor once read.
//
// Every table and field has an ID that never changes. A rename changes a
// name only; indexes, row rules and answers name fields by their IDs, so
// a rename never leaves one pointing at nothing.
//
// So does each server function a workflow may call (`functions`): its ID
// is what a workflow's grant and its calls name it by, and a rename
// (`renameFunction`) changes its name, the code's path to it, only. Its
// code stays found by that path. Each query and mutation the code exports
// gets an ID as a commit brings it, and loses it once the code no longer
// exports it (`withExportedFunctions`), so a version's definition names
// exactly its code's; a seal reads only those (core's app-definition.ts,
// `functionIdsOf`).
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

/**
 * A server function the App gives a stable ID: its ID, and its name, the
 * path its code exports it at (`server/tasks.ts`'s `create` is
 * `tasks.create`).
 */
export interface DefinedFunction {
  readonly id: string;
  readonly name: string;
}

/**
 * The workflow version a draft bound under a workflow permission's alias
 * (`bindWorkflow`): what making the version current binds (core's
 * app-workflow-bindings.ts). A claim until then: a definition committed
 * by hand may name any, so core checks each again as it binds it.
 */
export interface DefinedWorkflowBinding {
  readonly alias: string;
  readonly workflowId: string;
  readonly version: number;
}

/** An App's definition (see the header). */
export interface AppDefinition {
  readonly name: string;
  readonly permissions: readonly DefinedPermission[];
  readonly tables: readonly DefinedTable[];
  readonly answers: readonly DefinedAnswer[];
  /** The server functions it gives stable IDs; absent while it gives none. */
  readonly functions?: readonly DefinedFunction[];
  /**
   * The workflow versions it binds, by alias, in alias order; absent
   * while it records none. Never part of the code generated from it.
   */
  readonly workflowBindings?: readonly DefinedWorkflowBinding[];
}

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

/**
 * Whether `name` is a server function's path as the SDK makes one
 * (app-functions.ts, `checkPath`): its module's path under `server/` and
 * its export's name, each an identifier of letters, digits and `_` not
 * starting with either of the last two, so `__proto__` is never a
 * segment of one, joined by dots, at most as many and as long as a path
 * may be. A seal checks the rest: that the code exports it.
 */
export const isFunctionPath = (name: string): boolean => {
  const segments = name.split(".");
  return (
    segments.length >= 2 &&
    segments.length <= operationPathMaxSegments &&
    name.length <= operationPathMaxLength &&
    segments.every((segment) => operationSegmentPattern.test(segment))
  );
};

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
  functions: z
    .array(
      z.strictObject({
        id: idSchema,
        name: z.string().refine(isFunctionPath, {
          message:
            "A function's path: its module's path and its export's name, joined by dots",
        }),
      })
    )
    .optional(),
  workflowBindings: z
    .array(
      z.strictObject({
        alias: z.string(),
        workflowId: z.string().min(1).max(128),
        version: z.int().min(1),
      })
    )
    .optional(),
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
 * `data`, a permission's, with each descriptor it holds mapped by `map`:
 * a workflow's `args` and `returns`, its events' `data` and its
 * decisions' `value` and `context`, and the platform's functions' `args`
 * and `returns`. The only kinds whose data holds descriptors.
 */
const permissionTypes = (
  data: DefinedPermission,
  map: (descriptor: unknown) => unknown
): DefinedPermission => {
  const mapped = (value: FrozenJson | undefined): FrozenJson =>
    // SAFETY: a descriptor either way, which is JSON.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    map(value) as FrozenJson;
  const kind = data["~permission"];
  if (kind === "workflows") {
    const each = (
      record: FrozenJson | undefined,
      fields: readonly string[]
    ): FrozenJson =>
      isPlainObject(record)
        ? Object.fromEntries(
            Object.entries(record).map(([name, entry]) => [
              name,
              isPlainObject(entry)
                ? {
                    ...entry,
                    ...Object.fromEntries(
                      fields.map((field) => [field, mapped(entry[field])])
                    ),
                  }
                : entry,
            ])
          )
        : (record ?? {});
    return {
      ...data,
      args: mapped(data.args),
      returns: mapped(data.returns),
      events: each(data.events, ["data"]),
      decisions: each(data.decisions, ["value", "context"]),
    };
  }
  const { functions } = data;
  if (kind !== "grasp" || !isPlainObject(functions)) {
    return data;
  }
  return {
    ...data,
    functions: Object.fromEntries(
      Object.entries(functions).map(([name, declared]) => [
        name,
        isPlainObject(declared)
          ? {
              ...declared,
              args: mapped(declared.args),
              returns: mapped(declared.returns),
            }
          : declared,
      ])
    ),
  };
};

/** `read`'s answer, a refusal naming `where` when its descriptor isn't one. */
const readType = <Read>(where: string, read: () => Read): Read => {
  try {
    return read();
  } catch (error) {
    if (error instanceof ValueDefinitionError) {
      return refuse(`${where}: ${error.message}`);
    }
    throw error;
  }
};

/** A descriptor read from its compact form; `where` names it in a refusal. */
const fromCompact = (where: string, compact: unknown): ValueDescriptor =>
  readType(where, () => descriptorFromCompact(compact));

/** Orders keys as canonical JSON does: by UTF-16 code unit. */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : 1;

/**
 * `value` with every object's keys sorted, as canonical JSON has them,
 * but an object type's `fields` (`{ kind: "object", fields }`), which
 * keep the order their code declares them in: that order is the type's.
 */
const ordered = (value: unknown, declared = false): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => ordered(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  const objectType = Reflect.get(value, "kind") === "object";
  return Object.fromEntries(
    (declared ? entries : entries.toSorted(byKey)).map(([key, item]) => [
      key,
      ordered(item, objectType && key === "fields"),
    ])
  );
};

/**
 * `definition` as its text holds it: every descriptor in its compact
 * form, and no `functions` or `workflowBindings` while it has none, so
 * an App without them has one text, and one hash.
 */
const compactForm = ({
  functions,
  workflowBindings,
  ...definition
}: AppDefinition): unknown => ({
  ...definition,
  ...(functions === undefined || functions.length === 0 ? {} : { functions }),
  ...(workflowBindings === undefined || workflowBindings.length === 0
    ? {}
    : { workflowBindings }),
  permissions: definition.permissions.map((data) =>
    permissionTypes(data, (descriptor) =>
      // SAFETY: a permission's descriptors, as `permission.*` made them.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      compactDescriptor(descriptor as ValueDescriptor)
    )
  ),
  tables: definition.tables.map((table) => ({
    ...table,
    fields: table.fields.map((field) => ({
      ...field,
      type: compactDescriptor(field.type),
    })),
  })),
});

/**
 * The definition `data`, its structure checked, holds: each descriptor
 * read from its compact form, a refusal naming the one that isn't one.
 */
const fullForm = (data: z.output<typeof definitionSchema>): AppDefinition => {
  const { tables, permissions, functions, workflowBindings, ...rest } = data;
  return {
    ...rest,
    ...(functions === undefined || functions.length === 0 ? {} : { functions }),
    ...(workflowBindings === undefined || workflowBindings.length === 0
      ? {}
      : { workflowBindings }),
    permissions: permissions.map((permission) =>
      permissionTypes(permission, (compact) =>
        fromCompact(
          `A \`${JSON.stringify(permission["~permission"])}\` permission`,
          compact
        )
      )
    ),
    tables: tables.map((table) => ({
      ...table,
      fields: table.fields.map((field) => ({
        ...field,
        type: fromCompact(`\`${table.name}.${field.name}\``, field.type),
      })),
    })),
  };
};

/**
 * A definition's text, as Grasp stores, hashes and compares it: its JSON,
 * every descriptor in its compact form (value-compact.ts), in one form,
 * so equal definitions have equal text however the keys of its records
 * and values came in. Its keys are sorted as canonical JSON's are, but an
 * object type's fields (`ordered`): sorting those would reorder the code
 * it generates.
 */
export const definitionText = (definition: AppDefinition): string =>
  JSON.stringify(ordered(compactForm(definition)));

/**
 * `definition` in its one form, its text read back (`definitionText`):
 * what code is generated and declared from, so equal definitions
 * generate the same code however the keys of their values came in (an
 * object default's, say).
 */
export const canonicalDefinition = (definition: AppDefinition): AppDefinition =>
  fullForm(definitionSchema.parse(JSON.parse(definitionText(definition))));

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
export const definitionApp = (
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

/** `data`'s JSON, or undefined for data JSON can't hold. */
const jsonOf = (data: unknown): string | undefined => {
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
};

/**
 * The definition `data` is, checked whole (`definitionManifest`): throws
 * `AppDefinitionError`, or the builders' own errors, for data that isn't
 * one. Its size is checked first, on its JSON, before anything else
 * reads it.
 */
export const readDefinition = (data: unknown): AppDefinition => {
  const text = jsonOf(data);
  if (text === undefined || isOverBytes(text, definitionMaxBytes)) {
    return refuse(
      `A definition is JSON of at most ${definitionMaxBytes} bytes.`
    );
  }
  const parsed = definitionSchema.safeParse(data);
  if (!parsed.success) {
    return refuse(
      `That isn't an App definition: ${z.prettifyError(parsed.error)}`
    );
  }
  const definition = fullForm(parsed.data);
  definitionManifest(definition);
  return canonicalDefinition(definition);
};

/** The definition of a new App named `name`: nothing in it yet. */
export const emptyDefinition = (name: string): AppDefinition => ({
  name,
  permissions: [],
  tables: [],
  answers: [],
});
