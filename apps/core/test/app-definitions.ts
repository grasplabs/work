import type { ValueDescriptor } from "@grasp-os/sdk";
import {
  applyOperation,
  definitionPath,
  definitionSources,
  definitionText,
  emptyDefinition,
  generatedFiles,
  readDefinition,
  typeFrom,
} from "@grasp-os/sdk/host";
import type {
  AppDefinition,
  DefinitionOperation,
  FrozenJson,
} from "@grasp-os/sdk/host";

// An App's definition as a test writes it, and the files it is: the
// definition, and the config and schema generated from it, exactly as
// Grasp's definition tools make them. Every App's version holds them so
// (core's app-definition.ts), the tests' Apps (core's and e2e/'s) too.

/** A row rule, as `setAccess` takes it. */
type Rule =
  | { readonly kind: "owner" }
  | { readonly kind: "person" | "team"; readonly field: string }
  | { readonly kind: "role"; readonly role: "builder" | "user" };

type Mode = "owner" | "appMembers" | "appBuilders" | "none";

/** A table, its fields' types written as code writes them (`v.string()`). */
export interface TableSpec {
  readonly fields: Readonly<Record<string, string>>;
  readonly indexes?: Readonly<Record<string, readonly string[]>>;
  readonly searchIndex?: readonly string[];
  readonly sensitive?: true;
  readonly access?: {
    readonly read?: Mode;
    readonly write?: Mode;
    readonly rows?: {
      readonly read?: readonly Rule[];
      readonly write?: readonly Rule[];
    };
  };
}

/** What a test's App is: its name, tables, permissions, preferences and answers. */
export interface AppSpec {
  readonly name: string;
  readonly tables?: Readonly<Record<string, TableSpec>>;
  /** Each a `permission.*(…)` expression, or `people`. */
  readonly permissions?: readonly string[];
  /**
   * Each preference's type, by its name, or all of them as one
   * `v.object({ … })`, as `defineApp` takes them.
   */
  readonly preferences?: Readonly<Record<string, string>> | string;
  /** Answers for a schema change, by table and field name. */
  readonly answers?: readonly {
    readonly table: string;
    readonly field: string;
    readonly value: FrozenJson;
  }[];
}

/** Each preference's name and type, in the order `preferences` has them. */
const preferenceTypes = (
  preferences: AppSpec["preferences"]
): [string, ValueDescriptor][] => {
  if (typeof preferences !== "string") {
    return Object.entries(preferences ?? {}).map(([name, type]) => [
      name,
      typeFrom(type),
    ]);
  }
  const type = typeFrom(preferences);
  if (type.kind !== "object") {
    throw new Error("An App's preferences are a v.object({ … }).");
  }
  return Object.entries(type.fields);
};

/** The preferences `preferences` declares, their IDs counted up apart from the tables'. */
export const preferencesOf = (
  preferences: AppSpec["preferences"]
): AppDefinition["preferences"] =>
  preferenceTypes(preferences).map(([name, type], index) => ({
    id: `preference${String(index + 1)}`,
    name,
    type,
  }));

/** The definition `spec` describes, its IDs counted up, so it is the same each time. */
export const definitionOf = (spec: AppSpec): AppDefinition => {
  let next = 0;
  const newId = (): string => {
    next += 1;
    return `id${String(next)}`;
  };
  let definition = emptyDefinition(spec.name);
  const apply = (operation: DefinitionOperation): void => {
    definition = applyOperation(definition, operation, newId);
  };
  const tables = Object.entries(spec.tables ?? {});
  // Every table first, then their fields: a field may name a table
  // (`v.id("people")`) that comes after its own.
  for (const [name] of tables) {
    apply({ op: "addTable", name });
  }
  for (const [name, table] of tables) {
    for (const [field, type] of Object.entries(table.fields)) {
      apply({ op: "addField", table: name, name: field, type });
    }
    for (const [index, fields] of Object.entries(table.indexes ?? {})) {
      apply({ op: "addIndex", table: name, name: index, fields });
    }
    if (table.searchIndex !== undefined) {
      apply({
        op: "addIndex",
        table: name,
        fields: table.searchIndex,
        search: true,
      });
    }
    apply({
      op: "setAccess",
      table: name,
      access: {
        read: table.access?.read ?? "none",
        write: table.access?.write ?? "none",
        ...(table.access?.rows === undefined
          ? {}
          : { rows: table.access.rows }),
      },
      ...(table.sensitive === true ? { sensitive: true } : {}),
    });
  }
  for (const permission of spec.permissions ?? []) {
    apply({ op: "addPermission", permission });
  }
  const preferences = preferencesOf(spec.preferences);
  const answers = (spec.answers ?? []).map(({ table, field, value }) => {
    const defined = definition.tables.find(({ name }) => name === table);
    const held = defined?.fields.find(({ name }) => name === field);
    if (defined === undefined || held === undefined) {
      throw new Error(`No field ${table}.${field} to answer for`);
    }
    return { table: defined.id, field: held.id, value };
  });
  return { ...definition, preferences, answers };
};

/** The files `definition` is: itself, its config and its schema. */
const filesOf = (definition: AppDefinition): Record<string, string> => ({
  [definitionPath]: definitionText(definition),
  ...definitionSources(definition),
});

/** The files of the definition `spec` describes: itself, its config and its schema. */
export const appDefinition = (spec: AppSpec): Record<string, string> =>
  filesOf(definitionOf(spec));

/** `files` with their definition as `change` makes it, and the code generated from it. */
export const redefined = (
  files: Readonly<Record<string, string>>,
  change: (definition: AppDefinition) => AppDefinition
): Record<string, string> => ({
  ...files,
  ...filesOf(change(readDefinition(files[definitionPath] ?? ""))),
});

/**
 * `files` with their definition changed by `operations`, as the agent's
 * definition tools change it, and the code generated from it: new IDs
 * count up past the ones it holds.
 */
export const definedWith = (
  files: Readonly<Record<string, string>>,
  ...operations: readonly DefinitionOperation[]
): Record<string, string> =>
  redefined(files, (definition) => {
    let next = Math.max(
      0,
      ...definition.tables
        .flatMap((table) => [table.id, ...table.fields.map(({ id }) => id)])
        .map((id) => Number(/^id(?<n>\d+)$/u.exec(id)?.groups?.n ?? 0))
    );
    const newId = (): string => {
      next += 1;
      return `id${String(next)}`;
    };
    let changed = definition;
    for (const operation of operations) {
      changed = applyOperation(changed, operation, newId);
    }
    return changed;
  });

/**
 * `files` without their definition and the code generated from it: what
 * the agent writes with `writeFile`, which refuses those three.
 */
export const withoutDefinition = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        path !== definitionPath &&
        path !== generatedFiles.config &&
        path !== generatedFiles.schema
    )
  );

/** `files` with their table `table` declared sensitive. */
export const withSensitive = (
  files: Readonly<Record<string, string>>,
  table: string
): Record<string, string> =>
  redefined(files, (definition) => ({
    ...definition,
    tables: definition.tables.map((held) =>
      held.name === table ? { ...held, sensitive: true } : held
    ),
  }));
