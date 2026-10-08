/**
 * How a package's own package.json maps what is imported to a file, as
 * Node and bundlers read it: `exports` (and `imports` for `#` names) with
 * the target's conditions, else the `browser` field for the browser, else
 * `module` and `main`, then the file with the extensions and index files
 * Node tries. Pure: it reads only the files it is handed. `exports` and
 * `imports` follow Node's resolver algorithm (PACKAGE_EXPORTS_RESOLVE,
 * PACKAGE_IMPORTS_RESOLVE, PACKAGE_TARGET_RESOLVE, PATTERN_KEY_COMPARE),
 * its invalid targets included: a target or pattern match with an empty,
 * `.`, `..` or `node_modules` segment resolves to nothing, as does any
 * path that would leave the package.
 */

/** A package's files, by path within it, and what its package.json says. */
export interface PackageFiles {
  files: ReadonlyMap<string, Uint8Array>;
  manifest: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extensions = [".js", ".mjs", ".cjs", ".json"];

/**
 * A path within a package, normalized, or undefined if it would leave it:
 * `./a/../b` is `b`; `../b`, `/b` and anything through `node_modules` are
 * nothing.
 */
export const withinPackage = (path: string): string | undefined => {
  if (path.startsWith("/") || path.includes("\\")) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
    } else if (segment !== "." && segment !== "") {
      segments.push(segment);
    }
  }
  return segments.includes("node_modules") ? undefined : segments.join("/");
};

/**
 * Where an `exports` or `imports` target leads, as Node's resolver
 * (`PACKAGE_TARGET_RESOLVE`) has it: a file of the package, a bare
 * specifier (`imports` only, resolved through the importing package's own
 * dependencies), `null` where the package says it isn't exported or the
 * target isn't a valid one, or undefined where no condition matched.
 */
export type Resolved =
  | { kind: "file"; path: string }
  | { kind: "bare"; specifier: string }
  | null
  | undefined;

/**
 * Node's "Invalid Package Target" and "Invalid Module Specifier": an array
 * skips it for its next fallback.
 */
const invalid = Symbol("invalid");

/**
 * Node's "Invalid Package Configuration" (a condition key that is an
 * array index): nothing resolves, fallbacks included.
 */
const invalidConfiguration = Symbol("invalidConfiguration");

type Outcome = Resolved | typeof invalid | typeof invalidConfiguration;

/** Whether `target` parses as a URL, as Node's `new URL(target)` does. */
const isUrl = (target: string): boolean => {
  try {
    return new URL(target).href !== "";
  } catch {
    return false;
  }
};

/**
 * Whether `path`, split at `/` and `\\`, has a segment Node refuses in a
 * target or a pattern's match: empty, `.`, `..` or `node_modules` (in any
 * case, and percent-encoded).
 */
const hasInvalidSegment = (path: string): boolean =>
  path.split(/[/\\]/u).some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return (
      decoded === "" ||
      decoded === "." ||
      decoded === ".." ||
      decoded.toLowerCase() === "node_modules"
    );
  });

/** A string target: `./…` within the package, or (in `imports`) a bare one. */
const stringTarget = (
  target: string,
  patternMatch: string | null,
  isImports: boolean
): Outcome => {
  if (!target.startsWith("./")) {
    if (
      !isImports ||
      target.startsWith("../") ||
      target.startsWith("/") ||
      isUrl(target)
    ) {
      return invalid;
    }
    return {
      kind: "bare",
      specifier:
        patternMatch === null ? target : target.replaceAll("*", patternMatch),
    };
  }
  if (hasInvalidSegment(target.slice(2))) {
    return invalid;
  }
  if (patternMatch === null) {
    return { kind: "file", path: target.slice(2) };
  }
  if (hasInvalidSegment(patternMatch)) {
    return invalid;
  }
  return { kind: "file", path: target.slice(2).replaceAll("*", patternMatch) };
};

/**
 * An array of fallbacks, as Node resolves one: an invalid target, an
 * unmatched condition and a `null` each go on to the next; the result is
 * the first that resolves, else what the last gave (`null` for an empty
 * array). A `null` alone, outside an array, blocks the export.
 */
const resolveFallbacks = (
  targets: readonly unknown[],
  patternMatch: string | null,
  isImports: boolean,
  conditions: readonly string[]
): Outcome => {
  if (targets.length === 0) {
    return null;
  }
  let last: Outcome;
  for (const each of targets) {
    // oxlint-disable-next-line no-use-before-define -- the two recurse into each other
    const resolved = resolveTarget(each, patternMatch, isImports, conditions);
    if (resolved === invalidConfiguration) {
      return resolved;
    }
    if (resolved !== invalid && resolved !== undefined && resolved !== null) {
      return resolved;
    }
    if (resolved !== undefined) {
      last = resolved;
    }
  }
  return last;
};

/** Node's `PACKAGE_TARGET_RESOLVE`, with invalid targets as `invalid`. */
const resolveTarget = (
  target: unknown,
  patternMatch: string | null,
  isImports: boolean,
  conditions: readonly string[]
): Outcome => {
  if (typeof target === "string") {
    return stringTarget(target, patternMatch, isImports);
  }
  if (target === null) {
    return null;
  }
  if (Array.isArray(target)) {
    return resolveFallbacks(target, patternMatch, isImports, conditions);
  }
  if (!isRecord(target)) {
    return invalid;
  }
  const keys = Object.keys(target);
  if (keys.some((key) => /^\d+$/u.test(key))) {
    return invalidConfiguration;
  }
  for (const condition of keys) {
    if (condition === "default" || conditions.includes(condition)) {
      const resolved = resolveTarget(
        target[condition],
        patternMatch,
        isImports,
        conditions
      );
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
};

/**
 * Node's `PATTERN_KEY_COMPARE`: the key with the longer part before its
 * `*` first; then a key with a `*` before one without; then the longer.
 */
const patternKeyCompare = (keyA: string, keyB: string): number => {
  const baseA = keyA.indexOf("*") + 1;
  const baseB = keyB.indexOf("*") + 1;
  if (baseA > baseB) {
    return -1;
  }
  if (baseB > baseA) {
    return 1;
  }
  if (!keyA.includes("*")) {
    return 1;
  }
  if (!keyB.includes("*")) {
    return -1;
  }
  if (keyA.length > keyB.length) {
    return -1;
  }
  return keyB.length > keyA.length ? 1 : 0;
};

/** What resolved, or `null` for nothing: blocked, unmatched or invalid. */
const resolution = (outcome: Outcome): Exclude<Resolved, undefined> =>
  outcome === invalid ||
  outcome === invalidConfiguration ||
  outcome === undefined
    ? null
    : outcome;

/** Node's `PACKAGE_IMPORTS_EXPORTS_RESOLVE`. */
const throughMap = (
  map: Record<string, unknown>,
  matchKey: string,
  isImports: boolean,
  conditions: readonly string[]
): Outcome => {
  if (Object.hasOwn(map, matchKey) && !matchKey.includes("*")) {
    return resolveTarget(map[matchKey], null, isImports, conditions);
  }
  const expansionKeys = Object.keys(map)
    .filter(
      (key) => key.includes("*") && key.indexOf("*") === key.lastIndexOf("*")
    )
    .toSorted(patternKeyCompare);
  for (const key of expansionKeys) {
    const star = key.indexOf("*");
    const base = key.slice(0, star);
    if (matchKey.startsWith(base) && matchKey !== base) {
      const trailer = key.slice(star + 1);
      if (
        trailer === "" ||
        (matchKey.endsWith(trailer) && matchKey.length >= key.length)
      ) {
        return resolveTarget(
          map[key],
          matchKey.slice(base.length, matchKey.length - trailer.length),
          isImports,
          conditions
        );
      }
    }
  }
  return null;
};

/**
 * Node's `PACKAGE_EXPORTS_RESOLVE` for `subpath` (`.` or `./x`): a file of
 * the package, or `null` for one it doesn't export (or exports wrongly).
 */
const resolveExports = (
  exports: unknown,
  subpath: string,
  conditions: readonly string[]
): Resolved => {
  const keys = isRecord(exports) ? Object.keys(exports) : [];
  const dotted = keys.filter((key) => key.startsWith("."));
  if (dotted.length > 0 && dotted.length !== keys.length) {
    // Both subpaths and conditions at one level: an invalid configuration.
    return null;
  }
  // Sugar: `exports` that isn't a map of subpaths is the main export.
  const map: Record<string, unknown> =
    isRecord(exports) && dotted.length > 0 ? exports : { ".": exports };
  // The main export is `.` only, never a pattern's match.
  const resolved =
    subpath === "." && !Object.hasOwn(map, ".")
      ? null
      : throughMap(map, subpath, false, conditions);
  return resolution(resolved);
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The fields a package.json names its main file by, for a target. */
const mainFields = (browser: boolean): string[] =>
  browser ? ["browser", "module", "main"] : ["module", "main"];

/**
 * The file a directory's own package.json names as its main (packages
 * such as dom-helpers ship one per entry point), within the package.
 */
const directoryMain = (
  { files }: PackageFiles,
  directory: string,
  browser: boolean
): string | null | undefined => {
  const bytes = files.get(
    directory === "" ? "package.json" : `${directory}/package.json`
  );
  if (bytes === undefined || directory === "") {
    return undefined;
  }
  // Read whole or not at all: a package.json that can't be read, or a
  // main field of another shape or out of the package, resolves to
  // nothing (null), never past it to an index file.
  let manifest: unknown;
  try {
    manifest = JSON.parse(utf8.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(manifest)) {
    return null;
  }
  for (const field of mainFields(browser)) {
    const value = manifest[field];
    if (value !== undefined && field !== "browser") {
      const path =
        typeof value === "string"
          ? withinPackage(`${directory}/${value}`)
          : undefined;
      return path ?? null;
    }
    if (typeof value === "string") {
      return withinPackage(`${directory}/${value}`) ?? null;
    }
  }
  return undefined;
};

/**
 * The file a path names, trying Node's extensions, a directory's own
 * package.json, then its index files.
 */
export const resolveFile = (
  pkg: PackageFiles,
  path: string,
  browser = false
): string | undefined => {
  const { files } = pkg;
  const direct = [
    path,
    ...extensions.map((extension) => `${path}${extension}`),
  ];
  const found = direct.find((candidate) => files.has(candidate));
  if (found !== undefined) {
    return found;
  }
  const main = directoryMain(pkg, path, browser);
  if (main === null) {
    return undefined;
  }
  const viaMain =
    main === undefined
      ? undefined
      : [main, ...extensions.map((extension) => `${main}${extension}`)].find(
          (candidate) => files.has(candidate)
        );
  if (viaMain !== undefined) {
    return viaMain;
  }
  return extensions
    .map((extension) =>
      path === "" ? `index${extension}` : `${path}/index${extension}`
    )
    .find((candidate) => files.has(candidate));
};

/**
 * The `browser` field's remaps, for the browser target: a file or bare
 * name to another file, or to nothing (`false`, an empty module).
 */
export const browserRemap = (
  { manifest }: PackageFiles,
  from: string
): string | false | undefined => {
  const { browser } = manifest;
  if (!isRecord(browser)) {
    return undefined;
  }
  for (const key of [from, `./${from}`]) {
    const value = browser[key];
    if (Object.hasOwn(browser, key)) {
      if (value === false) {
        return false;
      }
      if (typeof value === "string") {
        return withinPackage(value) ?? false;
      }
    }
  }
  return undefined;
};

/**
 * The file an `exports` or `imports` target names, if the package has it.
 * Node and bundlers take a target as written, without trying extensions
 * or index files. (The `browser` field's remaps apply to it after, where
 * any resolved file is remapped.)
 */
const targetFile = (
  { files }: PackageFiles,
  path: string
): string | undefined => (files.has(path) ? path : undefined);

/**
 * The file within a package that `subpath` (`.` or `./x`) names for a
 * target: through `exports` when the package has it (anything it doesn't
 * export is nothing), else the main fields and the path itself. Returns
 * the file, or undefined.
 */
export const resolveSubpath = (
  pkg: PackageFiles,
  subpath: string,
  conditions: readonly string[],
  browser: boolean
): string | undefined => {
  const { exports } = pkg.manifest;
  if (exports !== undefined && exports !== null) {
    const resolved = resolveExports(exports, subpath, conditions);
    return resolved?.kind === "file"
      ? targetFile(pkg, resolved.path)
      : undefined;
  }
  if (subpath !== ".") {
    const path = withinPackage(subpath.slice(2));
    return path === undefined ? undefined : resolveFile(pkg, path, browser);
  }
  for (const field of mainFields(browser)) {
    const value = pkg.manifest[field];
    if (typeof value === "string") {
      const path = withinPackage(value);
      const file =
        path === undefined ? undefined : resolveFile(pkg, path, browser);
      if (file !== undefined) {
        return file;
      }
    }
  }
  return resolveFile(pkg, "", browser);
};

/** What a `#name` import leads to. */
export type ImportTarget =
  | { kind: "file"; path: string }
  | { kind: "bare"; specifier: string };

/**
 * What a `#name` import names through the package's `imports` (Node's
 * `PACKAGE_IMPORTS_RESOLVE`): a file of the package, or a bare specifier
 * the caller resolves through the package's own dependencies, with the
 * same refusals as any import. Undefined where nothing matches.
 */
export const resolveImports = (
  pkg: PackageFiles,
  specifier: string,
  conditions: readonly string[]
): ImportTarget | undefined => {
  const { imports } = pkg.manifest;
  if (
    specifier === "#" ||
    specifier.startsWith("#/") ||
    specifier.endsWith("/") ||
    !isRecord(imports)
  ) {
    return undefined;
  }
  const resolved = resolution(throughMap(imports, specifier, true, conditions));
  if (resolved === null) {
    return undefined;
  }
  if (resolved.kind === "bare") {
    return resolved;
  }
  const path = targetFile(pkg, resolved.path);
  return path === undefined ? undefined : { kind: "file", path };
};
