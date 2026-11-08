import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { DescriptorSchema } from "./references.ts";
import type { ValueSchema } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";

// The input and output inference below (which keys of an object may be left
// out by a caller, and which a handler can rely on) is adapted from
// Baseflare's value validators (MIT, © 2026 Baseflare contributors:
// packages/baseflare/src/values/types.ts), as is the record ID format.

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

/**
 * What `v.object` takes as its fields: schemas, and the descriptor schemas
 * a generated module holds (a decision's `valueSchema`), read back as the
 * schemas they describe.
 */
export type ObjectFields = Readonly<
  Record<string, AnySchema | DescriptorSchema>
>;

/** `Fields` with each descriptor schema as the schema it describes. */
export type ShapeOf<Fields extends ObjectFields> = {
  readonly [Key in keyof Fields]: Fields[Key] extends DescriptorSchema<
    infer Input,
    infer Output
  >
    ? SimpleSchema<Input, Output>
    : Extract<Fields[Key], AnySchema>;
};

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
