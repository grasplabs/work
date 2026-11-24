/**
 * What in a file TypeScript obeys as a direction to its type check rather
 * than checks: a comment it reads as a directive (a triple-slash
 * directive, which reaches the whole program, or a suppression, which
 * switches the check off), and an ambient module or global declaration.
 * Read from the file as oxc's parser gives it, comments and syntax tree:
 * the platform's compile (oxc.wasm, worker.ts) and a standalone definition
 * project's check (standalone-check.ts, with oxc-parser) both parse with
 * oxc and refuse the same things through this file.
 *
 * It imports nothing: a standalone definition project
 * (scripts/package-definition-lib.ts) carries this very file beside its
 * own check, so the two can't drift.
 */

/**
 * A triple-slash directive TypeScript obeys: `/// <reference …/>`,
 * `/// <amd-module …/>` or `/// <amd-dependency …/>`. Any other tag in a
 * `///` comment (`/// <summary>`) is a comment to it.
 */
const tripleSlash = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/iu;

/**
 * A comment that switches the type check off for the whole file: a
 * `@ts-nocheck` pragma, which TypeScript reads in any case
 * (`@ts-NoCheck`). Refused wherever a comment holds it, stricter than
 * TypeScript, which reads it only where a pragma goes.
 */
const fileSuppression = /@ts-nocheck\b/iu;

/**
 * A comment line that switches the type check off for the next line: one
 * that starts, after any `/` or `*` and space, with `@ts-ignore` or
 * `@ts-expect-error`, where TypeScript reads them (in a line comment, or
 * on any line of a block comment). A comment that only mentions one
 * (`// Do not use @ts-ignore here.`) is prose to it, and to the build.
 */
// No word boundary after it, as TypeScript has none: it reads
// `// @ts-ignoreX` as `@ts-ignore`.
const lineSuppression = /^[\s/*]*@ts-(?:ignore|expect-error)/iu;

const leadingDelimiters = /^[\s/*]*/u;

/**
 * Where TypeScript ends a line: `\r\n`, `\r`, `\n`, U+2028 and U+2029.
 * A block comment's suppression is read from its lines as TypeScript
 * splits them (`/* x\r @ts-ignore *\/` suppresses), never only on `\n`.
 */
const lineTerminator = /\r\n?|\n|\u2028|\u2029/u;

/** The suppression `comment` holds where TypeScript would obey it, if any. */
const suppressionIn = (comment: string): string | undefined =>
  fileSuppression.exec(comment)?.[0] ??
  comment
    .split(lineTerminator)
    .map((line) =>
      lineSuppression.exec(line)?.[0].trim().replace(leadingDelimiters, "")
    )
    .find((found) => found !== undefined);

/**
 * The directive a comment holds, if TypeScript would obey one: `kind` is
 * whether it is a line comment (`//`) or a block comment, and `value` its
 * text without its delimiters, as a parser keeps it (` x` for `// x`).
 * Answers what it says, e.g. `/// <reference lib="dom" />` or
 * `@ts-ignore`.
 */
const directiveIn = (
  kind: "line" | "block",
  value: string
): string | undefined =>
  kind === "line" && tripleSlash.test(value)
    ? `//${value}`.trim()
    : suppressionIn(value);

/**
 * A comment as the parser keeps it: whether it is a line comment (`//`),
 * its text without its delimiters, and where it starts (1-based).
 */
export interface ParsedComment {
  readonly lineComment: boolean;
  readonly value: string;
  readonly line?: number;
  readonly column?: number;
}

/** A comment TypeScript reads as a directive to the type check. */
export interface DirectiveSite {
  /** What it says, e.g. `/// <reference lib="dom" />` or `@ts-ignore`. */
  readonly directive: string;
  readonly line: number | undefined;
  /** 1-based. */
  readonly column: number | undefined;
}

/** Every comment of a parsed file TypeScript would obey as a directive. */
export const directivesIn = (
  comments: readonly ParsedComment[]
): DirectiveSite[] =>
  comments.flatMap(({ lineComment, value, line, column }) => {
    const directive = directiveIn(lineComment ? "line" : "block", value);
    return directive === undefined ? [] : [{ directive, line, column }];
  });

/**
 * A `declare module`, `declare global` or `namespace`, as TS-ESTree has
 * it (`TSModuleDeclaration`).
 */
export interface ModuleDeclaration {
  readonly id: {
    readonly type: string;
    readonly value?: unknown;
  };
  /** `global` on `declare global { … }`. */
  readonly kind?: string;
}

/**
 * What a module declaration declares ambiently: globals every file sees
 * (`declare global`), or a module by its name (`declare module "x"`),
 * which declares or shadows that module; undefined for a namespace.
 */
export const ambientOf = ({
  id,
  kind,
}: ModuleDeclaration): { global: true } | { module: string } | undefined => {
  if (kind === "global") {
    return { global: true };
  }
  return id.type === "Literal" && typeof id.value === "string"
    ? { module: id.value }
    : undefined;
};

/**
 * The one triple-slash directive an App file may hold, written only this
 * way: a lowercase `reference` with a lowercase `path` and nothing else.
 * TypeScript reads a directive's tag and attributes in any case and
 * order (`<REFERENCE PATH=…>`, `preserve="true" path=…`), so the gate
 * names what it lets through, and refuses everything else
 * (`referenceError`), never the other way round.
 */
const ownReference =
  /^\/\/\/[ \t]*<reference[ \t]+path[ \t]*=[ \t]*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')[ \t]*\/>[ \t]*$/u;

/** Where `/// <reference path>` in `file` points: a path from the App's root. */
const referencedPath = (file: string, reference: string): string => {
  const parts = reference.startsWith("/") ? [] : file.split("/").slice(0, -1);
  for (const part of reference.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return parts.join("/");
};

/**
 * Why a triple-slash directive (`directive`, as `directivesIn` lists it)
 * in `file` isn't allowed, or undefined when it is: only
 * `/// <reference path="…" />` to another of the App's `files`, each a
 * path from the App's root (`ownReference`). Every other one is refused,
 * however written: a reference into the kit, a type package, a lib the
 * page doesn't have, an AMD directive. The import checks hold every
 * import a file writes; these are how it would name a module without
 * one. A suppression (`@ts-expect-error`) is no directive here: a page
 * may hold one.
 */
export const referenceError = (
  directive: string,
  file: string,
  files: ReadonlySet<string>
): string | undefined => {
  if (!directive.startsWith("///")) {
    return undefined;
  }
  const groups = ownReference.exec(directive)?.groups;
  if (groups === undefined) {
    return `${directive} is never in App files: a triple-slash directive names only another of the App's files, as /// <reference path="./types.d.ts" />.`;
  }
  const name = groups.double ?? groups.single ?? "";
  return files.has(referencedPath(file, name))
    ? undefined
    : `"${name}" is not one of the App's files: a reference path names only those.`;
};
