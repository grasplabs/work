/**
 * Type-checks an App too large for one run of tsrs a part at a time, so a
 * check's memory follows the largest page and what it pulls in, not the
 * whole App, and a write checks only what it can change, as
 * `tsc --incremental` does. An App within `checkCharacters` is checked
 * whole, in one run, as ever. tsrs keeps no program between runs and its
 * own `--incremental` builds a program of every file each run, so the
 * parts are ours, on the import graph the compile parses
 * (check-graph.ts); every part is the same tsrs run (type-check.ts) over
 * fewer files.
 *
 * A file's diagnostics depend only on what its check reads of the App's
 * files: its closure, every file its imports reach and every global file
 * (a script, a declaration file, one that declares a module or globals
 * ambiently, or has a triple-slash directive), which every file sees. So
 * a check of any set of files that holds a file's closure says of it
 * exactly what a check of the whole App says. Its key (`checkKeys`) is
 * the hash of that closure's files and of every path its imports could
 * have resolved to but didn't, so adding the file a broken import named
 * changes it too. Core keeps each file's diagnostics under its key and
 * checks only the files whose key it has nothing under (pages.ts), in
 * parts of at most `checkCharacters` (`checkBatches`), each holding the
 * closures of the files it checks.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";

import { joinedPath, pathSpecifier, typeCandidates } from "./app-paths.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { CheckRecord } from "./increments.ts";
import type { TypeCheckRequest } from "./type-check.ts";

/** What a file's check reads of the App's other files (check-graph.ts `referencesOf`). */
export interface FileReferences {
  /** The modules it names, as written. */
  readonly specifiers: readonly string[];
  /** Whether what it declares reaches every file. */
  readonly global: boolean;
}

/**
 * The most characters of App files one run of tsrs reads: an App within
 * it is checked whole, in one run, a larger one a part at a time, each
 * part at most this, but where one file's closure alone is more. tsrs
 * takes about 117 MB to check almost nothing (its 80 MiB shadow stack
 * included) and about 57 MB more for each million characters (measured
 * 2026-11-06 on pages): about 174 MB of WebAssembly memory at this
 * size, below the about 256 MB at which Cloudflare ends an isolate
 * mid-call (build-heap.test.ts). As many as an App may have
 * (`appLimits.totalLength`).
 */
export const checkCharacters = 1_000_000;

/** Whether `request` is too large for one run of tsrs (`checkCharacters`, or `most`). */
export const checksInParts = (
  { files }: TypeCheckRequest,
  most: number = checkCharacters
): boolean => {
  let characters = 0;
  for (const source of Object.values(files)) {
    characters += source.length;
  }
  return characters > most;
};

/** Part of every key: a change to what a key stands for misses every one. */
const checkSchema = "c2";

/**
 * The App paths `paths` (a tsconfig's, as `compilerOptions.paths`) maps
 * each bare name to; undefined when a name holds a `*`, a pattern this
 * reads no edges for.
 */
const mappedPaths = (paths: unknown): Map<string, string[]> | undefined => {
  const entries = Object.entries(
    typeof paths === "object" && paths !== null ? paths : {}
  );
  if (entries.some(([name]) => name.includes("*"))) {
    return undefined;
  }
  return new Map(
    entries
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([name, targets]) => [
        name,
        targets.flatMap((target) =>
          typeof target === "string" ? [joinedPath("", target).path] : []
        ),
      ])
  );
};

/** Each file's key, and the App files its check reads, by path. */
export interface CheckKeys {
  /**
   * Undefined when a file didn't parse, or a `paths` name is a pattern:
   * then nothing is kept or reused.
   */
  readonly keys: Readonly<Record<string, string>> | undefined;
  readonly closures: Readonly<Record<string, readonly string[]>>;
}

/**
 * Each of `request`'s files' key (above) and closure, on `graph`. A file
 * the graph lacks (one that didn't parse) is read as global, so every
 * part holds it, and as importing nothing, which no key can stand for:
 * then there are no keys. With a `paths` pattern, whose edges aren't
 * read, every file's closure is every file, and there are no keys.
 */
export const checkKeys = async (
  { files, options, allowed }: TypeCheckRequest,
  graph: Readonly<Record<string, FileReferences>>
): Promise<CheckKeys> => {
  const paths = Object.keys(files);
  const mapped = mappedPaths(options.paths);
  if (mapped === undefined) {
    return {
      keys: undefined,
      closures: Object.fromEntries(paths.map((path) => [path, paths])),
    };
  }
  const lookups = new Map(
    paths.map((path) => [
      path,
      (graph[path]?.specifiers ?? []).flatMap((specifier) => {
        // TypeScript stays at the root where a path climbs above it.
        const targets = pathSpecifier.test(specifier)
          ? [joinedPath(path, specifier).path]
          : (mapped.get(specifier) ?? []);
        return targets.flatMap(typeCandidates);
      }),
    ])
  );
  const globals = paths.filter((path) => graph[path]?.global ?? true);
  const reads = (path: string): { closure: string[]; probed: Set<string> } => {
    const reached = new Set([path, ...globals]);
    const probed = new Set<string>();
    for (const file of reached) {
      for (const candidate of lookups.get(file) ?? []) {
        probed.add(candidate);
        if (Object.hasOwn(files, candidate)) {
          reached.add(candidate);
        }
      }
    }
    return { closure: [...reached], probed };
  };
  const closures: Record<string, string[]> = {};
  const read = new Map<string, Set<string>>();
  for (const path of paths) {
    const { closure, probed } = reads(path);
    closures[path] = closure;
    read.set(path, new Set([...closure, ...probed]));
  }
  if (paths.some((path) => graph[path] === undefined)) {
    return { keys: undefined, closures };
  }
  const contents = new Map(
    await Promise.all(
      Object.entries(files).map(
        async ([path, source]) => [path, await sha256Hex(source)] as const
      )
    )
  );
  const target = JSON.stringify({ options, allowed });
  const keys = await Promise.all(
    paths.map(
      async (path) =>
        [
          path,
          await sha256Hex(
            JSON.stringify([
              checkSchema,
              target,
              path,
              [...(read.get(path) ?? [])]
                .toSorted()
                .map((each) => [each, contents.get(each) ?? null]),
            ])
          ),
        ] as const
    )
  );
  return { keys: Object.fromEntries(keys), closures };
};

/**
 * The parts `request` is checked in to check its files `due`, each a
 * request of its own: each holds the closures of the files it checks,
 * and at most `most` characters, but where one closure alone is more.
 * First fit, largest closure first: each part takes the largest closure
 * left, then every other that still fits beside it, so the files they
 * share are checked once, and the files they reach need no part of
 * their own.
 */
export const checkBatches = (
  request: TypeCheckRequest,
  closures: Readonly<Record<string, readonly string[]>>,
  due: readonly string[],
  most: number = checkCharacters
): TypeCheckRequest[] => {
  const { files } = request;
  const length = (paths: Iterable<string>): number => {
    let sum = 0;
    for (const path of paths) {
      sum += files[path]?.length ?? 0;
    }
    return sum;
  };
  const closureOf = (path: string): readonly string[] =>
    closures[path] ?? [path];
  const parts: Set<string>[] = [];
  const checked = new Set<string>();
  let left = due.toSorted(
    (a, b) => length(closureOf(b)) - length(closureOf(a)) || (a < b ? -1 : 1)
  );
  while (left.length > 0) {
    const part = new Set<string>();
    let characters = 0;
    for (const path of left.filter((each) => !checked.has(each))) {
      const added = closureOf(path).filter((each) => !part.has(each));
      const more = length(added);
      if (part.size === 0 || characters + more <= most) {
        characters += more;
        for (const each of added) {
          part.add(each);
          checked.add(each);
        }
      }
    }
    parts.push(part);
    left = left.filter((path) => !checked.has(path));
  }
  return parts.map((part) => ({
    ...request,
    files: Object.fromEntries(
      Object.entries(files).filter(([path]) => part.has(path))
    ),
  }));
};

/**
 * Whether a part's check answered a refusal of the check as a whole (a
 * crash, an answer it couldn't read): no verdict on its files, so kept
 * for none.
 */
export const checkStopped = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some(({ rule }) => rule === "check");

/**
 * What a part's check (`diagnostics`) said of each of its files
 * (`paths`): its own diagnostics, and the program's, which every part
 * says alike, as they come of the options and the global files alone.
 */
export const checkRecords = (
  paths: readonly string[],
  diagnostics: readonly Diagnostic[]
): CheckRecord[] => {
  const program = diagnostics.filter(({ file }) => file === undefined);
  const byFile = Map.groupBy(
    diagnostics.filter(({ file }) => file !== undefined),
    ({ file }) => file
  );
  return paths.map((path) => ({
    path,
    diagnostics: byFile.get(path) ?? [],
    program,
  }));
};

/** Two strings in code unit order, whatever the locale. */
const byUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** Diagnostics in order: by file, line, column, rule and message; the program's last. */
const inOrder = (a: Diagnostic, b: Diagnostic): number =>
  (a.file === undefined ? 1 : 0) - (b.file === undefined ? 1 : 0) ||
  byUnits(a.file ?? "", b.file ?? "") ||
  (a.line ?? 0) - (b.line ?? 0) ||
  (a.column ?? 0) - (b.column ?? 0) ||
  byUnits(a.rule, b.rule) ||
  byUnits(a.message, b.message);

/**
 * What a check of the whole App says, from what was said of each of its
 * files (`paths`, `records`): every file's diagnostics and the program's,
 * each once, in order (`inOrder`): parts answer in no order of the
 * App's.
 */
export const checkedDiagnostics = (
  paths: readonly string[],
  records: ReadonlyMap<string, CheckRecord>
): Diagnostic[] => {
  const program = new Map<string, Diagnostic>();
  for (const record of records.values()) {
    for (const diagnostic of record.program) {
      program.set(JSON.stringify(diagnostic), diagnostic);
    }
  }
  return [
    ...paths.flatMap((path) => records.get(path)?.diagnostics ?? []),
    ...program.values(),
  ].toSorted(inOrder);
};
