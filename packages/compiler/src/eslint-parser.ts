/**
 * The parser of the compiler's ESLint lints (lint.ts, server-lint.ts), and
 * the one @shadcn/lint reads the kit's components with: oxc-parser, as the
 * threadless WebAssembly its workerd loader starts, with typescript-eslint's
 * own scope analysis and visitor keys. That is typescript-eslint's parser
 * less TypeScript: oxc answers TS-ESTree, the tree typescript-eslint's
 * converts TypeScript's to, and TypeScript 7 has no JavaScript API to run
 * typescript-eslint's on.
 *
 * It exists for what ESLint reads that oxc doesn't give, and is no more:
 * - every node's and comment's line and column (`loc`): oxc gives offsets
 *   alone (`range`);
 * - `tokens`, a list ESLint requires: oxc's WebAssembly has none (its
 *   tokens come only by raw transfer, which needs 64-bit memory). ESLint
 *   reads them only for its token API, which no rule of these lints calls
 *   (@shadcn/lint's and design-rules.ts read nodes, text and scopes), so
 *   the list is empty rather than made by a tokenizer of our own.
 */
import type {
  OxcError,
  ParserOptions,
} from "@oxc-parser/binding-wasm32-wasip1";
import { instantiate } from "@oxc-parser/binding-wasm32-wasip1/workerd";
import type { WasiBinding } from "@oxc-parser/binding-wasm32-wasip1/workerd";
import { analyze } from "@typescript-eslint/scope-manager";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import type { AST, Linter, Scope, SourceCode } from "eslint";
import { wrap } from "oxc-parser/src-js/wrap";

let binding: WasiBinding | undefined;

/**
 * Starts oxc-parser on its WebAssembly `module`, once per isolate: its
 * loader keeps the one instance. The module declares about 61 MiB of
 * linear memory as its least, which the instance takes whatever it parses.
 */
export const startOxcParser = async (
  module: WebAssembly.Module
): Promise<void> => {
  binding ??= await instantiate(module);
};

/**
 * oxc-parser's `parseSync`, as its own JavaScript entry answers it: what
 * the design lint's @shadcn/lint reads the kit's components with (build.ts
 * `shadcnParser`).
 */
export const parseSync = (
  filename: string,
  source: string,
  options?: ParserOptions
): ReturnType<typeof wrap> => {
  if (binding === undefined) {
    throw new Error("oxc-parser hasn't started (startOxcParser)");
  }
  return wrap(binding.parseSync(filename, source, options));
};

/** The severity of an error of oxc's that stops the parse; a warning doesn't. */
const stopping: ReadonlySet<string> = new Set(["Error"]);

/** Whether an error of oxc's stops the parse. */
export const stopsParse = ({ severity }: OxcError): boolean =>
  stopping.has(severity);

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

/** The ESLint parser over oxc-parser: `startOxcParser` first. */
export const parser: Linter.Parser = {
  meta: { name: "oxc-parser" },
  parseForESLint: (
    code: string,
    options: { filePath?: string; sourceType?: string } = {}
  ): Linter.ESLintParseResult => {
    const sourceType = options.sourceType === "module" ? "module" : "script";
    const result = parseSync(options.filePath ?? "file.ts", code, {
      sourceType,
      range: true,
      // TS-ESTree has no node for parentheses.
      preserveParens: false,
    });
    const at = positionsIn(code);
    const error = result.errors.find(stopsParse);
    if (error !== undefined) {
      throw syntaxError(error.message, error.labels[0]?.start ?? 0, at);
    }
    const { program } = result;
    locate(program, at);
    // SAFETY: oxc-parser answers TS-ESTree (its README: any deviation is a
    // bug), the tree typescript-eslint's scope analysis reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const tree = program as Parameters<typeof analyze>[0];
    Object.assign(tree, {
      sourceType,
      tokens: [],
      comments: result.comments.map(({ type, value, start, end }) => ({
        type,
        value,
        range: [start, end],
        loc: { start: at(start), end: at(end) },
      })),
    });
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
