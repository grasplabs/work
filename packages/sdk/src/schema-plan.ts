import { diffSchemaManifests } from "./schema-diff.ts";
import type { FieldChange } from "./schema-diff.ts";
import {
  manifestText,
  manifestVersion,
  readSchemaManifest,
} from "./schema-manifest.ts";
import type { ManifestTable, SchemaManifest } from "./schema-manifest.ts";
import { managedFields, SchemaDefinitionError } from "./schema.ts";
import { descriptorVersion, ValueDefinitionError } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// How a store's data contract changes when it is handed a new schema
// (spec 17.1, 17.4): which changes are safe to apply on their own, and
// what the contract is afterwards. Pure: the store's host runs it inside
// the transaction that applies it (apps/core/src/store-host.ts).
//
// A store's contract is every table and field of every schema it
// accepted, the union, so every version ever sealed on the store stays
// compatible with it, a rollback included. A change is safe, and applied
// without a migration, when the union still describes every record the
// store holds and every record any accepted version may write:
//
// - a new table: no record of it exists yet, so any fields;
// - a new optional field on a table the contract has: records without it
//   stay valid, and nothing is rewritten;
// - a new defaulted field on a table the contract has: safe once every
//   record the store holds has it, so the plan lists it as a field to
//   fill (`filledFields`), and the store fills it in, where it is
//   missing, before its contract takes the field (spec 17.2's generated
//   fill-missing backfill; never a default made up while reading). A
//   required or nullable-only field has no value to fill in: a migration.
//   So is a defaulted field that can hold a record ID at any depth: a
//   default reference would make every record refer to one record, which
//   the store's reference index (and its restrict and cascade rules)
//   must be told of, so it is an explicit migration, never a fill;
// - a table, or an optional or defaulted field, the schema leaves out:
//   kept in the contract, and its data with it, never dropped. The
//   store fills a defaulted field in on every write that lacks it, so the
//   schema's inserts still fit (the fill-missing rule is the compatible
//   mapping spec 17.4 step 5 asks of retained writers). A required field
//   left out is refused: the schema's inserts would lack it;
// - an index added or changed: installed beside the old ones, which stay
//   for versions pinned to them; the contract lists the newest. Indexes
//   don't constrain data.
//
// Anything else needs explicit intent in a migration and is refused here:
// a field whose descriptor changed in any way (type, constraint, default,
// presence, reference policy), and a changed access mode, either way: a
// looser mode exposes records, a tighter one would leave older versions
// reading under the looser one.
//
// A field the store reserved (`reserved`: one a pending target added
// before an admin abandoned it, whose values the records it filled in
// keep) is added again only with the descriptor it had, so those values
// still fit it; with any other it is refused (`reserved_field_changed`),
// on a table the contract has or one the schema adds alike.

/** Why a change can't be applied without a migration. */
export type PlanRefusalReason =
  | "access_changed"
  | "field_changed"
  | "required_field_added"
  | "defaulted_reference_added"
  | "required_field_removed"
  | "reserved_field_changed"
  | "contract_invalid";

/** One change refused, and why. */
export interface PlanRefusal {
  readonly table: string;
  readonly field?: string;
  readonly reason: PlanRefusalReason;
}

/** A table's field, as a plan names it. */
export interface PlannedField {
  readonly table: string;
  readonly field: string;
}

/** A table's index, as a plan names it. */
export interface PlannedIndex {
  readonly table: string;
  readonly index: string;
}

/** What a safe change adds to the contract, and what it keeps. */
export interface PlannedChanges {
  readonly addedTables: readonly string[];
  readonly addedFields: readonly PlannedField[];
  /**
   * Defaulted fields added to a table the contract has, also listed in
   * `addedFields`: each to be filled in with its default in every record
   * that lacks it before the contract takes it.
   */
  readonly filledFields: readonly PlannedField[];
  /** Indexes added or whose fields changed: each a new physical index. */
  readonly addedIndexes: readonly PlannedIndex[];
  /** Tables the schema leaves out, kept with their records. */
  readonly retainedTables: readonly string[];
  /** Optional or defaulted fields the schema leaves out, kept in every record. */
  readonly retainedFields: readonly PlannedField[];
  /** Indexes the schema leaves out or redefines, kept as they are. */
  readonly retainedIndexes: readonly PlannedIndex[];
}

/** A safe change: the contract after it, and what it changes. */
export interface AcceptedPlan extends PlannedChanges {
  readonly accepted: true;
  /** The contract after the change, canonical. */
  readonly contract: SchemaManifest;
  /** Whether the contract differs from the one before. */
  readonly changed: boolean;
}

/** A change refused: every reason it needs a migration. */
export interface RefusedPlan extends PlannedChanges {
  readonly accepted: false;
  readonly refused: readonly PlanRefusal[];
}

export type SchemaPlan = AcceptedPlan | RefusedPlan;

/** The contract of a store that holds nothing yet. */
const emptyContract: SchemaManifest = {
  manifestVersion,
  descriptorVersion,
  managedFields,
  tables: {},
};

/**
 * `descriptor` with every enum's members sorted, at every depth: an enum
 * is a set of strings, so declaring its members in another order permits
 * exactly the same values. Walked by kind, through object fields, array
 * items, union members and record values; a union's members keep their
 * order, which can decide how a value is read, and data (defaults,
 * literals) is never touched.
 */
const enumsSorted = (descriptor: ValueDescriptor): ValueDescriptor => {
  if (descriptor.kind === "enum") {
    return { ...descriptor, values: descriptor.values.toSorted() };
  }
  if (descriptor.kind === "object") {
    return {
      ...descriptor,
      fields: Object.fromEntries(
        Object.entries(descriptor.fields).map(([name, field]) => [
          name,
          enumsSorted(field),
        ])
      ),
    };
  }
  if (descriptor.kind === "array") {
    return { ...descriptor, item: enumsSorted(descriptor.item) };
  }
  if (descriptor.kind === "union") {
    return {
      ...descriptor,
      members: descriptor.members.map((member) => enumsSorted(member)),
    };
  }
  if (descriptor.kind === "record") {
    return { ...descriptor, value: enumsSorted(descriptor.value) };
  }
  // Every other kind holds no descriptor and no enum.
  return descriptor;
};

/** A descriptor's canonical text, its enums sorted (`enumsSorted`). */
const sortedText = (descriptor: ValueDescriptor): string =>
  manifestText({
    ...emptyContract,
    tables: {
      t: {
        fields: { f: enumsSorted(descriptor) },
        indexes: {},
        access: { read: "none", write: "none" },
      },
    },
  });

/**
 * Whether two descriptors of a field permit the same values, enum
 * members in any order: such a change is no change to the data a store
 * holds.
 */
const sameUpToEnumOrder = (
  before: ValueDescriptor | undefined,
  after: ValueDescriptor | undefined
): boolean =>
  before !== undefined &&
  after !== undefined &&
  sortedText(before) === sortedText(after);

const own = <Value>(
  map: Readonly<Record<string, Value>>,
  name: string
): Value | undefined => (Object.hasOwn(map, name) ? map[name] : undefined);

/** The map `entries` as an object with no prototype keys. */
const mapOf = <Value>(
  entries: Iterable<readonly [string, Value]>
): Record<string, Value> => Object.fromEntries(entries);

/** `contract`'s table `name` with the target's version of it merged in. */
const mergedTable = (
  kept: ManifestTable,
  declared: ManifestTable
): ManifestTable => ({
  fields: mapOf([
    ...Object.entries(kept.fields),
    ...Object.entries(declared.fields).filter(
      ([field]) => own(kept.fields, field) === undefined
    ),
  ]),
  indexes: declared.indexes,
  access: kept.access,
});

/** The contract after a safe change: the union, read back canonical. */
const unionOf = (
  contract: SchemaManifest,
  target: SchemaManifest
): SchemaManifest | undefined => {
  const tables = mapOf([
    ...Object.entries(contract.tables).map(([name, kept]) => {
      const declared = own(target.tables, name);
      return [
        name,
        declared === undefined ? kept : mergedTable(kept, declared),
      ] as const;
    }),
    ...Object.entries(target.tables).filter(
      ([name]) => own(contract.tables, name) === undefined
    ),
  ]);
  try {
    // Declared again through the SDK's own checks: a union past a
    // schema's limits (its size, its tables) is refused like any schema.
    return readSchemaManifest(manifestText({ ...contract, tables })).manifest;
  } catch (error) {
    if (
      error instanceof SchemaDefinitionError ||
      error instanceof ValueDefinitionError
    ) {
      return undefined;
    }
    throw error;
  }
};

/** Whether `descriptor` can hold a record ID, at any depth. */
const holdsId = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.kind === "id") {
    return true;
  }
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).some((field) => holdsId(field));
  }
  if (descriptor.kind === "array") {
    return holdsId(descriptor.item);
  }
  if (descriptor.kind === "union") {
    return descriptor.members.some((member) => holdsId(member));
  }
  if (descriptor.kind === "record") {
    return holdsId(descriptor.value);
  }
  return false;
};

/**
 * Fields a store reserved, by table and field, each with the descriptor
 * it may be added with again (see the header).
 */
export type ReservedFields = Readonly<
  Record<string, Readonly<Record<string, ValueDescriptor>>>
>;

/** The descriptor `field` of `table` is reserved with, if it is. */
const reservedAs = (
  reserved: ReservedFields,
  table: string,
  field: string
): ValueDescriptor | undefined => {
  const fields = own(reserved, table);
  return fields === undefined ? undefined : own(fields, field);
};

/** Where a field's change goes: refused, added or retained. */
interface FieldOutcomes {
  readonly refused: PlanRefusal[];
  readonly addedFields: PlannedField[];
  readonly filledFields: PlannedField[];
  readonly retainedFields: PlannedField[];
}

/** Classifies one change of a field of a table on both sides (see the header). */
const classifyField = (
  change: FieldChange,
  reserved: ReservedFields,
  { refused, addedFields, filledFields, retainedFields }: FieldOutcomes
): void => {
  const { table, field } = change;
  const kept = reservedAs(reserved, table, field);
  if (
    change.change === "added" &&
    kept !== undefined &&
    !sameUpToEnumOrder(kept, change.after)
  ) {
    refused.push({ table, field, reason: "reserved_field_changed" });
  } else if (change.change === "changed") {
    if (!sameUpToEnumOrder(change.before, change.after)) {
      refused.push({ table, field, reason: "field_changed" });
    }
  } else if (change.change === "added") {
    const presence = change.after?.presence;
    if (presence === "optional") {
      addedFields.push({ table, field });
    } else if (
      presence === "default" &&
      change.after !== undefined &&
      holdsId(change.after)
    ) {
      refused.push({ table, field, reason: "defaulted_reference_added" });
    } else if (presence === "default") {
      addedFields.push({ table, field });
      filledFields.push({ table, field });
    } else {
      refused.push({ table, field, reason: "required_field_added" });
    }
  } else if (
    change.before?.presence === "optional" ||
    change.before?.presence === "default"
  ) {
    retainedFields.push({ table, field });
  } else {
    refused.push({ table, field, reason: "required_field_removed" });
  }
};

/**
 * How `contract`, a store's data contract (null for a store holding
 * nothing yet), changes when the store is handed `target` (see the
 * header), given the fields the store reserved. Both are canonical
 * manifests. Refused when any change needs a migration, with every such
 * change; otherwise the contract after it.
 */
export const planSchemaChange = (
  contract: SchemaManifest | null,
  target: SchemaManifest,
  reserved: ReservedFields = {}
): SchemaPlan => {
  const before = contract ?? emptyContract;
  const diff = diffSchemaManifests(before, target);
  const addedTables = new Set(
    diff.tables.filter(({ change }) => change === "added").map((t) => t.table)
  );
  const retainedTables = new Set(
    diff.tables.filter(({ change }) => change === "removed").map((t) => t.table)
  );
  const onBothSides = (table: string): boolean =>
    !addedTables.has(table) && !retainedTables.has(table);

  const refused: PlanRefusal[] = [];
  const addedFields: PlannedField[] = [];
  const filledFields: PlannedField[] = [];
  const retainedFields: PlannedField[] = [];
  for (const change of diff.fields) {
    if (onBothSides(change.table)) {
      classifyField(change, reserved, {
        refused,
        addedFields,
        filledFields,
        retainedFields,
      });
    }
  }
  for (const table of addedTables) {
    const fields = own(target.tables, table)?.fields ?? {};
    for (const [field, descriptor] of Object.entries(fields)) {
      const kept = reservedAs(reserved, table, field);
      if (kept !== undefined && !sameUpToEnumOrder(kept, descriptor)) {
        refused.push({ table, field, reason: "reserved_field_changed" });
      }
    }
  }
  for (const { table } of diff.access) {
    if (onBothSides(table)) {
      refused.push({ table, reason: "access_changed" });
    }
  }
  const addedIndexes: PlannedIndex[] = [];
  const retainedIndexes: PlannedIndex[] = [];
  for (const { table, index, change } of diff.indexes) {
    if (retainedTables.has(table)) {
      continue;
    }
    if (change !== "removed") {
      addedIndexes.push({ table, index });
    }
    if (change !== "added" && !addedTables.has(table)) {
      retainedIndexes.push({ table, index });
    }
  }
  const changes: PlannedChanges = {
    addedTables: [...addedTables],
    addedFields,
    filledFields,
    addedIndexes,
    retainedTables: [...retainedTables],
    retainedFields,
    retainedIndexes,
  };
  if (refused.length > 0) {
    return { accepted: false, refused, ...changes };
  }
  const union = unionOf(before, target);
  if (union === undefined) {
    return {
      accepted: false,
      refused: [{ table: "", reason: "contract_invalid" }],
      ...changes,
    };
  }
  return {
    accepted: true,
    contract: union,
    changed: manifestText(union) !== manifestText(before),
    ...changes,
  };
};
