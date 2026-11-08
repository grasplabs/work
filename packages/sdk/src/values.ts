import {
  cursorMaxLength,
  queryDefaultPageSize,
  queryMaxResults,
} from "@grasp-os/shared/store-limits";

import { seal } from "./descriptor-seal.ts";
import { descriptorOf, fieldDescriptors } from "./sealed-descriptors.ts";
import type { DescriptorDraft } from "./sealed-descriptors.ts";
import { descriptorVersion, isPlainObject } from "./value-descriptor.ts";
import type { SemanticKind } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import type {
  ArraySchema,
  FileValue,
  Id,
  Infer,
  InferInput,
  MoneyValue,
  NumberSchema,
  ObjectFields,
  ObjectSchema,
  ScheduleValue,
  ShapeOf,
  SimpleSchema,
  StringSchema,
} from "./value-types.ts";

// `v`: how an App states what a value is. A function's arguments and return,
// a table's fields and a form's values are all declared with it, and checked
// by the one interpreter behind `schema["~standard"].validate`.
//
// Values are JSON and nothing else. There is deliberately no `any`, no
// bytes, vector or BigInt, no coercion, and no callback to transform or
// refine a value: a schema is data (its descriptor), so the browser and the
// Worker check the same thing. A business rule belongs in the handler.

export { defineSchema } from "./define-schema.ts";
export { defineTable } from "./define-table.ts";
export type {
  IndexDefinition,
  IndexField,
  SchemaDefinition,
  TableDefinition,
} from "./schema-types.ts";
export { rows } from "./table-access.ts";
export type {
  AccessMode,
  RowRole,
  RowRule,
  RowRules,
  TableAccess,
} from "./table-access.ts";
export { ValueDefinitionError } from "./value-descriptor.ts";
export type {
  JsonValue,
  ValueDefinitionCode,
  ValueDescriptor,
  ValueIssue,
  ValueIssueCode,
  ValueResult,
  ValueSchema,
} from "./value-descriptor.ts";

/**
 * `field` as a schema: a descriptor schema read back from its descriptor,
 * checked as any stored descriptor is; anything else as it is, for
 * `fieldDescriptors` to accept or refuse.
 */
const fieldSchema = (field: unknown): unknown =>
  isPlainObject(field) && field.kind === "descriptor" && !("~standard" in field)
    ? schemaOf(readDescriptor(field.descriptor, 1, { nodes: 0 }))
    : field;

/**
 * The schema of a descriptor, as the builder that asked for it types it.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the one place a schema built at run time gets its static type; see SAFETY
const schema = <Schema extends AnySchema>(draft: DescriptorDraft): Schema =>
  // SAFETY: a schema's modifiers depend on its descriptor's kind alone
  // (`schemaOf`), and each builder below asks for the interface of the kind
  // it seals. The input and output types are what that descriptor makes the
  // interpreter accept and return, which values.test-d.ts and the
  // conformance cases hold to each other.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  schemaOf(seal(draft)) as Schema;

/** What every new schema starts as: required, and not null. */
const required = {
  descriptorVersion,
  nullable: false,
  presence: "required",
} as const;

const semantic =
  <Value>(kind: SemanticKind) =>
  (): SimpleSchema<Value, Value> =>
    schema({ ...required, kind });

/**
 * The value builders. Each returns a new immutable schema; so does every
 * modifier, so a schema can be shared and built on without changing it.
 */
export const v = Object.freeze({
  array: <Item extends AnySchema>(
    item: Item
  ): ArraySchema<InferInput<Item>[], Infer<Item>[]> =>
    schema({ ...required, item: descriptorOf(item), kind: "array" }),
  boolean: (): SimpleSchema<boolean, boolean> =>
    schema({ ...required, kind: "boolean" }),
  /** Positive whole milliseconds. */
  duration: semantic<number>("duration"),
  /** One of a fixed set of strings. */
  enum: <const Values extends readonly [string, ...string[]]>(
    values: Values
  ): SimpleSchema<Values[number], Values[number]> =>
    schema({ ...required, kind: "enum", values }),
  /** A file, as `{ id }`. Holding the reference grants no access. */
  file: semantic<FileValue>("file"),
  /**
   * The ID of a record in the named table. In a table's field, deleting the
   * record it names is refused while this record holds it, unless
   * `onDelete` is `cascade`: then this record is deleted with it, within
   * the bound of one commit (a larger deletion is a workflow's, in
   * batches).
   */
  id: <const TableName extends string>(
    tableName: TableName,
    options?: { readonly onDelete?: "restrict" | "cascade" }
  ): SimpleSchema<Id<TableName>, Id<TableName>> =>
    schema({
      ...required,
      kind: "id",
      tableName,
      onDelete: options?.onDelete,
    }),
  literal: <const Value extends null | boolean | number | string>(
    value: Value
  ): SimpleSchema<Value, Value> =>
    schema({ ...required, kind: "literal", value }),
  /** A model the host offers, by reference. */
  model: semantic<string>("model"),
  /** `{ minorUnits, currency }`: whole minor units of an ISO 4217 currency. */
  money: semantic<MoneyValue>("money"),
  null: (): SimpleSchema<null, null> => schema({ ...required, kind: "null" }),
  /** A finite number; `.integer()` for whole ones. */
  number: (): NumberSchema =>
    schema({ ...required, integer: false, kind: "number" }),
  /**
   * An object with exactly these fields. A field may be a generated
   * descriptor schema, such as a decision's `valueSchema`.
   */
  object: <const Fields extends ObjectFields>(
    shape: Fields
  ): ObjectSchema<ShapeOf<Fields>> =>
    schema({
      ...required,
      fields: fieldDescriptors(
        isPlainObject(shape)
          ? Object.fromEntries(
              Object.entries(shape).map(([name, field]) => [
                name,
                fieldSchema(field),
              ])
            )
          : shape
      ),
      kind: "object",
    }),
  /** A person, by reference. */
  person: semantic<string>("person"),
  /** An object with any string keys, every value of one schema. */
  record: <Value extends AnySchema>(
    value: Value
  ): SimpleSchema<
    Record<string, InferInput<Value>>,
    Record<string, Infer<Value>>
  > => schema({ ...required, kind: "record", value: descriptorOf(value) }),
  /** `{ cron, timeZone }`: five cron fields in an IANA time zone. */
  schedule: semantic<ScheduleValue>("schedule"),
  string: (): StringSchema =>
    schema({ ...required, email: false, kind: "string", trim: false }),
  /** A template, by reference. */
  template: semantic<string>("template"),
  /** A moment, in whole milliseconds since the Unix epoch (UTC). */
  timestamp: semantic<number>("timestamp"),
  /** The first of the member schemas the value fits. */
  union: <const Members extends readonly [AnySchema, ...AnySchema[]]>(
    ...members: Members
  ): SimpleSchema<InferInput<Members[number]>, Infer<Members[number]>> =>
    schema({ ...required, kind: "union", members: members.map(descriptorOf) }),
});

// The page contract, as schemas an operation declares for its
// arguments and return: `{ pageSize, cursor }` in, `{ items, nextCursor,
// hasMore }` out. A page's two shapes are two strict objects, so a page
// with a cursor always says there is more, and the last page never carries
// a cursor, empty or not.

/** A page request: `pageSize` 1 to 100 (50 unless set), and a cursor or null. */
export const paginationOptionsValidator = v.object({
  pageSize: v
    .number()
    .integer()
    .min(1)
    .max(queryMaxResults)
    .default(queryDefaultPageSize),
  cursor: v.string().min(1).max(cursorMaxLength).nullable().default(null),
});

/** One page of `item`s: the last one without a cursor, any other with one. */
export const paginationResultValidator = <Item extends AnySchema>(item: Item) =>
  v.union(
    v.object({
      items: v.array(item).max(queryMaxResults),
      nextCursor: v.null(),
      hasMore: v.literal(false),
    }),
    v.object({
      items: v.array(item).min(1).max(queryMaxResults),
      nextCursor: v.string().min(1).max(cursorMaxLength),
      hasMore: v.literal(true),
    })
  );
