import { v, ValueDefinitionError } from "@grasp-os/runtime/app";
import type { StringSchema, ValueSchema } from "@grasp-os/runtime/app";
import { isRecord } from "@grasp-os/shared/json";
import { valueDepth } from "@grasp-os/shared/value-depth";

// A spec's JSON Schema (OpenAPI 3.1, dereferenced) as `v`: the types the
// generator writes and the mirror check compares. In an answer, what has
// no fixed shape is `v.json()`: a free-form value or object, a tuple, and
// a schema cut off where it refers to itself or nests past what a value
// may be. Arguments are never open, so in a request the same is left out,
// and so is a name `v` refuses (too long, a prototype key) anywhere. The
// caller decides what leaving it out means: a dropped field or parameter,
// or an operation skipped.

/** A schema `v` built. */
export type Schema = ValueSchema<unknown, unknown>;

/** A schema that can still be made nullable or optional. */
export interface Modifiable extends Schema {
  readonly nullable: () => Modifiable;
  readonly optional: () => Schema;
}

/** Why an operation can't become a tool: caught per operation. */
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

/** Schemas one operation may read, its request and answer together. */
const operationMaxNodes = 10_000;

/** Levels left under a field for what wraps it: a page and its items. */
const depthBudget = valueDepth - 3;

export interface Reading {
  /** A request's fields leave out what is read-only; an answer's, write-only. */
  readonly mode: "request" | "response";
  /** The schemas being read, so a recursive one stops instead of looping. */
  readonly open: Set<object>;
  /** Schemas read for the operation so far. */
  readonly read: { nodes: number };
}

type Node = Readonly<Record<string, unknown>>;

export const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export const record = (value: unknown): Node => (isRecord(value) ? value : {});

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** What `make` builds, or undefined where `v` refuses it. */
export const built = <Built>(make: () => Built): Built | undefined => {
  try {
    return make();
  } catch (error) {
    if (error instanceof ValueDefinitionError) {
      return undefined;
    }
    throw error;
  }
};

/** What has no fixed shape: any JSON in an answer, nothing in a request. */
const free = (reading: Reading): Modifiable | undefined =>
  reading.mode === "response" ? v.json() : undefined;

/** The `format`s a string keeps, as `v` checks them. */
const formats: Readonly<
  Record<string, (schema: StringSchema) => StringSchema>
> = {
  "date-time": (schema) => schema.datetime(),
  date: (schema) => schema.date(),
  email: (schema) => schema.email(),
};

/** The JSON types a schema allows, null included. */
const typesOf = (node: Node): string[] => {
  if (typeof node.type === "string") {
    return [node.type];
  }
  if (Array.isArray(node.type)) {
    return node.type.filter((type): type is string => typeof type === "string");
  }
  if (isRecord(node.properties) || node.additionalProperties !== undefined) {
    return ["object"];
  }
  return node.items === undefined ? [] : ["array"];
};

const literalOf = (value: unknown): Modifiable | undefined =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string"
    ? built(() => v.literal(value))
    : undefined;

/** One of the members, or undefined if any can't be typed. */
const unionOf = (
  members: readonly (Modifiable | undefined)[]
): Modifiable | undefined => {
  const typed = members.filter(
    (member): member is Modifiable => member !== undefined
  );
  const [first, ...rest] = typed;
  if (first === undefined || typed.length < members.length) {
    return undefined;
  }
  return rest.length === 0 ? first : built(() => v.union(first, ...rest));
};

const enumOf = (values: readonly unknown[]): Modifiable | undefined => {
  const distinct = [...new Set(values)];
  const nullable = distinct.includes(null);
  const others = distinct.filter((value) => value !== null);
  const strings = others.filter(
    (value): value is string => typeof value === "string"
  );
  const [first, ...rest] = strings;
  if (others.length === 0) {
    return nullable ? v.null() : undefined;
  }
  const schema =
    first !== undefined && strings.length === others.length
      ? built(() => v.enum([first, ...rest]))
      : unionOf(others.map(literalOf));
  return nullable ? schema?.nullable() : schema;
};

/**
 * An enum in an answer: any value of its type, since a vendor adds values
 * without a new spec, and an answer refused for one would fail every call.
 * Arguments keep the enum.
 */
const answerEnumOf = (
  values: readonly unknown[],
  reading: Reading
): Modifiable | undefined => {
  const nullable = values.includes(null);
  const kinds = new Set(
    values.filter((value) => value !== null).map((value) => typeof value)
  );
  const [kind] = kinds;
  let schema: Modifiable | undefined = free(reading);
  if (kinds.size === 0) {
    schema = v.null();
  } else if (kinds.size === 1 && kind === "string") {
    schema = v.string();
  } else if (kinds.size === 1 && kind === "number") {
    schema = v.number();
  } else if (kinds.size === 1 && kind === "boolean") {
    schema = v.boolean();
  }
  return nullable && kinds.size > 0 ? schema?.nullable() : schema;
};

/** A schema's own properties and those of every `allOf` member. */
const membersOf = (node: Node, seen: Set<object>): Node[] | undefined => {
  if (seen.has(node)) {
    return undefined;
  }
  seen.add(node);
  const members = [node];
  for (const member of list(node.allOf)) {
    if (
      !isRecord(member) ||
      member.oneOf !== undefined ||
      member.anyOf !== undefined
    ) {
      return undefined;
    }
    const nested = membersOf(member, seen);
    if (nested === undefined) {
      return undefined;
    }
    members.push(...nested);
  }
  return members;
};

/**
 * One schema as `v`, or undefined where it can't be typed. Throws
 * `OperationError` once the operation has read more schemas than one may.
 */
export const schemaOf = (
  node: unknown,
  reading: Reading,
  depth: number
): Modifiable | undefined => {
  if (node === undefined || node === true) {
    return free(reading);
  }
  if (!isRecord(node)) {
    return undefined;
  }
  if (reading.open.has(node) || depth > depthBudget) {
    return free(reading);
  }
  reading.read.nodes += 1;
  if (reading.read.nodes > operationMaxNodes) {
    throw new OperationError("Its schemas are too large.");
  }
  reading.open.add(node);
  try {
    // oxlint-disable-next-line no-use-before-define -- a schema's parts are schemas
    return schemaBody(node, reading, depth);
  } finally {
    reading.open.delete(node);
  }
};

/**
 * An object's fields, each required as the schema says, or every one
 * optional. Undefined if a request's required field can't be typed.
 */
export const fieldsOf = (
  node: Node,
  reading: Reading,
  depth: number
): Record<string, Schema> | undefined => {
  const members = membersOf(node, new Set());
  if (members === undefined) {
    return undefined;
  }
  const properties = new Map<string, unknown>();
  const required = new Set<string>();
  for (const member of members) {
    for (const name of list(member.required)) {
      if (typeof name === "string") {
        required.add(name);
      }
    }
    for (const [name, property] of Object.entries(record(member.properties))) {
      const earlier = properties.get(name);
      // Two members that state one property differently: allOf asks for
      // both, which no one schema here says, so it is left out.
      const same = earlier === undefined || earlier === property;
      properties.set(name, same ? property : null);
    }
  }
  const fields: Record<string, Schema> = {};
  for (const [name, property] of properties) {
    const hidden =
      reading.mode === "request"
        ? record(property).readOnly === true
        : record(property).writeOnly === true;
    const schema = hidden ? undefined : schemaOf(property, reading, depth + 1);
    const field = required.has(name) ? schema : schema?.optional();
    const named =
      field === undefined
        ? undefined
        : built(() => v.object({ [name]: field }));
    if (named === undefined || field === undefined) {
      if (reading.mode === "request" && required.has(name) && !hidden) {
        return undefined;
      }
      continue;
    }
    Object.defineProperty(fields, name, { enumerable: true, value: field });
  }
  return fields;
};

const objectOf = (
  node: Node,
  reading: Reading,
  depth: number
): Modifiable | undefined => {
  const members = membersOf(node, new Set()) ?? [];
  if (members.some((member) => isRecord(member.properties))) {
    const fields = fieldsOf(node, reading, depth);
    return fields === undefined ? undefined : built(() => v.object(fields));
  }
  const values = node.additionalProperties;
  const value =
    values === false ? undefined : schemaOf(values, reading, depth + 1);
  return value === undefined ? undefined : built(() => v.record(value));
};

const typedAs = (
  type: string,
  node: Node,
  reading: Reading,
  depth: number
): Modifiable | undefined => {
  switch (type) {
    case "string": {
      const format = text(node.format);
      const formatted =
        format !== undefined && Object.hasOwn(formats, format)
          ? formats[format]
          : undefined;
      return formatted === undefined ? v.string() : formatted(v.string());
    }
    case "integer": {
      return v.number().integer();
    }
    case "number": {
      return v.number();
    }
    case "boolean": {
      return v.boolean();
    }
    case "array": {
      const item = schemaOf(node.items, reading, depth + 1);
      return item === undefined ? undefined : built(() => v.array(item));
    }
    case "object": {
      return objectOf(node, reading, depth);
    }
    default: {
      return undefined;
    }
  }
};

/** Whether a schema says it is an object. */
const isObjectSchema = (node: Node): boolean =>
  "properties" in node || typesOf(node).includes("object");

/**
 * `allOf`: an object of every member's properties, or, where no member is
 * an object, one schema of all their keywords (`allOf: [{ $ref: Status }]`
 * is a Status). Members that state one keyword differently ask for no
 * value: it is free.
 */
const allOf = (
  node: Node,
  reading: Reading,
  depth: number
): Modifiable | undefined => {
  const { allOf: members, ...own } = node;
  const nodes = [own, ...list(members).map(record)];
  if (nodes.some((each) => isObjectSchema(each) || "allOf" in each)) {
    return objectOf(node, reading, depth);
  }
  const merged: Record<string, unknown> = {};
  for (const each of nodes) {
    for (const [key, value] of Object.entries(each)) {
      if (
        Object.hasOwn(merged, key) &&
        JSON.stringify(merged[key]) !== JSON.stringify(value)
      ) {
        return free(reading);
      }
      merged[key] = value;
    }
  }
  // oxlint-disable-next-line no-use-before-define -- a member is a schema
  return schemaBody(merged, reading, depth);
};

const schemaBody = (
  node: Node,
  reading: Reading,
  depth: number
): Modifiable | undefined => {
  if ("const" in node) {
    return literalOf(node.const);
  }
  if (Array.isArray(node.enum)) {
    return reading.mode === "response"
      ? answerEnumOf(node.enum, reading)
      : enumOf(node.enum);
  }
  if (Array.isArray(node.allOf)) {
    return allOf(node, reading, depth);
  }
  const alternatives = Array.isArray(node.oneOf) ? node.oneOf : node.anyOf;
  if (Array.isArray(alternatives)) {
    return (
      unionOf(
        alternatives.map((member) => schemaOf(member, reading, depth + 1))
      ) ?? free(reading)
    );
  }
  const types = typesOf(node);
  const nullable = types.includes("null");
  const others = types.filter((type) => type !== "null");
  if (others.length === 0) {
    return nullable ? v.null() : free(reading);
  }
  const schema = unionOf(
    others.map((type) => typedAs(type, node, reading, depth))
  );
  return nullable ? schema?.nullable() : schema;
};
