import { isValidIdentifier } from "@babel/types";

import { AppDefinitionError } from "./app.ts";
import {
  evaluateExpression,
  ExpressionError,
} from "./definition-expression.ts";
import {
  definitionManifest,
  peoplePermission,
  permissionDataSchema,
  readDefinition,
} from "./definition.ts";
import type {
  AppDefinition,
  DefinedAnswer,
  DefinedField,
  DefinedPermission,
  DefinedRule,
  DefinedTable,
} from "./definition.ts";
import {
  isBrowserPermission,
  isPermission,
  isWorkflowPermission,
  permission,
  PermissionDefinitionError,
} from "./permissions.ts";
import { SchemaDefinitionError } from "./schema.ts";
import type { AccessMode, RowRole } from "./schema.ts";
import { ValueDefinitionError } from "./value-descriptor.ts";
import type { JsonValue, ValueDescriptor } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import { v } from "./values.ts";

// The operations that change an App's definition (definition.ts): what
// the chat's tools and the workspace's Data view make. Each answers the
// definition after it, checked whole (`definitionManifest`), or throws
// `AppDefinitionError` (or a builder's own error) saying what is wrong,
// and changes nothing. Types are given as code would write them
// (`v.string().max(200)`) and permissions as `permission.*(…)`, read by
// `evaluateExpression` over the SDK's own builders.
//
// Tables and fields get IDs as they are added, and keep them: renaming
// changes a name only.

/** A row rule as an operation takes it: its field by name. */
export type RuleInput =
  | { readonly kind: "owner" }
  | { readonly kind: "person" | "team"; readonly field: string }
  | { readonly kind: "role"; readonly role: RowRole };

/** A table's access as an operation takes it. */
export interface AccessInput {
  readonly read: AccessMode;
  readonly write: AccessMode;
  readonly rows?: {
    readonly read?: readonly RuleInput[];
    readonly write?: readonly RuleInput[];
  };
}

/** An operation on a definition. */
export type DefinitionOperation =
  | {
      readonly op: "addTable";
      readonly name: string;
      /** Its fields, each a `v` expression, by name. */
      readonly fields?: Readonly<Record<string, string>>;
      readonly access?: AccessInput;
    }
  | {
      readonly op: "addField";
      readonly table: string;
      readonly name: string;
      readonly type: string;
      /** The value records the table holds already take. */
      readonly answer?: JsonValue;
    }
  | {
      readonly op: "changeField";
      readonly table: string;
      readonly field: string;
      readonly type: string;
      /** The value records that don't fit the new type take, where they lack one. */
      readonly answer?: JsonValue;
    }
  | {
      readonly op: "renameField";
      readonly table: string;
      readonly field: string;
      readonly name: string;
    }
  | {
      readonly op: "setAccess";
      readonly table: string;
      readonly access: AccessInput;
      readonly sensitive?: boolean;
    }
  | {
      readonly op: "addIndex";
      readonly table: string;
      /** Its name; a search index has none, as a table has one. */
      readonly name?: string;
      /** The fields it orders by, or, with `search`, the text fields it searches. */
      readonly fields: readonly string[];
      readonly search?: boolean;
    }
  | {
      readonly op: "addPermission";
      /** A `permission.*(…)` expression, or `people`. */
      readonly permission: string;
    }
  | { readonly op: "removeTable"; readonly table: string }
  | {
      readonly op: "removeField";
      readonly table: string;
      readonly field: string;
    }
  | {
      readonly op: "removeIndex";
      readonly table: string;
      /** The index's name; the search index, which has none, with `search`. */
      readonly name?: string;
      readonly search?: boolean;
    }
  | { readonly op: "removePermission"; readonly alias: string }
  | {
      readonly op: "addPreference" | "changePreference";
      readonly name: string;
      readonly type: string;
    }
  | { readonly op: "removePreference"; readonly name: string }
  | {
      readonly op: "moveField";
      readonly table: string;
      readonly field: string;
      /** Where it goes among the table's fields, from 0. */
      readonly to: number;
    };

const refuse = (message: string): never => {
  throw new AppDefinitionError(message);
};

/** The table named `name`. */
const tableNamed = (definition: AppDefinition, name: string): DefinedTable =>
  definition.tables.find((table) => table.name === name) ??
  refuse(
    `The App has no table \`${name}\`. Its tables: ${definition.tables.map((table) => `\`${table.name}\``).join(", ") || "none yet"}.`
  );

/** The field of `table` named `name`. */
const fieldNamed = (table: DefinedTable, name: string): DefinedField =>
  table.fields.find((field) => field.name === name) ??
  refuse(
    `\`${table.name}\` has no field \`${name}\`. Its fields: ${table.fields.map((field) => `\`${field.name}\``).join(", ") || "none yet"}.`
  );

/** The ID of the field of `table` an index or rule names, or a managed one. */
const fieldId = (table: DefinedTable, name: string): string =>
  name === "_createdAt" || name === "_updatedAt"
    ? name
    : fieldNamed(table, name).id;

/** The descriptor a `v` expression declares. */
export const typeFrom = (source: string): ValueDescriptor =>
  structuredClone(descriptorOf(evaluateExpression(source, { v })));

/** `definition` with `table` in place of the table with its ID. */
const withTable = (
  definition: AppDefinition,
  table: DefinedTable
): AppDefinition => ({
  ...definition,
  tables: definition.tables.map((held) =>
    held.id === table.id ? table : held
  ),
});

/** `answers` with `answer` for `table`'s `field`, in place of any before. */
const withAnswer = (
  answers: readonly DefinedAnswer[],
  table: DefinedTable,
  field: DefinedField,
  value: JsonValue | undefined
): readonly DefinedAnswer[] =>
  value === undefined
    ? answers
    : [
        ...answers.filter(
          (answer) => answer.table !== table.id || answer.field !== field.id
        ),
        { table: table.id, field: field.id, value },
      ];

/** An access input, its rules' fields by ID. */
const accessFrom = (table: DefinedTable, access: AccessInput) => {
  const rules = (list: readonly RuleInput[] | undefined) =>
    list?.map((rule): DefinedRule =>
      rule.kind === "person" || rule.kind === "team"
        ? { kind: rule.kind, field: fieldNamed(table, rule.field).id }
        : rule
    );
  const read = rules(access.rows?.read);
  const write = rules(access.rows?.write);
  return {
    read: access.read,
    write: access.write,
    ...(access.rows === undefined
      ? {}
      : {
          rows: {
            ...(read === undefined ? {} : { read }),
            ...(write === undefined ? {} : { write }),
          },
        }),
  };
};

/** The permission a `permission.*(…)` expression, or `people`, declares, as data. */
const permissionFrom = (
  source: string
): { alias: string; data: DefinedPermission } => {
  if (source.trim() === peoplePermission) {
    return {
      alias: peoplePermission,
      data: { "~permission": peoplePermission, alias: peoplePermission },
    };
  }
  const declared = evaluateExpression(source, { permission, v });
  if (
    !isPermission(declared) &&
    !isBrowserPermission(declared) &&
    !isWorkflowPermission(declared)
  ) {
    return refuse(
      "A permission is a `permission.*(…)` declaration, or `people`."
    );
  }
  if (!isValidIdentifier(declared.alias)) {
    return refuse(
      `\`${declared.alias}\` can't be a permission's alias: it is a word JavaScript keeps.`
    );
  }
  // A declaration is JSON data, which `readPermissionDeclaration` reads back.
  return {
    alias: declared.alias,
    data: permissionDataSchema.parse(structuredClone(declared)),
  };
};

/** `definition` with the index `operation` adds: a named one, or its table's search index. */
const withIndex = (
  definition: AppDefinition,
  operation: Extract<DefinitionOperation, { op: "addIndex" }>
): AppDefinition => {
  const table = tableNamed(definition, operation.table);
  const fields = operation.fields.map((name) => fieldId(table, name));
  if (operation.search === true) {
    if (operation.name !== undefined) {
      return refuse(
        "A search index has no name: a table has one, which `ctx.db.search` reads. Leave `name` out."
      );
    }
    if (table.searchIndex !== undefined) {
      return refuse(
        `\`${table.name}\` has a search index already: a table has one, over every text field it searches.`
      );
    }
    return withTable(definition, { ...table, searchIndex: fields });
  }
  if (operation.name === undefined) {
    return refuse("An index has a name, which `.withIndex(name)` reads.");
  }
  return withTable(definition, {
    ...table,
    indexes: [...table.indexes, { name: operation.name, fields }],
  });
};

/**
 * The table named `name` gone, with its answers. Its records stay in the
 * App's store, never dropped (schema-plan.ts): a table of that name added
 * again later is a new table, with an ID of its own.
 */
const withoutTable = (
  definition: AppDefinition,
  name: string
): AppDefinition => {
  const table = tableNamed(definition, name);
  return {
    ...definition,
    tables: definition.tables.filter(({ id }) => id !== table.id),
    answers: definition.answers.filter((answer) => answer.table !== table.id),
  };
};

/** What in `table` reads `field`: its indexes, its search index, its row rules. */
const readersOf = (table: DefinedTable, field: DefinedField): string[] => {
  const rules = [
    ...(table.access.rows?.read ?? []),
    ...(table.access.rows?.write ?? []),
  ];
  return [
    ...table.indexes.flatMap((index) =>
      index.fields.includes(field.id) ? [`the index \`${index.name}\``] : []
    ),
    ...(table.searchIndex?.includes(field.id) === true
      ? ["the search index"]
      : []),
    ...(rules.some((rule) => "field" in rule && rule.field === field.id)
      ? ["a row rule"]
      : []),
  ];
};

/**
 * `table`'s field named `name` gone, with its answers; refused while an
 * index, the search index or a row rule reads it, each named. Its values
 * stay in the records, as a table's do.
 */
const withoutField = (
  definition: AppDefinition,
  table: DefinedTable,
  name: string
): AppDefinition => {
  const field = fieldNamed(table, name);
  const readers = readersOf(table, field);
  if (readers.length > 0) {
    return refuse(
      `\`${table.name}.${field.name}\` is read by ${readers.join(", ")}: remove or change ${readers.length === 1 ? "it" : "them"} first.`
    );
  }
  return {
    ...withTable(definition, {
      ...table,
      fields: table.fields.filter(({ id }) => id !== field.id),
    }),
    answers: definition.answers.filter(
      (answer) => answer.table !== table.id || answer.field !== field.id
    ),
  };
};

/** `definition` without the index `operation` names, or its table's search index. */
const withoutIndex = (
  definition: AppDefinition,
  operation: Extract<DefinitionOperation, { op: "removeIndex" }>
): AppDefinition => {
  const table = tableNamed(definition, operation.table);
  if (operation.search === true) {
    if (table.searchIndex === undefined) {
      return refuse(`\`${table.name}\` has no search index.`);
    }
    const { searchIndex: _removed, ...rest } = table;
    return withTable(definition, rest);
  }
  if (!table.indexes.some((index) => index.name === operation.name)) {
    return refuse(
      `\`${table.name}\` has no index \`${operation.name ?? ""}\`. Its indexes: ${table.indexes.map((index) => `\`${index.name}\``).join(", ") || "none"}.`
    );
  }
  return withTable(definition, {
    ...table,
    indexes: table.indexes.filter((index) => index.name !== operation.name),
  });
};

/** `definition` without the permission whose alias is `alias`. */
const withoutPermission = (
  definition: AppDefinition,
  alias: string
): AppDefinition => {
  if (!definition.permissions.some((held) => held.alias === alias)) {
    return refuse(
      `The App has no permission \`${alias}\`. Its permissions: ${definition.permissions.map((held) => `\`${typeof held.alias === "string" ? held.alias : ""}\``).join(", ") || "none yet"}.`
    );
  }
  return {
    ...definition,
    permissions: definition.permissions.filter((held) => held.alias !== alias),
  };
};

/** `definition` without what a removal names. */
const removed = (
  definition: AppDefinition,
  operation: Extract<
    DefinitionOperation,
    { op: "removeTable" | "removeField" | "removeIndex" | "removePermission" }
  >
): AppDefinition => {
  switch (operation.op) {
    case "removeTable": {
      return withoutTable(definition, operation.table);
    }
    case "removeField": {
      return withoutField(
        definition,
        tableNamed(definition, operation.table),
        operation.field
      );
    }
    case "removeIndex": {
      return withoutIndex(definition, operation);
    }
    case "removePermission": {
      return withoutPermission(definition, operation.alias);
    }
    default: {
      return refuse("That isn't a removal from a definition.");
    }
  }
};

/**
 * `definition` with `operation`'s field moved to its place among its
 * table's fields: the order the generated schema, and every grid, lists
 * them in. Nothing a record holds changes.
 */
const withFieldMoved = (
  definition: AppDefinition,
  operation: Extract<DefinitionOperation, { op: "moveField" }>
): AppDefinition => {
  const table = tableNamed(definition, operation.table);
  const field = fieldNamed(table, operation.field);
  if (
    !Number.isInteger(operation.to) ||
    operation.to < 0 ||
    operation.to >= table.fields.length
  ) {
    return refuse(
      `\`${table.name}\` has ${table.fields.length} fields: a field moves to a place from 0 to ${table.fields.length - 1}.`
    );
  }
  const rest = table.fields.filter(({ id }) => id !== field.id);
  return withTable(definition, {
    ...table,
    fields: [
      ...rest.slice(0, operation.to),
      field,
      ...rest.slice(operation.to),
    ],
  });
};

/** The preference named `name`. */
const preferenceNamed = (
  definition: AppDefinition,
  name: string
): DefinedField =>
  definition.preferences.find((preference) => preference.name === name) ??
  refuse(
    `The App has no preference \`${name}\`. Its preferences: ${definition.preferences.map((preference) => `\`${preference.name}\``).join(", ") || "none yet"}.`
  );

/** `definition` with the change of its preferences `operation` makes. */
const withPreference = (
  definition: AppDefinition,
  operation: Extract<
    DefinitionOperation,
    { op: "addPreference" | "changePreference" | "removePreference" }
  >,
  newId: () => string
): AppDefinition => {
  if (operation.op === "addPreference") {
    if (definition.preferences.some(({ name }) => name === operation.name)) {
      return refuse(
        `The App has a preference \`${operation.name}\` already: change it with changePreference.`
      );
    }
    return {
      ...definition,
      preferences: [
        ...definition.preferences,
        { id: newId(), name: operation.name, type: typeFrom(operation.type) },
      ],
    };
  }
  const held = preferenceNamed(definition, operation.name);
  if (operation.op === "removePreference") {
    return {
      ...definition,
      preferences: definition.preferences.filter(({ id }) => id !== held.id),
    };
  }
  const type = typeFrom(operation.type);
  return {
    ...definition,
    preferences: definition.preferences.map((preference) =>
      preference.id === held.id ? { ...preference, type } : preference
    ),
  };
};

/** `definition` with the table `operation` adds, with new IDs from `newId`. */
const withNewTable = (
  definition: AppDefinition,
  operation: Extract<DefinitionOperation, { op: "addTable" }>,
  newId: () => string
): AppDefinition => {
  if (definition.tables.some((table) => table.name === operation.name)) {
    return refuse(`The App has a table \`${operation.name}\` already.`);
  }
  const table: DefinedTable = {
    id: newId(),
    name: operation.name,
    fields: Object.entries(operation.fields ?? {}).map(([name, type]) => ({
      id: newId(),
      name,
      type: typeFrom(type),
    })),
    indexes: [],
    access: { read: "none", write: "none" },
  };
  return {
    ...definition,
    tables: [
      ...definition.tables,
      operation.access === undefined
        ? table
        : { ...table, access: accessFrom(table, operation.access) },
    ],
  };
};

/** `definition` with the access `operation` sets on its table. */
const withAccess = (
  definition: AppDefinition,
  operation: Extract<DefinitionOperation, { op: "setAccess" }>
): AppDefinition => {
  const table = tableNamed(definition, operation.table);
  // Once declared sensitive, a table stays so: the store keeps its
  // values out of the change history for good.
  if (table.sensitive === true && operation.sensitive === false) {
    return refuse(
      `\`${table.name}\` is sensitive, and a table stays so once declared: leave \`sensitive\` out.`
    );
  }
  return withTable(definition, {
    ...table,
    access: accessFrom(table, operation.access),
    ...(operation.sensitive === true ? { sensitive: true as const } : {}),
  });
};

/** The definition after `operation`, before it is checked. */
const applied = (
  definition: AppDefinition,
  operation: DefinitionOperation,
  newId: () => string
): AppDefinition => {
  switch (operation.op) {
    case "addTable": {
      return withNewTable(definition, operation, newId);
    }
    case "addField": {
      const table = tableNamed(definition, operation.table);
      if (table.fields.some((field) => field.name === operation.name)) {
        return refuse(
          `\`${table.name}\` has a field \`${operation.name}\` already: change it with changeField.`
        );
      }
      const field = {
        id: newId(),
        name: operation.name,
        type: typeFrom(operation.type),
      };
      return {
        ...withTable(definition, {
          ...table,
          fields: [...table.fields, field],
        }),
        answers: withAnswer(definition.answers, table, field, operation.answer),
      };
    }
    case "changeField": {
      const table = tableNamed(definition, operation.table);
      const field = fieldNamed(table, operation.field);
      const changed = { ...field, type: typeFrom(operation.type) };
      return {
        ...withTable(definition, {
          ...table,
          fields: table.fields.map((held) =>
            held.id === field.id ? changed : held
          ),
        }),
        answers: withAnswer(definition.answers, table, field, operation.answer),
      };
    }
    case "renameField": {
      const table = tableNamed(definition, operation.table);
      const field = fieldNamed(table, operation.field);
      if (table.fields.some((held) => held.name === operation.name)) {
        return refuse(
          `\`${table.name}\` has a field \`${operation.name}\` already.`
        );
      }
      // Its answer, by the field's ID, stays: the records it fills are
      // the same under either name.
      return withTable(definition, {
        ...table,
        fields: table.fields.map((held) =>
          held.id === field.id ? { ...held, name: operation.name } : held
        ),
      });
    }
    case "moveField": {
      return withFieldMoved(definition, operation);
    }
    case "setAccess": {
      return withAccess(definition, operation);
    }
    case "addIndex": {
      return withIndex(definition, operation);
    }
    case "addPermission": {
      const declared = permissionFrom(operation.permission);
      if (
        definition.permissions.some((held) => held.alias === declared.alias)
      ) {
        return refuse(
          `The App has a permission \`${declared.alias}\` already.`
        );
      }
      return {
        ...definition,
        permissions: [...definition.permissions, declared.data],
      };
    }
    case "removeTable":
    case "removeField":
    case "removeIndex":
    case "removePermission": {
      return removed(definition, operation);
    }
    case "addPreference":
    case "changePreference":
    case "removePreference": {
      return withPreference(definition, operation, newId);
    }
    default: {
      return refuse("That isn't an operation on a definition.");
    }
  }
};

/**
 * `definition` after `operation` (see the header), checked whole, with
 * new IDs from `newId`. Throws for an operation that can't be made, or
 * that would leave the definition incoherent, saying why.
 */
export const applyOperation = (
  definition: AppDefinition,
  operation: DefinitionOperation,
  newId: () => string = () => crypto.randomUUID()
): AppDefinition => {
  const next = applied(definition, operation, newId);
  definitionManifest(next);
  return next;
};

/** The errors the builders refuse a definition with: what was wrong. */
const definitionErrors = [
  AppDefinitionError,
  ExpressionError,
  PermissionDefinitionError,
  SchemaDefinitionError,
  ValueDefinitionError,
];

/** What `make` makes, or the problem a builder refused it with, in words. */
const attempt = (
  make: () => AppDefinition
): { definition: AppDefinition } | { problem: string } => {
  try {
    return { definition: make() };
  } catch (error) {
    if (definitionErrors.some((type) => error instanceof type)) {
      return {
        problem: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
};

/**
 * `applyOperation`, its refusal answered as data: the problem, in words,
 * where an operation can't be made. Anything else still throws.
 */
export const tryOperation = (
  definition: AppDefinition,
  operation: DefinitionOperation,
  newId?: () => string
): { definition: AppDefinition } | { problem: string } =>
  attempt(() => applyOperation(definition, operation, newId));

/** `readDefinition`, its refusal answered as data, as `tryOperation`'s is. */
export const tryReadDefinition = (
  text: string
): { definition: AppDefinition } | { problem: string } =>
  attempt(() => readDefinition(text));
