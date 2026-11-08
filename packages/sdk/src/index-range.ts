import type {
  QueryScalar,
  RangeBound,
  RangeOperator,
} from "@grasp-os/shared/store-reads";

import { refuse } from "./query-error.ts";
import type { IndexRange } from "./query-types.ts";
import { baseOf, fits, nullableField } from "./query-values.ts";
import type { IndexDefinition, TableState } from "./schema-types.ts";

/** What a range builder recorded, and the table and index it was made for. */
interface RecordedRange {
  readonly owner: IndexDefinition;
  readonly bounds: readonly RangeBound[];
}

/** Every range builder this module made, with what it recorded. */
export const ranges = new WeakMap<object, RecordedRange>();

/** Where a range being built is: its owner, fields left and bounds so far. */
interface RangeState {
  /**
   * The index it is built for: the very definition of the schema the
   * reader reads, so a range built by another reader, even over a schema
   * with the same names, is no range of this one.
   */
  readonly owner: IndexDefinition;
  readonly table: TableState;
  /** The index fields not yet bounded. */
  readonly fields: readonly string[];
  readonly bounds: readonly RangeBound[];
  /** The field a lower bound was set on, which only its upper bound follows. */
  readonly lowerOn: string | null;
  /** Whether an upper bound ended it. */
  readonly ended: boolean;
}

/**
 * A range over the index fields still free in `range`. Each call answers a
 * new range; a call out of order, on the wrong field, or after the range
 * ended is refused. It belongs to its table's index: another's refuses it.
 */
export const rangeOf = (range: RangeState): IndexRange => {
  /** One more bound on a range, checked: in order, typed, and never null past equality. */
  const add = (
    op: RangeOperator,
    field: unknown,
    value: unknown
  ): IndexRange => {
    if (range.ended) {
      return refuse(
        "query.invalid_range",
        "An index range ends at its upper bound; nothing can follow it."
      );
    }
    if (range.lowerOn !== null && op !== "lt" && op !== "lte") {
      return refuse(
        "query.invalid_range",
        `After a lower bound on \`${range.lowerOn}\` only an upper bound on it may follow.`
      );
    }
    const expected = range.lowerOn ?? range.fields[0];
    if (typeof field !== "string" || field !== expected) {
      return refuse(
        "query.invalid_range",
        expected === undefined
          ? "This index range has no field left to bound."
          : `An index range bounds its fields in order: next is \`${expected}\`.`
      );
    }
    const base = baseOf(range.table, field);
    const allowNull = op === "eq" && nullableField(range.table, field);
    if (base === undefined || !fits(value, base, allowNull)) {
      return refuse(
        "query.invalid_range",
        allowNull
          ? `\`${field}\` is compared with a ${base ?? "scalar"} or null.`
          : `\`${field}\` is bounded by a ${base ?? "scalar"}, never null.`
      );
    }
    const bounds = [
      ...range.bounds,
      // SAFETY: `fits` checked it is a scalar of the field's type, or null.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      { field, op, value: value as QueryScalar },
    ];
    if (op === "eq") {
      return rangeOf({ ...range, fields: range.fields.slice(1), bounds });
    }
    if (op === "gt" || op === "gte") {
      return rangeOf({
        ...range,
        fields: range.fields.slice(1),
        bounds,
        lowerOn: field,
      });
    }
    return rangeOf({ ...range, bounds, lowerOn: null, ended: true });
  };

  const built = Object.freeze({
    "~indexRange": true as const,
    eq: (field: unknown, value: unknown) => add("eq", field, value),
    gt: (field: unknown, value: unknown) => add("gt", field, value),
    gte: (field: unknown, value: unknown) => add("gte", field, value),
    lt: (field: unknown, value: unknown) => add("lt", field, value),
    lte: (field: unknown, value: unknown) => add("lte", field, value),
  });
  ranges.set(built, {
    owner: range.owner,
    bounds: Object.freeze(range.bounds.map((bound) => Object.freeze(bound))),
  });
  return built;
};
