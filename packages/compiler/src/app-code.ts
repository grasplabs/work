/**
 * An App's server code as spec 8 lays it out, and what each part of it may
 * import. Four kinds of file, each a compilation target of its own:
 *
 * - its schema (`schema.ts`) and shared values (`values.ts`): only the
 *   SDK's root module and each other, never an operation or the App's
 *   registration, so declaring the schema can't run server code, and the
 *   modules generated from it can't depend on what they are generated for;
 * - its server (`app.ts`, `operations/**`): its own server files, the
 *   schema and values, the SDK's root module and the generated `#grasp`
 *   modules: no platform module, no Workers runtime, nothing with
 *   authority of its own;
 * - what the host generated for it (`.grasp/**`), which no App's version
 *   holds: the server constructors import `@grasp-os/sdk/server` and the
 *   schema; the references import nothing at run time;
 * - its tests (`tests/**`): each other, the schema and values, the SDK's
 *   root and testing modules and the public `#grasp` references, so a
 *   test reaches the App only as its callers do, through references the
 *   host resolves, never through its handlers or server constructors.
 *   Tests are never part of a release (`appCodeFiles`): core's test
 *   runner builds them on their own (`appTestFiles`).
 *
 * Screens never reach any of it: `screenImportError` says so, by name,
 * where a screen tries.
 */
import { kitModuleName, appModuleName } from "./kit.ts";

/**
 * The SDK modules an App's server isolate loads: the root (values, `app`,
 * `resource`, `AppError`), the server constructors the generated
 * `#grasp/server` calls, and the runner the host's main module calls.
 * App code imports only the root (`platformImports`).
 */
export const serverSdkImports = [
  "@grasp-os/sdk",
  "@grasp-os/sdk/server",
  "@grasp-os/sdk/runner",
] as const;

/** The kinds of an App's server code, and its tests. */
export type AppCodeKind = "schema" | "server" | "generated" | "test";

/** Where the host's generated modules are. */
export const generatedFolder = ".grasp/";

/** The modules generated for an App, by the alias its code imports them by. */
export const generatedModules = {
  "#grasp/server": ".grasp/server.ts",
  "#grasp/server-references": ".grasp/server-references.ts",
  "#grasp": ".grasp/references.ts",
} as const;

const schemaFiles: ReadonlySet<string> = new Set(["schema.ts", "values.ts"]);
const operationFile = /^operations\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;
const generatedFile = /^\.grasp\/[\w.-]+\.ts$/u;
const testFile = /^tests\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/**
 * The most test suites an App has: each runs in an isolate of its own
 * when a version is made current, within one deadline for them all.
 */
export const maxAppTestSuites = 20;

/** Whether `path` is one of an App's test suites: `tests/**.test.ts`. */
export const isAppTestSuite = (path: string): boolean =>
  testFile.test(path) && path.endsWith(".test.ts");

/** The kind of `path`'s code, or undefined for a file that isn't server code. */
export const appCodeKind = (path: string): AppCodeKind | undefined => {
  if (path.endsWith(".d.ts")) {
    return undefined;
  }
  if (schemaFiles.has(path)) {
    return "schema";
  }
  if (path === "app.ts" || operationFile.test(path)) {
    return "server";
  }
  if (generatedFile.test(path)) {
    return "generated";
  }
  return testFile.test(path) ? "test" : undefined;
};

/** Whether `files` are an App of spec 8's layout: a registration and a schema. */
export const isAppLayout = (files: Readonly<Record<string, string>>): boolean =>
  Object.hasOwn(files, "app.ts") && Object.hasOwn(files, "schema.ts");

/** The files a build of an App's server code reads: never its tests. */
export const appCodeFiles = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => {
      const kind = appCodeKind(path);
      return kind !== undefined && kind !== "test";
    })
  );

/**
 * The files a build of an App's tests reads: its tests, and the App's own
 * server code, so a test that imports a handler is told it can't, rather
 * than that the file doesn't exist. Only the tests become modules.
 */
export const appTestFiles = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => {
      const kind = appCodeKind(path);
      return kind !== undefined && kind !== "generated";
    })
  );

/** The kinds of file each kind's relative imports may reach. */
const reachable: Readonly<Record<AppCodeKind, ReadonlySet<AppCodeKind>>> = {
  schema: new Set(["schema"]),
  server: new Set(["server", "schema"]),
  generated: new Set(["schema"]),
  test: new Set(["test", "schema"]),
};

/** The modules each kind may import besides files, and their flat names. */
const platformImports: Readonly<
  Record<AppCodeKind, ReadonlyMap<string, string>>
> = {
  schema: new Map([["@grasp-os/sdk", kitModuleName("@grasp-os/sdk")]]),
  server: new Map([
    ["@grasp-os/sdk", kitModuleName("@grasp-os/sdk")],
    ...Object.entries(generatedModules).map(
      ([alias, path]) => [alias, appModuleName(path)] as const
    ),
  ]),
  generated: new Map([
    ["@grasp-os/sdk/server", kitModuleName("@grasp-os/sdk/server")],
  ]),
  test: new Map([
    ["@grasp-os/sdk", kitModuleName("@grasp-os/sdk")],
    ["@grasp-os/sdk/testing", kitModuleName("@grasp-os/sdk/testing")],
    ["#grasp", appModuleName(generatedModules["#grasp"])],
  ]),
};

/** What each kind is, for messages. */
const described: Readonly<Record<AppCodeKind, string>> = {
  schema:
    "The schema (schema.ts, values.ts) imports only @grasp-os/sdk and each other",
  server:
    "Server code (app.ts, operations/) imports its own files, schema.ts, values.ts, @grasp-os/sdk, #grasp, #grasp/server and #grasp/server-references",
  generated: "Generated code imports only @grasp-os/sdk/server and schema.ts",
  test: "Tests (tests/) import each other, schema.ts, values.ts, @grasp-os/sdk, @grasp-os/sdk/testing and #grasp: they reach the App through its references, as its callers do",
};

const javascriptExtension = /\.js$/u;
const importSuffixes = ["", ".ts", "/index.ts"];

/** The file a relative import names among `files`, if there is one. */
const resolveRelative = (
  importer: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined => {
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.replace(javascriptExtension, ".ts").split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) {
        return undefined;
      }
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  return importSuffixes
    .map((suffix) => `${path}${suffix}`)
    .find((candidate) => files.has(candidate));
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/**
 * The flat module name `specifier`, imported by `file`, loads, or why it
 * can't be imported there.
 */
export const appCodeImport = (
  file: string,
  specifier: string | undefined,
  files: ReadonlySet<string>
): { module: string } | { error: string } => {
  const kind = appCodeKind(file);
  if (kind === undefined) {
    return { error: `${file} isn't server code.` };
  }
  if (specifier === undefined) {
    return { error: "import() must name a module in quotes." };
  }
  if (isRelative(specifier)) {
    const target = resolveRelative(file, specifier, files);
    const targetKind = target === undefined ? undefined : appCodeKind(target);
    if (target === undefined || targetKind === undefined) {
      return {
        error: `"${specifier}" is not a file of the App's server code.`,
      };
    }
    return reachable[kind].has(targetKind)
      ? { module: appModuleName(target) }
      : { error: `"${specifier}" can't be imported here. ${described[kind]}.` };
  }
  const module = platformImports[kind].get(specifier);
  return module === undefined
    ? { error: `"${specifier}" can't be imported here. ${described[kind]}.` }
    : { module };
};

/** The imports screens can never make, and why: the App's server. */
const serverSpecifiers: ReadonlySet<string> = new Set([
  "#grasp/server",
  "#grasp/server-references",
  "@grasp-os/sdk/server",
  "@grasp-os/sdk/host",
  "@grasp-os/sdk/runner",
  "@grasp-os/sdk/database",
]);

/** A server file a screen's relative import would reach, by its path. */
const serverPath = (
  importer: string,
  specifier: string
): string | undefined => {
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/").replace(/\.tsx?$/u, "");
  return ["schema", "values", "app"].includes(path) ||
    path.startsWith("operations/") ||
    path.startsWith(".grasp/")
    ? path
    : undefined;
};

/**
 * Why a screen's import of `specifier` reaches the App's server code, or
 * undefined when it doesn't: a server constructor, an internal reference,
 * a platform-only module, the schema, the registration or an operation.
 * Screens get the App's server only through the references the host
 * extracts from it, never its code.
 */
export const screenImportError = (
  file: string,
  specifier: string | undefined
): string | undefined => {
  if (specifier === undefined) {
    return undefined;
  }
  let reached: string | undefined;
  if (isRelative(specifier)) {
    reached = serverPath(file, specifier);
  } else if (serverSpecifiers.has(specifier)) {
    reached = specifier;
  }
  return reached === undefined
    ? undefined
    : `"${specifier}" is the App's server code, which screens never import: what a screen calls comes from the App's references, never its handlers, schema or server modules.`;
};
