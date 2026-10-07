/**
 * How a package's own package.json maps what is imported to a file, as
 * Node and bundlers read it: `exports` (and `imports` for `#` names) with
 * the target's conditions, else the `browser` field for the browser, else
 * `module` and `main`, then the file with the extensions and index files
 * Node tries. Pure: it reads only the files it is handed. A target that
 * would leave the package (`..`, an absolute path, another package's
 * `node_modules`) resolves to nothing.
 */

/** A package's files, by path within it, and what its package.json says. */
export interface PackageFiles {
  files: ReadonlyMap<string, Uint8Array>;
  manifest: Record<string, unknown>;
}

/** What `exports` or `imports` maps to: a path, conditions, a list or nothing. */
type Target = string | null | Target[] | { [condition: string]: Target };

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
 * One `exports` target with `star` put in its pattern: a path within the
 * package, `null` where the package says it isn't exported, or undefined
 * where no condition matched.
 */
const resolveTarget = (
  target: Target | undefined,
  star: string,
  conditions: readonly string[]
): string | null | undefined => {
  if (target === undefined) {
    return undefined;
  }
  if (target === null) {
    return null;
  }
  if (typeof target === "string") {
    if (!target.startsWith("./")) {
      return null;
    }
    return withinPackage(target.replaceAll("*", star)) ?? null;
  }
  if (Array.isArray(target)) {
    for (const each of target) {
      const resolved = resolveTarget(each, star, conditions);
      if (resolved !== undefined && resolved !== null) {
        return resolved;
      }
    }
    return null;
  }
  for (const [condition, value] of Object.entries(target)) {
    if (condition === "default" || conditions.includes(condition)) {
      const resolved = resolveTarget(value, star, conditions);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
};

/** Whether a value is an `exports` target, as far as its shape goes. */
const isTarget = (value: unknown): value is Target =>
  value === null ||
  typeof value === "string" ||
  Array.isArray(value) ||
  isRecord(value);

/**
 * What a subpath (`.`, `./format`, `#internal`) maps to through a map of
 * them (`exports` or `imports`): exact keys first, then the longest
 * pattern with one `*`.
 */
const throughMap = (
  map: Record<string, unknown>,
  subpath: string,
  conditions: readonly string[]
): string | null | undefined => {
  const exact = map[subpath];
  if (Object.hasOwn(map, subpath) && isTarget(exact)) {
    return resolveTarget(exact, "", conditions);
  }
  let best: { key: string; star: string } | undefined;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star !== -1 && !key.includes("*", star + 1)) {
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= key.length - 1 &&
        (best === undefined || prefix.length > best.key.indexOf("*"))
      ) {
        best = {
          key,
          star: subpath.slice(prefix.length, subpath.length - suffix.length),
        };
      }
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const target = map[best.key];
  return isTarget(target)
    ? resolveTarget(target, best.star, conditions)
    : undefined;
};

/** `exports` as a map of subpaths, however the package wrote it. */
const exportsMap = (exports: unknown): Record<string, unknown> | undefined => {
  if (exports === undefined) {
    return undefined;
  }
  if (
    isRecord(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."))
  ) {
    return exports;
  }
  return { ".": exports };
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
  const map = exportsMap(pkg.manifest.exports);
  if (map !== undefined) {
    const target = throughMap(map, subpath, conditions);
    return typeof target === "string"
      ? resolveFile(pkg, target, browser)
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

/** The file a `#name` import names through the package's `imports`. */
export const resolveImports = (
  pkg: PackageFiles,
  specifier: string,
  conditions: readonly string[]
): string | undefined => {
  const { imports } = pkg.manifest;
  if (!isRecord(imports)) {
    return undefined;
  }
  const target = throughMap(imports, specifier, conditions);
  return typeof target === "string"
    ? resolveFile(pkg, target, conditions.includes("browser"))
    : undefined;
};
