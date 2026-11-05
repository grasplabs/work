/**
 * The parser of the compiler's ESLint lints (lint.ts, server-lint.ts), and
 * the one @shadcn/lint reads the kit's components with: oxc's, on oxc.wasm
 * (oxc-wasm/src/lib.rs `parse`, the WebAssembly Ultracite's lint runs on),
 * with typescript-eslint's own scope analysis and visitor keys. That is
 * typescript-eslint's parser less TypeScript: oxc answers TS-ESTree, the
 * tree typescript-eslint converts TypeScript's to, and ESLint's tokens
 * (oxc_estree_tokens, which oxc checks against typescript-eslint's), and
 * TypeScript 7 has no JavaScript API to run typescript-eslint's on.
 *
 * What it adds is what ESLint reads that oxc's ESTree leaves out: each
 * node's, comment's and token's line and column (`loc`), from its offsets,
 * as oxlint's own JavaScript plugins work them out.
 */
import { analyze } from "@typescript-eslint/scope-manager";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import type { AST, Linter, Scope, SourceCode } from "eslint";
import { z } from "zod";

import { oxcParserOf } from "./oxc.ts";

let parse: ((path: string, source: string) => string) | undefined;

/**
 * Starts the parser on oxc.wasm's `module`, once per isolate: an instance
 * made on the first parse and kept (oxc.ts).
 */
export const startOxcParser = (module: WebAssembly.Module): void => {
  parse ??= oxcParserOf(module);
};

const spanSchema = z.looseObject({ start: z.number(), end: z.number() });

/** What oxc.wasm's `parse` answers. */
const parsedSchema = z.union([
  z.strictObject({
    program: z.custom<object>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "type") === "Program"
    ),
    comments: z.array(
      z.strictObject({
        type: z.enum(["Line", "Block"]),
        value: z.string(),
        start: z.number(),
        end: z.number(),
      })
    ),
    tokens: z.array(spanSchema),
  }),
  z.strictObject({
    error: z.strictObject({ message: z.string(), start: z.number() }),
  }),
]);

type Parsed = z.infer<typeof parsedSchema>;

/** `source` (`path`, which picks the language) parsed by oxc. */
const parsed = (path: string, source: string): Parsed => {
  if (parse === undefined) {
    throw new Error("oxc's parser hasn't started (startOxcParser)");
  }
  return parsedSchema.parse(JSON.parse(parse(path, source)));
};

/** The comments of `source` (`path`), with where each is; none if it doesn't parse. */
export const commentsOf = (
  path: string,
  source: string
): { range: [number, number]; type: "Line" | "Block"; value: string }[] => {
  const found = parsed(path, source);
  return "error" in found
    ? []
    : found.comments.map(({ type, value, start, end }) => ({
        range: [start, end],
        type,
        value,
      }));
};

/**
 * oxc-parser's `parseSync`, as far as @shadcn/lint calls it to read the
 * kit's components (build.ts `shadcnParser`): the program, and an error
 * when it doesn't parse.
 */
export const parseSync = (
  filename: string,
  source: string
): { program: unknown; errors: { severity: "Error"; message: string }[] } => {
  const found = parsed(filename, source);
  return "error" in found
    ? {
        program: { type: "Program", body: [] },
        errors: [{ severity: "Error", message: found.error.message }],
      }
    : { program: found.program, errors: [] };
};

/** What ends a line, as ESLint counts lines. */
const lineBreak = /\r\n|[\n\r\u2028\u2029]/gu;

interface Position {
  line: number;
  column: number;
}

/** The line (1-based) and column (0-based) of each offset in `text`, as ESLint's `loc`. */
const positionsIn = (text: string): ((offset: number) => Position) => {
  const starts = [
    0,
    ...Array.from(
      text.matchAll(lineBreak),
      ({ index, 0: end }) => index + end.length
    ),
  ];
  // The last line that starts at or before `offset`, by halves: a file has
  // as many nodes as it has characters, near enough.
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) };
  };
};

const isRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  typeof value[0] === "number" &&
  typeof value[1] === "number";

/** Gives every node under `value` its `loc` from its `range`. */
const locate = (value: unknown, at: (offset: number) => Position): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const range: unknown = Reflect.get(value, "range");
  if (isRange(range) && typeof Reflect.get(value, "type") === "string") {
    Reflect.set(value, "loc", { start: at(range[0]), end: at(range[1]) });
  }
  for (const child of Object.values(value)) {
    locate(child, at);
  }
};

/** A comment or a token as ESLint reads it: its offsets as `range`, and its `loc`. */
const placed = <Span extends { start: number; end: number }>(
  span: Span,
  at: (offset: number) => Position
): Span & {
  range: [number, number];
  loc: { start: Position; end: Position };
} => ({
  ...span,
  range: [span.start, span.end],
  loc: { start: at(span.start), end: at(span.end) },
});

/** A parse error as ESLint reports one: where it is, 1-based. */
const syntaxError = (
  message: string,
  offset: number,
  at: (offset: number) => Position
): SyntaxError => {
  const { line, column } = at(offset);
  return Object.assign(new SyntaxError(message), {
    index: offset,
    lineNumber: line,
    column: column + 1,
  });
};

/** typescript-eslint's visitor keys, as ESLint types them (not read-only). */
const keys: SourceCode.VisitorKeys = Object.fromEntries(
  Object.entries(visitorKeys).map(([type, children = []]) => [
    type,
    [...children],
  ])
);

/** The ESLint parser over oxc's: `startOxcParser` first. */
export const parser: Linter.Parser = {
  meta: { name: "oxc" },
  parseForESLint: (
    code: string,
    options: { filePath?: string; sourceType?: string } = {}
  ): Linter.ESLintParseResult => {
    const sourceType = options.sourceType === "module" ? "module" : "script";
    const found = parsed(options.filePath ?? "file.ts", code);
    const at = positionsIn(code);
    if ("error" in found) {
      throw syntaxError(found.error.message, found.error.start, at);
    }
    const { program, comments, tokens } = found;
    locate(program, at);
    Object.assign(program, {
      sourceType,
      comments: comments.map((comment) => placed(comment, at)),
      tokens: tokens.map((token) => placed(token, at)),
    });
    // SAFETY: oxc answers TS-ESTree (its README: any deviation is a bug),
    // the tree typescript-eslint's scope analysis reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const tree = program as Parameters<typeof analyze>[0];
    return {
      // SAFETY: the same tree, which ESLint reads as ESTree: TS-ESTree is
      // ESTree with TypeScript's nodes added.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      ast: program as AST.Program,
      // SAFETY: typescript-eslint's scope analysis, which ESLint reads as
      // its own, as typescript-eslint's parser hands it over.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      scopeManager: analyze(tree, { sourceType }) as Scope.ScopeManager,
      visitorKeys: keys,
    };
  },
};
