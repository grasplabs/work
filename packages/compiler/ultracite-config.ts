/**
 * How App code is linted and formatted, wherever it is: Ultracite's oxlint
 * presets as the repo extends them (`core`, `react`, `tanstack` and
 * `vitest`; `shadcn` is the design system's lint, src/lint.ts) and its
 * oxfmt config, as Grasp's isolate runs them (src/ultracite.ts, with
 * oxlint and oxfmt compiled to WebAssembly) and as an exported App's own
 * oxlint and oxfmt read them (scripts/package-definition-lib.ts). Worked
 * out once, when the compiler is built, into `#ultracite-config`: the
 * isolate only reads it.
 */
import oxfmt from "ultracite/oxfmt";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

/**
 * Ultracite's oxlint presets App code is held to, by name, in the order
 * the repo's config extends them: a later preset's level wins (`tanstack`
 * turns `sort-keys` off: TanStack's option objects, as App pages' routes,
 * are in the order their types are inferred in). An exported App's
 * oxlint extends the same.
 */
export const ultracitePresets = { core, react, tanstack, vitest } as const;

/**
 * The presets' rules App code isn't held to, in Grasp or an export: they
 * read the App's other files (the module graph oxlint builds from disk),
 * and the isolate lints a file at a time with no file system.
 */
export const leftOut = ["import/no-cycle", "oxc/no-barrel-file"] as const;

type Levels = Readonly<Record<string, unknown>>;

/** An `.oxlintrc.json` with no `extends`, as the isolate's oxlint reads it. */
export interface LintConfig {
  plugins: string[];
  env: Levels;
  rules: Levels;
  overrides: { files: string[]; plugins?: string[]; rules: Levels }[];
}

/** `levels` as one, a later one's over an earlier one's. */
const merged = (levels: (Levels | undefined)[]): Levels =>
  Object.fromEntries(levels.flatMap((each) => Object.entries(each ?? {})));

/**
 * The presets as one config, merged as oxlint merges what a config
 * extends: plugins added, a later level over an earlier one, overrides in
 * order; less `leftOut`, and the presets' `ignorePatterns`, which pick
 * files (Grasp picks what it lints itself: save-builds.ts `lintedFiles`).
 * Only the overrides for TypeScript: Astro's pages have their own.
 */
export const ultraciteLint = (): LintConfig => {
  const presets = Object.values(ultracitePresets);
  return {
    plugins: [...new Set(presets.flatMap((preset) => preset.plugins ?? []))],
    env: merged(presets.map((preset) => preset.env)),
    rules: merged([
      ...presets.map((preset) => preset.rules),
      Object.fromEntries(leftOut.map((rule) => [rule, "off"])),
    ]),
    overrides: presets
      .flatMap((preset) => preset.overrides ?? [])
      .filter(({ files }) => files.some((glob) => glob.includes("ts")))
      .map(({ files, plugins, rules }) => ({
        files: [...files],
        ...(plugins === undefined ? {} : { plugins: [...plugins] }),
        rules: { ...rules },
      })),
  };
};

/**
 * Ultracite's oxfmt config as App code is formatted with, less what has
 * no part in it or needs oxfmt's JavaScript host, which the isolate's
 * oxfmt doesn't have: the files it picks (`ignorePatterns`), package.json
 * and Markdown (`sortPackageJson`, `proseWrap`), Tailwind's class sorter
 * (`sortTailwindcss`, Prettier's plugin), and a template's CSS, GraphQL or
 * HTML (`embeddedLanguageFormatting`), which stays as written.
 */
export const ultraciteFormat = (): Record<string, unknown> => {
  const {
    ignorePatterns: _files,
    sortPackageJson: _packageJson,
    proseWrap: _markdown,
    sortTailwindcss: _tailwind,
    ...format
  } = oxfmt;
  return { ...format, embeddedLanguageFormatting: "off" };
};

/** What `#ultracite-config` holds: both, as the isolate configures oxc with them. */
export interface UltraciteConfig {
  lint: LintConfig;
  format: Record<string, unknown>;
}

export const ultraciteConfig = (): UltraciteConfig => ({
  lint: ultraciteLint(),
  format: ultraciteFormat(),
});
