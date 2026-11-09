import {
  applyOperation,
  definitionSources,
  definitionText,
  emptyDefinition,
  generatedFiles,
} from "@grasp-os/sdk/definition";
import type {
  AppDefinition,
  DefinitionOperation,
  FrozenJson,
} from "@grasp-os/sdk/definition";

// An App's definition as a test writes it, and the config and schema
// generated from it, exactly as Grasp's definition tools make them. Every
// App's version holds its definition beside its files and its config and
// schema as the definition generates them (core's apps.ts), the tests'
// Apps (core's and e2e/'s) too: a test commits its files with the
// definition (`TestApp`, `commitApp`).

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

/** What a test's App is: its name, tables, permissions and answers. */
export interface AppSpec {
  readonly name: string;
  readonly tables?: Readonly<Record<string, TableSpec>>;
  /** Each a `permission.*(…)` expression, or `people`. */
  readonly permissions?: readonly string[];
  /** Answers for a schema change, by table and field name. */
  readonly answers?: readonly {
    readonly table: string;
    readonly field: string;
    readonly value: FrozenJson;
  }[];
}

/**
 * `operation` applied to `definition`, a new table's or field's ID taken
 * from its name: so a table or field of one name has one ID in every
 * definition a test makes, as one App's versions keep it.
 */
const applied = (
  definition: AppDefinition,
  operation: DefinitionOperation
): AppDefinition => {
  let id: string | undefined;
  if (operation.op === "addTable") {
    id = `table:${operation.name}`;
  } else if (operation.op === "addField") {
    id = `field:${operation.table}.${operation.name}`;
  }
  return applyOperation(definition, operation, () => {
    if (id === undefined) {
      throw new Error(`No ID to give in ${operation.op}`);
    }
    return id;
  });
};

/** The definition `spec` describes, its IDs taken from names, so it is the same each time. */
export const definitionOf = (spec: AppSpec): AppDefinition => {
  let definition = emptyDefinition(spec.name);
  const apply = (operation: DefinitionOperation): void => {
    definition = applied(definition, operation);
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
  const answers = (spec.answers ?? []).map(({ table, field, value }) => {
    const defined = definition.tables.find(({ name }) => name === table);
    const held = defined?.fields.find(({ name }) => name === field);
    if (defined === undefined || held === undefined) {
      throw new Error(`No field ${table}.${field} to answer for`);
    }
    return { table: defined.id, field: held.id, value };
  });
  return { ...definition, answers };
};

/**
 * What marks a test's App, or changes with their definition, as such: a
 * symbol, which no files' path can be, so changes alone are never taken
 * for one.
 */
const defined: unique symbol = Symbol("defined");

/**
 * Changes to commit over a version with a definition: files by path, null
 * deleting one there. A test's App is one.
 */
export interface TestChanges {
  readonly [defined]: true;
  readonly files: Readonly<Record<string, string | null>>;
  readonly definition: AppDefinition;
}

/**
 * A test's App: its files, its config and schema among them as its
 * definition generates them, and that definition, which a version of the
 * files is committed with.
 */
export interface TestApp extends TestChanges {
  readonly files: Readonly<Record<string, string>>;
}

/** `definition` with `files` beside the config and schema it generates. */
export const appOf = (
  definition: AppDefinition,
  files: Readonly<Record<string, string>> = {}
): TestApp => ({
  [defined]: true,
  // The config and schema always the definition's, as a commit makes them.
  files: { ...files, ...definitionSources(definition) },
  definition,
});

/** The App `spec` describes, with `files` beside its config and schema. */
export const testApp = (
  spec: AppSpec,
  files: Readonly<Record<string, string>> = {}
): TestApp => appOf(definitionOf(spec), files);

/** `app` with `files` changed (null deletes one), its definition kept. */
export const withFiles = (
  app: TestApp,
  files: Readonly<Record<string, string | null>>
): TestApp => {
  const changed: Record<string, string> = { ...app.files };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      Reflect.deleteProperty(changed, path);
    } else {
      changed[path] = content;
    }
  }
  return { [defined]: true, files: changed, definition: app.definition };
};

/**
 * `app`'s files with `files` over them as changes, a null deleting a
 * file of the version they are committed over, and `app`'s definition.
 */
export const changesOf = (
  app: TestApp,
  files: Readonly<Record<string, string | null>>
): TestChanges => ({
  [defined]: true,
  files: { ...app.files, ...files },
  definition: app.definition,
});

/**
 * What a test commits or writes: changes with their definition (a test's
 * App among them), or changes alone (null deletes a file), which keep
 * the App's.
 */
export type TestSource = TestChanges | Readonly<Record<string, string | null>>;

/** The changes `source` makes, and its definition if it has one. */
export const sourceParts = (
  source: TestSource
): {
  files: Readonly<Record<string, string | null>>;
  definition: AppDefinition | undefined;
} => (defined in source ? source : { files: source, definition: undefined });

/**
 * `definition` as a commit takes it: the JSON of its text, every
 * descriptor in its compact form, as Grasp stores it.
 */
export const definitionInput = (definition: AppDefinition): unknown =>
  JSON.parse(definitionText(definition));

/**
 * A test's commit of `source` (`apps.files.commit`): its files, with its
 * definition when it is a test's App.
 */
export const commitApp = <Committed>(
  api: {
    readonly commit: (
      app: string,
      changes: Record<string, string | null>,
      message: string,
      definition?: unknown
    ) => Committed;
  },
  app: string,
  source: TestSource,
  message: string
): Committed => {
  const { files, definition } = sourceParts(source);
  return api.commit(
    app,
    { ...files },
    message,
    definition === undefined ? undefined : definitionInput(definition)
  );
};

/** `app` with its definition as `change` makes it, and the code generated from it. */
export const redefined = (
  app: TestApp,
  change: (definition: AppDefinition) => AppDefinition
): TestApp => appOf(change(app.definition), app.files);

/**
 * `app` with its definition changed by `operations`, as the agent's
 * definition tools change it, and the code generated from it: new IDs
 * taken from names, as `definitionOf` takes them.
 */
export const definedWith = (
  app: TestApp,
  ...operations: readonly DefinitionOperation[]
): TestApp =>
  redefined(app, (definition) => {
    let changed = definition;
    for (const operation of operations) {
      changed = applied(changed, operation);
    }
    return changed;
  });

/**
 * `app`'s files without the code generated from its definition: what the
 * agent writes with `writeFile`, which refuses both.
 */
export const withoutDefinition = (app: TestApp): Record<string, string> =>
  Object.fromEntries(
    Object.entries(app.files).filter(
      ([path]) =>
        path !== generatedFiles.config && path !== generatedFiles.schema
    )
  );

/** `app` with its table `table` declared sensitive. */
export const withSensitive = (app: TestApp, table: string): TestApp =>
  redefined(app, (definition) => ({
    ...definition,
    tables: definition.tables.map((held) =>
      held.name === table ? { ...held, sensitive: true } : held
    ),
  }));

/** The text a chat's draft keeps of `app`'s definition, as the definition tools write it. */
export const draftDefinitionOf = (app: TestApp): string =>
  definitionText(app.definition);
