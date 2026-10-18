/**
 * The kit: what App screens can import. `build.ts` builds it once per
 * release, as ES modules (`KitModules`) and as what the compiler needs to
 * check and rewrite imports and to build CSS (`Kit`).
 *
 * Every module, the kit's and an App's, has a flat name such as `react.js`,
 * `@grasp-os~ui~components~button.js` or `app~screens~desk.js`, and imports
 * others by that name. Flat names are bare specifiers, so a browser page can
 * map them to `data:` URLs with an import map, and they resolve as they are
 * between modules loaded into a Worker.
 */
import type { Linter } from "eslint/universal";

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
   * What the type check reads, by absolute path: TypeScript's libraries
   * and the kit's packages with their declarations, as `/node_modules/…`.
   */
  types: Record<string, string>;
  /**
   * The kit as the design-system lint reads it from disk, by path
   * relative to the App: `components.json`, the theme and the kit's
   * component sources.
   */
  lintProject: Record<string, string>;
  /** The design-system lint's rules (@shadcn/lint's), as the repo lints with them. */
  lintRules: Linter.RulesRecord;
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
 * modules (`KitModules`) and the workflow SDK's modules, which App
 * workflows import (`KitModules` too). The path has the compiler's version
 * in it, so a cache never serves another release's.
 */
export const compilerAssets = {
  directory: (version: string): string => `/_compiler/${version}`,
  source: "compiler.js",
  kit: "kit.json",
  kitModules: "kit-modules.json",
  /** The SDK modules an App's workflows import (`sdkImports`). */
  workflowSdkModules: "sdk-workflow-modules.json",
  /** The SDK modules an App's server isolate loads (`serverSdkImports`). */
  serverSdkModules: "sdk-server-modules.json",
  /** The package builder's module (src/packages/worker.ts). */
  packageBuilder: "package-builder.js",
  /** esbuild's WebAssembly, which the package builder runs. */
  esbuildWasm: "esbuild.wasm",
} as const;

/**
 * The lock a build of the compiler into the assets directory `assets`
 * holds (build-lock.ts): next to the assets, never in them.
 */
export const compilerLock = (assets: string): string =>
  `${assets}.compiler-lock`;

/** The name the compiler's isolate has `Kit` under, as a JSON module. */
export const kitModule = "kit.json";

/**
 * What screens import to reach their App's server: the legacy hooks
 * (`callServer`, `useLive`, string `useWorkflow`), which GRA-343 removes.
 */
export const screenHooks = "@grasp-os/sdk/screen";

/**
 * The React SDK screens use (spec 10.1, 10.7.1): the platform's session
 * client and the App's queries, mutations and actions through `#grasp`.
 */
export const screenSdk = "@grasp-os/sdk/react";

/**
 * The SDK's root module: its types, which the generated `#grasp`
 * references import (`OperationReference`, `Id`, …), and its native
 * values (`v`), which a screen's local form validates with (spec 10.2.4).
 * Nothing else of it: the rest is server code (`screenRootNames`).
 */
export const sdkRoot = "@grasp-os/sdk";

/** What screens may import of the SDK's root module, besides its types. */
export const screenRootNames: ReadonlySet<string> = new Set(["v"]);

/**
 * The references the host generates for an App's server code, which its
 * screens import as `#grasp` (spec 8): `api`, `screens` and the browser
 * resources, data only. A build has them when the host put them among
 * its files (core does for a version of spec 8's layout).
 */
export const screenReferences = {
  specifier: "#grasp",
  path: ".grasp/references.ts",
} as const;

/**
 * What renders a screen in its frame. App code doesn't import it, but every
 * screen needs it (`ScreenClosure.kitModules`).
 */
export const screenRuntime = "@grasp-os/sdk/screen-runtime";

/** The kit's stylesheet, by the id its content is filed under in `stylesheets`. */
export const kitStylesheet = "@grasp-os/ui/styles.css";

/** The flat name of the kit module a specifier names, e.g. `react/jsx-runtime`. */
export const kitModuleName = (specifier: string): string =>
  `${specifier.replaceAll("/", "~")}.js`;

const typescriptExtension = /\.tsx?$/u;

/**
 * The flat name an approved package's entry is loaded under in a JSON
 * workflow's compute isolate, e.g. `pkg~date-fns~format.js`: a namespace
 * of its own, so no package module is ever an SDK, runner or workflow
 * module (GRA-665).
 */
export const packageModuleName = (entry: string): string =>
  `pkg~${entry.replaceAll("/", "~")}.js`;

/**
 * Where core names, among a compute build's files, the approved package
 * entries its modules may import (a JSON list of their names): never a
 * file a workflow publishes (only `code/` is), and part of what the build
 * is cached by, as every file is.
 */
export const computePackagesFile = ".grasp/packages.json";

/** The flat name of an App file's module, e.g. `app~screens~desk.js`. */
export const appModuleName = (path: string): string =>
  `app~${path.replace(typescriptExtension, "").replaceAll("/", "~")}.js`;
