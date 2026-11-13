import {
  applyOperation,
  definitionManifest,
  definitionSources,
  definitionText,
  emptyDefinition,
  generatedFiles,
  generatedServerSources,
} from "@grasp-os/runtime/definition";
import type {
  AppDefinition,
  DefinitionOperation,
  FrozenJson,
} from "@grasp-os/runtime/definition";
import { declaredPermission, ownFiles } from "@grasp-os/runtime/host";
import type { WorkflowEventContract } from "@grasp-os/runtime/host";

// An App's definition as a test writes it, and the code generated from
// it, exactly as Grasp's definition tools make it. Every App's version
// holds its definition beside its files, and its config, schema and
// `server/_generated/` as the definition and its code generate them
// (core's apps.ts, app-definition.ts), the tests' Apps (core's and e2e/'s)
// too: a test publishes its files with the definition (`TestApp`,
// `publishApp`), never what is generated, which no write may name.

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
  /**
   * The events, listen tasks and decisions of each workflow permission,
   * by alias, as the version bound has them: written as the host writes
   * them from that version (`setWorkflowContract`), never in the
   * permission's own expression.
   */
  readonly contracts?: Readonly<Record<string, WorkflowEventContract>>;
  /**
   * The workflow a draft bound under each alias (`bindWorkflow`), which
   * the version records and binds as it goes live: a definition written
   * by hand may name any.
   */
  readonly bound?: Readonly<Record<string, { readonly workflowId: string }>>;
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

/** No events, listen tasks or decisions: a workflow the App only starts. */
const startsOnly: WorkflowEventContract = {
  events: {},
  listens: {},
  decisions: {},
};

/** What sets each of `spec`'s workflow contracts, with the workflow bound. */
const contractOperations = (spec: AppSpec): DefinitionOperation[] =>
  [
    ...new Set([
      ...Object.keys(spec.contracts ?? {}),
      ...Object.keys(spec.bound ?? {}),
    ]),
  ].map((alias) => {
    const bound = spec.bound?.[alias];
    return {
      op: "setWorkflowContract",
      alias,
      contract: spec.contracts?.[alias] ?? startsOnly,
      ...(bound === undefined ? {} : { bound }),
    };
  });

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
  for (const operation of contractOperations(spec)) {
    apply(operation);
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
): TestApp => {
  // The config, schema and `server/_generated/` always the definition's
  // and the code's, as a commit makes them.
  const own = { ...ownFiles(files), ...definitionSources(definition) };
  return {
    [defined]: true,
    files: { ...own, ...generatedServerSources(own, definition) },
    definition,
  };
};

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
  return appOf(app.definition, changed);
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
} =>
  defined in source
    ? { files: ownFiles(source.files), definition: source.definition }
    : { files: source, definition: undefined };

/**
 * `definition` as a commit takes it: the JSON of its text, every
 * descriptor in its compact form, as Grasp stores it.
 */
export const definitionInput = (definition: AppDefinition): unknown =>
  JSON.parse(definitionText(definition));

/**
 * A test's publish of `source` as `api`'s person: written into App
 * `app`'s draft over the revision read (`apps.editDraft`), its files with
 * its definition when it is a test's App, then the draft published
 * (`drafts.publish`). Answers the version made live.
 */
export const publishApp = async (
  api: {
    readonly apps: {
      readonly editDraft: (
        app: string,
        edit: {
          revision: number;
          changes: Record<string, string | null>;
          definition?: unknown;
        }
      ) => Promise<{ revision: number }>;
    };
    readonly drafts: {
      readonly get: (subject: {
        kind: "app";
        id: string;
      }) => Promise<{ revision: number }>;
      readonly publish: (
        subject: { kind: "app"; id: string },
        revision: number
      ) => Promise<{ version: number; label: string }>;
    };
  },
  app: string,
  source: TestSource
): Promise<{ version: number; label: string }> => {
  const subject = { kind: "app", id: app } as const;
  const { revision } = await api.drafts.get(subject);
  const { files, definition } = sourceParts(source);
  const drafted = await api.apps.editDraft(app, {
    revision,
    changes: { ...files },
    ...(definition === undefined
      ? {}
      : { definition: definitionInput(definition) }),
  });
  const { version, label } = await api.drafts.publish(
    subject,
    drafted.revision
  );
  return { version, label };
};

/** `app` with its definition as `change` makes it, and the code generated from it. */
export const redefined = (
  app: TestApp,
  change: (definition: AppDefinition) => AppDefinition
): TestApp => appOf(change(app.definition), app.files);

/**
 * `app` binding workflow `workflowId` under its workflow permission
 * `alias`, as a draft's `bindWorkflow` records it, keeping what it
 * declares of the workflow: the binding goes live with the version.
 */
export const boundIn = (
  app: TestApp,
  bound: Readonly<Record<string, string>>
): TestApp =>
  redefined(app, (definition) => {
    let changed = definition;
    for (const [alias, workflowId] of Object.entries(bound)) {
      const held = declaredPermission(
        definitionManifest(changed),
        alias,
        "workflows"
      );
      if (held === undefined) {
        throw new Error(`The App declares no workflow ${alias}`);
      }
      const { events, listens, decisions } = held;
      changed = applyOperation(changed, {
        op: "setWorkflowContract",
        alias,
        contract: { events, listens, decisions },
        bound: { workflowId },
      });
    }
    return changed;
  });

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
 * `app`'s files without the code generated among them: what the agent
 * writes with `writeFile`, which refuses it.
 */
export const withoutDefinition = (app: TestApp): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ownFiles(app.files)).filter(
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
