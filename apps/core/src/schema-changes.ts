import type { FrozenJson, ValueDescriptor } from "@grasp-os/sdk/definition";
import {
  fieldWidens,
  holdsReference,
  referencesRenamed,
} from "@grasp-os/sdk/host";
import type {
  ManifestTable,
  SchemaAnswer,
  SchemaManifest,
} from "@grasp-os/sdk/host";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { fieldValueSchema } from "@grasp-os/shared/stores";

import { fitted } from "./store-queries.ts";

// What publishing a schema changes in an App's store, worked out from what
// the store holds and the schema the version brings: a diff by stable ID,
// which the store then applies in one transaction (store-host.ts,
// `applySchema`), as Drizzle diffs a schema and migrates. Pure: the store
// runs it inside that transaction, and the Data view runs it on two
// definitions for its dry run (app-definition.ts).
//
// Tables and fields are matched by the IDs the App's definition gives
// them, never by name, so a rename moves a name and nothing else:
// records, indexes and references are kept by the table's ID, and a
// field's values move to its new name.
//
// Applied on its own:
//
// - a new table, a new optional or defaulted field (filled in where
//   records lack it), a field widened (every stored value still fits);
// - a table or field renamed;
// - a table or field the schema leaves out: kept, with its values, never
//   dropped, so a rollback or a later version that brings it back finds
//   them (it comes back as it was, or widened);
// - a changed access mode or row rule, and indexes.
//
// A field records may lack, which the schema now requires (added, brought
// back, or made required), or may hold null in where it no longer can,
// takes the App's answer for it (`SchemaAnswer`) or its default; with
// neither, it is a check: the store refuses the change while any record
// lacks it.
//
// Anything else needs a migration of its table in code (`migrated`): a
// field narrowed or retyped (`field_changed`). Refused outright:
//
// - an ID changed: a name in force arriving under another ID
//   (`id_changed`), or a name another ID holds, kept ones included
//   (`name_taken`), so one field's values are never read as another's. A
//   migrated table's output may take over a kept field's name, unless the
//   new field refers to records or a row rule reads it;
// - a default or answer for a field that holds a record ID or a file
//   (`reference_filled`): the store's reference and file indexes follow
//   only writes it checks;
// - a default or answer for a field a row rule reads (`rule_field_filled`):
//   who sees a record changes only through writes, which pass the rules;
// - an answer that doesn't fit its field's type (`answer_unfit`). What
//   fills a field is checked as a write is, its nested defaults filled in.

/** A schema's stable IDs, by table name: the table's, and each field's by name. */
export type SchemaIds = Readonly<
  Record<
    string,
    { readonly id: string; readonly fields: Readonly<Record<string, string>> }
  >
>;

/** A schema with its stable IDs: what a version brings to its store. */
export interface IdentifiedSchema {
  readonly manifest: SchemaManifest;
  readonly ids: SchemaIds;
}

/** A field a store holds values of: its name and type now. */
export interface CatalogField {
  readonly name: string;
  readonly type: ValueDescriptor;
  /** Left out of the schema in force; its values kept. */
  readonly kept?: true;
}

/** A table a store holds records of. */
export interface CatalogTable {
  readonly name: string;
  /** Left out of the schema in force; its records kept. */
  readonly kept?: true;
  /** Its fields, by ID. */
  readonly fields: Readonly<Record<string, CatalogField>>;
}

/**
 * Every table and field a store holds values of, by ID, kept ones
 * included: what the next schema is diffed against.
 */
export type Catalog = Readonly<Record<string, CatalogTable>>;

/** What a store holds: the schema in force and its catalog. */
export interface HeldSchema {
  readonly manifest: SchemaManifest;
  readonly catalog: Catalog;
}

/** Why a change can't be applied. */
export type RefusalReason =
  | "field_changed"
  | "id_changed"
  | "name_taken"
  | "reference_filled"
  | "rule_field_filled"
  | "answer_unfit";

/** One change refused, by the names the schema gives it. */
export interface Refusal {
  readonly table: string;
  readonly field?: string;
  readonly reason: RefusalReason;
}

/** A field, by the names the schema gives it. */
export interface PlannedField {
  readonly table: string;
  readonly field: string;
}

/**
 * A value to fill in where records lack a field (`absent`) or hold null in
 * it (`nulls`), which its type doesn't take: its default or answer, as
 * its type takes it.
 */
export interface PlannedFill extends PlannedField {
  readonly tableId: string;
  readonly value: Json;
  readonly absent: boolean;
  readonly nulls: boolean;
}

/** A field renamed in one table: its values move from `from` to `to`. */
export interface PlannedRename {
  readonly tableId: string;
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/** What a schema change does to a store (see the header). */
export interface SchemaChangePlan {
  readonly addedTables: readonly string[];
  readonly renamedTables: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly keptTables: readonly string[];
  readonly addedFields: readonly PlannedField[];
  readonly renamedFields: readonly PlannedRename[];
  readonly widenedFields: readonly PlannedField[];
  /**
   * Fields records may lack (`absent`) or hold null in (`nulls`), which
   * their type doesn't take, and the value they take, if any.
   */
  readonly checks: readonly (PlannedField & {
    readonly answer: FrozenJson | null;
    readonly absent: boolean;
    readonly nulls: boolean;
  })[];
  /** What is filled in where records lack it. */
  readonly fills: readonly PlannedFill[];
  readonly keptFields: readonly PlannedField[];
  readonly accessChanges: readonly string[];
  readonly sensitiveTables: readonly string[];
  readonly refused: readonly Refusal[];
  /** The store's catalog after it. */
  readonly catalog: Catalog;
}

/** What a change is planned with, besides the two schemas. */
export interface PlanOptions {
  readonly answers?: readonly SchemaAnswer[];
  /** The tables a migration of the version transforms, by name. */
  readonly migrated?: ReadonlySet<string>;
}

/** A plan as it is planned: its lists filled in place. */
type MutablePlan = {
  -readonly [Key in Exclude<keyof SchemaChangePlan, "catalog">]: [
    ...SchemaChangePlan[Key],
  ];
};

const own = <Value>(
  map: Readonly<Record<string, Value>>,
  key: string
): Value | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** `table`'s IDs; throws for a table or field `ids` doesn't name. */
const requireIds = (
  ids: SchemaIds,
  name: string,
  table: ManifestTable
): SchemaIds[string] => {
  const found = own(ids, name);
  const missing = Object.keys(table.fields).find(
    (field) => own(found?.fields ?? {}, field) === undefined
  );
  if (found === undefined || missing !== undefined) {
    throw new Error(
      `The schema's \`${missing === undefined ? name : `${name}.${missing}`}\` has no ID in the App's definition`
    );
  }
  return found;
};

/** The catalog of `schema` alone: what a store that held only it holds. */
export const catalogOf = (schema: IdentifiedSchema): Catalog =>
  Object.fromEntries(
    Object.entries(schema.manifest.tables).map(([name, table]) => {
      const ids = requireIds(schema.ids, name, table);
      return [
        ids.id,
        {
          name,
          fields: Object.fromEntries(
            Object.entries(table.fields).map(([field, type]) => [
              own(ids.fields, field) ?? "",
              { name: field, type },
            ])
          ),
        },
      ];
    })
  );

/** The fields a table's row rules read, by name. */
const ruleFields = (table: ManifestTable): Set<string> =>
  new Set(
    [...(table.rules?.read ?? []), ...(table.rules?.write ?? [])].flatMap(
      (rule) =>
        rule.kind === "person" || rule.kind === "team" ? [rule.field] : []
    )
  );

/** A table's access and row rules, as text. */
const accessText = (table: ManifestTable): string =>
  canonicalText({ access: table.access, rules: table.rules ?? null });

/** `descriptor`'s values but null, whatever its presence. */
const present = (descriptor: ValueDescriptor): ValueDescriptor => ({
  ...descriptor,
  presence:
    descriptor.presence === "optional" ? "required" : descriptor.presence,
  nullable: false,
});

/**
 * Why a table or field arriving under `id` with a name another ID holds
 * (`holderId`, `holder`) is refused: a name in force arriving under a new
 * ID, its own gone, is `id_changed`; any other, `name_taken`.
 */
const holderReason = (
  isNew: boolean,
  holder: { readonly kept?: true },
  holderStays: boolean
): RefusalReason =>
  isNew && holder.kept !== true && !holderStays ? "id_changed" : "name_taken";

/** What planning one table needs. */
interface TableInput {
  readonly tableId: string;
  readonly name: string;
  readonly table: ManifestTable;
  readonly ids: Readonly<Record<string, string>>;
  /** The table as the store holds it; undefined for a new one. */
  readonly was: CatalogTable | undefined;
  /** Tables renamed, old name to new: references follow them. */
  readonly tableNames: ReadonlyMap<string, string>;
  readonly answers: readonly SchemaAnswer[];
  readonly migrated: boolean;
}

/** What records may hold of a field that no longer fits its type. */
interface Lacking {
  /** Records may lack it. */
  readonly absent: boolean;
  /** Records may hold null in it. */
  readonly nulls: boolean;
}

/**
 * A field records of `input`'s table may lack, or hold null in
 * (`lacking`), which `type` doesn't take: its fill (its default, or the
 * App's answer), or a check for a value.
 */
const planLacking = (
  plan: MutablePlan,
  input: TableInput,
  { field, type }: { field: string; type: ValueDescriptor },
  lacking: Lacking
): void => {
  const absent = lacking.absent && type.presence !== "optional";
  const nulls = lacking.nulls && !type.nullable;
  if (!absent && !nulls) {
    return;
  }
  const { tableId, name, table, answers } = input;
  const answer = answers.find(
    (held) => held.table === name && held.field === field
  );
  // The App's answer first, null included: it is for exactly these records.
  let given: FrozenJson | undefined;
  if (answer !== undefined) {
    given = answer.value;
  } else if (type.presence === "default") {
    given = type.defaultValue ?? null;
  }
  if (type.presence !== "default" || answer !== undefined) {
    plan.checks.push({
      table: name,
      field,
      answer: given ?? null,
      absent,
      nulls,
    });
  }
  if (given === undefined) {
    return;
  }
  // As a write would store it: fitting its type, nested defaults filled.
  const fits = fitted(type, given);
  const stored = fieldValueSchema.safeParse(fits?.value);
  if (fits === undefined || !stored.success) {
    plan.refused.push({ table: name, field, reason: "answer_unfit" });
    return;
  }
  const value = stored.data;
  if (holdsReference(type)) {
    plan.refused.push({ table: name, field, reason: "reference_filled" });
  } else if (ruleFields(table).has(field)) {
    plan.refused.push({ table: name, field, reason: "rule_field_filled" });
  } else {
    plan.fills.push({ tableId, table: name, field, value, absent, nulls });
  }
};

/** Plans field `field` (ID `id`, of `type`) of a table the store holds. */
const planField = (
  plan: MutablePlan,
  input: TableInput,
  { id, field, type }: { id: string; field: string; type: ValueDescriptor }
): void => {
  const { tableId, name, was, tableNames } = input;
  const previous = own(was?.fields ?? {}, id);
  if (previous === undefined) {
    plan.addedFields.push({ table: name, field });
    planLacking(plan, input, { field, type }, { absent: true, nulls: false });
    return;
  }
  if (previous.name !== field) {
    plan.renamedFields.push({
      tableId,
      table: name,
      from: previous.name,
      to: field,
    });
  }
  if (previous.kept === true) {
    plan.addedFields.push({ table: name, field });
  }
  // References follow the tables they point at as those are renamed.
  const stored = referencesRenamed(previous.type, tableNames);
  const same = canonicalText(stored) === canonicalText(type);
  if (!same && fieldWidens(stored, type)) {
    plan.widenedFields.push({ table: name, field });
  }
  // Records written while it was kept may lack it.
  const kept = previous.kept === true;
  if (same || fieldWidens(stored, type)) {
    planLacking(plan, input, { field, type }, { absent: kept, nulls: false });
  } else if (fieldWidens(present(stored), present(type))) {
    // Its values fit; only records lacking it, or holding null, don't.
    planLacking(
      plan,
      input,
      { field, type },
      {
        absent: kept || stored.presence === "optional",
        nulls: stored.nullable,
      }
    );
  } else {
    plan.refused.push({ table: name, field, reason: "field_changed" });
  }
};

/**
 * `field`, kept: a reference in it follows the tables renamed
 * (`tableNames`) like a declared field's, so it never points at a table
 * gone by that name, nor at a new table that took the name.
 */
const keptField = (
  field: CatalogField,
  tableNames: ReadonlyMap<string, string>
): CatalogField => ({
  ...field,
  type: referencesRenamed(field.type, tableNames),
  kept: true,
});

/**
 * Field `field` (ID `id`) of a migrated table `was` holds, renamed all
 * the same, by ID: its history follows the new name.
 */
const planMigratedRename = (
  plan: MutablePlan,
  input: TableInput,
  { id, field, was }: { id: string; field: string; was: CatalogTable }
): void => {
  const previous = own(was.fields, id);
  if (previous !== undefined && previous.name !== field) {
    plan.renamedFields.push({
      tableId: input.tableId,
      table: input.name,
      from: previous.name,
      to: field,
    });
  }
};

/** Plans one table's fields onto `plan`; answers its catalog entry. */
const planTable = (plan: MutablePlan, input: TableInput): CatalogTable => {
  const { name, table, ids, was, migrated } = input;
  const heldFields = was?.fields ?? {};
  const fields: Record<string, CatalogField> = {};
  for (const [field, type] of Object.entries(table.fields)) {
    const id = own(ids, field) ?? "";
    fields[id] = { name: field, type };
    const holder = Object.entries(heldFields).find(
      ([other, held]) => other !== id && held.name === field
    );
    // A migration's output may take over a kept field's name under a new
    // ID, but not for a field the store's reference index or a row rule
    // reads: the kept values were never checked as such.
    const takesOver =
      migrated &&
      holder?.[1].kept === true &&
      !holdsReference(type) &&
      !ruleFields(table).has(field);
    if (holder !== undefined && !takesOver) {
      const [holderId, holding] = holder;
      plan.refused.push({
        table: name,
        field,
        reason: holderReason(
          own(heldFields, id) === undefined,
          holding,
          Object.values(ids).includes(holderId)
        ),
      });
    } else if (was !== undefined && !migrated) {
      // A new table holds no records; a migrated one's are rewritten by
      // its migration, whose output must fit.
      planField(plan, input, { id, field, type });
    } else if (was !== undefined) {
      planMigratedRename(plan, input, { id, field, was });
    }
  }
  for (const [id, field] of Object.entries(heldFields)) {
    // A migration's output takes over a kept name it declares anew.
    const takenOver = migrated && own(table.fields, field.name) !== undefined;
    if (own(fields, id) !== undefined || takenOver) {
      continue;
    }
    if (field.kept !== true) {
      plan.keptFields.push({ table: name, field: field.name });
    }
    fields[id] = keptField(field, input.tableNames);
  }
  return { name, fields };
};

/** The tables of `after`, with their IDs. */
const declaredTables = (after: IdentifiedSchema) =>
  Object.entries(after.manifest.tables).map(([name, table]) => ({
    name,
    table,
    ids: requireIds(after.ids, name, table),
  }));

/**
 * The tables `after` renames, old name to new: references, declared or
 * kept, follow the tables they point at.
 */
const renamedTableNames = (
  held: Catalog,
  after: IdentifiedSchema
): Map<string, string> =>
  new Map(
    declaredTables(after).flatMap(({ name, ids }) => {
      const was = own(held, ids.id);
      return was === undefined || was.name === name ? [] : [[was.name, name]];
    })
  );

/** Plans the tables of `after` onto `plan`; answers their catalog entries. */
const planTables = (
  plan: MutablePlan,
  before: HeldSchema | null,
  after: IdentifiedSchema,
  tableNames: ReadonlyMap<string, string>,
  { answers = [], migrated = new Set() }: PlanOptions
): Record<string, CatalogTable> => {
  const held = before?.catalog ?? {};
  const declared = declaredTables(after);
  const declaredIds = new Set(declared.map(({ ids }) => ids.id));
  const catalog: Record<string, CatalogTable> = {};
  for (const { name, table, ids } of declared) {
    const was = own(held, ids.id);
    // Tables are told apart regardless of case.
    const holder = Object.entries(held).find(
      ([other, heldTable]) =>
        other !== ids.id && heldTable.name.toLowerCase() === name.toLowerCase()
    );
    if (holder !== undefined) {
      const [holderId, holding] = holder;
      plan.refused.push({
        table: name,
        reason: holderReason(
          was === undefined,
          holding,
          declaredIds.has(holderId)
        ),
      });
      continue;
    }
    if (was === undefined) {
      plan.addedTables.push(name);
    } else if (was.name !== name) {
      plan.renamedTables.push({ id: ids.id, from: was.name, to: name });
    }
    const previous =
      was === undefined || was.kept === true || before === null
        ? undefined
        : own(before.manifest.tables, was.name);
    if (previous !== undefined && accessText(previous) !== accessText(table)) {
      plan.accessChanges.push(name);
    }
    if (table.sensitive === true && previous?.sensitive !== true) {
      plan.sensitiveTables.push(name);
    }
    catalog[ids.id] = planTable(plan, {
      tableId: ids.id,
      name,
      table,
      ids: ids.fields,
      was,
      tableNames,
      answers,
      migrated: migrated.has(name),
    });
  }
  return catalog;
};

/**
 * Plans the move from what a store holds (`before`, null for a store that
 * holds nothing yet) to `after` (see the header). Throws for a schema whose
 * tables or fields `after.ids` doesn't name.
 */
export const planSchemaChange = (
  before: HeldSchema | null,
  after: IdentifiedSchema,
  options: PlanOptions = {}
): SchemaChangePlan => {
  const plan: MutablePlan = {
    addedTables: [],
    renamedTables: [],
    keptTables: [],
    addedFields: [],
    renamedFields: [],
    widenedFields: [],
    checks: [],
    fills: [],
    keptFields: [],
    accessChanges: [],
    sensitiveTables: [],
    refused: [],
  };
  const held = before?.catalog ?? {};
  const tableNames = renamedTableNames(held, after);
  const catalog = planTables(plan, before, after, tableNames, options);
  for (const [id, table] of Object.entries(held)) {
    if (own(catalog, id) !== undefined) {
      continue;
    }
    if (table.kept !== true) {
      plan.keptTables.push(table.name);
    }
    catalog[id] = {
      ...table,
      kept: true,
      fields: Object.fromEntries(
        Object.entries(table.fields).map(([fieldId, field]) => [
          fieldId,
          { ...field, type: referencesRenamed(field.type, tableNames) },
        ])
      ),
    };
  }
  return { ...plan, catalog };
};
