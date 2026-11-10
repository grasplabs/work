/**
 * An App's server code as spec 8 lays it out, Convex's way, and what each
 * part of it may import. Five kinds of file, each a compilation target of
 * its own:
 *
 * - its schema (`server/schema.ts`) and shared values (`values.ts`): only
 *   the SDK's root module and each other, never a server function or the
 *   App's config, so declaring the schema can't run server code, and the
 *   modules generated from it can't depend on what they are generated
 *   for;
 * - its server (`grasp.config.ts`, `server/**`): its own
 *   server files, the schema and values, the SDK's root module and the
 *   generated modules under `server/_generated/`: no platform module, no
 *   Workers runtime, nothing with authority of its own. Each module under
 *   `server/` (but the schema, `_generated/` and `migrations/`) is found
 *   for its functions: its path is their API (`server/tasks.ts`'s `list`
 *   is `api.tasks.list`);
 * - its migrations (`server/migrations/*.ts`, spec 17.2): the schema,
 *   values and the SDK's root module, never server code or the generated
 *   modules, so a transform is built from nothing that reaches a store or
 *   a function. The registration imports them to register them; the host
 *   runs them in an isolate with no env and no network whatever they
 *   import;
 * - what the host generated for it (`server/_generated/**`, `.grasp/**`),
 *   which no App's version holds: the server constructors import
 *   `@grasp-os/sdk/server` and the schema; the references import nothing
 *   at run time; the entry the host runs (`serverEntryPath`) imports the
 *   registration and every server module;
 * - its tests (`tests/**`): each other, the schema and values, the SDK's
 *   root and testing modules and the public references
 *   (`@server/_generated/api`), so a test reaches the App only as its
 *   callers do, through references the host resolves, never through its
 *   handlers or server constructors. Tests are never part of a release
 *   (`appCodeFiles`): core's test runner builds them on their own
 *   (`appTestFiles`).
 *
 * Pages never reach any of it: `pageImportError` says so, by name,
 * where a page tries.
 */
import { appPathSegmentPattern } from "@grasp-os/shared/app-limits";

import {
  generatedServerFolder,
  hasAppPathSegments,
  hostGeneratedFolder,
  routeTreePath,
} from "./inputs.ts";
import type { CodeFolder } from "./inputs.ts";
import {
  appModuleName,
  kitModuleName,
  packageModuleIn,
  pageFunctions,
  serverRunner,
} from "./kit.ts";

/**
 * The modules an App's server isolate loads: the SDK's root (values,
 * `defineApp`, `resource`, `AppError`), the server constructors the
 * generated `server/_generated/server.ts` calls, and the runtime's runner
 * the host's main module and the generated entry call (`serverRunner`).
 * App code imports only the root (`platformImports`).
 */
export const serverSdkImports = [
  "@grasp-os/sdk",
  "@grasp-os/sdk/server",
  serverRunner,
] as const;

/** The kinds of an App's server code, and its tests. */
export type AppCodeKind =
  | "schema"
  | "server"
  | "migration"
  | "generated"
  | "test";

/**
 * The modules generated for an App, by the specifier its code imports
 * them by: the public references (`api`), the internal ones (`internal`),
 * the server builders (`server`) and the data model's types
 * (`dataModel`). Server code may import them by a relative path too
 * (`./_generated/server`), as Convex's does.
 */
export const generatedModules = {
  "@server/_generated/api": "server/_generated/api.ts",
  "@server/_generated/internal": "server/_generated/internal.ts",
  "@server/_generated/server": "server/_generated/server.ts",
  "@server/_generated/dataModel": "server/_generated/dataModel.ts",
} as const;

/**
 * The entry the host runs an App's server from: its config, schema,
 * server modules and migrations, registered together
 * (`serverEntrySource`).
 */
export const serverEntryPath = ".grasp/app.ts";

/** Where an App's config is: generated from its definition. */
export const configPath = "grasp.config.ts";

/** Where an App's schema is: generated from its definition. */
export const schemaPath = "server/schema.ts";

const schemaFiles: ReadonlySet<string> = new Set([schemaPath, "values.ts"]);

/** The server file at the App's root: its config. */
const rootServerFiles: ReadonlySet<string> = new Set([configPath]);
const generatedFile = /^(?:server\/_generated|\.grasp)\/[\w.-]+\.ts$/u;

/** Where an App's migrations are. */
const migrationsPrefix = "server/migrations/";

/**
 * The App's migrations: each one file, `server/migrations/<name>.ts`,
 * never in a folder, so nothing that only helps a migration is ever
 * registered and run as one.
 */
export const migrationsFolder: CodeFolder = {
  folder: migrationsPrefix,
  isFile: (path) =>
    path.split("/").length === 3 &&
    path.startsWith(migrationsPrefix) &&
    path.endsWith(".ts") &&
    !path.endsWith(".d.ts") &&
    hasAppPathSegments(path),
  holds:
    "the App's migrations: one TypeScript file each (server/migrations/<name>.ts), never in a folder",
};

/**
 * Whether `path` is one of the App's server modules, whose exports are
 * its functions: a `.ts` file anywhere under `server/` but its schema,
 * its generated modules and its migrations, its folders named as any App
 * path's may be (`hasAppPathSegments`), dots included but never leading,
 * so no `.`, `..` or hidden folder is ever server code.
 */
export const isServerModule = (path: string): boolean =>
  path.startsWith("server/") &&
  path !== schemaPath &&
  !path.startsWith(generatedServerFolder) &&
  !path.startsWith(migrationsPrefix) &&
  path.endsWith(".ts") &&
  !path.endsWith(".d.ts") &&
  hasAppPathSegments(path);

/**
 * `server/`: its modules, its migrations and the modules the host
 * generates there, and nothing else.
 */
export const serverFolder: CodeFolder = {
  folder: "server/",
  isFile: (path) =>
    path === schemaPath ||
    isServerModule(path) ||
    migrationsFolder.isFile(path) ||
    generatedFile.test(path),
  holds:
    "the App's server code: TypeScript files (*.ts, not *.d.ts), in folders whose names don't start with a dot, with its migrations in server/migrations/",
};

/** The folders of server code whose builds refuse what else is in them. */
export const serverCodeFolders: readonly CodeFolder[] = [
  serverFolder,
  migrationsFolder,
];

/**
 * The module path of each of `files`' server modules, as their functions'
 * paths begin (`server/admin/users.ts` is `admin/users`), sorted.
 */
const serverModulePaths = (files: Iterable<string>): string[] =>
  [...files]
    .filter((path) => isServerModule(path))
    .map((path) => path.slice("server/".length, -".ts".length))
    .toSorted();

/**
 * The entry the host runs an App's server from (`serverEntryPath`): the
 * App's config and schema, with each of `files`' server modules
 * and migrations (`registerApp`). Generated from the file list alone, so
 * the host has it before anything else is known of the App.
 */
export const serverEntrySource = (files: Iterable<string>): string => {
  const paths = [...files];
  const modules = serverModulePaths(paths);
  const migrations = paths
    .filter((path) => migrationsFolder.isFile(path))
    .toSorted();
  const imports = [
    ...modules.map(
      (module, index) =>
        `import * as m${String(index)} from ${JSON.stringify(`../server/${module}.ts`)};\n`
    ),
    ...migrations.map(
      (path, index) =>
        `import migration${String(index)} from ${JSON.stringify(`../${path}`)};\n`
    ),
  ].join("");
  // Computed keys: a quoted `"__proto__"` key would set the map's
  // prototype, where a computed one is a module the SDK refuses by path.
  const entries = modules
    .map(
      (module, index) => `    [${JSON.stringify(module)}]: m${String(index)},\n`
    )
    .join("");
  return `// Generated by Grasp: the App, registered from its parts.
import { registerApp } from "${serverRunner}";

import config from "../${configPath}";
import schema from "../${schemaPath}";
${imports}
export default registerApp({
  config,
  schema,
  modules: {
${entries}  },
  migrations: [${migrations.map((_path, index) => `migration${String(index)}`).join(", ")}],
});
`;
};

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
  // The release's functions are the pages': no server code reads them.
  if (path === pageFunctions.path) {
    return undefined;
  }
  if (generatedFile.test(path)) {
    return "generated";
  }
  if (migrationsFolder.isFile(path)) {
    return "migration";
  }
  if (rootServerFiles.has(path) || isServerModule(path)) {
    return "server";
  }
  return isTestFile(path) ? "test" : undefined;
};

/** Whether `files` are an App of spec 8's layout: a config and a schema. */
export const isAppLayout = (files: Readonly<Record<string, string>>): boolean =>
  Object.hasOwn(files, configPath) && Object.hasOwn(files, schemaPath);

/**
 * The files a build of an App's server code reads: never its tests, and
 * everything under `server/`, so it can refuse what isn't server code
 * there (`serverCodeFolders`).
 */
export const appCodeFiles = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(([path]) => {
      const kind = appCodeKind(path);
      return (
        (kind !== undefined && kind !== "test") ||
        serverCodeFolders.some(({ folder }) => path.startsWith(folder))
      );
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
  server: new Set(["server", "schema", "migration", "generated"]),
  migration: new Set(["schema"]),
  generated: new Set(["schema", "server", "migration", "generated"]),
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
    // The entry's `registerApp` (`serverEntrySource`).
    [serverRunner, kitModuleName(serverRunner)],
  ]),
  test: new Map([
    ["@grasp-os/sdk", kitModuleName("@grasp-os/sdk")],
    ["@grasp-os/sdk/testing", kitModuleName("@grasp-os/sdk/testing")],
    [
      "@server/_generated/api",
      appModuleName(generatedModules["@server/_generated/api"]),
    ],
  ]),
};

/** What each kind is, for messages. */
const described: Readonly<Record<AppCodeKind, string>> = {
  schema:
    "The schema (server/schema.ts, values.ts) imports only @grasp-os/sdk and each other",
  server:
    "Server code (grasp.config.ts, server/) imports its own files, server/schema.ts, values.ts, server/migrations/, @grasp-os/sdk and the generated modules (@server/_generated/server, api, internal and dataModel)",
  migration:
    "A migration (server/migrations/) imports only server/schema.ts, values.ts and @grasp-os/sdk",
  generated: `Generated code imports only @grasp-os/sdk/server, ${serverRunner}, server/schema.ts, the App's server code and its migrations`,
  test: "Tests (tests/) import each other, server/schema.ts, values.ts, @grasp-os/sdk, @grasp-os/sdk/testing and @server/_generated/api: they reach the App through its references, as its callers do",
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
 * The SDK's entries (`@grasp-os/sdk`): of the platform's own packages,
 * all App code imports besides `@grasp-os/ui`'s modules. Which of them
 * a kind of file may import its own rules say (`platformImports`, the
 * kit's page imports).
 */
export const sdkEntries = [
  "@grasp-os/sdk",
  "@grasp-os/sdk/server",
  "@grasp-os/sdk/react",
  "@grasp-os/sdk/workflow",
  "@grasp-os/sdk/testing",
] as const;

const sdkEntrySet: ReadonlySet<string> = new Set(sdkEntries);

/** The scope of the platform's own packages. */
const platformScope = "@grasp-os/";

/** The scope of `@grasp-os/ui`'s modules, which pages import. */
const uiScope = "@grasp-os/ui/";

/** Whether `specifier` is one of `@grasp-os/ui`'s modules, by plain names alone. */
const isUiModule = (specifier: string): boolean =>
  specifier.startsWith(uiScope) &&
  specifier
    .slice(uiScope.length)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/**
 * Why App code may not import `specifier`, for its values or its types
 * alike, or undefined when it may: an allowlist of the platform's own
 * packages. App code imports the SDK's entries (`sdkEntries`) and
 * `@grasp-os/ui`'s modules, never anything else of the platform: not
 * `@grasp-os/runtime`, which implements the SDK and holds what only the
 * platform calls (the session client a host makes, the frame's runtime,
 * the run host), nor any other path of the SDK. A type names what its
 * module gives, and App code is never given it. A module outside the
 * platform's scope is an npm package, which the rules of each kind of
 * file decide.
 */
export const platformImportError = (specifier: string): string | undefined =>
  !specifier.startsWith(platformScope) ||
  sdkEntrySet.has(specifier) ||
  isUiModule(specifier)
    ? undefined
    : `"${specifier}" is the platform's own, which App code never imports, not even for its types. App code imports ${sdkEntries.join(", ")}, @grasp-os/ui, the npm packages its builder approved and its own files.`;

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
    if (
      target === undefined ||
      targetKind === undefined ||
      // The host's own files (the entry it runs) are never App code's.
      (kind !== "generated" && target.startsWith(hostGeneratedFolder))
    ) {
      return {
        error: `"${specifier}" is not a file of the App's server code.`,
      };
    }
    return reachable[kind].has(targetKind)
      ? { module: appModuleName(target) }
      : { error: `"${specifier}" can't be imported here. ${described[kind]}.` };
  }
  const module = platformImports[kind].get(specifier);
  if (module !== undefined) {
    return { module };
  }
  const platform = platformImportError(specifier);
  if (platform !== undefined) {
    return { error: platform };
  }
  // The npm packages the App's builder approved, bundled for its isolate.
  const approved =
    kind === "generated" ? undefined : packageModuleIn(files, specifier);
  return approved === undefined
    ? {
        error: `"${specifier}" can't be imported here. ${described[kind]}, or an npm package the App's builder approved: ask for one (again, if it was removed) with env.build.resolveDependencies.`,
      }
    : { module: approved };
};

/** The data model's types, which a page imports with `import type` alone. */
const dataModelSpecifier = "@server/_generated/dataModel";

/** The references the host generates, which pages import as `@server/_generated/api`. */
const referencesFile = "server/_generated/api.ts";

/** The release's functions the host generates, as `serverPath` names them. */
const pageFunctionsModule = ".grasp/functions";

/** The imports pages can never make, and why: the App's server. */
const serverSpecifiers: ReadonlySet<string> = new Set([
  "@server/_generated/server",
  "@server/_generated/internal",
  "@server/_generated/dataModel",
  "@grasp-os/sdk/server",
]);

/** A server file a page's relative import would reach, by its path. */
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
  return ["values", "grasp.config"].includes(path) ||
    path.startsWith("server/") ||
    path.startsWith(".grasp/")
    ? path
    : undefined;
};

/**
 * Why a page may not import `specifier`, or undefined when it may: the
 * platform's own modules but the SDK's entries and `@grasp-os/ui`'s
 * (`platformImportError`), or the App's server code: a server
 * constructor, an internal reference, the schema, the registration or an
 * operation. Pages get the App's server only through the references the
 * host extracts from it, never its code.
 */
export const pageImportError = (
  file: string,
  specifier: string | undefined
): string | undefined => {
  if (specifier === undefined) {
    return undefined;
  }
  const platform = platformImportError(specifier);
  if (platform !== undefined) {
    return platform;
  }
  let reached: string | undefined;
  if (isRelative(specifier)) {
    reached = serverPath(file, specifier);
  } else if (serverSpecifiers.has(specifier)) {
    reached = specifier;
  }
  // The release's functions, as data: what the route tree the host
  // generates hands the page runtime (worker.ts `withFunctions`).
  if (reached === pageFunctionsModule && file === routeTreePath) {
    return undefined;
  }
  if (reached === dataModelSpecifier) {
    return `"${specifier}" holds the types of the App's tables alone: import them with import type.`;
  }
  return reached === undefined
    ? undefined
    : `"${specifier}" is the App's server code, which pages never import: what a page calls comes from the App's references, never its handlers, config, schema, migrations or server modules.`;
};

/**
 * Why a type-only import of `specifier` (`import type`, `export type …
 * from`, `typeof import()`) in `file` isn't allowed, or undefined when it
 * is. Types are erased, so they are held only to what the file must
 * never reach: for a page, the App's server code, its internal
 * references and the platform's modules (`pageImportError`); for any
 * other App code, the platform's modules (`platformImportError`).
 * Everything else a type may name, as the type check reads it.
 */
export const typeImportError = (
  file: string,
  specifier: string | undefined,
  page: boolean
): string | undefined => {
  if (specifier === undefined) {
    return undefined;
  }
  if (page) {
    // The data model's types, erased as the page compiles: what a page
    // imports for its types, as Convex's do. The references the host
    // generates type each one as its function's export, erased too.
    const referenced =
      file === referencesFile &&
      isRelative(specifier) &&
      isServerModule(`${serverPath(file, specifier) ?? ""}.ts`);
    return specifier === dataModelSpecifier || referenced
      ? undefined
      : pageImportError(file, specifier);
  }
  return platformImportError(specifier);
};
