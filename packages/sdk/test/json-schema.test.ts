import { describe, expect, it } from "vite-plus/test";

import { v } from "../src/index.ts";
import { jsonSchemaOf } from "../src/json-schema.ts";

// A descriptor as JSON Schema, for a model told its answer's shape (pure
// logic): what fits the schema must fit the descriptor's own check.

/** How many characters (code points) `text` holds, as JSON Schema counts. */
const codePoints = (text: string): number => {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    index += (text.codePointAt(index) ?? 0) > 0xff_ff ? 2 : 1;
    count += 1;
  }
  return count;
};

/** Whether `text` fits `schema`'s string length and pattern, as JSON Schema reads them. */
const fitsString = (schema: Record<string, unknown>, text: string): boolean => {
  const { maxLength, minLength, pattern } = schema;
  const characters = codePoints(text);
  return (
    (typeof maxLength !== "number" || characters <= maxLength) &&
    (typeof minLength !== "number" || characters >= minLength) &&
    (typeof pattern !== "string" || new RegExp(pattern, "u").test(text))
  );
};

describe("a descriptor as JSON Schema", () => {
  it("bounds strings so what fits the schema fits the descriptor", () => {
    const short = v.string().max(1);
    const schema = jsonSchemaOf(short.descriptor);
    const passes = (text: string): boolean => {
      const result = short["~standard"].validate(text);
      return !("then" in result) && result.issues === undefined;
    };
    expect({
      // "😀" is one character but two UTF-16 units.
      emoji: [fitsString(schema, "😀"), passes("😀")],
      letter: [fitsString(schema, "a"), passes("a")],
      accented: [fitsString(schema, "é"), passes("é")],
    }).toStrictEqual({
      emoji: [false, false],
      letter: [true, true],
      accented: [true, true],
    });
  });

  it("leaves strings without an upper bound unconstrained", () => {
    expect(jsonSchemaOf(v.string().min(1).descriptor)).toStrictEqual({
      type: "string",
      minLength: 1,
    });
  });
});
