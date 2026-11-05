/**
 * The rules App code is linted with: the repo's own, Ultracite's oxlint
 * presets as the repo extends them (`core`, `react`, `tanstack` and
 * `vitest`; `shadcn` is the design system's lint, src/lint.ts), at their
 * levels, as the ESLint rules that are each one's equivalent, under
 * oxlint's names (src/ultracite-plugins.ts). The isolate has only
 * JavaScript and WebAssembly, and oxlint is native, so it runs them on
 * ESLint's `Linter`. Worked out once, when the compiler is built, into
 * `#ultracite-rules`: the isolate only reads them.
 *
 * Beyond them, reported as warnings and never fixed (`reportOnly`):
 * sonarjs's rules, as Ultracite's oxlint `js-plugins` preset enables them,
 * which an exported App runs as oxlint's JS plugins. They are the agent's
 * hints to better code, never what keeps a draft from being proposed. Its
 * react-doctor isn't: it loads oxc-parser and lightningcss, native
 * libraries the isolate can't run; nor github's, its own repositories'
 * conventions.
 *
 * Code that passes in Grasp passes the export's oxlint, but for what has
 * no equivalent the isolate can run (`unmapped`, printed by the build):
 * oxc's own rules, which only oxlint has; the rules that need type
 * information, which TypeScript's check stands in for; the few the ESLint
 * plugins no longer have; and those whose ESLint version disagrees with
 * oxlint's (`disagreeing`, src/ultracite-calibration.ts, which an export's
 * oxlint leaves out too).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { Linter } from "eslint";
import type { Rule } from "eslint";
import { builtinRules } from "eslint/use-at-your-own-risk";
import core from "ultracite/oxlint/core";
import jsPlugins from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";
import { z } from "zod";

import { disagreeing, noisy } from "./src/ultracite-calibration.ts";
import {
  lintConfig,
  pluginsWith,
  ultracitePlugins,
} from "./src/ultracite-plugins.ts";

/** The rules and levels App code is linted with, by their IDs in ESLint. */
export interface UltraciteRules {
  rules: Linter.RulesRecord;
  /** sonarjs's rules: reported as warnings, never fixed. */
  reportOnly: Linter.RulesRecord;
  /** The presets' overrides for some files (tests), by glob. */
  overrides: { files: string[]; rules: Linter.RulesRecord }[];
  /**
   * The rules a write fixes (`tidy`): those whose fix oxlint counts as
   * safe, which `oxlint --fix` makes without `--fix-dangerously`.
   */
  fixable: string[];
  /** oxlint's name of each rule whose ID in ESLint isn't it. */
  names: Record<string, string>;
  /**
   * The ID in ESLint of each name oxlint reads in a disable comment that
   * isn't it, without oxlint's `eslint/` prefix, which it reads too.
   */
  aliases: Record<string, string>;
  /** What oxlint has and nothing here runs (`plugin/rule`): stubs, for disable comments. */
  stubs: string[];
  /** The presets' rules left out: no equivalent the isolate runs. */
  unmapped: string[];
}

/** What needs type information: `requiresTypeChecking`, as typescript-eslint marks it. */
const needsTypes = (rule: Rule.RuleModule): boolean => {
  const docs: unknown = rule.meta?.docs;
  return (
    typeof docs === "object" &&
    docs !== null &&
    "requiresTypeChecking" in docs &&
    docs.requiresTypeChecking === true
  );
};

/** ESLint's own rule `name`, which only its unsupported API lists. */
const coreRule = (name: string): Rule.RuleModule | undefined =>
  // oxlint-disable-next-line typescript/no-deprecated -- see above
  builtinRules.get(name);

/** The rule a plugin of `ultracitePlugins` has as `id` (`plugin/rule`). */
const pluginRule = (id: string): Rule.RuleModule | undefined => {
  const slash = id.indexOf("/");
  return ultracitePlugins[id.slice(0, slash)]?.rules?.[id.slice(slash + 1)];
};

/**
 * The rule ESLint runs for oxlint's `name`, and its ID there: the same,
 * but for two kinds of rule.
 * - oxlint's ESLint rules read TypeScript (a type and a value of one name,
 *   overloads) and ESLint's own don't: typescript-eslint's extension of
 *   one, of the same name, stands in for it (`typescript/no-unused-vars`).
 * - oxlint's `node` rules ESLint still has of its own (deprecated, but
 *   kept): eslint-plugin-n, which has them too, loads what the isolate
 *   can't run. Its other two are on CommonJS's `exports`, which App code,
 *   ES modules, doesn't have.
 */
const equivalentOf = (
  name: string
): { id: string; rule: Rule.RuleModule } | undefined => {
  const slash = name.indexOf("/");
  if (slash === -1) {
    const extension = pluginRule(`typescript/${name}`);
    if (extension !== undefined && !needsTypes(extension)) {
      return { id: `typescript/${name}`, rule: extension };
    }
    const rule = coreRule(name);
    return rule === undefined ? undefined : { id: name, rule };
  }
  if (name.startsWith("node/")) {
    const rule = coreRule(name.slice(slash + 1));
    return rule === undefined ? undefined : { id: name.slice(slash + 1), rule };
  }
  const rule = pluginRule(name);
  return rule === undefined ? undefined : { id: name, rule };
};

/**
 * oxlint's own list of its rules (`oxlint --rules`), from the oxlint the
 * repo lints itself with: Vite+'s. It holds what a rule's fix is: whether
 * `oxlint --fix` makes it.
 */
const oxlintRulesSchema = z.array(
  z.object({ scope: z.string(), value: z.string(), fix: z.string() })
);

const oxlintRules = (): z.infer<typeof oxlintRulesSchema> => {
  const fromVitePlus = createRequire(
    createRequire(import.meta.filename).resolve("vite-plus/package.json")
  );
  const manifest = fromVitePlus.resolve("oxlint/package.json");
  const bin = z
    .object({ bin: z.object({ oxlint: z.string() }) })
    .parse(fromVitePlus(manifest)).bin.oxlint;
  return oxlintRulesSchema.parse(
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(path.dirname(manifest), bin), "--rules", "--format=json"],
        { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
      )
    )
  );
};

/**
 * A rule's name as oxlint reads it in a config or a comment: `scope/rule`,
 * a plugin's scope as its config names it (`jsx_a11y` is `jsx-a11y`), and
 * ESLint's own bare.
 */
const oxlintName = ({ scope, value }: { scope: string; value: string }) =>
  scope === "eslint" ? value : `${scope.replaceAll("_", "-")}/${value}`;

/**
 * Whether oxlint counts a fix of this kind as safe: one `oxlint --fix`
 * makes. A dangerous fix (`--fix-dangerously`) can change what code does
 * (`isNaN` to `Number.isNaN`), and a suggestion is only offered; a rule
 * whose fix oxlint hasn't written yet (`pending`) fixes nothing there.
 */
const safeFix = (kind: string): boolean =>
  !kind.includes("dangerous") && /(?:^|_)fix(?:_|$)/u.test(kind);

const isOff = (level: unknown): boolean => {
  const severity: unknown = Array.isArray(level) ? level[0] : level;
  return severity === "off" || severity === 0;
};

/**
 * oxlint's options where a rule's own differ from its ESLint equivalent's
 * and the presets set none: oxlint passes over unused names that start
 * with `_`, as the repo's code relies on.
 */
const oxlintOptions: Readonly<Record<string, unknown[]>> = {
  "no-unused-vars": [
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
};

/** `level` with oxlint's own options (`oxlintOptions`) where it sets none. */
const withOxlintOptions = (name: string, level: unknown): unknown => {
  const options = oxlintOptions[name];
  return options !== undefined && !Array.isArray(level)
    ? [level, ...options]
    : level;
};

/**
 * Fails the build on an option a rule doesn't take: the isolate's ESLint
 * checks none (Workers forbid the code Ajv compiles a schema to), so a
 * preset's option its equivalent doesn't know is caught here, by
 * ESLint's own check in Node, for every rule and override.
 */
const checkOptions = ({
  rules,
  reportOnly,
  overrides,
  stubs,
}: UltraciteRules): void => {
  const plugins = pluginsWith(stubs);
  const linter = new Linter({ configType: "flat", cwd: "/" });
  for (const levels of [
    rules,
    reportOnly,
    ...overrides.map((override) => override.rules),
  ]) {
    linter.verify(
      "export {};\n",
      lintConfig(plugins, levels, []),
      "/app/check.ts"
    );
  }
};

/** `level` as a warning, with its options: what a report-only rule is at. */
const asWarning = (level: unknown): unknown => {
  if (isOff(level)) {
    return level;
  }
  if (!Array.isArray(level)) {
    return "warn";
  }
  const options: unknown[] = level.slice(1);
  return ["warn", ...options];
};

/**
 * The JS plugins of Ultracite's `js-plugins` preset run here: sonarjs (see
 * above).
 */
const jsPluginRun = (name: string): boolean => name.startsWith("sonarjs/");

/** Ultracite's presets as ESLint's rules, and what a write and a comment need of oxlint's. */
export const ultraciteRules = (): UltraciteRules => {
  const unmapped = new Set<string>();
  const names: Record<string, string> = {};
  const fixKinds = new Map(
    oxlintRules().map((rule) => [oxlintName(rule), rule.fix])
  );
  const fixable = new Set<string>();

  /**
   * `levels` as ESLint runs them, less what is off; what has no
   * equivalent goes to `unmapped`. A JS plugin's rule (`jsPluginRun`) is
   * reported as a warning, and never fixed.
   */
  const mapped = (
    levels: Readonly<Record<string, unknown>>
  ): Linter.RulesRecord =>
    Object.fromEntries(
      Object.entries(levels).flatMap(([name, level]) => {
        const found = equivalentOf(name);
        if (
          found === undefined ||
          needsTypes(found.rule) ||
          Object.hasOwn(disagreeing, name) ||
          Object.hasOwn(noisy, name)
        ) {
          if (!isOff(level)) {
            unmapped.add(name);
          }
          return [];
        }
        if (found.id !== name) {
          names[found.id] = name;
        }
        const reported = jsPluginRun(name);
        if (!reported && safeFix(fixKinds.get(name) ?? "none")) {
          fixable.add(found.id);
        }
        const entry = reported
          ? asWarning(level)
          : withOxlintOptions(name, level);
        // SAFETY: an oxlint level is an ESLint one: a severity, and the
        // rule's options as ESLint's rule takes them.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return [[found.id, entry as Linter.RuleEntry]];
      })
    );

  // As the repo's config extends them: a later preset's level wins
  // (`tanstack` turns `sort-keys` off: TanStack's option objects, as App
  // pages' routes, are in the order their types are inferred in).
  const presets = [core, react, tanstack, vitest];
  const rules = mapped(
    Object.fromEntries(
      presets.flatMap((preset) => Object.entries(preset.rules ?? {}))
    )
  );
  const ofJsPlugins = (levels: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(levels).filter(([name]) => jsPluginRun(name))
    );
  const reportOnly = mapped(ofJsPlugins(jsPlugins.rules ?? {}));
  // Only what applies to TypeScript: Astro's pages have their own.
  const overrides = [
    ...presets.flatMap((preset) => preset.overrides ?? []),
    ...(jsPlugins.overrides ?? []).map((override) => ({
      ...override,
      rules: ofJsPlugins(override.rules ?? {}),
    })),
  ]
    .filter(({ files }) => files.some((glob) => glob.includes("ts")))
    .map(({ files, rules: levels }) => ({
      files: [...files],
      rules: mapped(levels ?? {}),
    }))
    .filter(({ rules: levels }) => Object.keys(levels).length > 0);

  // Every name oxlint reads in a comment, as ESLint's ID: the rule's
  // equivalent where there is one, which may be another ID (`names`), or
  // a stub.
  const aliases: Record<string, string> = {};
  const stubs: string[] = [];
  for (const name of fixKinds.keys()) {
    const id = equivalentOf(name)?.id;
    if (id === undefined) {
      const stubId = name.includes("/") ? name : `eslint/${name}`;
      stubs.push(stubId);
      if (stubId !== name) {
        aliases[name] = stubId;
      }
    } else if (id !== name) {
      aliases[name] = id;
    }
  }
  const ultracite: UltraciteRules = {
    rules,
    reportOnly,
    overrides,
    fixable: [...fixable].toSorted(),
    names,
    aliases,
    stubs: stubs.toSorted(),
    unmapped: [...unmapped].toSorted(),
  };
  checkOptions(ultracite);
  return ultracite;
};
