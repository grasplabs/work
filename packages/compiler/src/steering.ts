/**
 * What in a comment TypeScript obeys as a directive to its type check
 * rather than reads as a comment: a triple-slash directive, which reaches
 * the whole program, or a suppression, which switches the check off. Code
 * whose types the platform checks holds neither (imports.ts
 * `collectDirectives`).
 *
 * It imports nothing: a standalone definition project
 * (scripts/package-definition-lib.ts) carries this very file beside its
 * own check (standalone-check.ts), so the two refuse the same comments.
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
export const directiveIn = (
  kind: "line" | "block",
  value: string
): string | undefined =>
  kind === "line" && tripleSlash.test(value)
    ? `//${value}`.trim()
    : suppressionIn(value);
