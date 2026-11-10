/**
 * The kit: what App pages can import. `build.ts` builds it once per
 * release, as ES modules (`KitModules`) and as what the compiler needs to
 * check and rewrite imports and to build CSS (`Kit`).
 *
 * Every module, the kit's and an App's, has a flat name such as `react.js`,
 * `@grasp-os~ui~components~button.js` or `app~src~routes~desk.js`, and imports
 * others by that name. Flat names are bare specifiers, so a browser page can
 * map them to `data:` URLs with an import map, and they resolve as they are
 * between modules loaded into a Worker.
 */
export interface Kit {
  /** The specifiers App code may import, e.g. `@grasp-os/ui/components/button`. */
  imports: string[];
  /** lucide-react's icons by export name, e.g. `InboxIcon`, and the module that has each. */
  icons: Record<string, string>;
  /** The kit's stylesheet, followed by the stylesheets it imports, by import id. */
  stylesheets: Record<string, string>;
  /**
   * Tailwind class candidates in the kit's own sources, by the flat name of
   * the module that holds each source: a build's CSS has the classes of the
   * kit modules its App loads, not of the whole catalog.
   */
  moduleCandidates: Record<string, string[]>;
  /** What each of the kit's modules imports, by flat name. */
  moduleImports: Record<string, string[]>;
  /**
   * The kit's components (`@grasp-os/ui`'s modules), by specifier, each
   * with the variant props its `cva` calls give it and their values: what
   * a page picks instead of restyling one (classes.ts).
   */
  components: Record<string, Record<string, string[]>>;
  /**
   * The theme's own colours, by name (`primary`, `muted-foreground`): the
   * `--color-*` the kit's stylesheet declares beyond Tailwind's palette.
   */
  colors: string[];
  /**
   * What each of the preview kit's modules imports, by flat name: the kit
   * built for a chat's preview (spec 19.2.1), with React's development
   * builds and React Fast Refresh. Its own chunks, so its own graph.
   */
  previewModuleImports: Record<string, string[]>;
}

/** The kit's modules, shared by every App of a release. */
export interface KitModules {
  /** Changes with every change to the kit. */
  version: string;
  /** Module code by flat name. */
  modules: Record<string, string>;
}

/**
 * A record's own entry: never one `Object.prototype` has, such as
 * `toString`, which an App could otherwise name.
 */
export const ownEntry = <T>(
  record: Record<string, T>,
  key: string
): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * Where a release's compiler is among core's static assets, and its files:
 * the compiler's code, what it knows of the kit (`Kit`), the kit's
 * modules (`KitModules`) and the SDK's modules the isolates core runs
 * load (`KitModules` too). The path has the compiler's version
 * in it, so a cache never serves another release's.
 */
export const compilerAssets = {
  directory: (version: string): string => `/_compiler/${version}`,
  source: "compiler.js",
  kit: "kit.json",
  kitModules: "kit-modules.json",
  /** The preview kit's modules (`KitModules`), which only previews load. */
  kitPreviewModules: "kit-preview-modules.json",
  /** The SDK modules a workflow's or an App test's isolate loads (`sdkImports`). */
  workflowSdkModules: "sdk-workflow-modules.json",
  /** The SDK modules an App's server isolate loads (`serverSdkImports`). */
  serverSdkModules: "sdk-server-modules.json",
  /** The package builder's module (src/packages/worker.ts). */
  packageBuilder: "package-builder.js",
  /** Ultracite's lint and format of App code (src/ultracite-worker.ts). */
  ultracite: "ultracite.js",
  /**
   * oxc's WebAssembly (oxc-wasm/): its React transform and parser, which
   * the compiler's isolate builds with, and oxlint and oxfmt, which
   * Ultracite's isolate lints and formats with.
   */
  oxcWasm: "oxc.wasm",
  /** esbuild's WebAssembly, which the package builder runs. */
  esbuildWasm: "esbuild.wasm",
  /** The type checker's module (src/checker.ts). */
  checker: "checker.js",
  /**
   * What the type check reads of the kit (type-check.ts `KitTypes`): the
   * type chunks, the libraries they name, and where each module App code
   * may import resolves among them.
   */
  types: "types.json",
  /** tsrs's WebAssembly, the type checker's (`@tsrs/wasm`). */
  tsrsWasm: "tsrs.wasm",
} as const;

/**
 * The lock a build of the compiler into the assets directory `assets`
 * holds (build-lock.ts): next to the assets, never in them.
 */
export const compilerLock = (assets: string): string =>
  `${assets}.compiler-lock`;

/** The name the compiler's isolate has `Kit` under, as a JSON module. */
export const kitModule = "kit.json";

/** The name the type checker's isolate has `KitTypes` under, as a JSON module. */
export const typesModule = "types.json";

/**
 * The React SDK pages use (spec 10.1, 10.7.1): the platform's session
 * client and the App's queries, mutations and actions through `@server/_generated/api`.
 */
export const pageSdk = "@grasp-os/runtime/react";

/**
 * The SDK's root module: its types, which the generated `@server/_generated/api`
 * references import (`FunctionReference`, `Id`, …), and its native
 * values (`v`), which a page's local form validates with (spec 10.2.4).
 * Nothing else of it: the rest is server code (`pageRootNames`).
 */
export const sdkRoot = "@grasp-os/runtime";

/** What pages may import of the SDK's root module, besides its types. */
export const pageRootNames: ReadonlySet<string> = new Set(["v"]);

/**
 * The references the host generates for an App's server code, which its
 * pages import as `@server/_generated/api` (spec 8), as Convex's pages
 * import theirs: `api`, `pages` and the browser resources, data only.
 * A build has them when the host put them among its files (core does for
 * a version of spec 8's layout).
 */
export const pageReferences = {
  specifier: "@server/_generated/api",
  path: "server/_generated/api.ts",
} as const;

/**
 * The types of an App's tables (`Doc`, `Id`, `TableName`), which its
 * pages import with `import type`, as Convex's pages import theirs, and
 * which every build of them generates from the App's schema
 * (`buildFiles`): types alone, erased as each page compiles, so a page
 * gets no server code from them. The schema and `values.ts` they come
 * from are read by the type check, never compiled.
 */
export const pageDataModel = {
  specifier: "@server/_generated/dataModel",
  path: "server/_generated/dataModel.ts",
  reads: ["server/schema.ts", "values.ts"],
} as const;

/**
 * What renders a page in its frame. App code doesn't import it, but every
 * page needs it (`PageClosure.kitModules`).
 */
export const pageRuntime = "@grasp-os/runtime/page-runtime";

/**
 * What runs a chat's preview in its frame in place of `pageRuntime`:
 * the page runtime with React Fast Refresh (spec 22.7). Only the
 * preview kit has it.
 */
export const previewRuntime = "@grasp-os/runtime/preview-runtime";

/**
 * Where a preview build's modules register their components with React
 * Fast Refresh: only the preview kit has it, and App code never imports it
 * itself (the compiler adds the import).
 */
export const previewRefresh = "@grasp-os/runtime/preview-refresh";

/**
 * TanStack Router, which an App's pages route with: its file routes'
 * `createFileRoute`, `Link`, `useNavigate` and the rest. The page
 * runtime creates the router from the route tree (route-tree.ts).
 */
export const routerSpecifier = "@tanstack/react-router";

/** The kit's stylesheet, by the id its content is filed under in `stylesheets`. */
export const kitStylesheet = "@grasp-os/ui/styles.css";

/** The flat name of the kit module a specifier names, e.g. `react/jsx-runtime`. */
export const kitModuleName = (specifier: string): string =>
  `${specifier.replaceAll("/", "~")}.js`;

const typescriptExtension = /\.tsx?$/u;

/** The prefix of every approved package's module (`packageModuleName`). */
export const packageModulePrefix = "pkg~";

/**
 * The flat name an approved package's entry is loaded under, e.g.
 * `pkg~<graph>~date-fns~format.js`: a namespace of its own, so no package
 * module is ever an SDK, runner or workflow module (GRA-665).
 */
export const packageModuleName = (entry: string, graphHash?: string): string =>
  // `~` as `@` first, so `~` stands only for `/`: no two entries (`a~b` and
  // `a/b`, say) share a name, in only the characters a release artifact's
  // path takes. An entry (`packageEntrySchema`) has `@` only as its first
  // character, a scope's, and never starts with `~`, so an `@` after the
  // first is always a `~`. It carries its graph's hash, so what serves or
  // loads a build can tell whose approval it stands on (`graphsOfModules`);
  // without one it is the suffix every graph's module of `entry` ends in.
  `${packageModulePrefix}${graphHash === undefined ? "" : `${graphHash}~`}${entry.replaceAll("~", "@").replaceAll("/", "~")}.js`;

const appPackageModule = /^pkg~(?<graph>[0-9a-f]{64})~/u;

/** The graphs an App build's modules (`names`) bundle approved packages of. */
export const graphsOfModules = (names: Iterable<string>): string[] => [
  ...new Set(
    [...names].flatMap((name) => {
      const graph = appPackageModule.exec(name)?.groups?.graph;
      return graph === undefined ? [] : [graph];
    })
  ),
];

/**
 * Where core hands an App's page or server build its approved packages,
 * each entry already bundled for where it runs (packages/build.ts in
 * core), as JSON `{ graphHash, modules: { [entry]: code } }`: never an
 * App file, and part of what the build is cached by, as every file is.
 */
export const packageModulesFile = ".grasp/package-modules.json";

/**
 * The modules of React and React DOM the kit provides, by specifier: a
 * page's packages import these from the kit, never a copy of their own.
 */
export const kitPeers = [
  "react",
  "react/jsx-runtime",
  "react/compiler-runtime",
  "react-dom",
  "react-dom/client",
];

/** An App build's approved packages, read from `packageModulesFile`. */
export interface BundledPackages {
  graphHash: string;
  /** Each entry's module code. */
  modules: Record<string, string>;
}

/**
 * The approved packages `text` (`packageModulesFile`) hands a build;
 * none for a build without, or for text that isn't in its shape.
 */
export const bundledPackagesOf = (
  text: string | undefined
): BundledPackages | undefined => {
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const graphHash: unknown = Reflect.get(value, "graphHash");
  const modules: unknown = Reflect.get(value, "modules");
  if (
    typeof graphHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(graphHash) ||
    typeof modules !== "object" ||
    modules === null
  ) {
    return undefined;
  }
  const entries = Object.entries(modules).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return { graphHash, modules: Object.fromEntries(entries) };
};

/** The entries `text` (`packageModulesFile`) hands a build, by name. */
export const packageEntriesOf = (text: string | undefined): string[] =>
  Object.keys(bundledPackagesOf(text)?.modules ?? {});

/** Each bundled entry, by the flat name its module is loaded under. */
export const packageModulesByName = (
  bundled: BundledPackages | undefined
): Map<string, string> =>
  new Map(
    Object.entries(bundled?.modules ?? {}).map(([entry, code]) => [
      packageModuleName(entry, bundled?.graphHash),
      code,
    ])
  );

/** The flat name of `specifier`'s module among `known`, if it is an approved package's. */
export const packageModuleIn = (
  known: ReadonlySet<string>,
  specifier: string
): string | undefined => {
  const suffix = packageModuleName(specifier).slice(packageModulePrefix.length);
  return [...known].find(
    (name) =>
      appPackageModule.test(name) &&
      name.slice(packageModulePrefix.length + 65) === suffix
  );
};

/** The flat name of an App file's module, e.g. `app~src~routes~desk.js`. */
export const appModuleName = (path: string): string =>
  `app~${path.replace(typescriptExtension, "").replaceAll("/", "~")}.js`;
