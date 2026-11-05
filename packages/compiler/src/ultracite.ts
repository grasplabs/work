/**
 * App code held to the repo's own bar, Ultracite: the rules of the oxlint
 * presets the repo extends, which an exported App's `oxlint` runs too, and
 * its Prettier config. oxlint and oxfmt are native and have no WebAssembly
 * build, so the isolate runs each rule's ESLint equivalent on ESLint's
 * `Linter`, under oxlint's name (worked out when the compiler was built:
 * `#ultracite-rules`, ultracite-rules.ts), and Prettier's standalone
 * build. It runs in an isolate of its own (ultracite-worker.ts), started
 * only when a write tidies or a check lints.
 *
 * - `tidy`, on every write, before it is saved: every fix oxlint counts as
 *   safe, then Prettier, so the agent never spends a turn on formatting or
 *   on what fixes itself.
 * - `lintCode`, in what every write and check reports: every rule, no
 *   fixes, a file at a time (core keeps each file's result:
 *   module-cache.ts).
 */
import { Linter } from "eslint/universal";
import * as estree from "prettier/plugins/estree";
import * as prettierTypescript from "prettier/plugins/typescript";
import { format } from "prettier/standalone";

import ultracite from "#ultracite-rules";

import type { Diagnostic } from "./diagnostic.ts";
import { formatConfig } from "./format-config.ts";
import { isLintedCode } from "./inputs.ts";
import {
  asEslint,
  namesUnknownRule,
  placeIn,
  restored,
  ruleIndex,
} from "./lint-comments.ts";
import type { Place } from "./lint-comments.ts";
import { lintConfig, pluginsWith } from "./ultracite-plugins.ts";

const plugins = pluginsWith(ultracite.stubs);

const fixable = new Set(ultracite.fixable);

/**
 * Every rule here, and every stub, as a disable comment names it: sonarjs's
 * (`reportOnly`) are a JS plugin's in oxlint.
 */
const jsPluginRules = new Set(Object.keys(ultracite.reportOnly));
const commentRules = ruleIndex(
  [
    ...Object.keys(ultracite.rules),
    ...ultracite.overrides.flatMap(({ rules }) => Object.keys(rules)),
    ...ultracite.stubs,
  ].filter((id) => !jsPluginRules.has(id)),
  jsPluginRules
);

/** `rules`, but those a write doesn't fix (`fixable`). */
const fixing = (
  rules: Readonly<Record<string, Linter.RuleEntry>>
): Linter.RulesRecord =>
  Object.fromEntries(Object.entries(rules).filter(([id]) => fixable.has(id)));

/**
 * What a write fixes: only the rules whose fix oxlint counts as safe
 * (ultracite-rules.ts), so a fix never changes what the code does.
 */
const fixConfig = lintConfig(
  plugins,
  fixing(ultracite.rules),
  ultracite.overrides.map(({ files, rules }) => ({
    files,
    rules: fixing(rules),
  }))
);

/**
 * What a lint reports: every rule, and sonarjs's as warnings, which never
 * fix (`reportOnly`).
 */
const reportConfig = lintConfig(
  plugins,
  { ...ultracite.rules, ...ultracite.reportOnly },
  ultracite.overrides
);

const linter = new Linter({ cwd: "/" });

/** Where a file is linted: no rule here reads the file system. */
const filenameOf = (path: string): string => `/app/${path}`;

/** Whether a write makes `message`'s fix: only a rule of `fixable`'s. */
const fixes = ({ ruleId }: Linter.LintMessage): boolean =>
  ruleId !== null && fixable.has(ruleId);

/**
 * `text` (`path` in the App) with `fixes`' fixes made, as many rounds as
 * ESLint makes them. Filtered by rule, not only by `fixConfig`: an inline
 * config comment (`/* eslint rule: "error" *\/`) turns on a rule beyond
 * it, whose fix may not be safe. `verifyAndFix` takes a function as its
 * `fix` (its `ESLint` class passes one for `fixTypes`), which its types
 * don't name, so it is called by `Reflect` and its answer read as found.
 */
const fixedText = (path: string, text: string): string => {
  const verifyAndFix: unknown = Reflect.get(linter, "verifyAndFix");
  if (typeof verifyAndFix !== "function") {
    return text;
  }
  const report: unknown = Reflect.apply(verifyAndFix, linter, [
    text,
    fixConfig,
    { filename: filenameOf(path), fix: fixes },
  ]);
  return typeof report === "object" &&
    report !== null &&
    "output" in report &&
    typeof report.output === "string"
    ? report.output
    : text;
};

/**
 * `source` with every fix oxlint counts as safe made, then formatted.
 * Code that doesn't parse is left as it is: the build says why.
 */
const tidyOne = async (path: string, source: string): Promise<string> => {
  const { text, written } = asEslint(path, source, commentRules);
  const fixed = restored(path, fixedText(path, text), written) ?? source;
  try {
    return await format(fixed, {
      ...formatConfig,
      // By its name: a `.ts` file has no JSX, so `<T>` needs no comma.
      filepath: path,
      parser: "typescript",
      plugins: [estree, prettierTypescript],
    });
  } catch {
    return fixed;
  }
};

/** `files` (by path in the App), their TypeScript tidied (`tidyOne`), the rest as they are. */
export const tidy = async (
  files: Record<string, string>
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(
        async ([path, source]): Promise<[string, string]> => [
          path,
          isLintedCode(path) ? await tidyOne(path, source) : source,
        ]
      )
    )
  );

const diagnosticOf = (
  file: string,
  place: Place,
  { ruleId, severity, message, suggestions }: Linter.LintMessage
): Diagnostic => {
  const [suggestion] = suggestions ?? [];
  return {
    file,
    ...place,
    // As oxlint names it, which a disable comment names too.
    rule: ruleId === null ? "lint" : (ultracite.names[ruleId] ?? ruleId),
    severity: severity === 2 ? "error" : "warning",
    message,
    ...(suggestion === undefined ? {} : { fix: suggestion.desc }),
  };
};

/**
 * What the rules say of `source` (`path` in the App), each where it is in
 * `source`, not in the text ESLint reads (`placeIn`).
 */
const lintOne = (path: string, source: string): Diagnostic[] => {
  const { text, changes } = asEslint(path, source, commentRules);
  const place = placeIn(source, text, changes);
  return linter
    .verify(text, reportConfig, filenameOf(path))
    .filter((message) => message.fatal !== true && !namesUnknownRule(message))
    .map((message) => diagnosticOf(path, place(message), message));
};

/**
 * What the rules say of each of `files`' TypeScript (by path in the App),
 * at its own level, by file: every file it lints has an entry, empty when
 * clean. A file that doesn't parse says nothing here: the build says why.
 */
export const lintCode = (
  files: Record<string, string>
): Record<string, Diagnostic[]> =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => isLintedCode(path))
      .map(([path, source]) => [path, lintOne(path, source)])
  );
