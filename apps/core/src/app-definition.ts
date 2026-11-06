import {
  definitionManifest,
  definitionPath,
  definitionSources,
  definitionText,
  emptyDefinition,
  generatedFiles,
  tryReadDefinition,
} from "@grasp-os/sdk/definition";
import type {
  AppDefinition,
  DefinitionOperation,
} from "@grasp-os/sdk/definition";
import { planSchemaChange } from "@grasp-os/sdk/host";
import { appErrors } from "@grasp-os/shared/apps";
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

/** Where a field is, as a plan names it. */
interface PlanField {
  table: string;
  field: string;
}

/**
 * What a change of the definition does to the App's records, from the
 * definition its draft is over (`before`, null for an App with none) to
 * `after`, as the store plans it (@grasp-os/sdk's schema-plan.ts): what
 * is applied as it is, and what every record is checked for as the
 * version is made current, which a record that doesn't fit stops until
 * the field has an `answer`.
 */
export interface DefinitionPlan {
  /** Whether the store can apply it without a migration in code. */
  accepted: boolean;
  addedTables: string[];
  addedFields: PlanField[];
  /** Fields every record still fits: nothing to check. */
  widenedFields: PlanField[];
  /** Fields every record is checked against, and whether one lacking it takes an answer. */
  checks: (PlanField & { answered: boolean })[];
  /** Fields the schema left out: kept in every record, never dropped. */
  keptFields: PlanField[];
  /** Tables whose access changes, for every record at once. */
  accessChanges: string[];
  /**
   * Tables declared sensitive: their change history keeps no values from
   * now on, and every read is audited. A table stays so once declared.
   */
  sensitiveTables: string[];
  /** What needs a migration in code, and why. */
  refused: { table: string; field?: string; reason: string }[];
}

/** Where each of `list`'s fields is, as a plan names it. */
const fieldsOf = (list: readonly PlanField[]): PlanField[] =>
  list.map(({ table, field }) => ({ table, field }));

/** The plan of the change from `before` to `after` (see `DefinitionPlan`). */
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
      answered: answer !== null,
    })),
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
  ]);

/** What an operation's audit record keeps: its kind, its table and its alias. */
export const operationDetail = (
  operation: unknown
): Record<string, string | null> => {
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
  return {
    op: data.op,
    table,
    alias:
      data.op === "addPermission"
        ? (/["'`](?<alias>[\w-]+)["'`]/u.exec(data.permission)?.groups?.alias ??
          data.permission.slice(0, 64))
        : null,
  };
};
