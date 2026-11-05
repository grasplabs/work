/**
 * App code's comments that steer a lint, read by ESLint, which Grasp's
 * isolate lints with, as oxlint reads them, which an exported App lints
 * with: oxlint's own disable comments (`oxlint-disable…`) as ESLint's,
 * each rule by its ID in ESLint, and inline config comments, which oxlint
 * doesn't read, by neither. Ultracite's lint (ultracite.ts) and the
 * design system's (lint.ts) read them alike.
 */
import { parse } from "@typescript-eslint/parser";
import type { Linter } from "eslint/universal";

/**
 * Whether `source` may hold a disable comment or an inline config one: most
 * files hold none, and aren't parsed for them.
 */
const mayDirect = /(?:es|ox)lint-(?:disable|enable)|\/\*\s*eslint\s/u;

/**
 * An inline config comment (`/* eslint no-console: "error" *\/`), which
 * ESLint reads in a block comment and oxlint doesn't read at all.
 */
const inlineConfig = /^\s*eslint\s/u;

/** A disable comment's text (its value): its directive, then the rules it names. */
const directive =
  /^(?<space>\s*)(?:eslint|oxlint)(?<kind>-(?:disable|enable)(?:-next-line|-line)?)(?=\s|$)/u;

/** Where a disable comment's description starts, as ESLint reads it. */
const description = /\s-{2,}\s/u;

/**
 * A lint's rules as a disable comment names them, as oxlint reads one. A
 * rule of its own oxlint reads by the rule's name alone, whatever plugin,
 * if any, comes before it (`react-hooks/rules-of-hooks`,
 * `@typescript-eslint/no-explicit-any`, `no-danger`): `native`, by that
 * name, each with its IDs in ESLint. A rule of a JS plugin (sonarjs's,
 * `@shadcn/lint`'s, the compiler's design rules) it reads only by its
 * full name: `exact`.
 */
export interface RuleIndex {
  readonly native: ReadonlyMap<string, readonly string[]>;
  readonly exact: ReadonlySet<string>;
}

/** A rule's own name: without its plugin. */
const ruleName = (name: string): string =>
  name.slice(name.lastIndexOf("/") + 1);

/** A lint's rules, by their IDs in ESLint: oxlint's own, and JS plugins'. */
export const ruleIndex = (
  native: Iterable<string>,
  exact: Iterable<string>
): RuleIndex => {
  const byName = new Map<string, string[]>();
  for (const id of new Set(native)) {
    byName.set(ruleName(id), [...(byName.get(ruleName(id)) ?? []), id]);
  }
  return { native: byName, exact: new Set(exact) };
};

/**
 * The rules a name in a disable comment names, as oxlint reads it, by
 * their IDs here; as written if none runs here (`namesUnknownRule`).
 */
const idsOf = (name: string, rules: RuleIndex): string => {
  const ids = [
    ...(rules.native.get(ruleName(name)) ?? []),
    ...(rules.exact.has(name) ? [name] : []),
  ];
  return ids.length === 0 ? name : ids.join(", ");
};

/**
 * A comment's value as ESLint reads it, if it is a disable comment:
 * oxlint's own (`oxlint-disable…`), which the repo writes and an export's
 * oxlint reads, as ESLint's, and each rule it names by its ID here.
 */
const eslintDirective = (
  value: string,
  rules: RuleIndex
): string | undefined => {
  const found = directive.exec(value);
  if (found === null) {
    return undefined;
  }
  const rest = value.slice(found[0].length);
  const end = description.exec(rest)?.index ?? rest.length;
  const named = rest
    .slice(0, end)
    .replaceAll(/[^\s,]+/gu, (name) => idsOf(name, rules));
  return `${found.groups?.space ?? ""}eslint${found.groups?.kind ?? ""}${named}${rest.slice(end)}`;
};

/** A disable comment of one line (`-line`, `-next-line`), as ESLint reads it. */
const lineScoped = /^\s*eslint-disable-(?:next-)?line(?=\s|$)/u;

/**
 * A disable comment as ESLint reads it (`read`), of `type`. oxlint reads
 * one of a range (`oxlint-disable`, up to the next `-enable`) in a line
 * comment too, ESLint only in a block one: such a line comment is one.
 */
const commentOf = (type: "Line" | "Block", read: string): string => {
  if (type === "Block") {
    return `/*${read}*/`;
  }
  return lineScoped.test(read) || read.includes("*/")
    ? `//${read}`
    : `/*${read}*/`;
};

/** The comments of `source` (`path` in the App), with where each is; none if it doesn't parse. */
const commentsOf = (
  path: string,
  source: string
): { range: [number, number]; type: "Line" | "Block"; value: string }[] => {
  try {
    return (
      parse(source, { comment: true, range: true, filePath: path }).comments ??
      []
    );
  } catch {
    return [];
  }
};

/**
 * A disable comment `asEslint` changed: where it is in the source, and its
 * length as ESLint reads it. Its length can't be kept: a rule's ID here is
 * often longer than oxlint's name (`typescript/no-empty-function`), and a
 * line comment of a range becomes a block one.
 */
interface Change {
  start: number;
  end: number;
  length: number;
}

/**
 * `source` as ESLint reads it as oxlint does: its disable comments as
 * ESLint's (`eslintDirective`), and its inline config comments read by
 * neither (`inlineConfig`), with each comment as written by its text as
 * ESLint reads it, in order: what puts them back. `changes`, in order, map
 * a place in `text` back to the source (`placeIn`).
 */
export const asEslint = (
  path: string,
  source: string,
  rules: RuleIndex
): { text: string; written: Map<string, string[]>; changes: Change[] } => {
  const written = new Map<string, string[]>();
  const changes: Change[] = [];
  if (!mayDirect.test(source)) {
    return { text: source, written, changes };
  }
  let text = source;
  // From the last, so each one's place holds.
  for (const { range, type, value } of commentsOf(path, source).toReversed()) {
    const read =
      type === "Block" && inlineConfig.test(value)
        ? " "
        : eslintDirective(value, rules);
    const as = source.slice(...range);
    const comment = read === undefined ? as : commentOf(type, read);
    if (comment !== as) {
      written.set(comment, [as, ...(written.get(comment) ?? [])]);
      changes.unshift({
        start: range[0],
        end: range[1],
        length: comment.length,
      });
      text = `${text.slice(0, range[0])}${comment}${text.slice(range[1])}`;
    }
  }
  return { text, written, changes };
};

/** What ends a line, as ESLint counts lines. */
const lineBreak = /\r\n|[\n\r\u2028\u2029]/gu;

/** Where each of `text`'s lines starts. */
const lineStarts = (text: string): number[] => [
  0,
  ...Array.from(
    text.matchAll(lineBreak),
    ({ index, 0: end }) => index + end.length
  ),
];

/**
 * Where `at` in the text `asEslint` read by `changes` is in the source: a
 * name read by a longer one moves what follows it. A place inside a
 * changed comment is the comment's start.
 */
const sourceOffset = (at: number, changes: readonly Change[]): number => {
  let shift = 0;
  for (const { start, end, length } of changes) {
    if (at < start + shift) {
      break;
    }
    if (at < start + shift + length) {
      return start;
    }
    shift += length - (end - start);
  }
  return at - shift;
};

export interface Place {
  line: number;
  column: number;
}

/**
 * Where a place in `text` (a 1-based line and column, as ESLint reports
 * one) is in `source`, which `asEslint` read as `text` by `changes`.
 */
export const placeIn = (
  source: string,
  text: string,
  changes: readonly Change[]
): ((place: Place) => Place) => {
  if (changes.length === 0) {
    return ({ line, column }) => ({ line, column });
  }
  const textLines = lineStarts(text);
  const sourceLines = lineStarts(source);
  return ({ line, column }) => {
    const offset = sourceOffset(
      (textLines[line - 1] ?? 0) + column - 1,
      changes
    );
    const index = sourceLines.findLastIndex((start) => start <= offset);
    return { line: index + 1, column: offset - (sourceLines[index] ?? 0) + 1 };
  };
};

/**
 * `fixed` with each disable comment `asEslint` changed as it was written,
 * found by the parser, in order (a fix may move one); null if one isn't
 * there any more.
 */
export const restored = (
  path: string,
  fixed: string,
  written: ReadonlyMap<string, readonly string[]>
): string | null => {
  if (written.size === 0) {
    return fixed;
  }
  const left = new Map([...written].map(([read, as]) => [read, [...as]]));
  const places = commentsOf(path, fixed).flatMap(({ range }) => {
    const as = left.get(fixed.slice(...range))?.shift();
    return as === undefined ? [] : [{ range, as }];
  });
  if ([...left.values()].some((as) => as.length > 0)) {
    return null;
  }
  let text = fixed;
  for (const { range, as } of places.toReversed()) {
    text = `${text.slice(0, range[0])}${as}${text.slice(range[1])}`;
  }
  return text;
};

/**
 * Whether `message` is ESLint's of a disable comment that names a rule it
 * doesn't run, which oxlint passes over: a rule of another lint (a design
 * rule in Ultracite's, `typescript/…` in the design system's), of a JS
 * plugin of the export's (`react-doctor/…`), or a typo. Each lint's rules
 * are fixed as the compiler is built, so a comment is the only place such
 * a name comes from.
 */
export const namesUnknownRule = ({
  ruleId,
  message,
}: Linter.LintMessage): boolean =>
  ruleId !== null &&
  message === `Definition for rule '${ruleId}' was not found.`;
