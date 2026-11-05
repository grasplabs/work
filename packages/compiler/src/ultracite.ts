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
 */
import type { UltraciteConfig } from "../ultracite-config.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { isLintedCode } from "./inputs.ts";
import { oxcOf } from "./oxc.ts";
import type { Finding } from "./oxc.ts";

export interface Ultracite {
  /** `files` (by path in the App), their TypeScript tidied, the rest as they are. */
  tidy: (files: Record<string, string>) => Record<string, string>;
  /**
   * What the rules say of each of `files`' TypeScript (by path in the
   * App), at its own level, by file: every file it lints has an entry,
   * empty when clean. A file that doesn't parse says nothing here: the
   * build says why.
   */
  lintCode: (files: Record<string, string>) => Record<string, Diagnostic[]>;
}

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
  return {
    tidy: (files) =>
      Object.fromEntries(
        Object.entries(files).map(([path, source]) => [
          path,
          isLintedCode(path) ? oxc.tidy(path, source) : source,
        ])
      ),
    lintCode: (files) =>
      Object.fromEntries(
        Object.entries(files)
          .filter(([path]) => isLintedCode(path))
          .map(([path, source]) => [
            path,
            (oxc.lint(path, source) ?? [])
              .toSorted((a, b) => a.line - b.line || a.column - b.column)
              .map((finding) => diagnosticOf(path, finding)),
          ])
      ),
  };
};
