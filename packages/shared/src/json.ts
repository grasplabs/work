/** A JSON value. Keys whose value is `undefined` are left out, as in JSON. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json): value is readonly Json[] =>
  Array.isArray(value);

/**
 * JSON with object keys sorted by UTF-16 code unit and no whitespace, so equal
 * values always give the same text, whatever the locale. For values without
 * special number forms this matches RFC 8785 (JCS), so anyone can recompute
 * it. Keys whose value is `undefined` are left out, as `JSON.stringify` does.
 */
export const canonicalJson = (value: Json): string => {
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const members: string[] = [];
    // Keys are unique, so no two compare equal.
    for (const [key, member] of Object.entries(value).toSorted(([a], [b]) =>
      a < b ? -1 : 1
    )) {
      if (member !== undefined) {
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
      }
    }
    return `{${members.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("JSON has no representation for this number");
  }
  return JSON.stringify(value);
};

/**
 * The canonical text of `value`, which is JSON data (a manifest, a
 * report, a verb map): its JSON form with every object's keys in order,
 * so equal data has equal text.
 */
export const canonicalText = (value: unknown): string => {
  // SAFETY: what JSON.parse answers is JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = JSON.parse(JSON.stringify(value) ?? "null") as Json;
  return canonicalJson(json);
};

/**
 * A JSON Pointer (RFC 6901): `""` for the whole document, or `/` before
 * each reference token, `~0` and `~1` the only escapes (for `~` and `/`).
 * The grammar of section 3, nothing else: never an expression.
 */
export const jsonPointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/u;

/**
 * The value at JSON Pointer `pointer` in `document` (RFC 6901, section 4),
 * or undefined where there is none: an object's own member by name, an
 * array's element by its index in decimal without leading zeros.
 */
export const valueAtPointer = (
  document: Json,
  pointer: string
): Json | undefined => {
  if (!jsonPointerPattern.test(pointer)) {
    return undefined;
  }
  let value: Json | undefined = document;
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === undefined || value === null || typeof value !== "object") {
      return undefined;
    }
    if (isJsonArray(value)) {
      value = /^(?:0|[1-9]\d*)$/u.test(token)
        ? value[Number(token)]
        : undefined;
    } else {
      value = Object.hasOwn(value, token) ? value[token] : undefined;
    }
  }
  return value;
};
