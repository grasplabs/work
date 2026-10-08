import { pointerJoin } from "./diagnostics.ts";
import type { DiagnosticCode } from "./diagnostics.ts";

/**
 * The definition's JSON text, parsed here rather than by JSON.parse, which
 * keeps the last of two equal keys without a word and builds whatever the
 * text nests before a check could run. This parser works on the text
 * itself, once, without recursion: it refuses text over `maxBytes` UTF-8
 * bytes before parsing, and stops the moment the text nests deeper than
 * `maxDepth`, holds more than `maxValues` values and keys, repeats a key in
 * one object, or uses a key that reaches the object prototype. What it
 * returns is fresh plain data, so nothing a caller wrote runs while the
 * definition is checked, and no value is shared by two places in it.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TextBounds {
  /** UTF-8 bytes of the text. */
  maxBytes: number;
  /** Arrays and objects inside one another. */
  maxDepth: number;
  /** Values and object keys. */
  maxValues: number;
}

export interface TextProblem {
  code: Extract<DiagnosticCode, `json.${string}`>;
  pointer: string;
  reason?: string;
}

export type ParsedText =
  | { ok: true; value: JsonValue }
  | { ok: false; problem: TextProblem };

/** Keys that reach an object's prototype, as the SDK's values refuse them. */
export const prototypeKeys: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

interface ArrayFrame {
  kind: "array";
  value: JsonValue[];
}
interface ObjectFrame {
  kind: "object";
  value: JsonObject;
  keys: Set<string>;
  /** The key whose value is being read. */
  key: string;
}
type Frame = ArrayFrame | ObjectFrame;

class TextError extends Error {
  readonly problem: TextProblem;

  constructor(problem: TextProblem) {
    super(problem.code);
    this.name = "TextError";
    this.problem = problem;
  }
}

const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const hexDigits = /^[0-9A-Fa-f]{4}$/u;
const simpleEscapes: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const parseText = (text: string, bounds: TextBounds): JsonValue => {
  let position = 0;
  let values = 0;
  const stack: Frame[] = [];

  /** Where the parser is, as a pointer: built only when something fails. */
  const pointer = (extra?: string | number): string => {
    let built = "";
    for (const frame of stack) {
      built = pointerJoin(
        built,
        frame.kind === "array" ? frame.value.length : frame.key
      );
    }
    return extra === undefined ? built : pointerJoin(built, extra);
  };
  const fail = (code: TextProblem["code"], reason?: string): never => {
    throw new TextError({
      code,
      pointer: pointer(),
      reason: reason ?? `at character ${position}`,
    });
  };
  const count = (): void => {
    values += 1;
    if (values > bounds.maxValues) {
      fail("json.too_many_values");
    }
  };
  const skipWhitespace = (): void => {
    for (;;) {
      const char = text[position];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
        return;
      }
      position += 1;
    }
  };

  const readString = (): string => {
    // At the opening quote.
    position += 1;
    const parts: string[] = [];
    let start = position;
    for (;;) {
      if (position >= text.length) {
        return fail("json.invalid", "an unterminated string");
      }
      const code = text.codePointAt(position) ?? 0;
      if (code === 0x22) {
        parts.push(text.slice(start, position));
        position += 1;
        break;
      }
      if (code < 0x20) {
        return fail("json.invalid", "a raw control character in a string");
      }
      if (code !== 0x5c) {
        position += 1;
        continue;
      }
      parts.push(text.slice(start, position));
      const escape = text[position + 1] ?? "";
      if (escape === "u") {
        const digits = text.slice(position + 2, position + 6);
        if (!hexDigits.test(digits)) {
          return fail("json.invalid", "a \\u escape without four hex digits");
        }
        parts.push(String.fromCodePoint(Number.parseInt(digits, 16)));
        position += 6;
      } else {
        const replacement = simpleEscapes[escape];
        if (replacement === undefined) {
          return fail("json.invalid", "an unknown escape");
        }
        parts.push(replacement);
        position += 2;
      }
      start = position;
    }
    const value = parts.join("");
    // An escape can spell half a surrogate pair: that isn't text.
    if (!value.isWellFormed()) {
      fail("json.invalid_text", "a string with an unpaired surrogate");
    }
    return value;
  };

  const readNumber = (): number => {
    numberToken.lastIndex = position;
    const token = numberToken.exec(text)?.[0];
    if (token === undefined) {
      return fail("json.invalid");
    }
    position += token.length;
    const value = Number(token);
    return Number.isFinite(value)
      ? value
      : fail("json.invalid_number", "a number beyond the range of a double");
  };

  const readLiteral = (): JsonValue => {
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, position)) {
        position += word.length;
        return value;
      }
    }
    return fail("json.invalid");
  };

  /** Reads `"key":` into the object frame, before its value. */
  const readKey = (frame: ObjectFrame): void => {
    if (text[position] !== '"') {
      fail("json.invalid", "an object key that isn't a string");
    }
    const key = readString();
    count();
    frame.key = key;
    if (prototypeKeys.has(key)) {
      throw new TextError({ code: "json.prototype_key", pointer: pointer() });
    }
    if (frame.keys.has(key)) {
      throw new TextError({ code: "json.duplicate_key", pointer: pointer() });
    }
    frame.keys.add(key);
    skipWhitespace();
    if (text[position] !== ":") {
      fail("json.invalid", "a key without a colon");
    }
    position += 1;
    skipWhitespace();
  };

  /** Opens an array or object; whether it still waits for members. */
  const open = (char: "[" | "{"): JsonValue | undefined => {
    if (stack.length >= bounds.maxDepth) {
      fail("json.too_deep");
    }
    position += 1;
    skipWhitespace();
    if (char === "[") {
      const value: JsonValue[] = [];
      if (text[position] === "]") {
        position += 1;
        return value;
      }
      stack.push({ kind: "array", value });
      return undefined;
    }
    const value: JsonObject = {};
    if (text[position] === "}") {
      position += 1;
      return value;
    }
    const frame: ObjectFrame = {
      kind: "object",
      value,
      keys: new Set(),
      key: "",
    };
    stack.push(frame);
    readKey(frame);
    return undefined;
  };

  skipWhitespace();
  for (;;) {
    // A value starts here.
    count();
    const char = text[position];
    let value: JsonValue | undefined;
    if (char === "[" || char === "{") {
      value = open(char);
      if (value === undefined) {
        continue;
      }
    } else if (char === '"') {
      value = readString();
    } else if (
      char === "-" ||
      (char !== undefined && char >= "0" && char <= "9")
    ) {
      value = readNumber();
    } else {
      value = readLiteral();
    }
    // Hand the value to its container, closing every container it ends.
    for (;;) {
      const frame = stack.at(-1);
      if (frame === undefined) {
        skipWhitespace();
        if (position !== text.length) {
          fail("json.invalid", "text after the value");
        }
        return value;
      }
      if (frame.kind === "array") {
        frame.value.push(value);
      } else {
        frame.value[frame.key] = value;
      }
      skipWhitespace();
      const next = text[position];
      if (next === ",") {
        position += 1;
        skipWhitespace();
        if (frame.kind === "object") {
          readKey(frame);
        }
        break;
      }
      if (next !== (frame.kind === "array" ? "]" : "}")) {
        return fail("json.invalid", "a missing comma or bracket");
      }
      position += 1;
      stack.pop();
      ({ value } = frame);
    }
  }
};

const utf8Length = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * Parses the definition from its JSON text or its UTF-8 bytes, within
 * `bounds`. Size is checked on the actual bytes, before any parsing.
 */
export const parseDefinitionText = (
  input: string | Uint8Array,
  bounds: TextBounds
): ParsedText => {
  try {
    let text: string;
    if (typeof input === "string") {
      // Every code unit is at least one byte: too long is too large before
      // the text is encoded to count them.
      if (input.length > bounds.maxBytes) {
        return { ok: false, problem: { code: "json.too_large", pointer: "" } };
      }
      if (!input.isWellFormed()) {
        return {
          ok: false,
          problem: { code: "json.invalid_text", pointer: "" },
        };
      }
      text = input;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength > bounds.maxBytes) {
        return { ok: false, problem: { code: "json.too_large", pointer: "" } };
      }
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(input);
      } catch {
        return {
          ok: false,
          problem: { code: "json.invalid_text", pointer: "" },
        };
      }
    } else {
      return {
        ok: false,
        problem: {
          code: "json.invalid",
          pointer: "",
          reason: "a definition is JSON text or its UTF-8 bytes",
        },
      };
    }
    if (utf8Length(text) > bounds.maxBytes) {
      return { ok: false, problem: { code: "json.too_large", pointer: "" } };
    }
    return { ok: true, value: parseText(text, bounds) };
  } catch (error) {
    if (error instanceof TextError) {
      return { ok: false, problem: error.problem };
    }
    throw error;
  }
};

/** Whether a parsed value is an object (not an array or null). */
export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
