import { messageOf } from "@grasp-os/shared/errors";
import type { Expression, Program } from "@oxc-project/types";
import { z } from "zod";

import oxcParse from "#oxc-parse";

/**
 * oxc's parser, as oxc-parse.wasm runs it: the parser build of
 * packages/compiler/oxc-wasm (src/lib.rs), threadless, importing nothing,
 * of at most 16 MiB of memory, committed beside this file and built again
 * by CI to the byte. It answers ESTree as oxc-parser does (TS-ESTree's
 * node types, every offset in UTF-16 code units), from core's Worker
 * where oxc-parser's own WebAssembly would declare 61 MiB up front.
 *
 * One instance, started on the first call. A call that traps (its memory
 * or the stack run out on input nested too deep) leaves the instance
 * unusable, so the next call starts a fresh one.
 */

/** The language a text is parsed as: JavaScript in a module, or TypeScript. */
export type Language = "js" | "ts";

const fileNames: Record<Language, string> = {
  js: "input.mjs",
  ts: "input.ts",
};

const call = z.custom<(...args: number[]) => number>(
  (value) => typeof value === "function"
);

const exportsSchema = z.object({
  memory: z.instanceof(WebAssembly.Memory),
  alloc: call,
  out_ptr: call,
  parse: call,
  parse_expression: call,
});

type OxcParse = z.infer<typeof exportsSchema>;

let started: OxcParse | undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A new instance, with all of its memory. */
const fresh = (): OxcParse =>
  exportsSchema.parse(new WebAssembly.Instance(oxcParse).exports);

/** `oxc`'s answer to `name` of `language` and `source`, as text. */
const answerOf = (
  oxc: OxcParse,
  name: "parse" | "parse_expression",
  language: Language,
  source: string
): string => {
  const put = (text: string): [number, number] => {
    const bytes = encoder.encode(text);
    const pointer = oxc.alloc(bytes.length);
    new Uint8Array(oxc.memory.buffer, pointer, bytes.length).set(bytes);
    return [pointer, bytes.length];
  };
  const length = oxc[name](...put(fileNames[language]), ...put(source));
  return decoder.decode(
    new Uint8Array(oxc.memory.buffer, oxc.out_ptr(), length)
  );
};

/**
 * Its answer to `name` of `language` and `source`, as text: the same for
 * the same text, whatever was parsed before. An instance that answered
 * before holds what it allocated then, so a large text it refuses, or
 * traps on, is tried again on a fresh one, whose answer stands.
 */
const answer = (
  name: "parse" | "parse_expression",
  language: Language,
  source: string
): string => {
  const reused = started !== undefined;
  started ??= fresh();
  try {
    const text = answerOf(started, name, language, source);
    if (!(reused && text.startsWith('{"error"'))) {
      return text;
    }
  } catch (error) {
    started = undefined;
    if (!reused) {
      throw error;
    }
  }
  started = fresh();
  try {
    return answerOf(started, name, language, source);
  } catch (error) {
    started = undefined;
    throw error;
  }
};

const errorSchema = z.object({
  error: z.object({ message: z.string(), start: z.number() }).nullable(),
});

/** Why a text doesn't parse, and where: 0-based, in UTF-16 code units. */
interface ParseError {
  message: string;
  offset: number;
}

const errorOf = (text: string): ParseError => {
  const { error } = errorSchema.parse(JSON.parse(text));
  return error === null
    ? { message: "It doesn't parse.", offset: 0 }
    : { message: error.message, offset: error.start };
};

/** A parsed expression: its tree, and which of its nodes stood in parentheses. */
interface ParsedExpression {
  ok: true;
  /**
   * The expression as oxc's ESTree has it, with no
   * `ParenthesizedExpression` and no `ChainExpression`: a node in
   * parentheses is in `parenthesized`, and an optional chain is its
   * links, each `optional` where it is written `?.`.
   */
  node: Expression;
  parenthesized: ReadonlySet<object>;
}

const loneSurrogate = /\p{Surrogate}/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * `source` as one expression (oxc's `parse_expression`: the whole text,
 * comments around it allowed, `{` an object), or why it doesn't parse:
 * one that runs the parser out of memory or stack doesn't parse either.
 */
export const parseExpression = (
  source: string,
  language: Language
): ParsedExpression | ({ ok: false } & ParseError) => {
  // Text oxc reads is UTF-8, which has no half of a UTF-16 surrogate pair.
  if (!source.isWellFormed()) {
    return {
      ok: false,
      message: "It holds half of a surrogate pair, which is no character.",
      offset: source.search(loneSurrogate),
    };
  }
  // The parse and the tree's decoding, which recurses as deep as the
  // expression nests: either running out of memory or stack is a text
  // that doesn't parse, as any parser's would be.
  try {
    const text = answer("parse_expression", language, source);
    if (text.startsWith('{"error"')) {
      return { ok: false, ...errorOf(text) };
    }
    const parenthesized = new Set<object>();
    // Bottom up: each node's children are already unwrapped. A chain ends
    // where its parentheses close, or where an operator takes it: in
    // either case what reads it sees where it ends without its node.
    const { node } = z.object({ node: z.custom<Expression>(isObject) }).parse(
      JSON.parse(text, (_key, value: unknown) => {
        if (!isObject(value)) {
          return value;
        }
        if (
          value.type === "ParenthesizedExpression" &&
          isObject(value.expression)
        ) {
          parenthesized.add(value.expression);
          return value.expression;
        }
        return value.type === "ChainExpression" ? value.expression : value;
      })
    );
    return { ok: true, node, parenthesized };
  } catch (error) {
    return { ok: false, message: messageOf(error), offset: 0 };
  }
};

/** A comment of a program: a line or a block, its text between its markers. */
const commentSchema = z.object({
  type: z.enum(["Line", "Block"]),
  value: z.string(),
  start: z.number(),
  end: z.number(),
});

export type Comment = z.infer<typeof commentSchema>;

const programSchema = z.object({
  node: z.custom<Program>(isObject),
  comments: z.array(commentSchema),
});

/**
 * `source` as a module of `language`: its program and comments as oxc's
 * ESTree has them (oxc's `parse`, parentheses dropped). Throws a
 * `SyntaxError` if it doesn't parse.
 */
export const parseProgram = (
  source: string,
  language: Language
): { program: Program; comments: Comment[] } => {
  const text = answer("parse", language, source);
  if (text.startsWith('{"error"')) {
    const { message, offset } = errorOf(text);
    throw new SyntaxError(`${message} (at ${offset})`);
  }
  const { node, comments } = programSchema.parse(JSON.parse(text));
  return { program: node, comments };
};
