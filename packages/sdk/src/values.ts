import type { StandardSchemaV1 } from "@standard-schema/spec";

import { descriptorVersion } from "./value-descriptor.ts";
import type { SemanticKind, ValueSchema } from "./value-descriptor.ts";
import {
  descriptorOf,
  fieldDescriptors,
  schemaOf,
  seal,
} from "./value-schema.ts";
import type { AnySchema, DescriptorDraft } from "./value-schema.ts";

// `v`: how an App states what a value is. A function's arguments and return,
// a table's fields and a form's values are all declared with it, and checked
// by the one interpreter behind `schema["~standard"].validate`.
//
// Values are JSON and nothing else. There is deliberately no `any`, no
// bytes, vector or BigInt, no coercion, and no callback to transform or
// refine a value: a schema is data (its descriptor), so the browser, the
// Worker and a portable host check the same thing. A business rule belongs
// in the handler.
//
// The input and output inference below (which keys of an object may be left
// out by a caller, and which a handler can rely on) is adapted from
// Baseflare's value validators (MIT, © 2026 Baseflare contributors:
// packages/baseflare/src/values/types.ts), as is the record ID format.

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

/** What a caller may pass: a field with a default may be left out. */
export type InferInput<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferInput<Schema>;

/** What a handler gets, normalized: a field with a default is always there. */
export type Infer<Schema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<Schema>;

/**
 * The ID of a record in one table. The table is in the type only: whether
 * the record exists, and whether the caller may see it, is the host's to
 * decide.
 */
export type Id<TableName extends string = string> = string & {
  readonly __tableName: TableName;
};

/** A file, by reference. Holding one grants no access to it. */
export interface FileValue {
  id: string;
}

/** An amount in whole minor units of its currency (cents for EUR). */
export interface MoneyValue {
  /** An ISO 4217 code in upper case, e.g. `EUR`. */
  currency: string;
  minorUnits: number;
}

/** When something happens: five cron fields, read in an IANA time zone. */
export interface ScheduleValue {
  cron: string;
  timeZone: string;
}

/** With `undefined`: the value may be left out. */
type Omittable<Value> = Exclude<Value, undefined> | undefined;

/**
 * The modifiers every schema has, written out per kind below so each keeps
 * its own constraints after one. `.optional()` and `.default()` exclude each
 * other: a value is left out or filled in, never both.
 */
export interface SimpleSchema<Input, Output> extends ValueSchema<
  Input,
  Output
> {
  /** Stands in when the value is left out, never for `null`, `""` or `0`. */
  readonly default: (
    value: Exclude<Input, undefined>
  ) => SimpleSchema<Input | undefined, Exclude<Output, undefined>>;
  readonly nullable: () => SimpleSchema<Input | null, Output | null>;
  readonly optional: () => SimpleSchema<Input | undefined, Output | undefined>;
}

export interface StringSchema<
  Input = string,
  Output = string,
> extends ValueSchema<Input, Output> {
  readonly default: (
    value: Exclude<Input, undefined>
  ) => StringSchema<Input | undefined, Exclude<Output, undefined>>;
  /** A practical format check, not proof that mail arrives. */
  readonly email: () => StringSchema<Input, Output>;
  /** In UTF-16 code units, as `String.length` counts. */
  readonly max: (length: number) => StringSchema<Input, Output>;
  readonly min: (length: number) => StringSchema<Input, Output>;
  readonly nullable: () => StringSchema<Input | null, Output | null>;
  readonly optional: () => StringSchema<Input | undefined, Output | undefined>;
  /** Removes whitespace at both ends before the length is checked. */
  readonly trim: () => StringSchema<Input, Output>;
}

export interface NumberSchema<
  Input = number,
  Output = number,
> extends ValueSchema<Input, Output> {
  readonly default: (
    value: Exclude<Input, undefined>
  ) => NumberSchema<Input | undefined, Exclude<Output, undefined>>;
  /** Only whole numbers that are safe integers. */
  readonly integer: () => NumberSchema<Input, Output>;
  readonly max: (limit: number) => NumberSchema<Input, Output>;
  readonly min: (limit: number) => NumberSchema<Input, Output>;
  readonly nullable: () => NumberSchema<Input | null, Output | null>;
  readonly optional: () => NumberSchema<Input | undefined, Output | undefined>;
}

export interface ArraySchema<Input, Output> extends ValueSchema<Input, Output> {
  readonly default: (
    value: Exclude<Input, undefined>
  ) => ArraySchema<Input | undefined, Exclude<Output, undefined>>;
  /** In elements. */
  readonly max: (length: number) => ArraySchema<Input, Output>;
  readonly min: (length: number) => ArraySchema<Input, Output>;
  readonly nullable: () => ArraySchema<Input | null, Output | null>;
  readonly optional: () => ArraySchema<Input | undefined, Output | undefined>;
}

/** The fields of an object: a plain map, to share and spread as one. */
export type ValueShape = Readonly<Record<string, AnySchema>>;

// oxlint-disable-next-line typescript/ban-types -- `& {}` makes an editor show the object's keys instead of this alias
type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

/** What a caller passes for a shape: optional and defaulted keys may go. */
export type ObjectInput<Shape extends ValueShape> = Simplify<
  {
    -readonly [
      Key in keyof Shape as undefined extends InferInput<Shape[Key]>
        ? never
        : Key
    ]: InferInput<Shape[Key]>;
  } & {
    -readonly [
      Key in keyof Shape as undefined extends InferInput<Shape[Key]>
        ? Key
        : never
    ]?: Exclude<InferInput<Shape[Key]>, undefined>;
  }
>;

/** What a shape normalizes to: only optional keys may be missing. */
export type ObjectOutput<Shape extends ValueShape> = Simplify<
  {
    -readonly [
      Key in keyof Shape as undefined extends Infer<Shape[Key]> ? never : Key
    ]: Infer<Shape[Key]>;
  } & {
    -readonly [
      Key in keyof Shape as undefined extends Infer<Shape[Key]> ? Key : never
    ]?: Exclude<Infer<Shape[Key]>, undefined>;
  }
>;

/** A field as `.partial()` leaves it: optional, without its default. */
type PartialField<Field> =
  Field extends StringSchema<infer Input, infer Output>
    ? StringSchema<Omittable<Input>, Omittable<Output>>
    : Field extends NumberSchema<infer Input, infer Output>
      ? NumberSchema<Omittable<Input>, Omittable<Output>>
      : Field extends ObjectSchema<infer Shape, infer Input, infer Output>
        ? ObjectSchema<Shape, Omittable<Input>, Omittable<Output>>
        : Field extends ArraySchema<infer Input, infer Output>
          ? ArraySchema<Omittable<Input>, Omittable<Output>>
          : Field extends ValueSchema<infer Input, infer Output>
            ? SimpleSchema<Omittable<Input>, Omittable<Output>>
            : never;

/**
 * An object with exactly the declared keys: any other key is refused, on
 * every target, with no way to let them through.
 */
export interface ObjectSchema<
  Shape extends ValueShape,
  Input = ObjectInput<Shape>,
  Output = ObjectOutput<Shape>,
> extends ValueSchema<Input, Output> {
  readonly default: (
    value: Exclude<Input, undefined>
  ) => ObjectSchema<Shape, Input | undefined, Exclude<Output, undefined>>;
  /**
   * A new object with more fields. It can't replace a field: to change one,
   * build the shape you mean with `v.object`.
   */
  readonly extend: <const Added extends ValueShape>(
    fields: Added & { readonly [Key in keyof Shape]?: never }
  ) => ObjectSchema<Simplify<Shape & Added>>;
  readonly nullable: () => ObjectSchema<Shape, Input | null, Output | null>;
  /** A new object without the named fields. */
  readonly omit: <const Key extends keyof Shape>(
    keys: readonly Key[]
  ) => ObjectSchema<Simplify<Omit<Shape, Key>>>;
  readonly optional: () => ObjectSchema<
    Shape,
    Input | undefined,
    Output | undefined
  >;
  /**
   * A new object for a patch: every field optional and without its default,
   * so a field left out stays left out. Only the top level changes.
   */
  readonly partial: () => ObjectSchema<{
    readonly [Key in keyof Shape]: PartialField<Shape[Key]>;
  }>;
  /** A new object with only the named fields. */
  readonly pick: <const Key extends keyof Shape>(
    keys: readonly Key[]
  ) => ObjectSchema<Simplify<Pick<Shape, Key>>>;
  readonly shape: Shape;
}

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
  /** The ID of a record in the named table. */
  id: <const TableName extends string>(
    tableName: TableName
  ): SimpleSchema<Id<TableName>, Id<TableName>> =>
    schema({ ...required, kind: "id", tableName }),
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
  object: <const Shape extends ValueShape>(shape: Shape): ObjectSchema<Shape> =>
    schema({ ...required, fields: fieldDescriptors(shape), kind: "object" }),
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
