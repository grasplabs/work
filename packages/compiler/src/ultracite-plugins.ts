/**
 * The ESLint plugins that stand in for oxlint's own, under oxlint's names
 * (ultracite.ts): so a rule is named as the repo's and an exported App's
 * oxlint name it, in what a lint reports and in a disable comment.
 * oxlint's `react` holds React's hooks and compiler rules too, which ESLint
 * has in a plugin of its own, react-hooks. sonarjs runs in oxlint as a JS
 * plugin, under its own name, as here.
 */
import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import * as parser from "@typescript-eslint/parser";
import type { ESLint, Linter, Rule } from "eslint";
import { importX } from "eslint-plugin-import-x";
import { rules as jsdocRules } from "eslint-plugin-jsdoc";
import jsxA11y from "eslint-plugin-jsx-a11y";
import promise from "eslint-plugin-promise";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";

/** A plugin of `rules`, as ESLint's config takes it. */
const pluginOf = (
  ...rules: (Readonly<Record<string, unknown>> | undefined)[]
): ESLint.Plugin => ({
  // SAFETY: each plugin's rules are ESLint rule modules.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  rules: Object.assign({}, ...rules) as ESLint.Plugin["rules"],
});

const typescriptUnusedVars: unknown = typescriptPlugin.rules["no-unused-vars"];
// SAFETY: typescript-eslint's rules are ESLint rule modules (`pluginOf`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const unusedVarsRule = typescriptUnusedVars as Rule.RuleModule;

/** Whether `node` is in a type query (`typeof row` in a type), by its parents. */
const inTypeQuery = (node: unknown): boolean => {
  for (
    let at: unknown = node;
    typeof at === "object" && at !== null;
    at = "parent" in at ? at.parent : undefined
  ) {
    if ("type" in at && at.type === "TSTypeQuery") {
      return true;
    }
  }
  return false;
};

/**
 * Whether every read of the variable `node` declares or writes is in a
 * type query, as `type Row = typeof row` reads it.
 */
const readByTypeQueriesOnly = (
  { sourceCode }: Rule.RuleContext,
  node: unknown
): boolean => {
  const variable = sourceCode.scopeManager.scopes
    .flatMap(({ variables }) => variables)
    .find(
      ({ identifiers, references }) =>
        identifiers.some((identifier) => identifier === node) ||
        references.some(({ identifier }) => identifier === node)
    );
  const reads = (variable?.references ?? []).filter((reference) =>
    reference.isRead()
  );
  return (
    reads.length > 0 && reads.every(({ identifier }) => inTypeQuery(identifier))
  );
};

/**
 * typescript-eslint's `no-unused-vars`, reading a name as oxlint's does:
 * one a type query reads (`type Row = typeof row`) is used, as TypeScript
 * counts it too. typescript-eslint reports it as used only as a type
 * (`usedOnlyAsType`), as it does a parameter only a type predicate reads
 * (`(value, extra): extra is number`), and has no option to tell them
 * apart, so only the type query's report is dropped: oxlint reports the
 * predicate's too.
 *
 * Two differences remain until oxlint itself runs here: a variable only
 * ever written inside a loop or a condition (`subject += 1` in a loop),
 * which oxlint misses and TypeScript doesn't; and a variable written but
 * never read, which typescript-eslint reports at its last write and oxlint
 * at its declaration, so a disable comment for one misses the other.
 */
const unusedVars: Rule.RuleModule = {
  ...unusedVarsRule,
  create: (context) => {
    // The context is frozen: one of its own `report`, the rest the context's.
    // SAFETY: `Object.create` of the context is the context, but `report`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const reporting = Object.create(context, {
      report: {
        value: (descriptor: Rule.ReportDescriptor) => {
          const typeQueried =
            "messageId" in descriptor &&
            descriptor.messageId === "usedOnlyAsType" &&
            "node" in descriptor &&
            readByTypeQueriesOnly(context, descriptor.node);
          if (!typeQueried) {
            context.report(descriptor);
          }
        },
      },
    }) as Rule.RuleContext;
    return unusedVarsRule.create(reporting);
  },
};

export const ultracitePlugins: Readonly<Record<string, ESLint.Plugin>> = {
  import: pluginOf(importX.rules),
  jsdoc: pluginOf(jsdocRules),
  "jsx-a11y": pluginOf(jsxA11y.rules),
  promise: pluginOf(promise.rules),
  react: pluginOf(reactPlugin.rules, reactHooks.rules),
  sonarjs: pluginOf(sonarjs.rules),
  typescript: pluginOf(typescriptPlugin.rules, {
    "no-unused-vars": unusedVars,
  }),
  unicorn: pluginOf(unicorn.rules),
};

/**
 * A rule that finds nothing: what a rule oxlint has and nothing here runs
 * (oxc's own, those the ESLint plugins dropped) is, so a disable comment
 * that names it, which an export's oxlint needs, reads as it does there
 * rather than as a rule ESLint doesn't know.
 */
const stub: Rule.RuleModule = { create: () => ({}) };

/** `ultracitePlugins`, with a stub (`stub`) for each of `stubs` (`plugin/rule`). */
export const pluginsWith = (
  stubs: readonly string[]
): Record<string, ESLint.Plugin> => {
  const rules = new Map<string, Record<string, Rule.RuleModule>>();
  for (const id of stubs) {
    const slash = id.indexOf("/");
    const name = id.slice(0, slash);
    const stubbed = rules.get(name) ?? {};
    stubbed[id.slice(slash + 1)] = stub;
    rules.set(name, stubbed);
  }
  return Object.fromEntries(
    [...new Set([...Object.keys(ultracitePlugins), ...rules.keys()])].map(
      (name) => [
        name,
        {
          rules: { ...rules.get(name), ...ultracitePlugins[name]?.rules },
        },
      ]
    )
  );
};

/** The config `rules` run with on an App's TypeScript, with `overrides` for some files. */
export const lintConfig = (
  plugins: Record<string, ESLint.Plugin>,
  rules: Linter.RulesRecord,
  overrides: readonly Linter.Config[]
): Linter.Config[] => [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // A disable comment for one of oxlint's own rules, which have no
    // equivalent here, would read as unused: oxlint, where they run, says
    // whether it is.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins,
    // React's version, which eslint-plugin-react would otherwise work out
    // from disk: the kit's.
    settings: { react: { version: "19.0.0" } },
    rules,
  },
  ...overrides,
];
