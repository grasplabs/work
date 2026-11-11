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
 * Expressions share one instance, started on the first call; a call that
 * traps (its memory or the stack run out on input nested too deep) leaves
 * it unusable, so the next call starts a fresh one. A whole program gets
 * an instance of its own (`answer`).
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

/** A new instance, with none of its memory used. */
const instance = (): OxcParse =>
  exportsSchema.parse(new WebAssembly.Instance(oxcParse).exports);

/**
 * Its answer to `name` of `language` and `source`, as text. An expression
 * is parsed on the instance kept for them, which is started again after a
 * call that traps; a whole program on an instance of its own, so how much
 * of its memory a large one may use never depends on what was parsed
 * before, and the same text always gets the same answer.
 */
const answer = (
  name: "parse" | "parse_expression",
  language: Language,
  source: string
): string => {
  const kept = name === "parse_expression";
  const oxc = kept ? (started ??= instance()) : instance();
  const put = (text: string): [number, number] => {
    const bytes = encoder.encode(text);
    const pointer = oxc.alloc(bytes.length);
    new Uint8Array(oxc.memory.buffer, pointer, bytes.length).set(bytes);
    return [pointer, bytes.length];
  };
  try {
    const length = oxc[name](...put(fileNames[language]), ...put(source));
    return decoder.decode(
      new Uint8Array(oxc.memory.buffer, oxc.out_ptr(), length)
    );
  } catch (error) {
    if (kept) {
      started = undefined;
    }
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
 * The most syntax nodes an expression nests, one in another, as oxc's
 * tree has them: the root and every node on the way down to its deepest
 * leaf, parentheses and optional chains included (they are dropped from
 * the tree after).
 *
 * Everything that reads an expression after the parse walks its tree by
 * recursion (the check, the lowering and printing, a definition's
 * evaluation, the compiler's type check), so how deep a tree is decides
 * how much stack it takes, and the stack differs by where it runs:
 * workerd's, plain workerd's on-prem, Node's. Without a limit of its own,
 * an expression nested a few thousand deep was refused only by running
 * out of stack, at a depth that moved with the runtime, or not refused at
 * all (`1+1+…+1` parses without recursion, then overflowed the check).
 * This limit is checked by a loop before any of them runs, so the same
 * text gets the same answer everywhere.
 *
 * A value nested as deep as a value may be (`valueDepth`, 32) is at most
 * 64 nodes written as object literals, and 7 a level as a definition's
 * `v.object({ … }).optional().nullable()`: about 220 (each further
 * modifier at every level is 2 more a level, refused past this). Measured
 * with no limit, oxc's own parse runs out of stack past about 560 nodes
 * in a test on workerd 1.20261023 and 1.20261104 (a template in a
 * template, or parentheses), and past about 440 in Node; the check past
 * about 2,500.
 */
export const expressionMaxDepth = 256;

/** The type of an ESTree node, or undefined for what isn't one. */
const nodeType = (value: Record<string, unknown>): unknown => value.type;

/**
 * `value` itself, or, for a node in parentheses or an optional chain,
 * the expression inside, once every such wrapper is dropped: how many
 * were, and whether a parenthesis was among them.
 */
const unwrapped = (
  value: unknown
): { inner: unknown; wrappers: number; inParentheses: boolean } => {
  let inner = value;
  let wrappers = 0;
  let inParentheses = false;
  while (
    isObject(inner) &&
    (nodeType(inner) === "ParenthesizedExpression" ||
      nodeType(inner) === "ChainExpression") &&
    isObject(inner.expression)
  ) {
    inParentheses ||= nodeType(inner) === "ParenthesizedExpression";
    wrappers += 1;
    inner = inner.expression;
  }
  return { inner, wrappers, inParentheses };
};

/** A node, array or plain field still to walk, and how deep it is. */
interface Pending {
  readonly holder: Record<string, unknown>;
  readonly level: number;
  /** Where it starts, wrappers and all: where a refusal points. */
  readonly start: unknown;
}

/**
 * The tree of `root` without its wrappers (`unwrapped`), each node that
 * stood in parentheses added to `parenthesized`; or where the first node
 * nested deeper than `expressionMaxDepth` starts, in the order the source
 * reads. Walked by a loop, never by recursion, so a tree of any depth
 * costs no stack.
 */
const unwrappedTree = (
  root: unknown,
  parenthesized: Set<object>
): { node: unknown } | { tooDeep: number } => {
  const pending: Pending[] = [];
  /** `value` unwrapped, and queued to walk, under a holder `level` deep. */
  const enter = (value: unknown, level: number): unknown => {
    const { inner, wrappers, inParentheses } = unwrapped(value);
    if (!isObject(inner)) {
      return inner;
    }
    if (inParentheses) {
      parenthesized.add(inner);
    }
    // Arrays and plain fields (a regular expression's parts) hold nodes;
    // only a node is a level.
    const isNode = typeof nodeType(inner) === "string" && !Array.isArray(inner);
    pending.push({
      holder: inner,
      level: level + wrappers + (isNode ? 1 : 0),
      start: isObject(value) ? value.start : undefined,
    });
    return inner;
  };
  const node = enter(root, 0);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.level > expressionMaxDepth) {
      return { tooDeep: typeof next.start === "number" ? next.start : 0 };
    }
    // Queued last to first, so the first is walked first.
    for (const [key, value] of Object.entries(next.holder).toReversed()) {
      const inner = enter(value, next.level);
      if (inner !== value) {
        Reflect.set(next.holder, key, inner);
      }
    }
  }
  return { node };
};

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
  // oxc's parse recurses as deep as the expression nests: running it out
  // of memory or stack, far past `expressionMaxDepth`, is a text that
  // doesn't parse, as any parser's would be. Its answer is decoded with
  // no reviver, which doesn't recurse either way.
  let decoded: unknown;
  try {
    const text = answer("parse_expression", language, source);
    if (text.startsWith('{"error"')) {
      return { ok: false, ...errorOf(text) };
    }
    decoded = z
      .object({ node: z.custom<object>(isObject) })
      .parse(JSON.parse(text)).node;
  } catch (error) {
    return { ok: false, message: messageOf(error), offset: 0 };
  }
  const parenthesized = new Set<object>();
  // A chain ends where its parentheses close, or where an operator takes
  // it: in either case what reads it sees where it ends without its node.
  const tree = unwrappedTree(decoded, parenthesized);
  if ("tooDeep" in tree) {
    return {
      ok: false,
      message: `It nests more than ${expressionMaxDepth} levels deep.`,
      offset: tree.tooDeep,
    };
  }
  const node = z.custom<Expression>(isObject).parse(tree.node);
  return { ok: true, node, parenthesized };
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
