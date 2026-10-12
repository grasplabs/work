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
//   stay valid, and nothing is rewritten. A required, nullable-only or
//   defaulted field would need every existing record filled in first,
//   which is a migration (a defaulted one a generated backfill, spec 17.2;
//   never a default made up while reading);
// - a table, or an optional field, the schema leaves out: kept in the
//   contract, and its data with it, never dropped. A required or defaulted
//   field left out is refused: the schema's inserts would lack it;
// - an index added or changed: installed beside the old ones, which stay
//   for versions pinned to them; the contract lists the newest. Indexes
//   don't constrain data.
//
// Anything else needs explicit intent in a migration and is refused here:
// a field whose descriptor changed in any way (type, constraint, default,
// presence, reference policy), and a changed access mode, either way: a
// looser mode exposes records, a tighter one would leave older versions
// reading under the looser one.

/** Why a change can't be applied without a migration. */
export type PlanRefusalReason =
  | "access_changed"
  | "field_changed"
  | "required_field_added"
  | "defaulted_field_added"
  | "required_field_removed"
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
  /** Indexes added or whose fields changed: each a new physical index. */
  readonly addedIndexes: readonly PlannedIndex[];
  /** Tables the schema leaves out, kept with their records. */
  readonly retainedTables: readonly string[];
  /** Optional fields the schema leaves out, kept in every record. */
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

/** Where a field's change goes: refused, added or retained. */
interface FieldOutcomes {
  readonly refused: PlanRefusal[];
  readonly addedFields: PlannedField[];
  readonly retainedFields: PlannedField[];
}

/** Classifies one change of a field of a table on both sides (see the header). */
const classifyField = (
  change: FieldChange,
  { refused, addedFields, retainedFields }: FieldOutcomes
): void => {
  const { table, field } = change;
  if (change.change === "changed") {
    if (!sameUpToEnumOrder(change.before, change.after)) {
      refused.push({ table, field, reason: "field_changed" });
    }
  } else if (change.change === "added") {
    const presence = change.after?.presence;
    if (presence === "optional") {
      addedFields.push({ table, field });
    } else {
      refused.push({
        table,
        field,
        reason:
          presence === "default"
            ? "defaulted_field_added"
            : "required_field_added",
      });
    }
  } else if (change.before?.presence === "optional") {
    retainedFields.push({ table, field });
  } else {
    refused.push({ table, field, reason: "required_field_removed" });
  }
};

/**
 * How `contract`, a store's data contract (null for a store holding
 * nothing yet), changes when the store is handed `target` (see the
 * header). Both are canonical manifests. Refused when any change needs a
 * migration, with every such change; otherwise the contract after it.
 */
export const planSchemaChange = (
  contract: SchemaManifest | null,
  target: SchemaManifest
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
  const retainedFields: PlannedField[] = [];
  for (const change of diff.fields) {
    if (onBothSides(change.table)) {
      classifyField(change, { refused, addedFields, retainedFields });
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
