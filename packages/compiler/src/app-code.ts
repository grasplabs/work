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
 * - its migrations (`migrations/*.ts`, spec 17.2): the schema, values and
 *   the SDK's root module, never server code or the generated modules, so
 *   a transform is built from nothing that reaches a store or a function.
 *   The registration imports them to register them; the host runs them
 *   in an isolate with no env and no network whatever they import;
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
import { appPathSegmentPattern } from "@grasp-os/shared/app-limits";

import { workflowFiles } from "./inputs.ts";
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
export type AppCodeKind =
  | "schema"
  | "server"
  | "migration"
  | "generated"
  | "test";

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
const migrationFile = /^migrations\/[\w.-]+\.ts$/u;
const generatedFile = /^\.grasp\/[\w.-]+\.ts$/u;

/** Where an App's tests are: suites, their helpers and their fixtures. */
export const appTestsFolder = "tests/";

/** Whether `path` is under `tests/`, whatever it is. */
export const isUnderAppTests = (path: string): boolean =>
  path.startsWith(appTestsFolder);

/**
 * Whether `path` is test code: a `.ts` file anywhere under `tests/`, its
 * folders named as any App path's may be (`appPathSegmentPattern`), dots
 * included, so no suite an App can hold is ever passed over.
 */
const isTestFile = (path: string): boolean =>
  isUnderAppTests(path) &&
  path.endsWith(".ts") &&
  !path.endsWith(".d.ts") &&
  path.split("/").every((segment) => appPathSegmentPattern.test(segment));

/** Whether `path` is one of an App's test fixtures: `tests/fixtures/<name>.json`. */
const isTestFixture = (path: string): boolean => {
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === "tests" &&
    parts[1] === "fixtures" &&
    parts[2] !== undefined &&
    parts[2].endsWith(".json") &&
    appPathSegmentPattern.test(parts[2])
  );
};

/**
 * The most test suites an App has: each runs in an isolate of its own
 * when a version is made current, within one deadline for them all.
 */
export const maxAppTestSuites = 20;

/** Whether `path` is one of an App's test suites: `tests/**.test.ts`. */
export const isAppTestSuite = (path: string): boolean =>
  isTestFile(path) && path.endsWith(".test.ts");

/**
 * The files under `tests/` that are none of a suite, a helper (`.ts`) or
 * a fixture (`tests/fixtures/<name>.json`): a build of the tests refuses
 * each, so nothing there is ever silently left out.
 */
export const strayTestFiles = (
  files: Readonly<Record<string, string>>
): string[] =>
  Object.keys(files).filter(
    (path) => isUnderAppTests(path) && !isTestFile(path) && !isTestFixture(path)
  );

/** Why `file`, one of `strayTestFiles`, is refused. */
export const strayTestFileMessage = (file: string): string =>
  `${file} is in tests/, which holds only test suites (*.test.ts), their helpers (*.ts) and fixtures (tests/fixtures/<name>.json).`;

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
  if (migrationFile.test(path)) {
    return "migration";
  }
  if (generatedFile.test(path)) {
    return "generated";
  }
  return isTestFile(path) ? "test" : undefined;
};

/**
 * The App's server code a workflow's types may name: its schema, values,
 * registration and operations, with the host's generated modules, never
 * its migrations or tests. A workflow's `appFunctions<Tree>(env)` is
 * typed by the App's operations (`import type * as notes from
 * "../operations/notes.ts"`), so they join its type check; they never
 * join its build.
 */
export const workflowTypeContext = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => {
      const kind = appCodeKind(path);
      return kind === "schema" || kind === "server" || kind === "generated";
    })
  );

/**
 * The files a workflow build reads: the App's workflows and their tests,
 * and the server code their types may name (`workflowTypeContext`).
 */
export const workflowBuildFiles = (
  files: Readonly<Record<string, string>>
): Record<string, string> => ({
  ...workflowTypeContext(files),
  ...workflowFiles(files),
});

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
 * The files a build of an App's tests reads: everything under `tests/`
 * (so it can refuse what isn't a suite, helper or fixture), and the App's
 * own server code, so a test that imports a handler is told it can't,
 * rather than that the file doesn't exist. Only the tests become modules.
 */
export const appTestFiles = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => {
      const kind = appCodeKind(path);
      return (
        isUnderAppTests(path) || (kind !== undefined && kind !== "generated")
      );
    })
  );

/** The kinds of file each kind's relative imports may reach. */
const reachable: Readonly<Record<AppCodeKind, ReadonlySet<AppCodeKind>>> = {
  schema: new Set(["schema"]),
  server: new Set(["server", "schema", "migration"]),
  migration: new Set(["schema"]),
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
  migration: new Map([["@grasp-os/sdk", kitModuleName("@grasp-os/sdk")]]),
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
    "Server code (app.ts, operations/) imports its own files, schema.ts, values.ts, migrations/, @grasp-os/sdk, #grasp, #grasp/server and #grasp/server-references",
  migration:
    "A migration (migrations/) imports only schema.ts, values.ts and @grasp-os/sdk",
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

/**
 * What only the platform's bootstrap imports (spec 10.7.1): the session
 * client and the frame's runtime. A screen that made its own client would
 * get its own caches and submissions beside the platform's.
 */
const platformOnly: ReadonlySet<string> = new Set([
  "@grasp-os/sdk/client",
  "@grasp-os/sdk/screen-runtime",
]);

/**
 * The modules only the platform's bootstrap imports (spec 10.7.1): the
 * session client a host makes, the host's own SDK and the frame's
 * runtime. No App code imports them, screens, server, tests or
 * workflows, not even for their types: a type names what the module
 * gives, and App code is never given it.
 */
const bootstrapOnly: ReadonlySet<string> = new Set([
  "@grasp-os/sdk/client",
  "@grasp-os/sdk/host",
  "@grasp-os/sdk/screen-runtime",
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
    path.startsWith("migrations/") ||
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
  if (platformOnly.has(specifier)) {
    return `"${specifier}" is the platform's: it makes the session client and mounts it around every screen. Use useClient() and the hooks of @grasp-os/sdk/react.`;
  }
  let reached: string | undefined;
  if (isRelative(specifier)) {
    reached = serverPath(file, specifier);
  } else if (serverSpecifiers.has(specifier)) {
    reached = specifier;
  }
  return reached === undefined
    ? undefined
    : `"${specifier}" is the App's server code, which screens never import: what a screen calls comes from the App's references, never its handlers, schema, migrations or server modules.`;
};

/**
 * Why a type-only import of `specifier` (`import type`, `export type …
 * from`, `typeof import()`) in `file` isn't allowed, or undefined when it
 * is. Types are erased, so they are held only to what the file must
 * never reach: for a screen, the App's server code, its internal
 * references and the platform's modules (`screenImportError`); for any
 * other App code, the bootstrap's modules (`bootstrapOnly`). Everything
 * else a type may name, as the type check reads it.
 */
export const typeImportError = (
  file: string,
  specifier: string | undefined,
  screen: boolean
): string | undefined => {
  if (specifier === undefined) {
    return undefined;
  }
  if (screen) {
    return screenImportError(file, specifier);
  }
  return bootstrapOnly.has(specifier)
    ? `"${specifier}" is the platform's bootstrap, which only the code that makes and mounts the client imports (spec 10.7.1): never an App's server code, tests or workflows, not even for its types.`
    : undefined;
};
