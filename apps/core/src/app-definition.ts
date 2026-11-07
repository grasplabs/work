import type { IndexRead } from "@grasp-os/compiler";
import {
  definitionManifest,
  definitionPath,
  definitionSources,
  definitionText,
  emptyDefinition,
  generatedFiles,
  tryReadDefinition,
  validatorSource,
} from "@grasp-os/sdk/definition";
import type {
  AppDefinition,
  DefinedField,
  DefinedRule,
  DefinedTable,
  DefinitionOperation,
  ValueDescriptor,
} from "@grasp-os/sdk/definition";
import { planSchemaChange } from "@grasp-os/sdk/host";
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

// An App's definition among its files (@grasp-os/sdk's definition.ts):
// `definition.json`, what the App is, and the config and schema generated
// from it. Every App of spec 8's layout has one: a draft gets an empty one
// with its first write (agent-builds.ts), and every version the App
// commits holds its config and schema exactly as its definition generates
// them (`withDefinitionCode`). A chat's agent changes it only with the
// definition tools (`define`): `write` refuses the three files, naming the
// tools, so the definition and the code generated from it never part.

/** The files only the definition tools write. */
export const definitionFiles: ReadonlySet<string> = new Set([
  definitionPath,
  generatedFiles.config,
  generatedFiles.schema,
]);

/**
 * Refuses a write that names any of `definitionFiles`, in any case: an
 * App's paths may not differ only in case, so `GRASP.config.ts` would be
 * the same file.
 */
export const refuseDefinitionFiles = (paths: Iterable<string>): void => {
  const named = [...paths].filter((path) =>
    definitionFiles.has(path.toLowerCase())
  );
  if (named.length > 0) {
    throw appErrors.create("app.generated_file", { issues: named.toSorted() });
  }
};

/**
 * The definition `files` hold, a new one named `name` for files with none
 * yet, or the problem with the one they hold.
 */
export const definitionIn = (
  files: ReadonlyMap<string, string>,
  name: string
): { definition: AppDefinition } | { problem: string } => {
  const text = files.get(definitionPath);
  return text === undefined
    ? { definition: emptyDefinition(name) }
    : tryReadDefinition(text);
};

/** The files `definition` is: itself, and the code generated from it. */
export const definitionChanges = (
  definition: AppDefinition
): Record<string, string> => ({
  [definitionPath]: definitionText(definition),
  ...definitionSources(definition),
});

/**
 * Why `definition` renames a field one of the App's versions has (`held`:
 * the current one, and the commit a change starts from, which may have
 * run and been rolled back from), or undefined. Such a field may hold
 * values in the App's records, which stay under its old name until a
 * rename can carry them by its stable ID (GRA-1602): only a field the
 * change itself added renames.
 */
export const renameRefusal = (
  definition: AppDefinition,
  held: readonly (AppDefinition | null)[]
): string | undefined => {
  for (const version of held) {
    for (const table of version?.tables ?? []) {
      const now = definition.tables.find(({ id }) => id === table.id);
      for (const field of table.fields) {
        const renamed = now?.fields.find(({ id }) => id === field.id);
        if (renamed !== undefined && renamed.name !== field.name) {
          return `\`${table.name}.${field.name}\` is in a version of the App, and its records may hold values under that name, which a rename doesn't carry yet. Only a field this draft added renames. Keep its name, or add a field with the new name and copy the values with a migration in server/migrations/.`;
        }
      }
    }
  }
  return undefined;
};

/**
 * `files` with their config and schema as their definition generates
 * them, changed in place. Files with no definition yet, the first of the
 * App named `name` (one of pages alone too), get an empty one. Refused
 * (`app.definition_invalid`) when they hold a config or a schema but no
 * definition, a definition that isn't one, have lost the one they had
 * (`had`), or rename a field a version of the App has (`held`, see
 * `renameRefusal`): every write of a definition comes through here, the
 * definition tools' and a commit's alike.
 */
export const withDefinitionCode = (
  files: Map<string, string>,
  name: string,
  had: boolean,
  held: readonly (AppDefinition | null)[] = []
): void => {
  const text = files.get(definitionPath);
  if (text === undefined) {
    const handwritten =
      files.has(generatedFiles.config) || files.has(generatedFiles.schema);
    if (had || handwritten) {
      throw appErrors.create("app.definition_invalid", {
        issues: [
          `${generatedFiles.config} and ${generatedFiles.schema} are generated from ${definitionPath}, which the App doesn't have.`,
        ],
      });
    }
    for (const [path, source] of Object.entries(
      definitionChanges(emptyDefinition(name))
    )) {
      files.set(path, source);
    }
    return;
  }
  const read = tryReadDefinition(text);
  if ("problem" in read) {
    throw appErrors.create("app.definition_invalid", {
      issues: [read.problem],
    });
  }
  const renamed = renameRefusal(read.definition, held);
  if (renamed !== undefined) {
    throw appErrors.create("app.definition_invalid", { issues: [renamed] });
  }
  for (const [path, source] of Object.entries(
    definitionSources(read.definition)
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

/** The definition `files` hold, or null for none or one that doesn't read. */
export const heldDefinition = (
  files: ReadonlyMap<string, string>
): AppDefinition | null => {
  const text = files.get(definitionPath);
  if (text === undefined) {
    return null;
  }
  const read = tryReadDefinition(text);
  return "definition" in read ? read.definition : null;
};

/** Where each of `list`'s fields is, as a plan names it. */
const fieldsOf = (list: readonly PlanField[]): PlanField[] =>
  list.map(({ table, field }) => ({ table, field }));

/**
 * The plan of the change from `before`, the definition the draft is over
 * (null for an App with none), to `after` (`DefinitionPlan`): what is
 * applied as it is, and what every record is checked for as the version
 * is made current, which a record that doesn't fit stops until the field
 * has an `answer`.
 */
export const definitionPlan = (
  before: AppDefinition | null,
  after: AppDefinition
): DefinitionPlan => {
  const target = definitionManifest(after);
  const sensitiveBefore = new Set(
    (before?.tables ?? []).flatMap((table) =>
      table.sensitive === true ? [table.id] : []
    )
  );
  const plan = planSchemaChange(
    before === null ? null : definitionManifest(before).schema,
    target.schema,
    { answers: target.answers ?? [] }
  );
  return {
    accepted: plan.accepted,
    addedTables: [...plan.addedTables],
    addedFields: fieldsOf(plan.addedFields),
    widenedFields: fieldsOf(plan.widenedFields),
    checks: plan.checks.map(({ table, field, answer }) => ({
      table,
      field,
      answer: answer?.value ?? null,
    })),
    keptTables: [...plan.retainedTables],
    keptFields: fieldsOf(plan.retainedFields),
    accessChanges: [...plan.ruleChanges],
    sensitiveTables: after.tables.flatMap((table) =>
      table.sensitive === true && !sensitiveBefore.has(table.id)
        ? [table.name]
        : []
    ),
    refused: plan.accepted
      ? []
      : plan.refused.map(({ table, field, reason }) => ({
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
  return {
    id,
    name,
    type: fieldTypeOf(type),
    // A default fills every record that leaves it out, so none goes without.
    required: type.presence !== "optional",
    code: validatorSource({ ...declared, presence: "required" }),
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

/** `definition`'s data model, as the workspace's Data view shows it. */
export const dataModelOf = (definition: AppDefinition): DataModel => ({
  tables: definition.tables.map(modelTableOf),
  preferences: definition.preferences.map(modelFieldOf),
  permissions: definition.permissions.map((permission) => ({
    alias: textOf(permission.alias),
    kind: textOf(permission["~permission"]),
  })),
});

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

/** The operations the definition tools make, as `define` takes them. */
export const definitionOperationSchema: z.ZodType<DefinitionOperation> =
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
      op: z.enum(["addPreference", "changePreference"]),
      name: text,
      type: text,
    }),
    z.strictObject({ op: z.literal("removePreference"), name: text }),
    z.strictObject({
      op: z.literal("moveField"),
      table: text,
      field: text,
      to: z.int().min(0),
    }),
  ]);

/** One operation, or a few made as one change (a field renamed and retyped). */
export const definitionOperationsSchema = z.union([
  definitionOperationSchema,
  z.array(definitionOperationSchema).min(1).max(8),
]);

/** An audit's detail of one operation: its op, table and alias. */
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
  } else if (data.op === "removePermission") {
    alias = data.alias.slice(0, 64);
  }
  return { op: data.op, table, alias };
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
