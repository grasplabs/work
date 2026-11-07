/**
 * The parser of the lint isolate's ESLint lint (lint.ts),
 * and the one @shadcn/lint reads the kit's components with: oxc's, on the
 * oxc.wasm instance Ultracite's lint runs on (oxc-wasm/src/lib.rs
 * `parse`), with typescript-eslint's own scope analysis and visitor keys.
 * That is typescript-eslint's parser less TypeScript: oxc answers
 * TS-ESTree, the tree typescript-eslint converts TypeScript's to, and
 * ESLint's tokens (oxc_estree_tokens, which oxc checks against
 * typescript-eslint's), and TypeScript 7 has no JavaScript API to run
 * typescript-eslint's on.
 *
 * What it adds is what ESLint reads that oxc's JSON leaves out: each
 * node's, comment's and token's `range` and line and column (`loc`), from
 * its offsets, as oxlint's own JavaScript plugins work them out, and the
 * values of regular expression and BigInt literals.
 */
import { analyze } from "@typescript-eslint/scope-manager";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import type { AST, Linter, Scope, SourceCode } from "eslint";
import { z } from "zod";

/** oxc.wasm's `parse` (oxc.ts `Oxc.parse`): JSON of what it parsed. */
type Parse = (path: string, source: string) => string;

let parse: Parse | undefined;

/**
 * Starts the parser on oxc.wasm's `parse`, once per isolate: the lint's
 * own instance (ultracite-worker.ts), so the isolate holds one.
 */
export const startOxcParser = (oxcParse: Parse): void => {
  parse ??= oxcParse;
};

/**
 * What a file oxc.wasm couldn't parse says: past what its stack and
 * memory hold, nested hundreds deep or too large (oxc-wasm/src/lib.rs).
 */
export const unparsableMessage =
  "This file is too large or nested too deep for the lint to read: split this file into smaller ones, and flatten anything nested hundreds deep.";

/** A file `parse` couldn't take: it trapped, in a fresh instance too, or ran out of stack. */
class UnparsableFileError extends Error {
  constructor() {
    super(unparsableMessage);
    this.name = "UnparsableFileError";
  }
}

/**
 * Whether `error` is the stack or oxc.wasm's memory running out: a trap
 * (`unreachable`, as an allocation that fails aborts) or V8's stack.
 */
const ranOut = (error: unknown): boolean =>
  error instanceof RangeError ||
  error instanceof WebAssembly.RuntimeError ||
  error instanceof UnparsableFileError;

/**
 * Whether ESLint's `message` says its file couldn't be read at all
 * (`UnparsableFileError`), rather than that it doesn't parse.
 */
export const isUnparsable = (message: Linter.LintMessage): boolean =>
  message.fatal === true &&
  message.message === `Parsing error: ${unparsableMessage}`;

/**
 * `lint()`, or `unparsable()` should it run out of stack: ESLint walks a
 * tree as deep as it goes, which may be past where oxc.wasm stopped.
 */
export const orUnparsable = <T>(lint: () => T, unparsable: () => T): T => {
  try {
    return lint();
  } catch (error) {
    if (ranOut(error)) {
      return unparsable();
    }
    throw error;
  }
};

/** A node's, a comment's or a token's offsets, which oxc gives them all. */
interface Span {
  start: number;
  end: number;
}

const isSpan = (value: unknown): value is Span =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "start") === "number" &&
  typeof Reflect.get(value, "end") === "number";

/**
 * What oxc.wasm's `parse` answers. Each token is checked for its offsets
 * alone and kept as it is, not copied: a file has about as many as it
 * has words.
 */
const parsedSchema = z.union([
  z.strictObject({
    node: z.custom<object>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        Reflect.get(value, "type") === "Program"
    ),
    /** Where each regular expression and BigInt literal is (`fixed`). */
    fixes: z.array(z.array(z.union([z.string(), z.number()]))),
    comments: z.array(
      z.strictObject({
        type: z.enum(["Line", "Block"]),
        value: z.string(),
        start: z.number(),
        end: z.number(),
      })
    ),
    tokens: z.array(z.custom<Span>(isSpan)),
  }),
  z.strictObject({
    error: z.strictObject({ message: z.string(), start: z.number() }),
  }),
]);

type Parsed = z.infer<typeof parsedSchema>;

/**
 * Gives each literal `fixes` names its `value`, a `RegExp` or a `bigint`,
 * which JSON can't hold, as oxc-parser's own JavaScript does
 * (`jsonParseAst`): `null` stays for a pattern this engine can't compile.
 */
const fixed = (program: object, fixes: (string | number)[][]): void => {
  for (const fix of fixes) {
    let node: unknown = program;
    for (const key of fix) {
      node =
        typeof node === "object" && node !== null
          ? Reflect.get(node, key)
          : undefined;
    }
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const bigint: unknown = Reflect.get(node, "bigint");
    const regex: unknown = Reflect.get(node, "regex");
    if (typeof bigint === "string") {
      Reflect.set(node, "value", BigInt(bigint));
    } else if (typeof regex === "object" && regex !== null) {
      try {
        Reflect.set(
          node,
          "value",
          new RegExp(
            String(Reflect.get(regex, "pattern")),
            String(Reflect.get(regex, "flags"))
          )
        );
      } catch {
        // Flags or syntax this engine doesn't have: `null`, as oxc-parser leaves it.
      }
    }
  }
};

/**
 * `source` (`path`, which picks the language) parsed by oxc. Throws
 * `UnparsableFileError` should oxc.wasm run out of stack or memory on it.
 */
const parsed = (path: string, source: string): Parsed => {
  if (parse === undefined) {
    throw new Error("oxc's parser hasn't started (startOxcParser)");
  }
  let text: string;
  try {
    text = parse(path, source);
  } catch (error) {
    if (ranOut(error)) {
      throw new UnparsableFileError();
    }
    throw error;
  }
  const found = parsedSchema.parse(JSON.parse(text));
  if ("node" in found) {
    fixed(found.node, found.fixes);
  }
  return found;
};

/**
 * The comments of `source` (`path`), with where each is; none if it
 * doesn't parse, or can't be read (the lint's parse says so).
 */
export const commentsOf = (
  path: string,
  source: string
): { range: [number, number]; type: "Line" | "Block"; value: string }[] => {
  let found: Parsed;
  try {
    found = parsed(path, source);
  } catch (error) {
    if (error instanceof UnparsableFileError) {
      return [];
    }
    throw error;
  }
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
    : { program: found.node, errors: [] };
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

/** A node, a comment or a token as ESLint reads it: its offsets as `range`, and its `loc`, set on it. */
const placed = (span: Span, at: (offset: number) => Position): void => {
  Object.assign(span, {
    range: [span.start, span.end],
    loc: { start: at(span.start), end: at(span.end) },
  });
};

/** Gives every node under `value` its `range` and `loc`, from its offsets. */
const locate = (value: unknown, at: (offset: number) => Position): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (isSpan(value) && typeof Reflect.get(value, "type") === "string") {
    placed(value, at);
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
    const { node: program, comments, tokens } = found;
    // SAFETY: oxc answers TS-ESTree (its README: any deviation is a bug),
    // the tree typescript-eslint's scope analysis reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const tree = program as Parameters<typeof analyze>[0];
    // Both walk the whole tree, as deep as oxc.wasm parsed it.
    const scopeManager = orUnparsable(
      () => {
        locate(program, at);
        for (const comment of comments) {
          placed(comment, at);
        }
        for (const token of tokens) {
          placed(token, at);
        }
        Object.assign(program, { sourceType, comments, tokens });
        return analyze(tree, { sourceType });
      },
      () => {
        throw new UnparsableFileError();
      }
    );
    return {
      // SAFETY: the same tree, which ESLint reads as ESTree: TS-ESTree is
      // ESTree with TypeScript's nodes added.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      ast: program as AST.Program,
      // SAFETY: typescript-eslint's scope analysis, which ESLint reads as
      // its own, as typescript-eslint's parser hands it over.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      scopeManager: scopeManager as Scope.ScopeManager,
      visitorKeys: keys,
    };
  },
};
