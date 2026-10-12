import type { ValueSchema } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf } from "@grasp-os/shared/operations";

import { accepts, admissible } from "./connector-schema-check.ts";

// A generated connector contract's JSON Schemas (connect's contracts.ts),
// read as the SDK's value descriptors, so core checks a connector call's
// arguments and its answer with the one validator every boundary uses
// (spec 32.1), never a second rulebook.
//
// What is read is decided by an allow-list (connector-schema-check.ts):
// every keyword is one a descriptor holds or the schema check enforces, or
// an annotation; anything else leaves the action out of the binding, so no
// constraint is ever dropped. The descriptor checks shape and normal form;
// the schema check enforces the rest exactly (patterns, formats), and both
// must pass.

/** A descriptor as plain JSON, before the SDK reads and seals it. */
type Draft = Record<string, Json>;

/** The most a schema nests here, as the SDK's descriptors do. */
const maxDepth = 32;

const isRecord = (value: Json | undefined): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` is a JSON array: `Array.isArray` doesn't narrow a readonly one. */
const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** Reads a nested schema, one level deeper. */
type Read = (schema: Json | undefined, depth: number) => Draft | undefined;

const base = (kind: string, extra: Draft = {}): Draft => ({
  descriptorVersion: 1,
  kind,
  presence: "required",
  nullable: false,
  ...extra,
});

/** A count bound of `schema` as `as`, if it is a nonnegative safe integer. */
const countOf = (schema: Draft, key: string, as: string): Draft => {
  const value = schema[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { [as]: value }
    : {};
};

/** A numeric bound of `schema` as `as`, if it is a finite number. */
const boundOf = (schema: Draft, key: string, as: string): Draft => {
  const value = schema[key];
  return typeof value === "number" && Number.isFinite(value)
    ? { [as]: value }
    : {};
};

/** `draft`, nullable too. */
const nullable = (draft: Draft): Draft => ({ ...draft, nullable: true });

/** A union of `members`, nullable when one of them is `null` alone. */
const unionOf = (members: readonly Draft[]): Draft | undefined => {
  const values = members.filter((member) => member.kind !== "null");
  const hasNull = values.length < members.length;
  if (values.length === 0) {
    return hasNull ? base("null") : undefined;
  }
  const [only] = values;
  const draft =
    values.length === 1 && only !== undefined
      ? only
      : base("union", { members: values });
  return hasNull ? nullable(draft) : draft;
};

/** An object schema's fields, or a map's value, read. */
const objectOf = (
  schema: Draft,
  depth: number,
  read: Read
): Draft | undefined => {
  const { properties = {}, required = [], additionalProperties } = schema;
  if (!isRecord(properties) || !isList(required)) {
    return undefined;
  }
  const names = Object.keys(properties);
  if (additionalProperties !== false) {
    // A map: no named properties, and every value of one schema.
    if (names.length > 0 || !isRecord(additionalProperties)) {
      return undefined;
    }
    const value = read(additionalProperties, depth + 1);
    return value === undefined ? undefined : base("record", { value });
  }
  const fields: Draft = {};
  for (const name of names) {
    const field = read(properties[name], depth + 1);
    if (field === undefined) {
      return undefined;
    }
    fields[name] = required.includes(name)
      ? field
      : { ...field, presence: "optional" };
  }
  return base("object", { fields });
};

/** One `type` of `schema`, read; undefined for one that can't be. */
const typedOf = (
  schema: Draft,
  type: Json,
  depth: number,
  read: Read
): Draft | undefined => {
  if (type === "string") {
    return base("string", {
      trim: false,
      email: schema.format === "email",
      ...countOf(schema, "minLength", "min"),
      ...countOf(schema, "maxLength", "max"),
    });
  }
  if (type === "integer" || type === "number") {
    return base("number", {
      integer: type === "integer",
      ...boundOf(schema, "minimum", "min"),
      ...boundOf(schema, "maximum", "max"),
    });
  }
  if (type === "boolean" || type === "null") {
    return base(type);
  }
  if (type === "array") {
    const item = read(schema.items, depth + 1);
    return item === undefined
      ? undefined
      : base("array", {
          item,
          ...countOf(schema, "minItems", "min"),
          ...countOf(schema, "maxItems", "max"),
        });
  }
  return type === "object" ? objectOf(schema, depth, read) : undefined;
};

/** Reads `schema` as a descriptor draft; undefined if it can't be. */
const draftOf = (
  schema: Json | undefined,
  depth: number
): Draft | undefined => {
  if (!isRecord(schema) || depth > maxDepth) {
    return undefined;
  }
  const { anyOf, type } = schema;
  if (Object.hasOwn(schema, "const")) {
    const value = schema.const;
    return isList(value) || isRecord(value)
      ? undefined
      : base("literal", { value: value ?? null });
  }
  if (isList(schema.enum)) {
    const values = schema.enum;
    return values.length > 0 &&
      values.every((value) => typeof value === "string")
      ? base("enum", { values })
      : undefined;
  }
  if (isList(anyOf)) {
    const members = anyOf.map((member) => draftOf(member, depth + 1));
    return members.every((member) => member !== undefined)
      ? unionOf(members)
      : undefined;
  }
  const types: readonly Json[] = isList(type) ? type : [type ?? null];
  const typed = types.map((each) => typedOf(schema, each, depth, draftOf));
  return typed.every((each) => each !== undefined) ? unionOf(typed) : undefined;
};

/** A contract's schema, read: its descriptor, its schema and its full check. */
export interface ReadSchema {
  readonly descriptor: Draft;
  readonly schema: ValueSchema<unknown, unknown>;
  /** Whether a value fits every constraint of the JSON Schema itself. */
  readonly accepts: (value: Json) => boolean;
}

/**
 * `text` (a JSON Schema of a generated contract, as JSON text) as a sealed
 * value schema and its full check, or undefined when it uses anything not
 * enforced, or holds what a descriptor can't say.
 */
export const readContractSchema = (text: string): ReadSchema | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const json = jsonOf(parsed);
  if (json === undefined || !admissible(json)) {
    return undefined;
  }
  const draft = draftOf(json, 1);
  if (draft === undefined) {
    return undefined;
  }
  try {
    return {
      descriptor: draft,
      schema: schemaFromDescriptor(JSON.stringify(draft)),
      accepts: (value) => accepts(json, value),
    };
  } catch {
    return undefined;
  }
};
