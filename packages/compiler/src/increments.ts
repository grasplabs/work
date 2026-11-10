import { sha256Hex } from "@grasp-os/shared/encoding";

import type { ClassSite } from "./classes.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { buildFiles, declarationFile, sourceCode } from "./inputs.ts";
import {
  bundledPackagesOf,
  packageModulesByName,
  packageModulesFile,
  pageFunctions,
  pageReferences,
} from "./kit.ts";

// What a pages build keeps of each of its files, so the next build of
// files that changed only in part reuses it (spec 19.2, GRA-958): each
// module's transform. Core keeps them in its one cache, as it keeps whole
// builds, served only under core's MAC (core's build-cache.ts), and hands
// them to the next build; the compiler uses one only under the key it works out itself
// from what the record stands for, and checks everything else again.
//
// - A module's transform (oxc's React Compiler, types stripped, imports
//   pointed at flat names) and the classes it writes is a function of its path and source, the
//   App's files it may import, the declarations its types may name, and
//   whether it is a preview's: its key is the hash of all of those, so a
//   change to any is a new key, and the module is compiled again.
// - The type check reads every file each build, in an isolate of its own
//   (checker.ts): tsrs keeps no program between checks, and checks a whole
//   App in about the time a kept check would save. The CSS is built again
//   from every module's candidates, its classes checked again against the
//   kit (classes.ts), and the lint runs over every file: "incremental"
//   never skips a gate.

/** Part of every key: a change to what a record holds or means misses every one. */
export const incrementSchema = "i2";

/** A module's transform, as a build keeps it. */
export interface ModuleRecord {
  path: string;
  code: string;
  /** The App's modules and the kit's it imports, by flat name. */
  app: string[];
  kit: string[];
  /** Its Tailwind class candidates (candidates.ts). */
  candidates: string[];
  /** The App's functions it calls, `api.deals.list` as `deals.list` (index-uses.ts). */
  calls: string[];
  /** The classes it writes where a class goes, which the build checks (classes.ts). */
  classes: ClassSite[];
}

/** What a build is handed of earlier ones, or keeps of its own: records by key. */
export interface Increments {
  modules: Record<string, ModuleRecord>;
}

/**
 * How much of a build was done now and how much reused: counts, as the
 * compiler's isolate can't time its own work (a Worker's clock stands
 * still while it computes). Core times what it can: putting the build
 * together from what it kept, and the compiler's run (pages.ts).
 */
export interface BuildMetrics {
  /** Modules transformed now, and reused. */
  compiled: number;
  reused: number;
}

/** A build, what it kept for the next, and how it came about. */
export interface IncrementalBuild<Build> {
  built: Build;
  fresh: Increments;
  metrics: BuildMetrics;
}

/**
 * What a build is handed of earlier ones, as it came: records by key, each
 * checked where it is used (`moduleRecordOf`).
 */
export interface Handed {
  modules: Readonly<Record<string, unknown>>;
}

/** No records. */
export const noIncrements = (): Increments => ({ modules: {} });

const keyOf = async (parts: readonly unknown[]): Promise<string> =>
  await sha256Hex(JSON.stringify([incrementSchema, ...parts]));

/**
 * The key of the transform of `path` (`source`) in a build whose
 * modules are `known` and whose types may name `typeFiles`.
 */
export const moduleKey = async ({
  path,
  source,
  known,
  typeFiles,
  preview,
}: {
  path: string;
  source: string;
  known: readonly string[];
  typeFiles: readonly string[];
  preview: boolean;
}): Promise<string> =>
  await keyOf([
    "module",
    preview,
    path,
    source,
    known.toSorted(),
    typeFiles.toSorted(),
  ]);

/**
 * What a pages build compiles of `app` (its build files): its front
 * end under `src/` and the references it imports, never a declaration
 * (only types), nor the route tree, which every build makes afresh
 * (route-tree.ts); the paths they may import (`known`); and what their
 * types may name (`typeFiles`), the build's files and its declarations.
 */
export const pageSources = (
  app: Readonly<Record<string, string>>,
  /** The flat names of the App's approved packages' modules (`packageModulesByName`). */
  packages: Iterable<string> = []
): {
  sources: [string, string][];
  known: string[];
  typeFiles: string[];
} => {
  const sources = Object.entries(app)
    .filter(
      ([path]) =>
        sourceCode.isFile(path) ||
        path === pageReferences.path ||
        path === pageFunctions.path
    )
    .filter(([path]) => !declarationFile.test(path));
  const approved = [...packages];
  return {
    sources,
    known: [...sources.map(([path]) => path), ...approved],
    typeFiles: [...Object.keys(app), ...approved],
  };
};

/**
 * The key Ultracite's lint of `path` (`source`) is kept under (`lint`,
 * ultracite.ts): its result reads that file alone. The compiler's
 * version, which every cache key holds, stands for the rules.
 */
export const lintKey = async (path: string, source: string): Promise<string> =>
  await keyOf(["lint", path, source]);

/** Ultracite's lint of one file, as core keeps it. */
export interface LintRecord {
  path: string;
  diagnostics: Diagnostic[];
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === "string");

const isClassSites = (value: unknown): value is ClassSite[] =>
  Array.isArray(value) &&
  value.every(
    (each: unknown) =>
      typeof each === "object" &&
      each !== null &&
      "name" in each &&
      typeof each.name === "string" &&
      "line" in each &&
      typeof each.line === "number" &&
      "column" in each &&
      typeof each.column === "number" &&
      (!("component" in each) ||
        (typeof each.component === "object" &&
          each.component !== null &&
          "name" in each.component &&
          typeof each.component.name === "string" &&
          "module" in each.component &&
          typeof each.component.module === "string"))
  );

/** `value` as a module record of `path`, or nothing when it isn't one. */
export const moduleRecordOf = (
  value: unknown,
  path: string
): ModuleRecord | undefined =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  value.path === path &&
  "code" in value &&
  typeof value.code === "string" &&
  "app" in value &&
  isStrings(value.app) &&
  "kit" in value &&
  isStrings(value.kit) &&
  "candidates" in value &&
  isStrings(value.candidates) &&
  "classes" in value &&
  isClassSites(value.classes)
    ? {
        path,
        code: value.code,
        app: value.app,
        kit: value.kit,
        candidates: value.candidates,
        // One kept before it was recorded calls nothing that's known.
        calls: "calls" in value && isStrings(value.calls) ? value.calls : [],
        classes: value.classes,
      }
    : undefined;

const isDiagnostics = (value: unknown): value is Diagnostic[] =>
  Array.isArray(value) &&
  value.every(
    (each: unknown) =>
      typeof each === "object" &&
      each !== null &&
      "rule" in each &&
      typeof each.rule === "string" &&
      "message" in each &&
      typeof each.message === "string" &&
      "severity" in each &&
      (each.severity === "error" || each.severity === "warning")
  );

/** `value` as a lint record of `path`'s, if it is one. */
export const lintRecordOf = (
  value: unknown,
  path: string
): LintRecord | undefined =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  value.path === path &&
  "diagnostics" in value &&
  isDiagnostics(value.diagnostics)
    ? { path, diagnostics: value.diagnostics }
    : undefined;

/** The keys of what a pages build of `files` may reuse: each module's transform, by its path. */
export const pageIncrementKeys = async (
  files: Readonly<Record<string, string>>,
  preview: boolean
): Promise<{ modules: Record<string, string> }> => {
  const { [packageModulesFile]: bundled, ...given } = files;
  const app = buildFiles(given);
  const { sources, known, typeFiles } = pageSources(
    app,
    packageModulesByName(bundledPackagesOf(bundled)).keys()
  );
  const modules = await Promise.all(
    sources.map(
      async ([path, source]) =>
        [
          path,
          await moduleKey({ path, source, known, typeFiles, preview }),
        ] as const
    )
  );
  return { modules: Object.fromEntries(modules) };
};
