import { sha256Hex } from "@grasp-os/shared/encoding";

import type { Diagnostic } from "./diagnostic.ts";
import {
  buildFiles,
  componentsFolder,
  declarationFile,
  screenFile,
} from "./inputs.ts";
import { screenReferences } from "./kit.ts";
import type { FileDiagnostics } from "./type-check.ts";

// What a screens build keeps of each of its files, so the next build of
// files that changed only in part reuses it (spec 19.2, GRA-958): each
// module's transform, and each file's type check. Core keeps them as it
// keeps whole builds, served only as the build that made them wrote them
// (core's build-cache.ts, module-cache.ts), and hands them to the next
// build; the compiler uses one only under the key it works out itself
// from what the record stands for, and checks everything else again.
//
// - A module's transform (Babel's React Compiler, types stripped, imports
//   pointed at flat names) is a function of its path and source, the
//   App's files it may import, the declarations its types may name, and
//   whether it is a preview's: its key is the hash of all of those, so a
//   change to any is a new key, and the module is compiled again.
// - A file's type check depends on every App file its imports reach, as
//   TypeScript resolved them, and on every declaration file (which may
//   declare globals): its record carries the fingerprint of that closure,
//   and is used only while the closure is the same. A file whose closure
//   changed (a type it imports changed shape) is checked again, even when
//   its transform is reused.
// - A file that declares globals or augments a module (`declare global`,
//   `declare module` outside a declaration file) changes what other files
//   see without being imported: then nothing's check is reused.
// - The CSS is built again from every module's candidates each build, and
//   the lint runs over every file: "incremental" never skips a gate.

/** Part of every key: a change to what a record holds or means misses every one. */
export const incrementSchema = "i1";

/** A module's transform, as a build keeps it. */
export interface ModuleRecord {
  path: string;
  code: string;
  /** The App's modules and the kit's it imports, by flat name. */
  app: string[];
  kit: string[];
  /** Its Tailwind class candidates (candidates.ts). */
  candidates: string[];
}

/** A file's type check, as a build keeps it. */
export interface CheckRecord extends FileDiagnostics {
  path: string;
  /** The fingerprint of the files its check read (`closureFingerprint`). */
  closure: string;
}

/** What a build is handed of earlier ones, or keeps of its own: records by key. */
export interface Increments {
  modules: Record<string, ModuleRecord>;
  checks: Record<string, CheckRecord>;
}

/**
 * How much of a build was done now and how much reused: counts, as the
 * compiler's isolate can't time its own work (a Worker's clock stands
 * still while it computes). Core times what it can: putting the build
 * together from what it kept, and the compiler's run (screens.ts).
 */
export interface BuildMetrics {
  /** Modules transformed now, and reused. */
  compiled: number;
  reused: number;
  /** Files type-checked now, and whose check was reused. */
  checked: number;
  checksReused: number;
}

/** A build, what it kept for the next, and how it came about. */
export interface IncrementalBuild<Build> {
  built: Build;
  fresh: Increments;
  metrics: BuildMetrics;
}

/**
 * What a build is handed of earlier ones, as it came: records by key, each
 * checked where it is used (`moduleRecordOf`, `checkRecordOf`).
 */
export interface Handed {
  modules: Readonly<Record<string, unknown>>;
  checks: Readonly<Record<string, unknown>>;
}

/** No records. */
export const noIncrements = (): Increments => ({ modules: {}, checks: {} });

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
 * What a screens build compiles of `app` (its build files): its screens,
 * components and the references they import, never a declaration (only
 * types); the paths they may import (`known`); and what their types may
 * name (`typeFiles`), the build's files and its declarations.
 */
export const screenSources = (
  app: Readonly<Record<string, string>>
): {
  sources: [string, string][];
  known: string[];
  typeFiles: string[];
} => {
  const sources = Object.entries(app)
    .filter(
      ([path]) =>
        screenFile.test(path) ||
        componentsFolder.isFile(path) ||
        path === screenReferences.path
    )
    .filter(([path]) => !declarationFile.test(path));
  return {
    sources,
    known: sources.map(([path]) => path),
    typeFiles: Object.keys(app),
  };
};

/** The key a check of `path` (`source`) is kept under: its closure is in the record. */
export const checkKey = async (path: string, source: string): Promise<string> =>
  await keyOf(["check", path, source]);

/**
 * The fingerprint of the files `path`'s check reads of the App's: itself,
 * every App file its imports reach, and every declaration file, each by
 * its content.
 */
export const closureFingerprint = async (
  path: string,
  files: Readonly<Record<string, string>>,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
  declarations: readonly string[]
): Promise<string> => {
  const reached = new Set<string>([path, ...declarations]);
  const next = [path];
  for (let file = next.pop(); file !== undefined; file = next.pop()) {
    for (const imported of imports.get(file) ?? []) {
      if (!reached.has(imported)) {
        reached.add(imported);
        next.push(imported);
      }
    }
  }
  return await keyOf([
    "closure",
    [...reached].toSorted().map((each) => [each, files[each] ?? null]),
  ]);
};

/** A global declaration or a module augmentation, outside a declaration file. */
const globalEffect = /\bdeclare\s+(?:global\b|module\s)/u;

/**
 * Whether any of `files` changes what other files see without being
 * imported: then every file's check is done again.
 */
export const hasGlobalEffects = (
  files: Readonly<Record<string, string>>
): boolean =>
  Object.entries(files).some(
    ([path, source]) => !path.endsWith(".d.ts") && globalEffect.test(source)
  );

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === "string");

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
  isStrings(value.candidates)
    ? {
        path,
        code: value.code,
        app: value.app,
        kit: value.kit,
        candidates: value.candidates,
      }
    : undefined;

/** `value` as a check record of `path`, or nothing when it isn't one. */
export const checkRecordOf = (
  value: unknown,
  path: string
): CheckRecord | undefined =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  value.path === path &&
  "closure" in value &&
  typeof value.closure === "string" &&
  "found" in value &&
  isDiagnostics(value.found) &&
  "references" in value &&
  isDiagnostics(value.references)
    ? {
        path,
        closure: value.closure,
        found: value.found,
        references: value.references,
      }
    : undefined;

/**
 * The keys of what a screens build of `files` may reuse: each module's
 * transform, by its path, and each build file's check, by its path.
 */
export const screenIncrementKeys = async (
  files: Readonly<Record<string, string>>,
  preview: boolean
): Promise<{
  modules: Record<string, string>;
  checks: Record<string, string>;
}> => {
  const app = buildFiles({ ...files });
  const { sources, known, typeFiles } = screenSources(app);
  const [modules, checks] = await Promise.all([
    Promise.all(
      sources.map(
        async ([path, source]) =>
          [
            path,
            await moduleKey({ path, source, known, typeFiles, preview }),
          ] as const
      )
    ),
    Promise.all(
      Object.entries(app).map(
        async ([path, source]) => [path, await checkKey(path, source)] as const
      )
    ),
  ]);
  return {
    modules: Object.fromEntries(modules),
    checks: Object.fromEntries(checks),
  };
};
