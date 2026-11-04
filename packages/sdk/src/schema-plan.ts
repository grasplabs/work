import { assignable } from "./descriptor-assignable.ts";
import { diffSchemaManifests } from "./schema-diff.ts";
import type { FieldChange, SchemaDiff } from "./schema-diff.ts";
import {
  manifestText,
  manifestVersion,
  readSchemaManifest,
} from "./schema-manifest.ts";
import type { ManifestTable, SchemaManifest } from "./schema-manifest.ts";
import { managedFields, SchemaDefinitionError } from "./schema.ts";
import type { RowRules } from "./schema.ts";
import { descriptorVersion, ValueDefinitionError } from "./value-descriptor.ts";
import type { FrozenJson, ValueDescriptor } from "./value-descriptor.ts";

// How a store's data contract changes when it is handed a new schema
// (spec 17.1, 17.4): which changes apply on their own, which the store
// applies once it checked every record it holds, and what the contract is
// afterwards. Pure: the store's host runs it, and carries its steps out
// (apps/core/src/store-host.ts, store-schema-changes.ts).
//
// Every record a store holds fits its contract, always (as Convex holds
// every document to the schema in force). The contract is every table and
// field of every schema the store accepted, so versions sealed on it keep
// writing records that fit; a field's descriptor in it is the newest the
// store took.
//
// Applied at once, with no record rewritten:
//
// - a new table: no record of it exists yet, so any fields;
// - a new optional field on a table the contract has: records without it
//   stay valid;
// - a new defaulted field on a table the contract has: safe once every
//   record the store holds has it, so the plan lists it as a field to
//   fill (`filledFields`), and the store fills it in, where it is
//   missing, before its contract takes the field (spec 17.2's generated
//   fill-missing backfill; never a default made up while reading). A
//   defaulted field that can hold a record ID at any depth is refused: a
//   default reference would make every record refer to one record, which
//   the store's reference index (and its restrict and cascade rules)
//   must be told of, so it is an explicit migration, never a fill;
// - a field widened (`widenedFields`): every value the old descriptor
//   takes, the new one takes too (`fieldWidens`: a higher `max`, a new
//   enum value, a field made optional or nullable), so every record still
//   fits, and so does every write of a version sealed before;
// - a table, or a field, the schema leaves out: kept in the contract, and
//   its data with it, never dropped. A required field left out is kept as
//   optional, a widening: records keep their values, and the schema's
//   inserts, which lack it, fit. The store fills a defaulted field in on
//   every write that lacks it;
// - an index added or changed: installed beside the old ones, which stay
//   for versions pinned to them; the contract lists the newest. Indexes
//   don't constrain data.
//
// Applied only as the release that brings them is made current
// (`activates`), in one transaction that first checks every record the
// tables hold (store-schema-changes.ts), the version in force serving
// until then:
//
// - a field narrowed, or changed in any other way that isn't a widening,
//   and a required or nullable-only field added (`checks`): every record
//   must fit the new descriptor. When one doesn't, the change is a
//   question (the store answers its rows and why, never their values),
//   answered by a value the App declares for the field (`SchemaAnswer`,
//   a backfill's default for the records that lack it, never written over
//   a value they hold), or by an explicit migration, a per-row function
//   in code (below), the one way to reshape what records hold;
// - a field renamed (`renames`, a seam for the App definition's stable
//   field IDs): the new field takes the old one's value, which stays in
//   the record, its field kept as optional;
// - a changed access mode or row rule (`ruleChanges`): no record changes.
//   The store reads and writes every table under the access and rules its
//   contract holds, whichever version is pinned (store-host.ts,
//   `#pinned`), so once the contract takes them they hold for every
//   record and every version at once.
//
// Refused (`refused`):
//
// - a field that can hold a record ID or a file, changed in a way that
//   isn't the same up to enum order (the store's reference and file
//   indexes would have to follow), or added as required;
// - an answer, a rename or a default fill that would write a field a row
//   rule reads (`rule_field_rewritten`): who sees a record changes only
//   through writes, which pass the rules before and after
//   (store-rules.ts);
// - a field the store reserved (`reserved`: one a pending target added
//   before an admin abandoned it, whose values the records it filled in
//   keep), added again with another descriptor than it had
//   (`reserved_field_changed`), on a table the contract has or one the
//   schema adds alike.
//
// A table declared sensitive (`TableDefinition.sensitive`) changes no
// data, and no plan: the store keeps which tables any schema declared so
// (core's store-host.ts, `sdk_tables.sensitive`).
//
// A table an explicit migration transforms (`migrated`, spec 17.2) may
// also take a required field without a default, and a field whose
// descriptor changed: the migration's transform rewrites every record of
// the table before the contract takes the change, so the contract holds
// the schema's descriptors for that table's declared fields (its
// retained ones kept), and nothing of it is filled in or checked (the
// transform's output, validated against the table, supplies defaults).
// Still refused there: a field holding a record ID that is added or
// changed (the store's reference index would have to follow), and a
// field whose old and new values can't overlap (`values_disjoint`: a
// migration only expands, its output fitting the version in force too).
// A migrated table must be on both sides (`migration_table_invalid`): a
// table the contract hasn't holds no record to transform.

/** Why a change can't be applied without a migration. */
export type PlanRefusalReason =
  | "field_changed"
  | "required_field_added"
  | "defaulted_reference_added"
  | "reserved_field_changed"
  | "rule_field_rewritten"
  | "migration_table_invalid"
  | "values_disjoint"
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

/**
 * An App's value for the records that lack one field a change requires
 * (`app({ answers })`): only a record that doesn't hold it, or holds
 * null, takes it, and it must fit. A backfill's default, never written
 * over a value a record holds: anything that reshapes what a record holds
 * is an explicit migration, a per-row function in code.
 */
export interface SchemaAnswer extends PlannedField {
  readonly value: FrozenJson;
}

/**
 * A field whose records the store checks before the contract takes it
 * (see the header): every record must fit its new descriptor, given the
 * App's `answer` where it doesn't, or, for a field renamed, the value of
 * the field it was renamed `from`. When records still don't fit, the
 * store asks for a value or a migration.
 */
export interface PlannedCheck extends PlannedField {
  readonly answer: SchemaAnswer | null;
  readonly from: string | null;
}

/** A field renamed: `to` takes `from`'s value (see the header). */
export interface PlannedRename {
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/** What a change adds to the contract, what it keeps, and what it checks. */
export interface PlannedChanges {
  readonly addedTables: readonly string[];
  readonly addedFields: readonly PlannedField[];
  /**
   * Defaulted fields added to a table the contract has, also listed in
   * `addedFields`: each to be filled in with its default in every record
   * that lacks it before the contract takes it.
   */
  readonly filledFields: readonly PlannedField[];
  /** Fields whose new descriptor takes every value the old one took. */
  readonly widenedFields: readonly PlannedField[];
  /** Fields every record must fit before the contract takes them. */
  readonly checks: readonly PlannedCheck[];
  /** Fields renamed; each new name is checked too. */
  readonly renames: readonly PlannedRename[];
  /** Tables whose access mode or row rules change. */
  readonly ruleChanges: readonly string[];
  /** Indexes added or whose fields changed: each a new physical index. */
  readonly addedIndexes: readonly PlannedIndex[];
  /** Tables the schema leaves out, kept with their records. */
  readonly retainedTables: readonly string[];
  /** Fields the schema leaves out, kept in every record. */
  readonly retainedFields: readonly PlannedField[];
  /** Indexes the schema leaves out or redefines, kept as they are. */
  readonly retainedIndexes: readonly PlannedIndex[];
}

/** A change the store may apply: the contract after it, and what it changes. */
export interface AcceptedPlan extends PlannedChanges {
  readonly accepted: true;
  /** The tables an explicit migration transforms, sorted. */
  readonly migratedTables: readonly string[];
  /** The contract after the change, canonical. */
  readonly contract: SchemaManifest;
  /** Whether the contract differs from the one before. */
  readonly changed: boolean;
  /**
   * Whether the change waits for its release to be made current, and is
   * applied then, after a check of every record (`checks`, `renames`,
   * `ruleChanges`; see the header).
   */
  readonly activates: boolean;
}

/** A change refused: every reason it needs a migration. */
export interface RefusedPlan extends PlannedChanges {
  readonly accepted: false;
  readonly refused: readonly PlanRefusal[];
}

export type SchemaPlan = AcceptedPlan | RefusedPlan;

/**
 * Fields a store reserved, by table and field, each with the descriptor
 * it may be added with again (see the header).
 */
export type ReservedFields = Readonly<
  Record<string, Readonly<Record<string, ValueDescriptor>>>
>;

/** What a change is planned with, besides the contract and the target. */
export interface PlanOptions {
  /** The fields the store reserved. */
  readonly reserved?: ReservedFields;
  /** The tables an explicit migration transforms. */
  readonly migrated?: ReadonlySet<string>;
  /** The App's answers for fields a narrowing may not fit. */
  readonly answers?: readonly SchemaAnswer[];
  /** Fields renamed, as the App definition's stable IDs tell them. */
  readonly renames?: readonly PlannedRename[];
}

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

/** Whether `descriptor` holds a value of one of `kinds`, at any depth. */
const holdsKind = (
  descriptor: ValueDescriptor,
  kinds: ReadonlySet<ValueDescriptor["kind"]>
): boolean => {
  if (kinds.has(descriptor.kind)) {
    return true;
  }
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).some((field) =>
      holdsKind(field, kinds)
    );
  }
  if (descriptor.kind === "array") {
    return holdsKind(descriptor.item, kinds);
  }
  if (descriptor.kind === "union") {
    return descriptor.members.some((member) => holdsKind(member, kinds));
  }
  if (descriptor.kind === "record") {
    return holdsKind(descriptor.value, kinds);
  }
  return false;
};

const idKinds: ReadonlySet<ValueDescriptor["kind"]> = new Set(["id"]);
const indexedKinds: ReadonlySet<ValueDescriptor["kind"]> = new Set([
  "id",
  "file",
]);

/** Whether `descriptor` can hold a record ID, at any depth. */
export const holdsId = (descriptor: ValueDescriptor): boolean =>
  holdsKind(descriptor, idKinds);

/**
 * Whether `descriptor` can hold a record ID or a file, at any depth: what
 * the store's reference and file indexes read a record's fields by.
 */
const holdsIndexed = (descriptor: ValueDescriptor): boolean =>
  holdsKind(descriptor, indexedKinds);

/**
 * Whether a field of `after` may always be left as `before` left it: a
 * field that may be missing stays one that may only where `after` lets it
 * be. A defaulted field is never missing in a stored record (the store
 * fills it in), so it may become required.
 */
const presenceWidens = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean => after.presence === "optional" || before.presence !== "optional";

/**
 * Whether `after` gives a field nested in an object a default that
 * `before` didn't: a stored record may lack the field, and a read leaves
 * it missing (defaults are filled in as values are written, never made up
 * as they are read), so such a change fills it in first (`checks`,
 * `withDefaultsFilled`), never counts as a widening. Through objects,
 * array items and record values; a union's members are left as they are.
 */
const addsNestedDefault = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean => {
  if (before.kind === "object" && after.kind === "object") {
    return Object.entries(after.fields).some(([name, field]) => {
      const was = own(before.fields, name);
      return field.presence === "default"
        ? was?.presence !== "default"
        : was !== undefined && addsNestedDefault(was, field);
    });
  }
  if (before.kind === "array" && after.kind === "array") {
    return addsNestedDefault(before.item, after.item);
  }
  if (before.kind === "record" && after.kind === "record") {
    return addsNestedDefault(before.value, after.value);
  }
  return false;
};

/**
 * Whether every value field `before` holds, `after` takes, and a record
 * lacking it fits `after` wherever it fit `before`, as stored: a
 * widening, which no stored record can fail and none needs filling in
 * for (descriptor-assignable.ts, `assignable`, is conservative: what it
 * can't prove isn't one; a nested default added isn't one either,
 * `addsNestedDefault`).
 */
export const fieldWidens = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean =>
  presenceWidens(before, after) &&
  assignable(before, after) &&
  !addsNestedDefault(before, after);

/**
 * `value`, which fits `descriptor`, with every default of a field nested
 * in an object that it lacks filled in: through objects, array items and
 * record values, as a write would have stored them. Nothing it holds is
 * changed. A union's members are left as they are.
 */
export const withDefaultsFilled = (
  descriptor: ValueDescriptor,
  value: unknown
): unknown => {
  if (
    descriptor.kind === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const held: Readonly<Record<string, unknown>> = Object.fromEntries(
      Object.entries(value)
    );
    const filled: Record<string, unknown> = { ...held };
    for (const [name, field] of Object.entries(descriptor.fields)) {
      if (Object.hasOwn(held, name)) {
        filled[name] = withDefaultsFilled(field, held[name]);
      } else if (field.presence === "default") {
        filled[name] = field.defaultValue ?? null;
      }
    }
    return filled;
  }
  if (descriptor.kind === "array" && Array.isArray(value)) {
    return value.map((item: unknown) =>
      withDefaultsFilled(descriptor.item, item)
    );
  }
  if (
    descriptor.kind === "record" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        withDefaultsFilled(descriptor.value, item),
      ])
    );
  }
  return value;
};

/** `descriptor` as a field that may be left out. */
const relaxed = (descriptor: ValueDescriptor): ValueDescriptor =>
  descriptor.presence === "required"
    ? { ...descriptor, presence: "optional" }
    : descriptor;

/** The fields a table's row rules read, either way. */
const ruleFields = (rules: RowRules | undefined): Set<string> =>
  new Set(
    [...(rules?.read ?? []), ...(rules?.write ?? [])].flatMap((rule) =>
      "field" in rule ? [rule.field] : []
    )
  );

/**
 * `kept`, the contract's table, with the target's version of it
 * (`declared`) merged in: every field it declares as it declares it (the
 * contract's own where they are the same up to enum order, so no
 * reordering moves the contract), every other the contract holds kept,
 * as optional (see the header); its indexes, search index, access and
 * rules.
 */
const mergedTable = (
  kept: ManifestTable,
  declared: ManifestTable
): ManifestTable => ({
  fields: mapOf([
    ...Object.entries(kept.fields).map(([field, descriptor]) => {
      const now = own(declared.fields, field);
      if (now === undefined) {
        return [field, relaxed(descriptor)] as const;
      }
      return [
        field,
        sameUpToEnumOrder(descriptor, now) ? descriptor : now,
      ] as const;
    }),
    ...Object.entries(declared.fields).filter(
      ([field]) => own(kept.fields, field) === undefined
    ),
  ]),
  indexes: declared.indexes,
  ...(declared.searchIndex === undefined
    ? {}
    : { searchIndex: declared.searchIndex }),
  access: declared.access,
  ...(declared.rules === undefined ? {} : { rules: declared.rules }),
});

/** The contract after a change: the union, read back canonical. */
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

/** The descriptor `field` of `table` is reserved with, if it is. */
const reservedAs = (
  reserved: ReservedFields,
  table: string,
  field: string
): ValueDescriptor | undefined => {
  const fields = own(reserved, table);
  return fields === undefined ? undefined : own(fields, field);
};

/** Where a field's change goes. */
interface FieldOutcomes {
  readonly refused: PlanRefusal[];
  readonly addedFields: PlannedField[];
  readonly filledFields: PlannedField[];
  readonly widenedFields: PlannedField[];
  readonly checks: PlannedCheck[];
  readonly retainedFields: PlannedField[];
}

/** What a table on both sides is planned with. */
interface TableContext {
  readonly reserved: ReservedFields;
  readonly migrated: boolean;
  /** The App's answers for this table's fields, by field. */
  readonly answers: ReadonlyMap<string, SchemaAnswer>;
  /** Fields renamed on this table, by their new name: the old one. */
  readonly renamedFrom: ReadonlyMap<string, string>;
  /** The fields the table's row rules read, before or after. */
  readonly ruleFields: ReadonlySet<string>;
}

/**
 * Whether some value fits both `before` and `after`: the same kind, a
 * string and an enum (an enum's members are strings), a union with a
 * member that overlaps the other, or both nullable. A migration only
 * expands, so its output fits the contract in force and the target at
 * once: a change whose value sets can't overlap (a string becoming a
 * number) can't run under it, and is refused (`values_disjoint`).
 */
const valuesOverlap = (
  before: ValueDescriptor,
  after: ValueDescriptor
): boolean => {
  if (before.nullable && after.nullable) {
    return true;
  }
  if (before.kind === "union") {
    return before.members.some((member) => valuesOverlap(member, after));
  }
  if (after.kind === "union") {
    return after.members.some((member) => valuesOverlap(before, member));
  }
  const kinds = new Set([before.kind, after.kind]);
  return kinds.size === 1 || (kinds.has("string") && kinds.has("enum"));
};

/**
 * Classifies one change of a field of a migrated table (see the header),
 * where it isn't the same as on any other: a field added or changed.
 * Whether it did.
 */
const classifyMigrated = (
  change: FieldChange,
  { refused, addedFields }: FieldOutcomes
): boolean => {
  const { table, field } = change;
  const references =
    (change.before !== undefined && holdsId(change.before)) ||
    (change.after !== undefined && holdsId(change.after));
  if (change.change === "changed") {
    if (references && !sameUpToEnumOrder(change.before, change.after)) {
      refused.push({ table, field, reason: "field_changed" });
    } else if (
      change.before !== undefined &&
      change.after !== undefined &&
      !valuesOverlap(change.before, change.after)
    ) {
      refused.push({ table, field, reason: "values_disjoint" });
    }
    return true;
  }
  if (change.change === "added") {
    if (references) {
      refused.push({
        table,
        field,
        reason:
          change.after?.presence === "default"
            ? "defaulted_reference_added"
            : "required_field_added",
      });
    } else {
      addedFields.push({ table, field });
    }
    return true;
  }
  return false;
};

/**
 * A check of `field` of `table`, which records must fit as `after`
 * describes it, answered by the App's answer for it or, for a field
 * renamed, by the field it was renamed from. Refused when the answer
 * would rewrite a field a row rule reads, or one the store's reference
 * or file index reads.
 */
const checkOf = (
  change: FieldChange & { readonly after: ValueDescriptor },
  context: TableContext,
  { refused, checks }: FieldOutcomes
): void => {
  const { table, field } = change;
  const from = context.renamedFrom.get(field) ?? null;
  const answer = from === null ? (context.answers.get(field) ?? null) : null;
  // A value, a rename or a default fill all write the field.
  const rewrites =
    answer !== null || from !== null || change.after.presence === "default";
  if (rewrites && context.ruleFields.has(field)) {
    refused.push({ table, field, reason: "rule_field_rewritten" });
    return;
  }
  if (rewrites && holdsIndexed(change.after)) {
    refused.push({ table, field, reason: "field_changed" });
    return;
  }
  checks.push({ table, field, answer, from });
};

/** Classifies a field added to a table on both sides (see the header). */
const classifyAdded = (
  change: FieldChange & { readonly after: ValueDescriptor },
  context: TableContext,
  outcomes: FieldOutcomes
): void => {
  const { refused, addedFields, filledFields } = outcomes;
  const { table, field, after } = change;
  if (context.renamedFrom.has(field)) {
    addedFields.push({ table, field });
    checkOf(change, context, outcomes);
  } else if (after.presence === "optional") {
    addedFields.push({ table, field });
  } else if (after.presence === "default" && holdsId(after)) {
    refused.push({ table, field, reason: "defaulted_reference_added" });
  } else if (after.presence === "default" && context.ruleFields.has(field)) {
    // Filled in, it would decide who sees records no write moved.
    refused.push({ table, field, reason: "rule_field_rewritten" });
  } else if (after.presence === "default") {
    addedFields.push({ table, field });
    filledFields.push({ table, field });
  } else if (holdsIndexed(after)) {
    refused.push({ table, field, reason: "required_field_added" });
  } else {
    addedFields.push({ table, field });
    checkOf(change, context, outcomes);
  }
};

/** Classifies one change of a field of a table on both sides (see the header). */
const classifyField = (
  change: FieldChange,
  context: TableContext,
  outcomes: FieldOutcomes
): void => {
  const { refused, widenedFields, retainedFields } = outcomes;
  const { table, field, before, after } = change;
  const kept = reservedAs(context.reserved, table, field);
  if (
    change.change === "added" &&
    kept !== undefined &&
    !sameUpToEnumOrder(kept, after)
  ) {
    refused.push({ table, field, reason: "reserved_field_changed" });
  } else if (context.migrated && classifyMigrated(change, outcomes)) {
    // A migrated table's own rules.
  } else if (after === undefined) {
    // Left out, or renamed: kept, its values with it.
    retainedFields.push({ table, field });
  } else if (change.change === "added" || before === undefined) {
    classifyAdded({ ...change, after }, context, outcomes);
  } else if (sameUpToEnumOrder(before, after)) {
    // No change to what it holds.
  } else if (holdsIndexed(before) || holdsIndexed(after)) {
    refused.push({ table, field, reason: "field_changed" });
  } else if (fieldWidens(before, after)) {
    widenedFields.push({ table, field });
  } else {
    checkOf({ ...change, after }, context, outcomes);
  }
};

/** The migrated tables not on both sides (see the header). */
const migratedTablesRefused = (
  before: SchemaManifest,
  target: SchemaManifest,
  migrated: ReadonlySet<string>
): PlanRefusal[] =>
  [...migrated]
    .filter(
      (table) =>
        own(before.tables, table) === undefined ||
        own(target.tables, table) === undefined
    )
    .map((table) => ({ table, reason: "migration_table_invalid" }));

/**
 * The renames that apply: of a table on both sides, from a field the
 * contract holds and the target leaves out, to one the target adds. A
 * rename of a field the store's indexes read, or that a row rule reads,
 * is refused (see the header).
 */
const renamesOf = (
  before: SchemaManifest,
  target: SchemaManifest,
  renames: readonly PlannedRename[],
  refused: PlanRefusal[]
): PlannedRename[] =>
  renames.filter(({ table, from, to }) => {
    const kept = own(before.tables, table);
    const declared = own(target.tables, table);
    const old = kept === undefined ? undefined : own(kept.fields, from);
    if (
      kept === undefined ||
      declared === undefined ||
      old === undefined ||
      own(declared.fields, from) !== undefined ||
      own(kept.fields, to) !== undefined ||
      own(declared.fields, to) === undefined
    ) {
      return false;
    }
    if (holdsIndexed(old)) {
      refused.push({ table, field: to, reason: "field_changed" });
      return false;
    }
    if (ruleFields(kept.rules).has(from)) {
      refused.push({ table, field: to, reason: "rule_field_rewritten" });
      return false;
    }
    return true;
  });

/** The answers and renames of `table`, as `classifyField` reads them. */
const contextOf = (
  table: string,
  before: SchemaManifest,
  target: SchemaManifest,
  options: {
    reserved: ReservedFields;
    migrated: ReadonlySet<string>;
    answers: readonly SchemaAnswer[];
    renames: readonly PlannedRename[];
  }
): TableContext => ({
  reserved: options.reserved,
  migrated: options.migrated.has(table),
  answers: new Map(
    options.answers
      .filter((answer) => answer.table === table)
      .map((answer) => [answer.field, answer])
  ),
  renamedFrom: new Map(
    options.renames
      .filter((rename) => rename.table === table)
      .map(({ from, to }) => [to, from])
  ),
  ruleFields: new Set([
    ...ruleFields(own(before.tables, table)?.rules),
    ...ruleFields(own(target.tables, table)?.rules),
  ]),
});

/**
 * The fields of the tables `target` adds that the store reserved with
 * another descriptor (see the header).
 */
const reservedRefused = (
  target: SchemaManifest,
  addedTables: ReadonlySet<string>,
  reserved: ReservedFields
): PlanRefusal[] =>
  [...addedTables].flatMap((table) =>
    Object.entries(own(target.tables, table)?.fields ?? {}).flatMap(
      ([field, descriptor]): PlanRefusal[] => {
        const kept = reservedAs(reserved, table, field);
        return kept !== undefined && !sameUpToEnumOrder(kept, descriptor)
          ? [{ table, field, reason: "reserved_field_changed" }]
          : [];
      }
    )
  );

/** The indexes a change installs, and those it keeps (see the header). */
const indexesOf = (
  diff: SchemaDiff,
  addedTables: ReadonlySet<string>,
  retainedTables: ReadonlySet<string>
): { addedIndexes: PlannedIndex[]; retainedIndexes: PlannedIndex[] } => {
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
  return { addedIndexes, retainedIndexes };
};

/**
 * Classifies every change of a field of a table on both sides
 * (`classifyField`), each table with its answers and renames.
 */
const classifyFields = (
  diff: SchemaDiff,
  onBothSides: (table: string) => boolean,
  build: (table: string) => TableContext,
  outcomes: FieldOutcomes
): void => {
  const contexts = new Map<string, TableContext>();
  for (const change of diff.fields) {
    if (onBothSides(change.table)) {
      const context = contexts.get(change.table) ?? build(change.table);
      contexts.set(change.table, context);
      classifyField(change, context, outcomes);
    }
  }
};

/**
 * How `contract`, a store's data contract (null for a store holding
 * nothing yet), changes when the store is handed `target` (see the
 * header), given the fields the store reserved, the tables an explicit
 * migration transforms, the App's answers and the renames. Both are
 * canonical manifests. Refused when any change needs a migration (that
 * none covers), with every such change; otherwise the contract after it,
 * and whether it waits for activation.
 */
export const planSchemaChange = (
  contract: SchemaManifest | null,
  target: SchemaManifest,
  options: PlanOptions = {}
): SchemaPlan => {
  const reserved = options.reserved ?? {};
  const migrated = options.migrated ?? new Set<string>();
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

  const outcomes: FieldOutcomes = {
    refused: [
      ...migratedTablesRefused(before, target, migrated),
      ...reservedRefused(target, addedTables, reserved),
    ],
    addedFields: [],
    filledFields: [],
    widenedFields: [],
    checks: [],
    retainedFields: [],
  };
  const renames = renamesOf(
    before,
    target,
    options.renames ?? [],
    outcomes.refused
  );
  const answers = options.answers ?? [];
  classifyFields(
    diff,
    onBothSides,
    (table) =>
      contextOf(table, before, target, {
        reserved,
        migrated,
        answers,
        renames,
      }),
    outcomes
  );
  const { refused, ...fields } = outcomes;
  const changes: PlannedChanges = {
    addedTables: [...addedTables],
    ...fields,
    renames,
    ruleChanges: diff.access
      .filter(({ table }) => onBothSides(table))
      .map(({ table }) => table),
    ...indexesOf(diff, addedTables, retainedTables),
    retainedTables: [...retainedTables],
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
    migratedTables: [...migrated].toSorted(),
    activates:
      changes.checks.length > 0 ||
      changes.renames.length > 0 ||
      changes.ruleChanges.length > 0,
    ...changes,
  };
};

/**
 * Whether `contract` covers `schema`: a version sealed on it may write
 * under it as it is, every record it writes fitting the contract. Every
 * table and field it declares is in the contract, each field as it
 * declares it or widened since (`fieldWidens`; one the store's indexes
 * read, the same up to enum order), and every field the contract
 * requires, it declares too (one with a default the store fills in).
 * Its access and rules don't count: the store reads and writes under the
 * contract's (see the header); nor do its indexes, installed whatever the
 * contract lists. A store holding nothing covers only a schema of no
 * tables.
 */
export const schemaCovered = (
  contract: SchemaManifest | null,
  schema: SchemaManifest
): boolean =>
  Object.entries(schema.tables).every(([name, table]) => {
    const kept = contract === null ? undefined : own(contract.tables, name);
    if (kept === undefined) {
      return false;
    }
    const declaredFit = Object.entries(table.fields).every(
      ([field, descriptor]) => {
        const held = own(kept.fields, field);
        if (held === undefined) {
          return false;
        }
        if (sameUpToEnumOrder(descriptor, held)) {
          return true;
        }
        return (
          !holdsIndexed(descriptor) &&
          !holdsIndexed(held) &&
          fieldWidens(descriptor, held)
        );
      }
    );
    return (
      declaredFit &&
      Object.entries(kept.fields).every(
        ([field, held]) =>
          held.presence !== "required" || own(table.fields, field) !== undefined
      )
    );
  });
