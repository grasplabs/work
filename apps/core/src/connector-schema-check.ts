import type { Json } from "@grasp-os/shared/json";

// The constraints of a generated connector contract's JSON Schema that a
// value descriptor can't say (a `pattern`, a `format`), checked exactly,
// with an allow-list of what is checked at all (connector-contracts.ts).
//
// A schema is admitted only if every keyword in it, at every depth, is one
// this checks or a descriptor holds, or an annotation that constrains
// nothing. Anything else (`exclusiveMinimum`, `multipleOf`, `uniqueItems`,
// `contains`, a format not listed, a `required` name with no property)
// makes the schema unreadable, so no constraint is ever dropped in silence.
// Admitted schemas are then checked in full here, alongside the
// descriptor: types, constants, bounds, patterns, formats, properties,
// items and unions.

type Schema = Record<string, Json>;

/** The keywords a contract's schema may use: each enforced, or an annotation. */
const enforced = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "const",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "pattern",
  "format",
]);
const annotations = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$schema",
]);

/** The JSON types a schema may name. */
const types = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "array",
  "object",
]);

/**
 * An address, as `format: email` asks: zod's own rule, the one the native
 * connectors' schemas are made with, so `format` here is as exact as the
 * connectors' own check, not a looser one.
 */
const emailPattern =
  /^(?!\.)(?!.*\.\.)(?:[A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u;

/** A timestamp's form, as `format: date-time` asks (RFC 3339, with an offset). */
const dateTimePattern =
  /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/iu;

/** The days of `month` (1–12) in `year`, leap years counted. */
const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Whether `text` is an RFC 3339 timestamp of a day that exists. */
const isDateTime = (text: string): boolean => {
  const parts = dateTimePattern.exec(text)?.groups;
  if (parts === undefined) {
    return false;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  return Number(parts.day) <= daysIn(year, month);
};

/** Each format checked, and how. */
const formats: Readonly<Record<string, (text: string) => boolean>> = {
  email: (text) => emailPattern.test(text),
  "date-time": isDateTime,
};

/** The most a schema nests here, as the SDK's descriptors do. */
const maxDepth = 32;

const isRecord = (value: Json | undefined): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** Each admitted schema's pattern, compiled once. */
const patterns = new WeakMap<Schema, RegExp>();

/** Whether `schema`'s own keywords, and their values, are admissible. */
const ownAdmissible = (schema: Schema): boolean => {
  const { type, format, pattern, properties, required } = schema;
  const keysKnown = Object.keys(schema).every(
    (key) => enforced.has(key) || annotations.has(key)
  );
  const typesKnown =
    type === undefined ||
    (isList(type) ? type : [type]).every(
      (each) => typeof each === "string" && types.has(each)
    );
  const formatKnown =
    format === undefined ||
    (typeof format === "string" && Object.hasOwn(formats, format));
  const names = isRecord(properties) ? Object.keys(properties) : [];
  const requiredKnown =
    required === undefined ||
    (isList(required) &&
      required.every(
        (name) => typeof name === "string" && names.includes(name)
      ));
  return (
    keysKnown &&
    typesKnown &&
    formatKnown &&
    requiredKnown &&
    (pattern === undefined || typeof pattern === "string")
  );
};

/** Compiles `schema`'s pattern; false when it isn't a valid one. */
const compiled = (schema: Schema): boolean => {
  if (typeof schema.pattern !== "string") {
    return true;
  }
  try {
    patterns.set(schema, new RegExp(schema.pattern, "u"));
    return true;
  } catch {
    return false;
  }
};

/** The schemas nested in `schema`, each to be admitted too. */
const nested = (schema: Schema): (Json | undefined)[] => {
  const { properties, additionalProperties, items, anyOf } = schema;
  return [
    ...(isRecord(properties) ? Object.values(properties) : []),
    ...(isRecord(additionalProperties) ? [additionalProperties] : []),
    ...(items === undefined ? [] : [items]),
    ...(isList(anyOf) ? anyOf : []),
  ];
};

/**
 * Whether `schema` uses only what is enforced, at every depth (see the
 * header); its patterns are compiled as it is read.
 */
export const admissible = (schema: Json | undefined, depth = 1): boolean =>
  isRecord(schema) &&
  depth <= maxDepth &&
  ownAdmissible(schema) &&
  compiled(schema) &&
  nested(schema).every((inner) => admissible(inner, depth + 1));

/** Whether `value` is of JSON type `type`. */
const isOfType = (type: Json, value: Json): boolean => {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "array") {
    return isList(value);
  }
  if (type === "object") {
    return isRecord(value);
  }
  if (type === "null") {
    return value === null;
  }
  return typeof value === type;
};

/** How many code points `text` holds: each surrogate pair counts once. */
const codePoints = (text: string): number => {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const point = text.codePointAt(index) ?? 0;
    index += point > 0xff_ff ? 2 : 1;
    count += 1;
  }
  return count;
};

/** Whether a string fits `schema`'s length, pattern and format. */
const stringFits = (schema: Schema, text: string): boolean => {
  const { minLength, maxLength, format } = schema;
  const pattern = patterns.get(schema);
  // JSON Schema counts characters as code points, not UTF-16 units.
  const length = codePoints(text);
  return (
    (typeof minLength !== "number" || length >= minLength) &&
    (typeof maxLength !== "number" || length <= maxLength) &&
    (pattern === undefined || pattern.test(text)) &&
    (typeof format !== "string" || formats[format]?.(text) === true)
  );
};

/** Whether a number fits `schema`'s bounds. */
const numberFits = (schema: Schema, number: number): boolean =>
  (typeof schema.minimum !== "number" || number >= schema.minimum) &&
  (typeof schema.maximum !== "number" || number <= schema.maximum);

/**
 * Whether a value fits `schema`'s structure: an array's length and items,
 * an object's required, named and other properties.
 */
const structureFits = (schema: Schema, value: Json): boolean => {
  const {
    minItems,
    maxItems,
    items,
    properties,
    required,
    additionalProperties,
  } = schema;
  if (isList(value)) {
    return (
      (typeof minItems !== "number" || value.length >= minItems) &&
      (typeof maxItems !== "number" || value.length <= maxItems) &&
      // oxlint-disable-next-line no-use-before-define -- a schema nests in itself
      value.every((item) => items === undefined || accepts(items, item))
    );
  }
  if (!isRecord(value)) {
    return true;
  }
  const named = isRecord(properties) ? properties : {};
  const present = (isList(required) ? required : []).every(
    (name) => typeof name === "string" && Object.hasOwn(value, name)
  );
  return (
    present &&
    Object.entries(value).every(([key, field]) => {
      if (Object.hasOwn(named, key)) {
        // oxlint-disable-next-line no-use-before-define -- a schema nests in itself
        return accepts(named[key], field);
      }
      return (
        additionalProperties !== false &&
        (!isRecord(additionalProperties) ||
          // oxlint-disable-next-line no-use-before-define -- a schema nests in itself
          accepts(additionalProperties, field))
      );
    })
  );
};

/** Whether `value` fits an admitted `schema` in full. */
export const accepts = (schema: Json | undefined, value: Json): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const { type, anyOf } = schema;
  if (Object.hasOwn(schema, "const") && schema.const !== value) {
    return false;
  }
  if (isList(schema.enum) && !schema.enum.includes(value)) {
    return false;
  }
  if (isList(anyOf) && !anyOf.some((member) => accepts(member, value))) {
    return false;
  }
  if (
    type !== undefined &&
    !(isList(type) ? type : [type]).some((each) => isOfType(each, value))
  ) {
    return false;
  }
  if (typeof value === "string") {
    return stringFits(schema, value);
  }
  if (typeof value === "number") {
    return numberFits(schema, value);
  }
  return structureFits(schema, value);
};
