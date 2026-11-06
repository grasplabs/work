import {
  definitionManifest,
  definitionPath,
  definitionText,
  emptyDefinition,
  generatedFiles,
  readDefinition,
} from "@grasp-os/sdk/definition";
import type { AppDefinition } from "@grasp-os/sdk/definition";
import type { DefinitionOperation } from "@grasp-os/sdk/definition-operations";
import { definitionSources } from "@grasp-os/sdk/definition-source";
import { planSchemaChange } from "@grasp-os/sdk/host";
import { appErrors } from "@grasp-os/shared/apps";
import { z } from "zod";

// An App's definition among its files (@grasp-os/sdk's definition.ts):
// `definition.json`, what the App is, and the config and schema generated
// from it, which only the definition tools write (agent-builds.ts,
// `define`). A chat's agent never writes them by hand: `write` refuses
// them, naming the tools, so the definition and the code generated from
// it never part.

/** The files only the definition tools write. */
export const definitionFiles: ReadonlySet<string> = new Set([
  definitionPath,
  generatedFiles.config,
  generatedFiles.schema,
]);

/** Refuses a write that names any of `definitionFiles`. */
export const refuseDefinitionFiles = (paths: Iterable<string>): void => {
  const named = [...paths].filter((path) => definitionFiles.has(path));
  if (named.length > 0) {
    throw appErrors.create("app.generated_file", { issues: named.toSorted() });
  }
};

/**
 * The definition `files` hold, or a new one named `name` for an App that
 * has none yet. An App whose config was written without a definition
 * (one exported, or written before) has none the tools could change
 * without losing it: refused.
 */
export const definitionIn = (
  files: ReadonlyMap<string, string>,
  name: string
): AppDefinition => {
  const text = files.get(definitionPath);
  if (text !== undefined) {
    return readDefinition(text);
  }
  if (files.has(generatedFiles.config) || files.has(generatedFiles.schema)) {
    throw appErrors.create("app.no_definition");
  }
  return emptyDefinition(name);
};

/** The files `definition` is: itself, and the code generated from it. */
export const definitionChanges = (
  definition: AppDefinition
): Record<string, string> => ({
  [definitionPath]: definitionText(definition),
  ...definitionSources(definition),
});

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
      name: text,
      fields: z.array(text).min(1),
      search: z.boolean().optional(),
    }),
    z.strictObject({ op: z.literal("addPermission"), permission: text }),
  ]);
