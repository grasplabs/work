/**
 * Bundles an App's approved packages for one target with esbuild-wasm,
 * in the package builder's isolate: no network, no file system, no
 * package-supplied plugins or scripts. Every import is resolved here, by
 * Grasp's own plugin, from the unpacked tarballs of the lock and the
 * lock's edges alone:
 *
 * - A package imports only what it depends on (or a peer the lock
 *   resolved), at the exact version the lock names, never a package it
 *   happens to share a graph with.
 * - Paths stay inside their package: `..` out of it, absolute paths and
 *   another package's `node_modules` resolve to nothing.
 * - Node.js's built-ins (`fs`, `node:crypto`, …) are refused on every
 *   target: neither the browser nor a Worker has them.
 * - React and React DOM are the platform's, imported by the specifiers the
 *   kit provides, in the browser only; any other of their entry points,
 *   and either on the server, is refused.
 * - Remote scripts and stylesheets (`https:`, `//`, a URL with
 *   credentials) are refused; an import whose path is computed at run
 *   time can't be resolved and is refused. Literal dynamic imports are
 *   bundled into the artifact, so nothing is fetched at run time.
 * - Files are bundled by kind: code, JSON and CSS, and static assets
 *   (images, fonts) as files of the artifact under hashed names, which
 *   resolve only within it. SVGs that could script, HTML and anything else
 *   are refused.
 */
import type { DependencyTarget } from "@grasp-os/shared/dependencies";
import { entryPackage } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import { build } from "esbuild-wasm/esm/browser.js";
import type {
  Loader,
  OnLoadArgs,
  OnLoadResult,
  OnResolveArgs,
  OnResolveResult,
  Plugin,
} from "esbuild-wasm/esm/browser.js";

import {
  browserRemap,
  resolveFile,
  resolveImports,
  resolveSubpath,
  withinPackage,
} from "./exports.ts";
import type { PackageFiles } from "./exports.ts";
import {
  inertDataUrl,
  remoteInCss,
  runtimeLoadMarkers,
  runtimeLoadsInJs,
  unbundledInCss,
} from "./inert.ts";
import { platformModules, platformPeers } from "./platform.ts";
import { svgRefusal } from "./svg.ts";

/** Node.js's built-in modules: never available to an App's packages. */
const nodeBuiltins = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Code esbuild compiles, by extension. */
const codeLoaders: Readonly<Record<string, Loader>> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".css": "css",
};

/** Static assets an artifact may carry, by extension, with their type. */
export const assetTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
};

/**
 * Whether the builder keeps a file of a package for bundling: code, CSS,
 * assets, and every file a build would refuse to carry (HTML, WASM, …),
 * so that an import of one is refused by name rather than not found.
 */
export const isBuildable = (path: string): boolean =>
  !path.endsWith(".d.ts") &&
  !path.endsWith(".map") &&
  !path.endsWith(".md") &&
  !path.endsWith(".ts");

/**
 * Every path, as esbuild filters take it: a Go regular expression, which
 * has no `u` flag (esbuild refuses one).
 */
// oxlint-disable-next-line require-unicode-regexp
const anything = /.*/;

/** A URL rather than a path: anything with a scheme, or protocol-relative. */
const remote = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** An entry's own extension, which its module's name doesn't repeat. */
const entryExtension = /\.(?:css|js|mjs|cjs)$/u;

/** The name of a module of the artifact, from the entry it is: `date-fns~format`. */
export const entryModuleName = (entry: string): string =>
  entry.replace(entryExtension, "").replaceAll("/", "~");

/** Where a module of a package is, as the plugin names it. */
interface Located {
  key: string;
  file: string;
}

const isLocated = (value: unknown): value is Located =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  "file" in value &&
  typeof value.key === "string" &&
  typeof value.file === "string";

/** What one build is given. */
export interface BundleInput {
  lock: GraspLock;
  target: DependencyTarget;
  /** Each package's buildable files and package.json, by `name@version`. */
  packages: ReadonlyMap<string, PackageFiles>;
}

/** What one build made, or why it couldn't. */
export type Bundled =
  | {
      ok: true;
      files: Map<string, Uint8Array>;
      /** Each entry's module and stylesheet, and the file it resolved to. */
      entries: Record<
        string,
        { module: string | null; css: string | null; resolved: string }
      >;
      /** The platform's modules the artifact imports. */
      imports: string[];
    }
  | { ok: false; refusals: string[] };

const decoder = new TextDecoder();

const refuse = (text: string): OnResolveResult => ({ errors: [{ text }] });

const located = (key: string, file: string): OnResolveResult => ({
  path: `${key}/${file}`,
  namespace: "pkg",
  pluginData: { key, file },
});

/** Who imports, in a refusal's words. */
const importer = (from: Located | undefined): string => from?.key ?? "the App";

/** A URL in place of a path: refused, but for images and fonts inline. */
const urlImport = (
  path: string,
  from: Located | undefined,
  kind: string
): OnResolveResult => {
  if (path.startsWith("data:")) {
    return inertDataUrl.test(path)
      ? { path, external: true }
      : refuse(
          `${importer(from)} embeds a data URL that isn't an image or a font`
        );
  }
  const what =
    kind === "import-statement" || kind === "dynamic-import"
      ? "script"
      : "file";
  return refuse(
    `${importer(from)} imports a remote ${what}, which an artifact never loads`
  );
};

const pluginName = "grasp-packages";

/** Most refusals one build reports (build.ts caps them too). */
const maxRefusals = 50;

/** Resolves and loads every module of one build. */
class Resolver {
  readonly #lock: GraspLock;
  readonly #target: DependencyTarget;
  readonly #packages: ReadonlyMap<string, PackageFiles>;
  readonly #conditions: readonly string[];
  readonly #browser: boolean;
  /** Each entry, by the file of its package it resolved to. */
  readonly entries = new Map<string, string>();
  /** The platform's modules the build imports. */
  readonly imports = new Set<string>();

  constructor({ lock, target, packages }: BundleInput) {
    this.#lock = lock;
    this.#target = target;
    this.#packages = packages;
    this.#conditions = lock.targets[target]?.conditions ?? [];
    this.#browser = target === "browser";
  }

  /** The package `from` gets for `name`: a dependency, or a peer in the graph. */
  #keyFor(from: Located | undefined, name: string): string | undefined {
    if (from === undefined) {
      const version = this.#lock.direct[name];
      return version === undefined ? undefined : `${name}@${version}`;
    }
    const entry = this.#lock.packages[from.key];
    const peer = entry?.peers[name];
    const version =
      entry?.dependencies[name] ??
      (peer?.by === "graph" ? peer.resolved : undefined);
    return version === undefined || version === null
      ? undefined
      : `${name}@${version}`;
  }

  /** A file of a package, through its `browser` remaps in the browser. */
  #remapped(key: string, pkg: PackageFiles, file: string): OnResolveResult {
    const remap = this.#browser ? browserRemap(pkg, file) : undefined;
    if (remap === false) {
      return { path: `${key}/${file}`, namespace: "empty" };
    }
    if (remap === undefined) {
      return located(key, file);
    }
    const target = resolveFile(pkg, remap, this.#browser);
    return target === undefined
      ? refuse(`${key} remaps ${file} to a file it doesn't have`)
      : located(key, target);
  }

  /** React or React DOM: the platform's module, in the browser only. */
  #platform(specifier: string, from: Located | undefined): OnResolveResult {
    if (!this.#browser) {
      return refuse(
        `${importer(from)} imports ${specifier}, which the platform provides only in the browser`
      );
    }
    if (!platformModules.includes(specifier)) {
      return refuse(
        `${importer(from)} imports ${specifier}, which the platform doesn't provide`
      );
    }
    return { path: specifier, namespace: "platform" };
  }

  /** A bare specifier imported by `from` (a package, or the App's entry). */
  #bare(
    specifier: string,
    from: Located | undefined,
    entry: boolean
  ): OnResolveResult {
    const name = entryPackage(specifier);
    // A package may import itself by its own name, through its `exports`
    // only, as Node allows: never past what it exports.
    const self =
      from !== undefined && this.#lock.packages[from.key]?.name === name;
    const key = self ? from?.key : this.#keyFor(from, name);
    if (
      specifier.startsWith("node:") ||
      (nodeBuiltins.has(name) && key === undefined)
    ) {
      return refuse(
        `${importer(from)} uses Node.js's ${specifier}, which isn't available on the ${this.#target} target`
      );
    }
    if (Object.hasOwn(platformPeers, name)) {
      return this.#platform(specifier, from);
    }
    if (key === undefined) {
      return refuse(
        `${importer(from)} imports ${name}, which it doesn't depend on`
      );
    }
    const subpath =
      specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
    const pkg = this.#packages.get(key);
    if (self && pkg?.manifest.exports === undefined) {
      return refuse(
        `${key} imports itself by name, which only a package with exports may`
      );
    }
    const file =
      pkg === undefined
        ? undefined
        : resolveSubpath(pkg, subpath, this.#conditions, this.#browser);
    if (pkg === undefined || file === undefined) {
      return refuse(
        `${key} doesn't export ${subpath} for the ${this.#target} target`
      );
    }
    const result = this.#remapped(key, pkg, file);
    // The file built: after the browser field's remap, if it has one.
    if (entry && result.namespace === "pkg" && result.path !== undefined) {
      this.entries.set(specifier, result.path);
    }
    return result;
  }

  /** A path relative to the importing file, within its package. */
  #relative(path: string, from: Located, pkg: PackageFiles): OnResolveResult {
    const directory = from.file.includes("/")
      ? from.file.slice(0, from.file.lastIndexOf("/"))
      : "";
    const joined = withinPackage(
      directory === "" ? path : `${directory}/${path}`
    );
    if (joined === undefined) {
      return refuse(`${from.key} imports ${path}, outside itself`);
    }
    const file = resolveFile(pkg, joined, this.#browser);
    return file === undefined
      ? refuse(`${from.key} imports ${path}, which it doesn't have`)
      : this.#remapped(from.key, pkg, file);
  }

  /** An import from within a package: `#name`, relative or bare. */
  #within(path: string, from: Located, pkg: PackageFiles): OnResolveResult {
    if (path.startsWith("#")) {
      const file = resolveImports(pkg, path, this.#conditions);
      return file === undefined
        ? refuse(
            `${from.key} imports ${path}, which its package.json doesn't map`
          )
        : this.#remapped(from.key, pkg, file);
    }
    if (path.startsWith("/")) {
      return refuse(`${from.key} imports an absolute path, ${path}`);
    }
    if (path.startsWith(".")) {
      return this.#relative(path, from, pkg);
    }
    // A package's `browser` field may swap a module for a file of its own
    // (a shim for `crypto`, say) or for nothing.
    const remap = this.#browser ? browserRemap(pkg, path) : undefined;
    if (remap === false) {
      return { path, namespace: "empty" };
    }
    if (remap !== undefined) {
      const file = resolveFile(pkg, remap, true);
      return file === undefined
        ? refuse(`${from.key} remaps ${path} to a file it doesn't have`)
        : located(from.key, file);
    }
    return this.#bare(path, from, false);
  }

  resolve = (args: OnResolveArgs): OnResolveResult => {
    const from = isLocated(args.pluginData) ? args.pluginData : undefined;
    const { path, kind } = args;
    if (args.namespace === "platform") {
      return { path, external: true };
    }
    if (kind === "entry-point") {
      return this.#bare(path, undefined, true);
    }
    // `url(#id)` names something in the document itself.
    if (kind === "url-token" && path.startsWith("#")) {
      return { path, external: true };
    }
    // `node:` is a built-in's scheme, refused by name as one.
    if (remote.test(path) && !path.startsWith("node:")) {
      return urlImport(path, from, kind);
    }
    const pkg = from === undefined ? undefined : this.#packages.get(from.key);
    return from === undefined || pkg === undefined
      ? refuse(`an import of ${path} comes from outside the packages`)
      : this.#within(path, from, pkg);
  };

  /** The platform's module, for ES imports and CommonJS requires alike. */
  platform = (args: OnLoadArgs): OnLoadResult => {
    this.imports.add(args.path);
    // A require of an external from CommonJS wouldn't run in a browser;
    // a require of this module, which imports it, does.
    const specifier = JSON.stringify(args.path);
    return {
      contents: `export * from ${specifier}; import * as platform from ${specifier}; export default platform.default ?? platform;`,
      loader: "js",
    };
  };

  load = (args: OnLoadArgs): OnLoadResult => {
    if (!isLocated(args.pluginData)) {
      return { errors: [{ text: `${args.path} wasn't resolved by Grasp` }] };
    }
    const { key, file } = args.pluginData;
    const contents = this.#packages.get(key)?.files.get(file);
    if (contents === undefined) {
      return { errors: [{ text: `${key} has no file ${file}` }] };
    }
    const extension = extensionOf(file);
    const loader = codeLoaders[extension];
    if (loader !== undefined) {
      return { contents, loader, pluginData: args.pluginData };
    }
    if (!Object.hasOwn(assetTypes, extension)) {
      return {
        errors: [
          {
            text: `${key} imports ${file}, a kind of file an artifact doesn't carry`,
          },
        ],
      };
    }
    const svg = extension === ".svg" ? svgRefusal(contents) : undefined;
    if (svg !== undefined) {
      return { errors: [{ text: `${key}'s ${file} ${svg}` }] };
    }
    return { contents, loader: "file" };
  };

  plugin(): Plugin {
    return {
      name: pluginName,
      setup: (plugin) => {
        plugin.onResolve({ filter: anything }, this.resolve);
        plugin.onLoad({ filter: anything, namespace: "empty" }, () => ({
          contents: "",
          loader: "js",
        }));
        plugin.onLoad(
          { filter: anything, namespace: "platform" },
          this.platform
        );
        plugin.onLoad({ filter: anything, namespace: "pkg" }, this.load);
      },
    };
  }
}

/** Where esbuild says a message is from: `pkg:<name@version/file>`. */
const fileOf = (message: object): string | undefined => {
  if (!("location" in message)) {
    return undefined;
  }
  const { location } = message;
  return typeof location === "object" &&
    location !== null &&
    "file" in location &&
    typeof location.file === "string"
    ? location.file.replace(/^pkg:/u, "")
    : undefined;
};

/**
 * Every message of a failed build, as refusals: the plugin's name what
 * they refuse; esbuild's own are put after the file they are about.
 */
const refusalsOf = (error: unknown): string[] => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("errors" in error) ||
    !Array.isArray(error.errors)
  ) {
    throw error;
  }
  const errors: unknown[] = error.errors;
  // Only as many as a build reports are worded.
  return errors.slice(0, maxRefusals).map((message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("text" in message) ||
      typeof message.text !== "string"
    ) {
      return "the build failed";
    }
    const ours = "pluginName" in message && message.pluginName === pluginName;
    const file = fileOf(message);
    return ours || file === undefined
      ? message.text
      : `${file}: ${message.text}`;
  });
};

/**
 * What an output file of the build would load from outside the artifact,
 * which esbuild's plugin never saw: strings `image-set()` takes (remote
 * or local), and modules that load files by URL or start workers.
 */
const leavingOutput = (
  path: string,
  contents: Uint8Array,
  limit: number
): string[] => {
  if (limit <= 0) {
    return [];
  }
  const text = decoder.decode(contents);
  if (path.endsWith(".css")) {
    return [
      ...remoteInCss(text, limit).map(
        (url) => `the stylesheet ${path} loads ${url}, outside the artifact`
      ),
      ...unbundledInCss(text, limit).map(
        (name) =>
          `the stylesheet ${path} names ${name} in image-set() as a string, which isn't bundled: use url()`
      ),
    ].slice(0, limit);
  }
  if (path.endsWith(".js")) {
    return runtimeLoadsInJs(text).map((why) => `the module ${path} ${why}`);
  }
  return [];
};

/**
 * Builds each entry of the lock's target into one ES module (and its
 * stylesheet, if it imports CSS), with the assets it imports. No code
 * splitting: each entry is whole, and nothing loads more at run time.
 */
export const bundle = async (input: BundleInput): Promise<Bundled> => {
  const { lock, target } = input;
  const entries = lock.targets[target]?.entries ?? [];
  const names = new Map<string, string>();
  for (const entry of entries) {
    const name = entryModuleName(entry);
    const other = names.get(name);
    if (other !== undefined) {
      return {
        ok: false,
        refusals: [
          `the entries ${other} and ${entry} would both be the module ${name}`,
        ],
      };
    }
    names.set(name, entry);
  }
  const resolver = new Resolver(input);
  let outputs: { path: string; contents: Uint8Array }[];
  try {
    const result = await build({
      entryPoints: Object.fromEntries(
        entries.map((entry) => [entryModuleName(entry), entry])
      ),
      bundle: true,
      write: false,
      format: "esm",
      splitting: false,
      platform: "neutral",
      target: "es2022",
      mainFields: [],
      conditions: [],
      outdir: "/artifact",
      entryNames: "[name]",
      assetNames: "assets/[name]-[hash]",
      minify: true,
      logLevel: "silent",
      // An import whose path is computed at run time can't be bundled.
      logOverride: {
        "unsupported-dynamic-import": "error",
        "unsupported-require-call": "error",
      },
      define: { "process.env.NODE_ENV": '"production"', ...runtimeLoadMarkers },
      plugins: [resolver.plugin()],
    });
    outputs = result.outputFiles ?? [];
  } catch (error) {
    return { ok: false, refusals: refusalsOf(error) };
  }
  const files = new Map<string, Uint8Array>();
  const leaving: string[] = [];
  for (const output of outputs) {
    const path = output.path.replace(/^\/artifact\//u, "");
    files.set(path, output.contents);
    leaving.push(
      ...leavingOutput(path, output.contents, maxRefusals - leaving.length)
    );
  }
  if (leaving.length > 0) {
    return { ok: false, refusals: leaving };
  }
  return {
    ok: true,
    files,
    entries: Object.fromEntries(
      entries.map((entry) => {
        const name = entryModuleName(entry);
        return [
          entry,
          {
            module: files.has(`${name}.js`) ? `${name}.js` : null,
            css: files.has(`${name}.css`) ? `${name}.css` : null,
            resolved: resolver.entries.get(entry) ?? "",
          },
        ];
      })
    ),
    imports: [...resolver.imports].toSorted(),
  };
};
