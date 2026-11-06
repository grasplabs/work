/**
 * App code held to the repo's own bar, Ultracite: its oxlint presets and
 * its oxfmt config (ultracite-config.ts), run by oxlint and oxfmt
 * themselves, compiled to WebAssembly (oxc.ts), the same releases an
 * exported App's own oxlint and oxfmt are. It runs in an isolate of its
 * own (ultracite-worker.ts), started only when a write tidies or a check
 * lints. Disable comments are oxlint's own to read.
 *
 * - `tidy`, on every write, before it is saved: every fix oxlint counts as
 *   safe (`oxlint --fix`), then oxfmt, so the agent never spends a turn on
 *   formatting or on what fixes itself.
 * - `lintCode`, in what every write and check reports: every rule, no
 *   fixes, a file at a time (core keeps each file's result:
 *   module-cache.ts).
 *
 * A file oxc.wasm can't take (nested too deep, or too large for its
 * memory) fails alone: the others in its call, and every other App's,
 * are linted and tidied as ever (oxc.ts).
 */
import { appLimits } from "@grasp-os/shared/app-limits";

import type { UltraciteConfig } from "../ultracite-config.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { isLintedCode } from "./inputs.ts";
import { oxcOf } from "./oxc.ts";
import type { Finding } from "./oxc.ts";

export interface Ultracite {
  /**
   * `files` (by path in the App), their TypeScript tidied, the rest as
   * they are; null for a file to keep as written, which `tidy` couldn't
   * take, or whose tidied text is past the App's file limit or the
   * answer's (`tidiedCharacters`).
   */
  tidy: (files: Record<string, string>) => Record<string, string | null>;
  /**
   * What the rules say of each of `files`' TypeScript (by path in the
   * App), at its own level, by file: every file it lints has an entry,
   * empty when clean. A file that doesn't parse says nothing here: the
   * build says why.
   */
  lintCode: (files: Record<string, string>) => Record<string, Diagnostic[]>;
  /**
   * oxc's parser, on the same instance (oxc.ts `Oxc.parse`): what the
   * isolate's ESLint lints parse with (eslint-parser.ts).
   */
  parse: (path: string, source: string) => string;
}

/**
 * The most characters one `tidy` answers: what a call hands Workers RPC
 * is at most two bytes a character, so this keeps an answer at half its
 * 32 MiB. oxfmt can make a file far larger than it was (an array nested
 * 500 deep, 1 kB written, is half a megabyte formatted).
 */
const tidiedCharacters = 8_000_000;

/**
 * What a file oxc.wasm couldn't lint says: an error, so a draft never
 * passes unlinted. Past what its stack and memory hold: an expression
 * nested hundreds deep, or a component with hundreds of conditional
 * branches (the React Compiler's analysis recurses on each), which native
 * oxlint, with a far larger stack, still reads.
 */
const unlintable = (file: string): Diagnostic => ({
  file,
  rule: "lint",
  severity: "error",
  message:
    "Ultracite's lint ran out of room on this file: split this page into components, or the file into smaller ones, and flatten anything nested hundreds deep.",
});

const diagnosticOf = (
  file: string,
  { rule, severity, message, help, line, column }: Finding
): Diagnostic => ({
  file,
  line,
  column,
  rule,
  severity,
  message,
  ...(help === undefined ? {} : { fix: help }),
});

/** Ultracite's lint and format of App code, on oxc.wasm's `module`. */
export const ultraciteOf = (
  module: WebAssembly.Module,
  config: UltraciteConfig
): Ultracite => {
  const oxc = oxcOf(module, config);
  /** `source` tidied, or null to keep it as written. */
  const tidied = (path: string, source: string): string | null => {
    try {
      const text = oxc.tidy(path, source);
      return text.length > appLimits.fileLength ? null : text;
    } catch {
      return null;
    }
  };
  const linted = (path: string, source: string): Diagnostic[] => {
    try {
      return (oxc.lint(path, source) ?? [])
        .toSorted((a, b) => a.line - b.line || a.column - b.column)
        .map((finding) => diagnosticOf(path, finding));
    } catch {
      return [unlintable(path)];
    }
  };
  return {
    parse: oxc.parse,
    tidy: (files) => {
      let answered = 0;
      return Object.fromEntries(
        Object.entries(files).map(([path, source]) => {
          if (!isLintedCode(path)) {
            answered += source.length;
            return [path, source];
          }
          const text = tidied(path, source);
          if (text === null || answered + text.length > tidiedCharacters) {
            return [path, null];
          }
          answered += text.length;
          return [path, text];
        })
      );
    },
    lintCode: (files) =>
      Object.fromEntries(
        Object.entries(files)
          .filter(([path]) => isLintedCode(path))
          .map(([path, source]) => [path, linted(path, source)])
      ),
  };
};
