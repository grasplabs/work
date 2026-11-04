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
import { parse } from "@typescript-eslint/parser";
import { Linter } from "eslint/universal";
import * as estree from "prettier/plugins/estree";
import * as prettierTypescript from "prettier/plugins/typescript";
import { format } from "prettier/standalone";
import prettierConfig from "ultracite/prettier";

import ultracite from "#ultracite-rules";

import type { Diagnostic } from "./diagnostic.ts";
import { lintConfig, pluginsWith } from "./ultracite-plugins.ts";

const plugins = pluginsWith(ultracite.stubs);

const fixable = new Set(ultracite.fixable);

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

/** What the rules lint and Prettier formats: the App's TypeScript. */
const isLinted = (path: string): boolean =>
  (path.endsWith(".ts") || path.endsWith(".tsx")) && !path.endsWith(".d.ts");

/** Whether `source` may hold a disable comment: most files hold none, and aren't parsed for them. */
const mayDirect = /(?:es|ox)lint-(?:disable|enable)/u;

/** A disable comment's text (its value): its directive, then the rules it names. */
const directive =
  /^(?<space>\s*)(?:eslint|oxlint)(?<kind>-(?:disable|enable)(?:-next-line|-line)?)(?=\s|$)/u;

/** Where a disable comment's description starts, as ESLint reads it. */
const description = /\s-{2,}\s/u;

/** A rule's name as oxlint reads it in a comment, as ESLint's ID (`aliases`). */
const idOf = (name: string): string => {
  const bare = name.startsWith("eslint/") ? name.slice("eslint/".length) : name;
  return ultracite.aliases[bare] ?? bare;
};

/**
 * A comment's value as ESLint reads it, if it is a disable comment:
 * oxlint's own (`oxlint-disable…`), which the repo writes and an export's
 * oxlint reads, as ESLint's, and each rule it names by its ID here.
 */
const eslintDirective = (value: string): string | undefined => {
  const found = directive.exec(value);
  if (found === null) {
    return undefined;
  }
  const rest = value.slice(found[0].length);
  const end = description.exec(rest)?.index ?? rest.length;
  const rules = rest.slice(0, end).replaceAll(/[^\s,]+/gu, idOf);
  return `${found.groups?.space ?? ""}eslint${found.groups?.kind ?? ""}${rules}${rest.slice(end)}`;
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
 * `source` with its disable comments as ESLint reads them
 * (`eslintDirective`), and each one, as written, by its text as ESLint
 * reads it, in order: what puts them back.
 */
const asEslint = (
  path: string,
  source: string
): { text: string; written: Map<string, string[]> } => {
  const written = new Map<string, string[]>();
  if (!mayDirect.test(source)) {
    return { text: source, written };
  }
  let text = source;
  // From the last, so each one's place holds.
  for (const { range, type, value } of commentsOf(path, source).toReversed()) {
    const read = eslintDirective(value);
    const as = source.slice(...range);
    const comment = read === undefined ? as : commentOf(type, read);
    if (comment !== as) {
      written.set(comment, [as, ...(written.get(comment) ?? [])]);
      text = `${text.slice(0, range[0])}${comment}${text.slice(range[1])}`;
    }
  }
  return { text, written };
};

/**
 * `fixed` with each disable comment `asEslint` changed as it was written,
 * found by the parser, in order (a fix may move one); null if one isn't
 * there any more.
 */
const restored = (
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
 * `source` with every fix oxlint counts as safe made, then formatted.
 * Code that doesn't parse is left as it is: the build says why.
 */
const tidyOne = async (path: string, source: string): Promise<string> => {
  const { text, written } = asEslint(path, source);
  const { output } = linter.verifyAndFix(text, fixConfig, filenameOf(path));
  const fixed = restored(path, output, written) ?? source;
  try {
    return await format(fixed, {
      ...prettierConfig,
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
          isLinted(path) ? await tidyOne(path, source) : source,
        ]
      )
    )
  );

/**
 * Whether `message` is ESLint's of a disable comment that names a rule it
 * doesn't know, which oxlint passes over: a rule of a JS plugin of the
 * export's (`react-doctor/…`), or a typo. Every rule oxlint knows has a
 * stub (`pluginsWith`), so only such a name is left. The rules' config is
 * fixed and checked as the compiler is built (ultracite-rules.ts), so a
 * comment is the only place it comes from.
 */
const namesUnknownRule = ({ ruleId, message }: Linter.LintMessage): boolean =>
  ruleId !== null &&
  message === `Definition for rule '${ruleId}' was not found.`;

const diagnosticOf = (
  file: string,
  { ruleId, line, column, severity, message, suggestions }: Linter.LintMessage
): Diagnostic => {
  const [suggestion] = suggestions ?? [];
  return {
    file,
    line,
    column,
    // As oxlint names it, which a disable comment names too.
    rule: ruleId === null ? "lint" : (ultracite.names[ruleId] ?? ruleId),
    severity: severity === 2 ? "error" : "warning",
    message,
    ...(suggestion === undefined ? {} : { fix: suggestion.desc }),
  };
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
      .filter(([path]) => isLinted(path))
      .map(([path, source]) => [
        path,
        linter
          .verify(asEslint(path, source).text, reportConfig, filenameOf(path))
          .filter(
            (message) => message.fatal !== true && !namesUnknownRule(message)
          )
          .map((message) => diagnosticOf(path, message)),
      ])
  );
