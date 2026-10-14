import type { JsonValue, ValueDescriptor } from "./value-descriptor.ts";

// A descriptor as JSON Schema (draft 2020-12), for what only reads JSON
// Schema: a model told the shape its answer must take, say. It describes;
// it never decides. Every value is still checked by the descriptor itself
// (`schemaFromDescriptor`), which holds rules JSON Schema can't say here
// (trimming, canonical form), so this may be looser, never stricter.

/** A JSON Schema, as plain data. */
export type JsonSchema = Record<string, JsonValue>;

/** One semantic kind's single wire form (spec 32.1). */
const semanticSchema = (kind: string): JsonSchema => {
  if (kind === "timestamp") {
    return { type: "integer" };
  }
  if (kind === "duration") {
    return { type: "integer", minimum: 1 };
  }
  if (kind === "file") {
    return {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
  }
  if (kind === "money") {
    return {
      type: "object",
      properties: {
        minorUnits: { type: "integer" },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
      },
      required: ["minorUnits", "currency"],
      additionalProperties: false,
    };
  }
  if (kind === "schedule") {
    return {
      type: "object",
      properties: { cron: { type: "string" }, timeZone: { type: "string" } },
      required: ["cron", "timeZone"],
      additionalProperties: false,
    };
  }
  // A person, a model or a template: an opaque ID.
  return { type: "string" };
};

/** A scalar descriptor's value, as JSON Schema; undefined for any other. */
const scalarSchema = (descriptor: ValueDescriptor): JsonSchema | undefined => {
  if (descriptor.kind === "string") {
    return {
      type: "string",
      // A descriptor counts UTF-16 code units, JSON Schema characters (code
      // points), and a character is one or two units. The schema describes
      // the bounds loosely, never stricter than the descriptor, which stays
      // the final check: at most `max` units is at most `max` characters,
      // and at least `min` units is at least half as many characters.
      ...(descriptor.min === undefined
        ? {}
        : { minLength: Math.ceil(descriptor.min / 2) }),
      ...(descriptor.max === undefined ? {} : { maxLength: descriptor.max }),
      ...(descriptor.email ? { format: "email" } : {}),
    };
  }
  if (descriptor.kind === "number") {
    return {
      type: descriptor.integer ? "integer" : "number",
      ...(descriptor.min === undefined ? {} : { minimum: descriptor.min }),
      ...(descriptor.max === undefined ? {} : { maximum: descriptor.max }),
    };
  }
  if (descriptor.kind === "boolean" || descriptor.kind === "null") {
    return { type: descriptor.kind };
  }
  if (descriptor.kind === "literal") {
    return { const: descriptor.value };
  }
  if (descriptor.kind === "enum") {
    return { type: "string", enum: [...descriptor.values] };
  }
  return descriptor.kind === "id" ? { type: "string" } : undefined;
};

/**
 * A composite descriptor's value, as JSON Schema, its parts by `of`;
 * undefined for any other.
 */
const compositeSchema = (
  descriptor: ValueDescriptor,
  of: (inner: ValueDescriptor) => JsonSchema,
  exact: boolean
): JsonSchema | undefined => {
  if (descriptor.kind === "object") {
    const properties: JsonSchema = {};
    const required: string[] = [];
    for (const [name, field] of Object.entries(descriptor.fields)) {
      properties[name] = of(field);
      if (
        field.presence === "required" ||
        (exact && field.presence === "default")
      ) {
        required.push(name);
      }
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  if (descriptor.kind === "array") {
    return {
      type: "array",
      items: of(descriptor.item),
      ...(descriptor.min === undefined ? {} : { minItems: descriptor.min }),
      ...(descriptor.max === undefined ? {} : { maxItems: descriptor.max }),
    };
  }
  if (descriptor.kind === "union") {
    return { anyOf: descriptor.members.map(of) };
  }
  return descriptor.kind === "record"
    ? { type: "object", additionalProperties: of(descriptor.value) }
    : undefined;
};

/** How a descriptor is told as JSON Schema. */
export interface JsonSchemaOptions {
  /**
   * The exact form, as every return is checked: a field with a default
   * must be given, filled in, so a value the descriptor would complete is
   * never offered as one that fits.
   */
  readonly exact?: boolean;
}

/**
 * `descriptor` as JSON Schema: its kind and bounds, and `null` too when it
 * is nullable. Whether a field may be left out is its object's `required`,
 * where a field with a default counts as required in the exact form; a
 * default is the descriptor's to fill in, so the schema doesn't say it.
 */
export const jsonSchemaOf = (
  descriptor: ValueDescriptor,
  { exact = false }: JsonSchemaOptions = {}
): JsonSchema => {
  const of = (inner: ValueDescriptor): JsonSchema =>
    jsonSchemaOf(inner, { exact });
  const value =
    scalarSchema(descriptor) ??
    compositeSchema(descriptor, of, exact) ??
    semanticSchema(descriptor.kind);
  return descriptor.nullable ? { anyOf: [value, { type: "null" }] } : value;
};
