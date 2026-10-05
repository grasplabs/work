import type { StandardSchemaV1 } from "@standard-schema/spec";

// What a value schema is, as data. A descriptor is plain frozen JSON: it has
// no functions, so it can be stored, hashed, sent to a browser and turned
// back into a schema without running App code. The one interpreter
// (value-interpreter.ts) reads it wherever a value is checked.

/** Anything JSON can hold. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A default as a descriptor holds it: JSON, frozen all the way down, so no
 * two parses can share (and change) it.
 */
export type FrozenJson =
  | null
  | boolean
  | number
  | string
  | readonly FrozenJson[]
  | { readonly [key: string]: FrozenJson };

/** The version of the descriptor format below, not of Standard Schema. */
export const descriptorVersion = 1;

/**
 * Whether a value may be left out: `required` needs it, `optional` allows
 * leaving it out, `default` fills it in when it is left out.
 */
export type Presence = "required" | "optional" | "default";

interface DescriptorBase {
  /** Only when `presence` is `default`, and valid under this descriptor. */
  readonly defaultValue?: FrozenJson;
  readonly descriptorVersion: 1;
  readonly nullable: boolean;
  readonly presence: Presence;
}

/** The kinds whose value has one fixed form and no constraints to set. */
export type SemanticKind =
  | "timestamp"
  | "file"
  | "money"
  | "person"
  | "model"
  | "template"
  | "duration"
  | "schedule";

const semanticKinds: ReadonlySet<unknown> = new Set<SemanticKind>([
  "timestamp",
  "file",
  "money",
  "person",
  "model",
  "template",
  "duration",
  "schedule",
]);

export const isSemanticKind = (kind: unknown): kind is SemanticKind =>
  semanticKinds.has(kind);

/** What each kind adds to a descriptor. */
export type ValueKindDescriptor =
  | {
      readonly kind: "string";
      readonly trim: boolean;
      readonly email: boolean;
      /** In UTF-16 code units, as `String.length` counts. */
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "boolean" | "null" }
  | {
      readonly kind: "literal";
      readonly value: null | boolean | number | string;
    }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "id"; readonly tableName: string }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, ValueDescriptor>>;
    }
  | {
      readonly kind: "array";
      readonly item: ValueDescriptor;
      /** In elements. */
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "union"; readonly members: readonly ValueDescriptor[] }
  | { readonly kind: "record"; readonly value: ValueDescriptor }
  | { readonly kind: SemanticKind };

/** A value schema as data: fully discriminated, with nothing callable. */
export type ValueDescriptor = DescriptorBase & ValueKindDescriptor;

/**
 * The bounds of one descriptor and one check. They hold on every target, so
 * a descriptor or a value built to exhaust the checker is refused before the
 * work is done.
 */
export const valueLimits = {
  /**
   * How deep a descriptor nests, and so how deep a value is read: the same
   * depth the wire allows an untrusted connection.
   */
  depth: 32,
  /** Descriptors in one schema, counting each enum value as one. */
  descriptorNodes: 10_000,
  /** Members of one union. */
  unionMembers: 64,
  /**
   * Code units in a name a descriptor or a record states: a field, a table,
   * an enum value, a literal, a record key.
   */
  nameLength: 256,
  /** Issues one check reports. */
  issues: 50,
  /**
   * Values one check reads. A value within the largest JSON budget (1 MiB)
   * stays under it; a union that re-reads a large value per member doesn't.
   */
  steps: 1_000_000,
} as const;

/** Keys that reach an object's prototype: never a field or a record key. */
export const unsafeKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Why a value was refused. Stable: branch on the code, not the message. */
export const valueIssueMessages = {
  "value.required": "A value is required.",
  "value.invalid_type": "The value has the wrong type.",
  "value.not_finite": "The number must be finite.",
  "value.not_integer": "The number must be a whole number.",
  "value.too_small": "The number is too small.",
  "value.too_large": "The number is too large.",
  "value.too_short": "The value is too short.",
  "value.too_long": "The value is too long.",
  "value.invalid_email": "The value must be an email address.",
  "value.invalid_literal": "The value isn't the one allowed.",
  "value.invalid_enum": "The value isn't one of those allowed.",
  "value.invalid_id": "The value isn't a record ID.",
  "value.invalid_reference": "The value isn't a reference.",
  "value.invalid_timestamp": "The value isn't a time in whole milliseconds.",
  "value.invalid_duration":
    "The value isn't a duration in whole milliseconds above zero.",
  "value.invalid_currency": "The value isn't an ISO 4217 currency code.",
  "value.invalid_cron": "The value isn't five cron fields.",
  "value.invalid_time_zone": "The value isn't an IANA time zone.",
  "value.unknown_key": "The object has a key that isn't declared.",
  "value.unsafe_key": "The object has a key that isn't allowed.",
  "value.no_union_match": "The value matches none of the allowed forms.",
  "value.too_complex": "The value is too large to check.",
  "value.unreadable": "The value can't be read as JSON.",
} as const;

export type ValueIssueCode = keyof typeof valueIssueMessages;

/**
 * One thing wrong with a value. The message never repeats what was
 * submitted; the path leads to it, as Standard Schema paths do.
 */
export interface ValueIssue extends StandardSchemaV1.Issue {
  readonly code: ValueIssueCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/** What a check answers: the normalized value, or what is wrong with it. */
export type ValueResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly ValueIssue[] };

/**
 * A value schema: Standard Schema, backed by a descriptor. Checking is
 * `schema["~standard"].validate(value)` and nothing else: there is no
 * `parse`, `safeParse` or `validate` beside it.
 */
export interface ValueSchema<Input, Output> extends StandardSchemaV1<
  Input,
  Output
> {
  readonly "~standard": Omit<
    StandardSchemaV1.Props<Input, Output>,
    "validate"
  > & {
    /** Never asynchronous; callers may still await it. */
    readonly validate: (value: unknown) => ValueResult<Output>;
  };
  readonly descriptor: ValueDescriptor;
}

/** Why a schema's declaration was refused. */
export type ValueDefinitionCode =
  | "definition.invalid_bound"
  | "definition.contradictory_bounds"
  | "definition.invalid_default"
  | "definition.default_with_optional"
  | "definition.invalid_key"
  | "definition.invalid_name"
  | "definition.invalid_value"
  | "definition.invalid_schema"
  | "definition.invalid_descriptor"
  | "definition.too_large";

/**
 * A schema declared wrongly: thrown while it is built or read back from a
 * descriptor, never while a value is checked. `code` is an own property, so
 * it crosses an RPC boundary with the message.
 */
export class ValueDefinitionError extends Error {
  readonly code: ValueDefinitionCode;

  constructor(code: ValueDefinitionCode, message: string) {
    super(message);
    this.name = "ValueDefinitionError";
    this.code = code;
  }
}

/**
 * Whether a value is a JSON object: its prototype is `Object`'s or none, so
 * not an array, a class instance, a function or an RPC stub.
 */
export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
