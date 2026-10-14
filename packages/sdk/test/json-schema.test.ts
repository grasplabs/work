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

/** Whether `text` passes `schema`'s own check, the descriptor's. */
const passes = (schema: ReturnType<typeof v.string>, text: string): boolean => {
  const result = schema["~standard"].validate(text);
  return !("then" in result) && result.issues === undefined;
};

describe("a descriptor as JSON Schema", () => {
  it("describes string bounds never stricter than the descriptor", () => {
    // "😀" is one character but two UTF-16 units.
    const upTo2 = v.string().max(2);
    const atLeast2 = v.string().min(2);
    const both = (schema: ReturnType<typeof v.string>, text: string) => [
      fitsString(jsonSchemaOf(schema.descriptor), text),
      passes(schema, text),
    ];
    expect({
      maxEmoji: both(upTo2, "😀"),
      maxLetters: both(upTo2, "ab"),
      maxTooLong: both(upTo2, "abc"),
      minEmoji: both(atLeast2, "😀"),
      minLetter: both(atLeast2, "a"),
      minLetters: both(atLeast2, "ab"),
    }).toStrictEqual({
      maxEmoji: [true, true],
      maxLetters: [true, true],
      maxTooLong: [false, false],
      minEmoji: [true, true],
      minLetter: [true, false],
      minLetters: [true, true],
    });
  });

  it("leaves the final word to the descriptor where the schema is looser", () => {
    const upTo1 = v.string().max(1);
    // Fits the schema (one character) but not the descriptor (two units):
    // the answer is checked, and asked for again.
    expect([
      fitsString(jsonSchemaOf(upTo1.descriptor), "😀"),
      passes(upTo1, "😀"),
    ]).toStrictEqual([true, false]);
  });

  it("puts no pattern on a bounded string", () => {
    expect(jsonSchemaOf(v.string().min(3).max(10).descriptor)).toStrictEqual({
      type: "string",
      minLength: 2,
      maxLength: 10,
    });
  });
});
