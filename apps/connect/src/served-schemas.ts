import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

// A schema an outside MCP server lists for a tool, as an App's contract
// serves it (composio-contracts.ts, mcp-connectors.ts): untrusted, so its
// depth is checked without recursion before anything reads it; it is
// served only up to `maxSchemaDepth` and `maxSchemaBytes`; a `pattern`
// anywhere leaves it out, as core would run the server's regular
// expression on App arguments and answers, and one that backtracks
// (`^(a+)+$`) would burn core's CPU; and an object that names its
// properties and says nothing of others is served closed.

/** Largest schema served for one side of one action, in bytes of JSON. */
export const maxSchemaBytes = 64 * 1024;

/** Deepest a served schema nests, in schemas, as core reads them. */
const maxSchemaDepth = 32;

/**
 * Deepest a listed schema's JSON may nest before it is read at all: a
 * schema level is at most two levels of JSON (a `properties` map, or an
 * `anyOf` list, then the schema).
 */
const maxJsonDepth = 2 * maxSchemaDepth;

/** What a tool without an output schema answers: its text. */
/** A name an App can declare as an action (the SDK's own rule). */
export const actionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export const textAnswer = JSON.stringify({ type: "string" });

/**
 * Whether `value` is JSON nesting at most `maxJsonDepth` deep: walked
 * with a stack of its own, never by recursion, however deep it goes.
 */
export const isShallowJson = (value: unknown): value is Json => {
  const pending: [unknown, number][] = [[value, 1]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [each, depth] = next;
    if (typeof each === "object" && each !== null) {
      if (depth > maxJsonDepth) {
        return false;
      }
      const children: unknown[] = Array.isArray(each)
        ? each
        : Object.values(each);
      for (const child of children) {
        pending.push([child, depth + 1]);
      }
    } else if (
      !(
        each === null ||
        typeof each === "string" ||
        typeof each === "boolean" ||
        (typeof each === "number" && Number.isFinite(each))
      )
    ) {
      return false;
    }
  }
  return true;
};

/** Sets `key` on `target` as its own property, `__proto__` included. */
const setOwn = (
  target: Record<string, Json>,
  key: string,
  value: Json
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/**
 * `schema` with each object that names its properties, and says nothing
 * of others, closed; at its subschemas only (`properties`, `items`,
 * `anyOf`, `additionalProperties`), the places core reads, never inside a
 * value such as a `const`. Undefined when it nests deeper than
 * `maxSchemaDepth`, or uses `pattern` at any of them.
 */
const closedSchema = (schema: Json, depth: number): Json | undefined => {
  if (depth > maxSchemaDepth) {
    return undefined;
  }
  if (!isRecord(schema)) {
    return schema;
  }
  if (Object.hasOwn(schema, "pattern")) {
    return undefined;
  }
  const deeper = (each: Json): Json | undefined =>
    closedSchema(each, depth + 1);
  const closed: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Left out, as JSON leaves a key whose value is undefined.
    if (value === undefined) {
      continue;
    }
    let served: Json | undefined = value;
    if (key === "properties" && isRecord(value)) {
      const properties: Record<string, Json> = {};
      for (const [name, property] of Object.entries(value)) {
        if (property === undefined) {
          continue;
        }
        const read = deeper(property);
        if (read === undefined) {
          return undefined;
        }
        setOwn(properties, name, read);
      }
      served = properties;
    } else if (key === "anyOf" && Array.isArray(value)) {
      const members = value.map(deeper);
      served = members.every((member) => member !== undefined)
        ? members
        : undefined;
    } else if (key === "items" || key === "additionalProperties") {
      served = deeper(value);
    }
    if (served === undefined) {
      return undefined;
    }
    setOwn(closed, key, served);
  }
  if (
    isRecord(closed.properties) &&
    !Object.hasOwn(closed, "additionalProperties")
  ) {
    closed.additionalProperties = false;
  }
  return closed;
};

/**
 * `schema` as served, as JSON text; undefined if it is too deep or too
 * large, or holds a `pattern`.
 */
export const servedSchema = (schema: unknown): string | undefined => {
  if (!isShallowJson(schema)) {
    return undefined;
  }
  const closed = closedSchema(schema, 1);
  if (closed === undefined) {
    return undefined;
  }
  const text = JSON.stringify(closed);
  return new TextEncoder().encode(text).byteLength > maxSchemaBytes
    ? undefined
    : text;
};
