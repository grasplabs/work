import { isServerModule } from "@grasp-os/compiler";
import type { IndexRead } from "@grasp-os/compiler";
import {
  canonicalDefinition,
  definitionManifest,
  definitionSources,
  generatedFiles,
  generatedServerSources,
  serverFunctionsOf,
  validatorSource,
} from "@grasp-os/runtime/definition";
import type {
  AppDefinition,
  DefinedField,
  DefinedRule,
  DefinedTable,
  DefinitionOperation,
  ValueDescriptor,
} from "@grasp-os/runtime/definition";
import { generatedPaths as hostGeneratedPaths } from "@grasp-os/runtime/host";
import type {
  AppManifest,
  SchemaManifest,
  ServerFunctions,
} from "@grasp-os/runtime/host";
import { appErrors } from "@grasp-os/shared/apps";
import type {
  DataModel,
  DataModelField,
  DataModelRule,
  DataModelTable,
  DefinitionPlan,
  FieldType,
  IndexUse,
  PlanField,
} from "@grasp-os/shared/data-model";
import { z } from "zod";

import { catalogOf, planSchemaChange } from "./schema-changes.ts";
import type { SchemaIds } from "./schema-changes.ts";

// An App's definition (@grasp-os/runtime's definition.ts), what the App is,
// and the code generated among its files. The definition is no file:
// each version holds it as metadata (apps.ts), a chat's draft its own
// copy (workspace.ts). Every write of an App's files, a draft's and a
// commit's alike, writes what is generated as `withGeneratedCode`
// generates it, whatever the files held: the config and schema from the
// definition, and `server/_generated/` (the references, the server
// constructors and the data model) from the definition and the server
// modules' syntax, as Convex's `convex/_generated/` is part of the
// project. Generation goes one way: nothing reads a definition back from
// code. A chat's agent changes the definition only with the definition
// tools (`define`): `write` refuses the generated files, so the
// definition, the code and what is generated from them never part.
//
// Threat model of `server/_generated/` in the App's files, and how each
// is closed:
//
// - A builder or the agent writes it, to reference a function the code
//   doesn't declare, hide one, or type a page's calls as something else:
//   no write names a path under `server/_generated/`, in any case (the
//   path schema, shared's apps.ts; `refuseGeneratedFiles`), and every
//   write generates it again anyway.
// - A copy that is stale or forged in storage (a tree written another
//   way, or by an earlier generator): sealing a version compares its
//   copy with what the seal generates, byte for byte, and refuses it
//   (`version.generated_stale`, app-releases.ts); a page is only ever
//   built with what the seal generated. A draft's preview generates its
//   own and never reads the copy.
// - A definition change not reflected in it (a workflow's events, a
//   files or links permission): it is generated from the very
//   definition each write saves, and a seal holds the copy to the
//   release's own.
// - A function the syntax doesn't read (an alias of a builder, a
//   wrapper): it has no reference, and a seal refuses it by name
//   (`version.function_undeclared`), so a page never misses one a
//   release registers.

/** The files Grasp generates among an App's, which only Grasp writes. */
export const generatedPaths: ReadonlySet<string> = new Set([
  generatedFiles.config,
  generatedFiles.schema,
  hostGeneratedPaths.api,
  hostGeneratedPaths.internal,
  hostGeneratedPaths.server,
  hostGeneratedPaths.dataModel,
]);

/**
 * Refuses a write that names any of `generatedPaths`, in any case: an
 * App's paths may not differ only in case, so `GRASP.config.ts` would be
 * the same file.
 */
export const refuseGeneratedFiles = (paths: Iterable<string>): void => {
  const named = [...paths].filter((path) =>
    generatedPaths.has(path.toLowerCase())
  );
  if (named.length > 0) {
    throw appErrors.create("app.generated_file", { issues: named.toSorted() });
  }
};

/**
 * The App's server modules among `files`, each one's source by its path
 * under `server/` without `.ts` (`crm/deals`), as the generated
 * references read them.
 */
const serverModulesOf = (
  files: ReadonlyMap<string, string>
): Record<string, string> =>
  Object.fromEntries(
    [...files]
      .filter(([path]) => isServerModule(path))
      .map(([path, source]) => [
        path.slice("server/".length, -".ts".length),
        source,
      ])
  );

/**
 * The functions `files`' server modules declare, as their syntax does
 * (`serverFunctionsOf`): what `server/_generated/` references, and what
 * the host generates a release's from.
 */
export const serverFunctionsIn = (
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>
): ServerFunctions =>
  serverFunctionsOf(
    serverModulesOf(
      files instanceof Map ? files : new Map(Object.entries(files))
    )
  );

/**
 * `server/_generated/`, by path, as `definition` and `files`' own server
 * modules generate it: what every write puts among them
 * (`withGeneratedCode`), and what a seal holds their copy to.
 */
export const generatedServerFiles = (
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  definition: AppDefinition
): Record<string, string> =>
  generatedServerSources(
    serverModulesOf(
      files instanceof Map ? files : new Map(Object.entries(files))
    ),
    definition
  );

/**
 * `files` with what is generated among them as `definition` and their
 * own server modules generate it, changed in place, whatever they held:
 * every write of an App's files comes through here, the definition
 * tools' and a commit's alike.
 */
export const withGeneratedCode = (
  files: Map<string, string>,
  definition: AppDefinition
): void => {
  for (const [path, source] of Object.entries(definitionSources(definition))) {
    files.set(path, source);
  }
  for (const [path, source] of Object.entries(
    generatedServerFiles(files, definition)
  )) {
    files.set(path, source);
  }
};

/**
 * The problem an `app.definition_invalid` refusal names, in words, or
 * undefined for any other error: as the definition tools answer it.
 */
export const definitionRefusal = (error: unknown): string | undefined => {
  if (appErrors.codeOf(error) !== "app.definition_invalid") {
    return undefined;
  }
  const details: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "details")
      : undefined;
  const parsed = z
    .object({ issues: z.array(z.string()).min(1) })
    .safeParse(details);
  return parsed.success
    ? parsed.data.issues.join(" ")
    : appErrors.create("app.definition_invalid").message;
};

/** Where each of `list`'s fields is, as a plan names it. */
const fieldsOf = (list: readonly PlanField[]): PlanField[] =>
  list.map(({ table, field }) => ({ table, field }));

/** The stable IDs `definition` gives its tables and fields, by name. */
const idsOf = (definition: AppDefinition): SchemaIds =>
  Object.fromEntries(
    definition.tables.map((table) => [
      table.name,
      {
        id: table.id,
        fields: Object.fromEntries(
          table.fields.map((field) => [field.name, field.id])
        ),
      },
    ])
  );

/**
 * The stable IDs of `schema`'s tables and fields, from `definition`, the
 * version's or draft's own (schema-changes.ts): what its store matches
 * them by. `app.definition_invalid` when the definition doesn't name
 * every one: the schema is generated from it, so only code that drifted
 * from its definition misses one.
 */
export const schemaIdsOf = (
  definition: AppDefinition,
  schema: SchemaManifest
): SchemaIds => {
  const ids = idsOf(definition);
  const missing = Object.entries(schema.tables).flatMap(([name, table]) =>
    ids[name] === undefined
      ? [name]
      : Object.keys(table.fields)
          .filter((field) => ids[name]?.fields[field] === undefined)
          .map((field) => `${name}.${field}`)
  );
  if (missing.length > 0) {
    throw appErrors.create("app.definition_invalid", {
      issues: [
        `The App's definition gives no ID to ${missing.slice(0, 10).join(", ")}, which ${generatedFiles.schema} declares.`,
      ],
    });
  }
  return ids;
};

/**
 * The paths of the queries and mutations `app` exports publicly: the
 * functions a version gives stable IDs, which a workflow may call. An
 * action reaches outside systems, and is never one.
 */
const exportedFunctionPaths = (
  app: Pick<AppManifest, "operations">
): string[] =>
  Object.values(app.operations).flatMap(({ path, kind, visibility }) =>
    visibility === "public" && kind !== "action" ? [path] : []
  );

/**
 * The paths of the functions `definition` gives stable IDs, by ID, of
 * those `app` exports as public queries and mutations: what a workflow's
 * call of the App (workflows/app-calls.ts) and a publish's check of the
 * workflows bound to it (app-function-bindings.ts) resolve an ID through,
 * in the release sealed with that definition. A version's definition
 * names its code's (apps.ts, `storedVersion`); one committed while its
 * build was late, or a draft's, may still name one it no longer exports,
 * which serves nothing.
 */
export const functionIdsOf = (
  definition: AppDefinition,
  app: Pick<AppManifest, "operations">
): ReadonlyMap<string, string> => {
  const exported = new Set(exportedFunctionPaths(app));
  return new Map(
    (definition.functions ?? []).flatMap(({ id, name }) =>
      exported.has(name) ? [[id, name] as const] : []
    )
  );
};

/**
 * What publishing `after` does to the App's records over `before`, the
 * definition the draft is over (null for an App with none), as the store
 * plans it (schema-changes.ts) from what that version holds
 * (`DefinitionPlan`): what applies on its own, which records need a value
 * (`checks`, until the field has an `answer`), and what needs a
 * migration in code.
 */
export const definitionPlan = (
  before: AppDefinition | null,
  after: AppDefinition
): DefinitionPlan => {
  const target = definitionManifest(after);
  const held =
    before === null
      ? null
      : {
          manifest: definitionManifest(before).schema,
          catalog: catalogOf({
            manifest: definitionManifest(before).schema,
            ids: idsOf(before),
          }),
        };
  const plan = planSchemaChange(
    held,
    { manifest: target.schema, ids: idsOf(after) },
    { answers: target.answers ?? [] }
  );
  return {
    accepted: plan.refused.length === 0,
    addedTables: [...plan.addedTables],
    renamedTables: plan.renamedTables.map(({ from, to }) => ({ from, to })),
    renamedFields: plan.renamedFields.map(({ table, from, to }) => ({
      table,
      from,
      to,
    })),
    addedFields: fieldsOf(plan.addedFields),
    widenedFields: fieldsOf(plan.widenedFields),
    checks: plan.checks.map(({ table, field, answer }) => ({
      table,
      field,
      answer,
    })),
    keptTables: [...plan.keptTables],
    keptFields: fieldsOf(plan.keptFields),
    accessChanges: [...plan.accessChanges],
    sensitiveTables: [...plan.sensitiveTables],
    refused: plan.refused.map(({ table, field, reason }) => ({
      table,
      ...(field === undefined ? {} : { field }),
      reason,
    })),
  };
};

/** `src/routes/tasks.$taskId.tsx` as its route's path: `/tasks/$taskId`. */
const routeOf = (path: string): string =>
  `/${path
    .slice("src/routes/".length)
    .replace(/\.tsx?$/u, "")
    .replaceAll(".", "/")
    .replace(/(?:^|\/)index$/u, "")}`;

/**
 * What uses each index, from what the compiler found as it built the
 * App's code: the indexes its functions read (`reads`, once each), and
 * the pages, by route, whose files call each function (`calls`, by path).
 */
export const usesOf = (
  reads: readonly IndexRead[],
  calls: Readonly<Record<string, readonly string[]>>
): IndexUse[] => {
  const routes = Object.entries(calls).filter(
    ([path]) => path.startsWith("src/routes/") && !path.includes("__root")
  );
  const seen = new Set<string>();
  return reads.flatMap(({ table, index, query }) => {
    const key = JSON.stringify([table, index, query]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        table,
        index,
        query,
        pages: routes
          .filter(([, called]) => called.includes(query))
          .map(([path]) => routeOf(path))
          .toSorted(),
      },
    ];
  });
};

/** The entries of `list` that `before` lacks. */
const freshIn = <T>(list: readonly T[], before: readonly T[]): T[] => {
  const seen = new Set(before.map((entry) => JSON.stringify(entry)));
  return list.filter((entry) => !seen.has(JSON.stringify(entry)));
};

/**
 * What a change of the draft does to the App's records on its own: what
 * publishing the draft after it (`after`) does that publishing it before
 * (`own`) didn't, both from the version people use (`live`). A field the
 * draft adds and the change renames is no field the records ever had.
 */
export const changePlan = (
  live: AppDefinition | null,
  own: AppDefinition,
  after: AppDefinition
): DefinitionPlan => {
  const was = definitionPlan(live, own);
  const now = definitionPlan(live, after);
  return {
    accepted: now.accepted,
    addedTables: freshIn(now.addedTables, was.addedTables),
    renamedTables: freshIn(now.renamedTables, was.renamedTables),
    renamedFields: freshIn(now.renamedFields, was.renamedFields),
    addedFields: freshIn(now.addedFields, was.addedFields),
    widenedFields: freshIn(now.widenedFields, was.widenedFields),
    checks: freshIn(now.checks, was.checks),
    keptTables: freshIn(now.keptTables, was.keptTables),
    keptFields: freshIn(now.keptFields, was.keptFields),
    accessChanges: freshIn(now.accessChanges, was.accessChanges),
    sensitiveTables: freshIn(now.sensitiveTables, was.sensitiveTables),
    refused: freshIn(now.refused, was.refused),
  };
};

/** The kind a person picks for each kind of descriptor but a choice and a link. */
const fieldKinds: Record<
  Exclude<
    ValueDescriptor["kind"],
    "enum" | "id" | "string" | "number" | "boolean"
  >,
  "date" | "person" | "file" | "money" | "other"
> = {
  timestamp: "date",
  person: "person",
  file: "file",
  money: "money",
  literal: "other",
  null: "other",
  object: "other",
  array: "other",
  union: "other",
  record: "other",
  duration: "other",
  model: "other",
  schedule: "other",
  template: "other",
};

/** A field's kind, as a person picks it, with what it takes (`FieldType`). */
const fieldTypeOf = (type: ValueDescriptor): FieldType => {
  if (type.kind === "enum") {
    return { kind: "choice", values: [...type.values] };
  }
  if (type.kind === "id") {
    return {
      kind: "link",
      table: type.tableName,
      cascade: type.onDelete === "cascade",
    };
  }
  if (type.kind === "string") {
    return {
      kind: type.email ? "email" : "text",
      trim: type.trim,
      min: type.min ?? null,
      max: type.max ?? null,
    };
  }
  if (type.kind === "number") {
    return {
      kind: "number",
      integer: type.integer,
      min: type.min ?? null,
      max: type.max ?? null,
    };
  }
  if (type.kind === "boolean") {
    return {
      kind: "boolean",
      default:
        typeof type.defaultValue === "boolean" ? type.defaultValue : null,
    };
  }
  return { kind: fieldKinds[type.kind] };
};

/** A field as the Data view shows it (`DataModelField`). */
const modelFieldOf = ({ id, name, type }: DefinedField): DataModelField => {
  // Its code with no presence: `required` says that, and a change of it
  // adds `.optional()` or doesn't (`fieldCode`).
  const { defaultValue: _default, ...declared } = type;
  const code = validatorSource({ ...declared, presence: "required" });
  // Its default as code says it: what the whole of it adds to its code.
  const whole = validatorSource(type);
  return {
    id,
    name,
    type: fieldTypeOf(type),
    // A default fills every record that leaves it out, so none goes without.
    required: type.presence !== "optional",
    code,
    nullable: type.nullable,
    defaultCode:
      type.presence === "default" && whole.startsWith(code)
        ? whole.slice(code.length)
        : null,
  };
};

/** A table's field's name, by its ID; the ID itself for a managed field. */
const nameOf = (table: DefinedTable, id: string): string =>
  table.fields.find((field) => field.id === id)?.name ?? id;

/** A table as the Data view shows it (`DataModelTable`), its fields by name. */
const modelTableOf = (table: DefinedTable): DataModelTable => {
  const rules = (list: readonly DefinedRule[] = []): DataModelRule[] =>
    list.map((rule) =>
      rule.kind === "person" || rule.kind === "team"
        ? { kind: rule.kind, field: nameOf(table, rule.field) }
        : { ...rule }
    );
  return {
    id: table.id,
    name: table.name,
    fields: table.fields.map(modelFieldOf),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      fields: index.fields.map((field) => nameOf(table, field)),
    })),
    searchIndex:
      table.searchIndex?.map((field) => nameOf(table, field)) ?? null,
    sensitive: table.sensitive === true,
    access: {
      read: table.access.read,
      write: table.access.write,
      rows: {
        read: rules(table.access.rows?.read),
        write: rules(table.access.rows?.write),
      },
    },
  };
};

/** A permission's alias or kind: text, as every declaration's is. */
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * `definition`'s data model, as the workspace's Data view shows it: from
 * its one form (`canonicalDefinition`), so each field's code reads as the
 * generated code declares it.
 */
export const dataModelOf = (declared: AppDefinition): DataModel => {
  const definition = canonicalDefinition(declared);
  return {
    tables: definition.tables.map(modelTableOf),
    permissions: definition.permissions.map((permission) => ({
      alias: textOf(permission.alias),
      kind: textOf(permission["~permission"]),
    })),
  };
};

/** A row rule, as the tools take it: its field by name. */
const ruleSchema = z.union([
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.enum(["person", "team"]), field: z.string() }),
  z.strictObject({
    kind: z.literal("role"),
    role: z.enum(["builder", "user"]),
  }),
]);

const modeSchema = z.enum(["owner", "appMembers", "appBuilders", "none"]);

/** A table's access, as the tools take it. */
const accessSchema = z.strictObject({
  read: modeSchema,
  write: modeSchema,
  rows: z
    .strictObject({
      read: z.array(ruleSchema).optional(),
      write: z.array(ruleSchema).optional(),
    })
    .optional(),
});

/** A name, a type or a permission, as the tools take it. */
const text = z.string().min(1).max(20_000);

/**
 * An operation the definition tools make: one of the definition's own,
 * but the workflow contract, which the tools set only from the version a
 * builder binds (`bindWorkflow`, read by `defineInDraft`).
 */
export type DraftOperation =
  | Exclude<DefinitionOperation, { readonly op: "setWorkflowContract" }>
  | {
      /**
       * Declares, for workflow permission `alias`, the events, listen
       * tasks and decisions version `version` of workflow `workflow` has,
       * and records that version as the one the App binds there once the
       * App version is current.
       */
      readonly op: "bindWorkflow";
      readonly alias: string;
      readonly workflow: string;
      readonly version: number;
    };

/** The operations the definition tools make, as `define` takes them. */
export const definitionOperationSchema: z.ZodType<DraftOperation> =
  z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("addTable"),
      name: text,
      fields: z.record(z.string(), text).optional(),
      access: accessSchema.optional(),
    }),
    z.strictObject({
      op: z.literal("addField"),
      table: text,
      name: text,
      type: text,
      answer: z.json().optional(),
    }),
    z.strictObject({
      op: z.literal("changeField"),
      table: text,
      field: text,
      type: text,
      answer: z.json().optional(),
    }),
    z.strictObject({
      op: z.literal("renameField"),
      table: text,
      field: text,
      name: text,
    }),
    z.strictObject({ op: z.literal("renameTable"), table: text, name: text }),
    z.strictObject({
      op: z.literal("setAccess"),
      table: text,
      access: accessSchema,
      sensitive: z.boolean().optional(),
    }),
    z.strictObject({
      op: z.literal("addIndex"),
      table: text,
      name: text.optional(),
      fields: z.array(text).min(1),
      search: z.boolean().optional(),
    }),
    z.strictObject({ op: z.literal("addPermission"), permission: text }),
    z.strictObject({ op: z.literal("removeTable"), table: text }),
    z.strictObject({
      op: z.literal("removeField"),
      table: text,
      field: text,
    }),
    z.strictObject({
      op: z.literal("removeIndex"),
      table: text,
      name: text.optional(),
      search: z.boolean().optional(),
    }),
    z.strictObject({ op: z.literal("removePermission"), alias: text }),
    z.strictObject({
      op: z.literal("bindWorkflow"),
      alias: text,
      workflow: text,
      version: z.int().min(1),
    }),
    z.strictObject({
      op: z.literal("moveField"),
      table: text,
      field: text,
      to: z.int().min(0),
    }),
    z.strictObject({
      op: z.literal("renameFunction"),
      function: text,
      name: text,
    }),
  ]);

/** One operation, or a few made as one change (a field renamed and retyped). */
export const definitionOperationsSchema = z.union([
  definitionOperationSchema,
  z.array(definitionOperationSchema).min(1).max(8),
]);

/**
 * An audit's detail of one operation: its op, table and alias, and for a
 * workflow bound from the draft, the workflow and version it named.
 */
const singleDetail = (operation: unknown): Record<string, string | null> => {
  const parsed = definitionOperationSchema.safeParse(operation);
  if (!parsed.success) {
    return { op: null };
  }
  const { data } = parsed;
  let table: string | null = null;
  if ("table" in data) {
    ({ table } = data);
  } else if (data.op === "addTable") {
    table = data.name;
  }
  let alias: string | null = null;
  if (data.op === "addPermission") {
    alias =
      /["'`](?<alias>[\w-]+)["'`]/u.exec(data.permission)?.groups?.alias ??
      data.permission.slice(0, 64);
  } else if (data.op === "removePermission" || data.op === "bindWorkflow") {
    alias = data.alias.slice(0, 64);
  }
  // Which version a workflow's declared contract was read from.
  const bound: Record<string, string> =
    data.op === "bindWorkflow"
      ? { workflow: data.workflow.slice(0, 256), version: String(data.version) }
      : {};
  return { op: data.op, table, alias, ...bound };
};

/**
 * An audit's detail of `operation`, or of operations made as one: their
 * ops, in order, with the table and alias of the first.
 */
export const operationDetail = (
  operation: unknown
): Record<string, string | null> => {
  if (Array.isArray(operation)) {
    const details = operation.map(singleDetail);
    return {
      ...details[0],
      op: details.map(({ op }) => op ?? "?").join(","),
    };
  }
  return singleDetail(operation);
};
