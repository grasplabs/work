/**
 * App code's comments that steer the design system's lint (lint.ts), read
 * by ESLint, which Grasp's compiler lints screens with, as oxlint reads
 * them, which an exported App lints them with: oxlint's own disable
 * comments (`oxlint-disable…`) as ESLint's, and inline config comments,
 * which oxlint doesn't read, by neither. Its rules are JS plugins' in
 * oxlint, which a comment names in full, as ESLint does. Ultracite's lint
 * is oxlint's own, which reads its comments itself (ultracite.ts).
 */
import type { Linter } from "eslint/universal";

import { parseSync, stopsParse } from "./eslint-parser.ts";

/**
 * Whether `source` may hold a disable comment or an inline config one: most
 * files hold none, and aren't parsed for them.
 */
const mayDirect = /(?:es|ox)lint-(?:disable|enable)|\/\*\s*eslint\s/u;

/**
 * An inline config comment (`/* eslint no-console: "error" *\/`), which
 * ESLint reads in a block comment and oxlint doesn't read at all: its
 * leading space, then the word ESLint reads it by.
 */
const inlineConfig = /^(?<space>\s*)eslint(?=\s)/u;

/**
 * An inline config comment's value as neither lint reads it: its word as
 * spaces, so every line and place in it stays where it is.
 */
const inactive = (value: string): string =>
  value.replace(
    inlineConfig,
    (word, space: string) => `${space}${" ".repeat(word.length - space.length)}`
  );

/** A disable comment's text (its value): its directive, then the rules it names. */
const directive =
  /^(?<space>\s*)(?:eslint|oxlint)(?<kind>-(?:disable|enable)(?:-next-line|-line)?)(?=\s|$)/u;

/**
 * A comment's value as ESLint reads it, if it is a disable comment:
 * oxlint's own (`oxlint-disable…`), which the repo writes and an export's
 * oxlint reads, as ESLint's.
 */
const eslintDirective = (value: string): string | undefined => {
  const found = directive.exec(value);
  if (found === null) {
    return undefined;
  }
  return `${found.groups?.space ?? ""}eslint${found.groups?.kind ?? ""}${value.slice(found[0].length)}`;
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
  const { comments, errors } = parseSync(path, source);
  return errors.some(stopsParse)
    ? []
    : comments.map(({ type, value, start, end }) => ({
        range: [start, end],
        type,
        value,
      }));
};

/**
 * A disable comment `asEslint` changed: where it is in the source, and its
 * length as ESLint reads it. Its length can't be kept: `oxlint-` is
 * `eslint-`, and a line comment of a range becomes a block one.
 */
interface Change {
  start: number;
  end: number;
  length: number;
}

/**
 * `source` as ESLint reads it as oxlint does: its disable comments as
 * ESLint's (`eslintDirective`), and its inline config comments read by
 * neither (`inlineConfig`). `changes`, in order, map a place in `text`
 * back to the source (`placeIn`).
 */
export const asEslint = (
  path: string,
  source: string
): { text: string; changes: Change[] } => {
  const changes: Change[] = [];
  if (!mayDirect.test(source)) {
    return { text: source, changes };
  }
  let text = source;
  // From the last, so each one's place holds.
  for (const { range, type, value } of commentsOf(path, source).toReversed()) {
    const read =
      type === "Block" && inlineConfig.test(value)
        ? inactive(value)
        : eslintDirective(value);
    const as = source.slice(...range);
    const comment = read === undefined ? as : commentOf(type, read);
    if (comment !== as) {
      changes.unshift({
        start: range[0],
        end: range[1],
        length: comment.length,
      });
      text = `${text.slice(0, range[0])}${comment}${text.slice(range[1])}`;
    }
  }
  return { text, changes };
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
