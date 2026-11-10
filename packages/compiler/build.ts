/**
 * Builds the App compiler into dist/, once per release at core's build
 * time: the kit's modules, what the compiler needs to know of the kit, and
 * the compiler that runs in its own isolate. Core imports the result
 * through `#isolate`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT_CRASHED,
  NotFoundError,
  makeRequest,
  memoryFileSystem,
  parseReply,
  runTsc,
} from "@tsrs/wasm/core";
import type {
  FileStat,
  HostFileSystem,
  Diagnostic as TscDiagnostic,
} from "@tsrs/wasm/core";
import { rolldown } from "rolldown";
import type { Plugin as RolldownPlugin } from "rolldown";
import { dts } from "rolldown-plugin-dts";
import { ResolverFactory } from "rolldown/experimental";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { build, parseSync } from "vite-plus";
import type { InlineConfig, Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

import { withBuildLock } from "./build-lock.ts";
import {
  buildPackageBuilder,
  chunksOf,
  esbuildWasm,
  production,
} from "./build-package-builder.ts";
import { oxcWasm, oxcWasmModule } from "./oxc-wasm/wasm.ts";
import { serverSdkImports } from "./src/app-code.ts";
import { extractCandidates } from "./src/candidates.ts";
import { compileReact } from "./src/compile.ts";
import { generatedWorkflowSdkImports, sdkImports } from "./src/imports.ts";
import {
  compilerAssets,
  kitModule,
  typesModule,
  kitModuleName,
  kitPeers,
  kitStylesheet,
  previewRefresh,
  previewRuntime,
  routerSpecifier,
  pageRuntime,
  pageSdk,
  sdkRoot,
} from "./src/kit.ts";
import type { Kit, KitModules } from "./src/kit.ts";
import { startOxc } from "./src/oxc.ts";
import { compilerOptions, serverLibs } from "./src/type-check.ts";
import type { KitTypes } from "./src/type-check.ts";
import { ultraciteConfig } from "./ultracite-config.ts";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
const modules = path.join(root, "node_modules");
const ui = realpathSync(path.join(modules, "@grasp-os/ui"));
const sdk = realpathSync(path.join(modules, "@grasp-os/sdk"));
/**
 * The SDK's own dependency: its types name `@grasp-os/shared`'s (a
 * workflow's `Json`, a run's errors), so the kit's type chunks
 * carry what they name of it, or a check would read each as `any`.
 */
const shared = realpathSync(path.join(sdk, "node_modules/@grasp-os/shared"));
/**
 * The Brain's contract, which the SDK re-exports (`@grasp-os/sdk/brain`)
 * and Knowledge's types come from: carried for the same reason.
 */
const brain = realpathSync(path.join(sdk, "node_modules/@grasp-os/brain"));
/** The platform's own packages the kit's types come from, by name. */
const ownPackages: Readonly<Record<string, string>> = {
  "@grasp-os/sdk": sdk,
  "@grasp-os/ui": ui,
  "@grasp-os/shared": shared,
  "@grasp-os/brain": brain,
};
const require = createRequire(path.join(root, "package.json"));

/** The modules of React and React DOM the kit provides, by specifier. */
const reactSpecifiers = kitPeers;
/** What App code may import besides `@grasp-os/ui` and lucide-react icons. */
const reactImports = ["react", "react/jsx-runtime"];

// A package.json, as far as the build reads it.
const manifestSchema = z.object({
  exports: z
    .record(
      z.string(),
      z.union([z.string(), z.object({ style: z.string().optional() })])
    )
    .optional(),
  module: z.string().optional(),
});

const readText = (file: string): string => readFileSync(file, "utf-8");

const manifestOf = (dir: string) =>
  manifestSchema.parse(JSON.parse(readText(path.join(dir, "package.json"))));

const exportsOf = (dir: string) => manifestOf(dir).exports ?? {};

/**
 * A test or a declaration among the kit's sources: no part of a release.
 * It is never a module of the kit, so never sent to a page, and the
 * compiler doesn't read it either: adding or changing one builds the same
 * release.
 */
const notShipped = /\.(?:test|d)\.tsx?$/u;

/** Every source file under a directory that a release is built from. */
const sourcesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.tsx?$/u.test(file) && !notShipped.test(file))
    .map((file) => path.join(dir, file));

/** A kit module's entry: its specifier and the file or virtual module it is. */
interface Entry {
  specifier: string;
  id: string;
}

/**
 * `@grasp-os/ui`'s exports that are one module each, not a folder of them:
 * the form helpers (`Form`, `TextField`, …) pages render the SDK's
 * forms with.
 */
const uiSingleExports: ReadonlySet<string> = new Set(["./form"]);

/**
 * `@grasp-os/ui`: one module per file its exports (`./components/*`, …)
 * cover, and its single-module exports (`uiSingleExports`).
 */
const uiEntries = (): Entry[] =>
  Object.entries(exportsOf(ui)).flatMap(([key, target]) => {
    if (uiSingleExports.has(key) && typeof target === "string") {
      return [
        {
          specifier: `@grasp-os/ui/${key.slice(2)}`,
          id: path.join(ui, target),
        },
      ];
    }
    if (!key.endsWith("/*") || typeof target !== "string") {
      return [];
    }
    const [prefix = "", suffix = ""] = target.split("*");
    const dir = path.join(ui, prefix);
    const files = existsSync(dir)
      ? readdirSync(dir).filter(
          (file) => file.endsWith(suffix) && !notShipped.test(file)
        )
      : [];
    return files.map((file) => ({
      specifier: `@grasp-os/ui/${key.slice(2, -1)}${file.slice(0, -suffix.length)}`,
      id: path.join(dir, file),
    }));
  });

/**
 * `@grasp-os/sdk`'s page modules: the React SDK and the legacy hooks
 * App code imports, and the runtime that renders a page in its frame
 * and mounts the session client (see kit.ts). They share the client's
 * module, so the provider the runtime mounts is the one the hooks read.
 */
const sdkEntries = (extra: readonly string[] = []): Entry[] =>
  [sdkRoot, pageSdk, pageRuntime, ...extra].map((specifier) => {
    const target =
      exportsOf(sdk)[`.${specifier.slice("@grasp-os/sdk".length)}`];
    if (typeof target !== "string") {
      throw new TypeError(`@grasp-os/sdk doesn't export ${specifier}`);
    }
    return { specifier, id: path.join(sdk, target) };
  });

/**
 * lucide-react's icons, one module each, and the export names App code
 * imports them by. Its index re-exports every icon module, one line each:
 * `export { default as A, default as B } from './icons/a.mjs';`.
 */
const iconEntries = (): { entries: Entry[]; icons: Kit["icons"] } => {
  const dir = realpathSync(path.join(modules, "lucide-react"));
  const index = path.join(dir, manifestOf(dir).module ?? "");
  const lines = readText(index).matchAll(
    /^export \{ (?<names>[^}]+) \} from '\.\/icons\/(?<file>[\w-]+)\.mjs';$/gmu
  );
  const entries: Entry[] = [];
  const icons: Kit["icons"] = {};
  for (const [, names = "", file = ""] of lines) {
    const specifier = `lucide-react/icons/${file}`;
    entries.push({
      specifier,
      id: path.join(path.dirname(index), "icons", `${file}.mjs`),
    });
    for (const name of names.split(", ")) {
      icons[name.split(" as ").at(-1) ?? name] = kitModuleName(specifier);
    }
  }
  if (entries.length === 0) {
    throw new Error(`No icons found in ${index}`);
  }
  return { entries, icons };
};

/**
 * What the preview kit is built as (spec 19.2.1): React's development
 * builds, the only ones React Fast Refresh works with, whatever `NODE_ENV`
 * the building process has, as for `production`.
 */
const development = {
  "process.env.NODE_ENV": JSON.stringify("development"),
};

/** Which kit a build is of: the one every page loads, or a preview's. */
type KitProfile = "production" | "preview";

/**
 * The export conditions the kit's packages resolve by, the production ones
 * whatever `NODE_ENV` is (see `production`). Vite picks `development` or
 * `production` by `NODE_ENV`, and some packages (Radix, under cmdk) ship
 * a build for each.
 */
const kitResolve = {
  conditions: ["module", "browser", "production"],
};

/** The preview kit's export conditions: the development ones (see `kitResolve`). */
const previewKitResolve = {
  conditions: ["module", "browser", "development"],
};

/**
 * A CommonJS package as it loads in production, or in development for
 * the preview kit (see `production`).
 */
const requireAs = (
  specifier: string,
  mode: "production" | "development"
): unknown => {
  const { NODE_ENV: before } = process.env;
  process.env.NODE_ENV = mode;
  try {
    // Not a copy this process loaded earlier, under its own NODE_ENV.
    Reflect.deleteProperty(require.cache, require.resolve(specifier));
    return require(specifier);
  } finally {
    if (before === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = before;
    }
  }
};

const virtualEntry = "\0kit-entry:";
const identifier = /^[A-Za-z_$][\w$]*$/u;

/**
 * React's packages are CommonJS, whose exports a bundler can't list. Each
 * gets an ES module that re-exports what the package exports under Node,
 * in production, or in development for the preview kit.
 */
const reactEntries = (mode: "production" | "development"): Plugin => ({
  name: "kit-react-entries",
  resolveId: (id) => (id.startsWith(virtualEntry) ? id : null),
  load: (id) => {
    if (!id.startsWith(virtualEntry)) {
      return null;
    }
    const specifier = id.slice(virtualEntry.length);
    const exported = z
      .record(z.string(), z.unknown())
      .parse(requireAs(specifier, mode));
    const names = Object.keys(exported).filter(
      (name) => identifier.test(name) && name !== "default"
    );
    return `import m from "${specifier}";
export const { ${names.join(", ")} } = m;
export default m;`;
  },
});

/**
 * Packages whose `browser` build touches the DOM as it loads, by the build
 * without it. A kit module must load without a document: wherever it is
 * evaluated before a page exists (a check in a worker, a page's module
 * graph before its frame renders), a module that reads `document` at load
 * fails, and every page that imports it with it. Markdown's decoder
 * (`decode-named-character-reference`, under react-markdown's micromark)
 * makes an element at load to decode entities with `innerHTML`; its own
 * build decodes them from a table instead.
 */
const loadsWithoutDom: Readonly<Record<string, string>> = {
  "decode-named-character-reference": "index.js",
};

/** Resolves each of `loadsWithoutDom` to its build that needs no DOM. */
const withoutDomAtLoad: Plugin = {
  name: "kit-without-dom-at-load",
  enforce: "pre",
  async resolveId(source, importer, options) {
    const file = Object.hasOwn(loadsWithoutDom, source)
      ? loadsWithoutDom[source]
      : undefined;
    if (file === undefined) {
      return null;
    }
    const resolved = await this.resolve(source, importer, {
      ...options,
      skipSelf: true,
    });
    return resolved === null
      ? null
      : { ...resolved, id: path.join(path.dirname(resolved.id), file) };
  },
};

/**
 * The kit's files that opt a component out of the React Compiler, each for
 * a library the compiler lists as incompatible (AGENTS.md): RecordGrid,
 * for TanStack Virtual's `useVirtualizer`.
 */
const kitOptOuts: ReadonlySet<string> = new Set([
  "src/components/record-grid.tsx",
]);

/**
 * Compiles the kit's own sources with oxc and its React Compiler, the same
 * way as App files (src/compile.ts). They are the only TypeScript in the
 * build.
 */
const reactCompiler: Plugin = {
  name: "kit-react-compiler",
  enforce: "pre",
  transform: (code, id) => {
    if (!/\.tsx?$/u.test(id)) {
      return null;
    }
    const file = path.relative(ui, id);
    const compiled = compileReact(file, code, {
      optOut: kitOptOuts.has(file),
    });
    if (compiled.code === null) {
      const [error] = compiled.errors;
      throw new Error(
        `${file}:${error?.line ?? 0}:${error?.column ?? 0}: ${error?.message ?? "it doesn't compile"}`
      );
    }
    return { code: compiled.code };
  },
};

/** Built modules by flat name: their code, imports and source files. */
interface FlatModules {
  code: Record<string, string>;
  imports: Record<string, string[]>;
  /** The files bundled into each module, by path. */
  sources: Record<string, string[]>;
}

/**
 * Built chunks as modules by flat name, importing each other by that name
 * instead of by relative path, what each imports and what it was built from.
 */
const flatModules = (chunks: Rolldown.OutputChunk[]): FlatModules => {
  const code: Record<string, string> = {};
  const imports: Record<string, string[]> = {};
  const sources: Record<string, string[]> = {};
  for (const chunk of chunks) {
    let flat = chunk.code;
    const imported = [...chunk.imports, ...chunk.dynamicImports];
    for (const name of imported) {
      flat = flat.replaceAll(`"./${name}"`, `"${name}"`);
    }
    if (flat.includes('"./')) {
      throw new Error(`${chunk.fileName} still imports by relative path`);
    }
    code[chunk.fileName] = flat;
    imports[chunk.fileName] = imported;
    sources[chunk.fileName] = chunk.moduleIds;
  }
  return { code, imports, sources };
};

/**
 * What every page shares one instance of: React and what renders with it.
 * A page loads each kit module once, by its flat name, and the bundler puts
 * each file in one module, so there is one of each unless a dependency
 * brings a second copy from another directory. That fails the build, like
 * two versions of one package in the kit's types.
 */
const singlePackages = [
  "react",
  "react-dom",
  "scheduler",
  "@tanstack/react-router",
  "@tanstack/router-core",
];

const assertSinglePackages = (sources: FlatModules["sources"]): void => {
  for (const name of singlePackages) {
    const marker = `/node_modules/${name}/`;
    const copies = new Set(
      Object.values(sources)
        .flat()
        .filter((file) => file.includes(marker))
        .map((file) => file.slice(0, file.lastIndexOf(marker) + marker.length))
    );
    if (copies.size > 1) {
      throw new Error(
        `The kit must have one copy of ${name}, not ${copies.size}: ${[...copies].join(", ")}`
      );
    }
  }
};

/**
 * Tailwind class candidates in the kit's own sources, by the module each
 * source was built into (`Kit.moduleCandidates`). Every source must be in a
 * module: one that isn't would lose its classes without a word.
 */
const candidatesByModule = (
  sources: FlatModules["sources"]
): Record<string, string[]> => {
  const own = new Set(sourcesIn(path.join(ui, "src")));
  const placed = new Set<string>();
  const candidates: Record<string, string[]> = {};
  for (const [name, files] of Object.entries(sources)) {
    const mine = files.filter((file) => own.has(file));
    const found = mine.flatMap((file) => extractCandidates(readText(file)));
    if (found.length > 0) {
      candidates[name] = [...new Set(found)].toSorted();
    }
    for (const file of mine) {
      placed.add(file);
    }
  }
  const missing = [...own].filter((file) => !placed.has(file));
  if (missing.length > 0) {
    throw new Error(`Not in any of the kit's modules: ${missing.join(", ")}`);
  }
  return candidates;
};

/**
 * The kit's modules: React, `@grasp-os/ui` and lucide-react's icons, built
 * together so they share one React and one copy of every dependency. Entries
 * and the chunks they share are named flat (`react.js`, `kit~….js`), and
 * import each other by that name instead of by relative path. Returns their
 * code and what each imports, by flat name.
 */
const buildKitModules = async (
  entries: Entry[],
  profile: KitProfile = "production"
): Promise<FlatModules> => {
  const preview = profile === "preview";
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: preview ? "development" : "production",
    define: preview ? development : production,
    resolve: preview ? previewKitResolve : kitResolve,
    // oxc.wasm compiles TypeScript here, with the React Compiler
    // (`reactCompiler`): Vite's own transform has nothing left to do.
    oxc: false,
    plugins: [
      reactEntries(preview ? "development" : "production"),
      reactCompiler,
      withoutDomAtLoad,
    ],
    build: {
      write: false,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: Object.fromEntries(
          entries.map(({ specifier, id }) => [
            kitModuleName(specifier).slice(0, -".js".length),
            id,
          ])
        ),
        preserveEntrySignatures: "strict",
        // Base UI marks its modules "use client", for React Server
        // Components; pages only render on the client.
        onLog: (level, log, handle) => {
          if (log.code !== "MODULE_LEVEL_DIRECTIVE") {
            handle(level, log);
          }
        },
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "kit~[name]-[hash].js",
        },
      },
    },
  };
  const built = flatModules(chunksOf(await build(config)));
  for (const { specifier } of entries) {
    if (built.code[kitModuleName(specifier)] === undefined) {
      throw new Error(`The kit has no module for ${specifier}`);
    }
  }
  assertSinglePackages(built.sources);
  return built;
};

/**
 * The SDK's modules for `specifiers`, which code runs with outside
 * pages: what a workflow's or an App test's isolate loads (`sdkImports`
 * and the JSON workflows' own), or what an App's server isolate loads
 * (`serverSdkImports`), each a set
 * of its own, so each isolate carries only what it uses. One module per
 * specifier, named by it (`@grasp-os~sdk~workflow.js`), and chunks for
 * what they share (Zod), importing each other by flat name like the kit's
 * modules.
 */
const buildSdkModules = async (
  specifiers: readonly string[]
): Promise<Record<string, string>> => {
  const exported = exportsOf(sdk);
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    define: production,
    resolve: { conditions: ["workerd", "worker"] },
    build: {
      write: false,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: Object.fromEntries(
          specifiers.map((specifier) => {
            const target =
              exported[`.${specifier.slice("@grasp-os/sdk".length)}`];
            if (typeof target !== "string") {
              throw new TypeError(`The SDK doesn't export ${specifier}`);
            }
            return [
              kitModuleName(specifier).slice(0, -".js".length),
              path.join(sdk, target),
            ];
          })
        ),
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "sdk~[name]-[hash].js",
        },
      },
    },
  };
  return flatModules(chunksOf(await build(config))).code;
};

/** The kit's stylesheet and the ones it imports, by their `style` export. */
const collectStylesheets = (): Record<string, string> => {
  const sheet = readText(path.join(ui, "src/styles.css"));
  const stylesheets: Record<string, string> = { [kitStylesheet]: sheet };
  for (const [, id = ""] of sheet.matchAll(/@import "(?<id>[^"]+)"/gu)) {
    const segments = id.split("/");
    const nameLength = id.startsWith("@") ? 2 : 1;
    const dir = path.join(ui, "node_modules", ...segments.slice(0, nameLength));
    const subpath = segments.slice(nameLength).join("/");
    const entry = exportsOf(dir)[subpath === "" ? "." : `./${subpath}`];
    const file = typeof entry === "string" ? entry : entry?.style;
    if (file === undefined) {
      throw new Error(`No stylesheet found for "${id}"`);
    }
    stylesheets[id] = readText(path.join(dir, file));
  }
  return stylesheets;
};

/**
 * Drops JSDoc comments: most of lucide-react's declarations, and nothing
 * a type check reads. oxc's parser (Vite+'s) finds them.
 */
const withoutDocComments = (source: string): string => {
  let result = "";
  let kept = 0;
  for (const { type, start, end } of parseSync("types.d.ts", source).comments) {
    if (type === "Block" && source.startsWith("/**", start)) {
      result += source.slice(kept, start);
      kept = end;
    }
  }
  return result + source.slice(kept);
};

const declaration = /\.d\.[cm]?ts$/u;

/** A module that imports each of `specifiers`, which a program starts from. */
const importing = (specifiers: readonly string[]): string =>
  specifiers.map((specifier) => `import "${specifier}";`).join("\n");

/**
 * How the kit is loaded at build time: the options App code is checked
 * with, and the worker lib too, what an App's server code is checked
 * against (type-check.ts `serverTarget`), which no page is. Third-party
 * declarations can have errors that don't matter here.
 */
const { paths: _appPaths, ...checkOptions } = compilerOptions;
const kitOptions = {
  ...checkOptions,
  skipLibCheck: true,
  lib: [...compilerOptions.lib, ...serverLibs],
};

/**
 * tsrs, the checker App code is checked with (type-check.ts), which every
 * build-time check and emit of the kit runs on too: its WebAssembly, as
 * the package ships it, compiled once.
 */
const tsrsBytes = readFileSync(require.resolve("@tsrs/wasm/tsrs.wasm"));
const tsrsModule: unknown = Reflect.construct(WebAssembly.Module, [tsrsBytes]);
if (!(tsrsModule instanceof WebAssembly.Module)) {
  throw new TypeError("tsrs's WebAssembly didn't compile");
}

/** The errors of tsrs's `tsc -p <config>` over `host`. */
const tsrs = (host: HostFileSystem, config: string): TscDiagnostic[] => {
  const stderr: string[] = [];
  const decoder = new TextDecoder();
  const { exitCode, reply } = runTsc(
    tsrsModule,
    makeRequest(["-p", config], { cwd: path.dirname(config), json: true }),
    host,
    {
      env: {},
      stderr: (chunk) => {
        stderr.push(decoder.decode(chunk, { stream: true }));
      },
    }
  );
  if (exitCode === EXIT_CRASHED) {
    throw new Error(`tsrs stopped: ${stderr.join("")}`);
  }
  return parseReply(reply).filter(({ category }) => category === 1);
};

const messageOf = ({ fileName, text }: TscDiagnostic): string =>
  `${fileName ?? ""} ${text}`.trim();

/** A failed read of `file`, as tsrs's host says a path is missing. */
const missing = (file: string, error: unknown): never => {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  ) {
    throw new NotFoundError(file);
  }
  throw error;
};

/** A directory entry's kind, as tsrs's host names it. */
const kindOf = (entry: {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink?: () => boolean;
}): "f" | "d" | "l" | "o" => {
  if (entry.isDirectory()) {
    return "d";
  }
  if (entry.isFile()) {
    return "f";
  }
  return entry.isSymbolicLink?.() === true ? "l" : "o";
};

/**
 * The real file system as tsrs reads it (as its own Node host does), with
 * `overlay`'s files on top: every file it reads goes in `read`, every file
 * it writes in `written`, and nothing is written to disk.
 */
const diskHost = (
  overlay: Readonly<Record<string, string>>,
  read: Map<string, string>,
  written = new Map<string, string>()
): HostFileSystem => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    readFile: (file) => {
      if (Object.hasOwn(overlay, file)) {
        return encoder.encode(overlay[file]);
      }
      try {
        const bytes = readFileSync(file);
        read.set(file, decoder.decode(bytes));
        return bytes;
      } catch (error) {
        return missing(file, error);
      }
    },
    stat: (file): FileStat => {
      if (Object.hasOwn(overlay, file)) {
        return { kind: "f", size: overlay[file]?.length ?? 0, mtimeNs: 0n };
      }
      try {
        const found = statSync(file, { bigint: true });
        // A stat follows links: what it finds is never one.
        const kind = kindOf({
          isDirectory: () => found.isDirectory(),
          isFile: () => found.isFile(),
        });
        return {
          kind: kind === "l" ? "o" : kind,
          size: found.size,
          mtimeNs: found.mtimeNs,
        };
      } catch (error) {
        return missing(file, error);
      }
    },
    readDir: (directory) => {
      try {
        return readdirSync(directory, { withFileTypes: true }).map(
          (entry): ["f" | "d" | "l" | "o", string] => [
            kindOf(entry),
            entry.name,
          ]
        );
      } catch (error) {
        return missing(directory, error);
      }
    },
    realpath: (file) => {
      if (Object.hasOwn(overlay, file)) {
        return file;
      }
      try {
        return realpathSync(file);
      } catch (error) {
        return missing(file, error);
      }
    },
    writeFile: (file, data) => {
      written.set(file, decoder.decode(data));
    },
    remove: () => {
      throw new Error("The kit's build removes nothing.");
    },
    chtimes: () => {
      // Nothing is written to disk.
    },
  };
};

/**
 * Where a file of a package (by its real path) is in the kit's types:
 * `/node_modules/<name>/…`, the platform's own packages by their sources;
 * undefined for a file of no package (the compiler's own package.json).
 */
const kitPathOf = (real: string): string | undefined => {
  const own = Object.entries(ownPackages).find(([, dir]) =>
    real.startsWith(`${dir}/`)
  );
  if (own !== undefined) {
    const [packageName, dir] = own;
    return `/node_modules/${packageName}${real.slice(dir.length)}`;
  }
  const inPackage = real.split("/node_modules/").at(-1) ?? real;
  return inPackage === real ? undefined : `/node_modules/${inPackage}`;
};

/**
 * The files a type check of the kit's sources reads, by the path the
 * isolate knows them by (see src/type-check.ts): tsrs loads everything
 * App code may import, with the options the isolate checks with, and
 * every file it reads is kept. Packages are flattened into
 * `/node_modules/<name>`, the platform's own as their sources: what the
 * type chunks are made of (`typeChunks`). Two versions of one package would clash, and fail the
 * build. TypeScript's own libs are tsrs's, never read from disk.
 */
const collectTypes = (specifiers: string[]): Record<string, string> => {
  const entry = path.join(root, "kit-types.ts");
  const config = path.join(root, "kit-types.tsconfig.json");
  const read = new Map<string, string>();
  const [error] = tsrs(
    diskHost(
      {
        [entry]: importing(specifiers),
        [config]: JSON.stringify({
          compilerOptions: kitOptions,
          files: [entry],
        }),
      },
      read
    ),
    config
  );
  if (error !== undefined) {
    throw new Error(`The kit doesn't type-check: ${messageOf(error)}`);
  }
  const types: Record<string, string> = {};
  for (const [file, content] of read) {
    const name = kitPathOf(realpathSync(file));
    if (name === undefined) {
      continue;
    }
    const kept = declaration.test(name) ? withoutDocComments(content) : content;
    if (types[name] !== undefined && types[name] !== kept) {
      throw new Error(`Two versions of ${name} in the kit's types`);
    }
    types[name] = kept;
  }
  return types;
};

/**
 * The type chunks: the platform's own packages as App code type-checks
 * against them, rolled up into one declaration file per module it may
 * import (`@grasp-os/sdk/react`, `@grasp-os/ui/components/button`, the
 * server and workflow modules, …) and chunks for what those
 * share, with the packages they reach inlined. A check parses only the
 * chunks the modules it imports reach, never the sources of everything
 * those name: any import of the SDK used to bring all of
 * `@grasp-os/shared` with it.
 */

/** Whether `file` is one of the platform's own packages' sources. */
const isOwnSource = (file: string): boolean =>
  Object.values(ownPackages).some((dir) => file.startsWith(`${dir}/src/`));

/** A specifier of one of the platform's own packages: its name and subpath. */
const ownSpecifier = /^(?<name>@grasp-os\/[^/]+)(?:\/(?<subpath>.+))?$/u;

/** The name and subpath (`""` for the root) of an own package's specifier. */
const ownModuleOf = (
  specifier: string
): { name: string; subpath: string } | undefined => {
  const groups = ownSpecifier.exec(specifier)?.groups;
  return groups?.name === undefined
    ? undefined
    : { name: groups.name, subpath: groups.subpath ?? "" };
};

/**
 * What `subpath` (`.`, `./components/button`) is among `exported`: by its
 * own key, or by a pattern's (`./components/*`).
 */
const exportTarget = (
  exported: ReturnType<typeof exportsOf>,
  subpath: string
): string | undefined => {
  const exact = Object.hasOwn(exported, subpath)
    ? exported[subpath]
    : undefined;
  if (typeof exact === "string") {
    return exact;
  }
  for (const [key, target] of Object.entries(exported)) {
    const [prefix = "", suffix] = key.split("*");
    if (
      suffix !== undefined &&
      typeof target === "string" &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    ) {
      return target.replace(
        "*",
        subpath.slice(prefix.length, subpath.length - suffix.length)
      );
    }
  }
  return undefined;
};

/** The source file an own package's specifier names, by its exports. */
const ownSourceOf = (specifier: string): string | undefined => {
  const named = ownModuleOf(specifier);
  if (named === undefined) {
    return undefined;
  }
  const dir = Object.hasOwn(ownPackages, named.name)
    ? ownPackages[named.name]
    : undefined;
  const target =
    dir === undefined
      ? undefined
      : exportTarget(
          exportsOf(dir),
          named.subpath === "" ? "." : `./${named.subpath}`
        );
  if (dir === undefined || target === undefined) {
    throw new Error(`The kit's types have no module ${specifier}`);
  }
  return path.join(dir, target);
};

const typescriptSource = /\.tsx?$/u;

/** Where a source's declaration goes: `app.ts` → `app.d.ts`. */
const declarationOf = (source: string): string =>
  source.replace(typescriptSource, ".d.ts");

/**
 * The declarations of the platform's own sources that `specifiers` reach,
 * by `declarationOf` their source, as tsrs emits them with the options the
 * kit is loaded with, without checking them again: `collectTypes` did.
 * Declaration files among the sources are as they are. Every own source
 * is a root of the program: one only reached through the workspace's
 * links in node_modules would be a library's, which emits nothing.
 */
const emitOwnDeclarations = (
  specifiers: readonly string[]
): Map<string, string> => {
  const entry = path.join(root, "kit-declarations.ts");
  const config = path.join(root, "kit-declarations.tsconfig.json");
  const read = new Map<string, string>();
  const written = new Map<string, string>();
  // Unchecked, so its only errors are the declarations' own: a type it
  // can't name, which would leave its file out.
  const [error] = tsrs(
    diskHost(
      {
        [entry]: importing(specifiers),
        [config]: JSON.stringify({
          compilerOptions: {
            ...kitOptions,
            noEmit: false,
            declaration: true,
            emitDeclarationOnly: true,
            noCheck: true,
          },
          files: [
            entry,
            ...Object.values(ownPackages).flatMap((dir) =>
              sourcesIn(path.join(dir, "src"))
            ),
          ],
        }),
      },
      read,
      written
    ),
    config
  );
  if (error !== undefined) {
    throw new Error(`The kit's declarations don't emit: ${messageOf(error)}`);
  }
  const declarations = new Map<string, string>();
  for (const [file, text] of [...read, ...written]) {
    const real = realpathSync(path.dirname(file));
    const source = path.join(real, path.basename(file));
    if (isOwnSource(source) && declaration.test(source)) {
      declarations.set(source, text);
    }
  }
  return declarations;
};

/**
 * Where a type chunk goes in the kit's types, under `/node_modules/`: at
 * the source of its main module (`@grasp-os/sdk/src/react` for the chunk
 * of `@grasp-os/sdk/react`), so a diagnostic that names a module
 * (`typeof import("/node_modules/@grasp-os/sdk/src/react")`) names it as
 * a check of the sources did, with no hash that changes from release to
 * release. A chunk the entries share takes `.shared.d.ts` there.
 */
const chunkPathOf = (declarationFile: string): string => {
  const own = Object.entries(ownPackages).find(([, dir]) =>
    declarationFile.startsWith(`${dir}/`)
  );
  if (own === undefined) {
    throw new Error(`${declarationFile} is none of the platform's own`);
  }
  const [name, dir] = own;
  return `${name}${declarationFile.slice(dir.length, -".d.ts".length)}`;
};

/**
 * Resolves the own declarations' imports among them: by package and its
 * exports, or by relative path, as the sources name each other (`./x.ts`,
 * `./x.js`, `./x`, `./dir`).
 */
const ownDeclarations = (declarations: Map<string, string>): RolldownPlugin => {
  const found = (file: string, importer: string, source: string): string => {
    if (!declarations.has(file)) {
      throw new Error(`No declaration of ${source} for ${importer}`);
    }
    return file;
  };
  return {
    name: "kit-own-declarations",
    resolveId: {
      order: "pre",
      handler: (source, importer) => {
        const named = ownSourceOf(source);
        if (named !== undefined) {
          return found(declarationOf(named), importer ?? "the kit", source);
        }
        if (importer === undefined || !source.startsWith(".")) {
          return declarations.has(source) ? source : null;
        }
        const target = path.resolve(path.dirname(importer), source);
        const candidates = [
          declarationOf(target),
          target.replace(/\.js$/u, ".d.ts"),
          target,
          `${target}.d.ts`,
          path.join(target, "index.d.ts"),
        ];
        return found(
          candidates.find((file) => declarations.has(file)) ?? target,
          importer,
          source
        );
      },
    },
    load: (id) => declarations.get(id) ?? null,
  };
};

/**
 * The type chunks of the own modules among `specifiers`, by their path in
 * the kit's types (`/node_modules/@grasp-os/sdk/src/react.d.ts`), with a
 * package.json for each own package that exports its modules' chunks
 * and nothing else. Other packages stay imports, resolved among the
 * kit's types.
 */
const rollUpTypes = async (
  specifiers: readonly string[]
): Promise<Record<string, string>> => {
  const own = specifiers.filter((specifier) => ownModuleOf(specifier));
  const entries = new Map(
    own.map((specifier) => [
      specifier,
      declarationOf(ownSourceOf(specifier) ?? specifier),
    ])
  );
  const declarations = emitOwnDeclarations(own);
  const bundle = await rolldown({
    input: Object.fromEntries(
      [...entries.values()].map((file) => [chunkPathOf(file), file])
    ),
    cwd: root,
    // The declarations plugin is this build's work by design: its timings
    // aren't worth a warning at every release.
    checks: { bundlerTimings: false },
    external: (id) =>
      !id.startsWith(".") &&
      !path.isAbsolute(id) &&
      ownModuleOf(id) === undefined,
    plugins: [
      ownDeclarations(declarations),
      // Its input is declarations already (`emitOwnDeclarations`): no
      // generator runs, and oxc's is the one that needs no tsconfig.
      dts({ dtsInput: true, tsconfig: false, generator: "oxc" }),
    ],
  });
  const chunks: Record<string, string> = {};
  try {
    const { output } = await bundle.generate({
      format: "es",
      entryFileNames: "[name].d.ts",
      // A shared chunk goes beside its main module (rolldown names it by
      // that module's file), as `.shared.d.ts`: never an entry's name,
      // which the module may have (`index`, `workflow`). A chunk with no
      // module has nothing but its name to go by.
      chunkFileNames: ({ name, moduleIds }) => {
        const main =
          moduleIds.find((id) => path.basename(id) === `${name}.ts`) ??
          moduleIds[0];
        return main === undefined
          ? "@grasp-os/sdk/src/[name].shared.d.ts"
          : `${chunkPathOf(main)}.shared.d.ts`;
      },
    });
    for (const file of output) {
      if (file.type === "chunk") {
        chunks[`/node_modules/${file.fileName}`] = withoutDocComments(
          file.code
        );
      }
    }
  } finally {
    await bundle.close();
  }
  const manifests: Record<string, Record<string, string>> = {};
  for (const [specifier, file] of entries) {
    const { name, subpath } = ownModuleOf(specifier) ?? {
      name: "",
      subpath: "",
    };
    manifests[name] = {
      ...manifests[name],
      [subpath === "" ? "." : `./${subpath}`]:
        `.${chunkPathOf(file).slice(name.length)}.d.ts`,
    };
  }
  for (const [name, exported] of Object.entries(manifests)) {
    chunks[`/node_modules/${name}/package.json`] = JSON.stringify({
      name,
      type: "module",
      exports: exported,
    });
  }
  return chunks;
};

/**
 * What of `files` a program that imports each of `specifiers` reads, as
 * the isolate's check reads them (src/type-check.ts, on the same tsrs),
 * and its first error, if any: in the program, its entry or a type chunk.
 */
const readByKit = (
  files: Readonly<Record<string, string>>,
  specifiers: readonly string[]
): { read: Set<string>; error: TscDiagnostic | undefined } => {
  const entry = "/kit-types.ts";
  const memory = memoryFileSystem({
    ...files,
    [entry]: importing(specifiers),
    // Type chunks are checked too; the third-party declarations aren't.
    "/tsconfig.json": JSON.stringify({
      compilerOptions: { ...kitOptions, skipLibCheck: false },
      files: [entry],
    }),
  });
  const read = new Set<string>();
  const host: HostFileSystem = {
    readFile: (file) => {
      const bytes = memory.readFile(file);
      read.add(file);
      return bytes;
    },
    stat: (file) => memory.stat(file),
    readDir: (directory) => memory.readDir(directory),
    realpath: (file) => memory.realpath(file),
    writeFile: (file, data, append) => {
      memory.writeFile(file, data, append);
    },
    remove: (file) => {
      memory.remove(file);
    },
    chtimes: (file, atime, mtime) => {
      memory.chtimes(file, atime, mtime);
    },
  };
  const error = tsrs(host, "/tsconfig.json").find(
    ({ fileName }) =>
      fileName === undefined ||
      fileName === entry ||
      Object.keys(ownPackages).some((name) =>
        fileName.startsWith(`/node_modules/${name}/`)
      )
  );
  return { read, error };
};

/**
 * What a declaration's `specifier` resolves to among the packages on
 * disk, by its file's place in the kit's types: as TypeScript resolves it
 * with `moduleResolution: "bundler"` (the `types` condition, then the
 * `types` or `typings` field), and for a package with no types of its own,
 * by its DefinitelyTyped package (`react` is `@types/react`).
 */
const resolver = new ResolverFactory({
  conditionNames: ["types", "import"],
  mainFields: ["types", "typings"],
  extensions: [".d.ts", ".d.mts", ".d.cts"],
});

const resolveType = (specifier: string): string | undefined => {
  const typed = (name: string): string | undefined => {
    const found = resolver.sync(root, name).path;
    return found !== undefined && declaration.test(found)
      ? kitPathOf(realpathSync(found))
      : undefined;
  };
  const scoped = specifier.startsWith("@") ? 2 : 1;
  const [scope = "", ...rest] = specifier.split("/");
  const packageName = specifier.split("/").slice(0, scoped).join("/");
  const definitelyTyped = `@types/${scoped === 2 ? `${scope.slice(1)}__${rest[0] ?? ""}` : packageName}${specifier.slice(packageName.length)}`;
  return typed(specifier) ?? typed(definitelyTyped);
};

/**
 * Where `specifier` resolves among the kit's types `kept`: an own module
 * is its chunk, by the manifest `rollUpTypes` wrote; anything else is a
 * library's on disk (`resolveType`).
 */
const resolveKitType = (
  kept: Readonly<Record<string, string>>,
  specifier: string
): string | undefined => {
  const own = ownModuleOf(specifier);
  if (own === undefined) {
    return resolveType(specifier);
  }
  const manifest = kept[`/node_modules/${own.name}/package.json`];
  const target =
    manifest === undefined
      ? undefined
      : exportTarget(
          manifestSchema.parse(JSON.parse(manifest)).exports ?? {},
          own.subpath === "" ? "." : `./${own.subpath}`
        );
  return target === undefined
    ? undefined
    : path.posix.join(`/node_modules/${own.name}`, target);
};

/**
 * The kit's types with the type chunks in place of the platform's own
 * sources (`sources`, as `collectTypes` collected them for `specifiers`),
 * and of everything else only what a check of the chunks reads: the
 * libraries that only the sources' insides imported go with them. Fails
 * the build should the chunks not type-check, or leave any of
 * `specifiers` unresolved.
 */
const typeChunks = async (
  sources: Readonly<Record<string, string>>,
  specifiers: readonly string[]
): Promise<KitTypes> => {
  const libraries = Object.fromEntries(
    Object.entries(sources).filter(
      ([file]) =>
        !Object.keys(ownPackages).some((name) =>
          file.startsWith(`/node_modules/${name}/`)
        )
    )
  );
  const files = { ...libraries, ...(await rollUpTypes(specifiers)) };
  const { read, error } = readByKit(files, specifiers);
  if (error !== undefined) {
    throw new Error(
      `The kit's type chunks don't type-check: ${messageOf(error)}`
    );
  }
  const kept = Object.fromEntries(
    Object.entries(files).filter(([file]) => read.has(file))
  );
  // Where each module App code may import resolves from an App file: the
  // check maps exactly these names to these files (type-check.ts `paths`),
  // and nothing else of the kit.
  const resolved: Record<string, string> = {};
  for (const specifier of specifiers) {
    const found = resolveKitType(kept, specifier);
    if (found === undefined || !Object.hasOwn(kept, found)) {
      throw new Error(`The kit's types don't resolve ${specifier}`);
    }
    resolved[specifier] = found;
  }
  return { files: kept, resolved };
};

/**
 * The theme's own colours: the `--color-*` the kit's stylesheet declares,
 * less Tailwind's palette, which the theme imports with Tailwind's
 * default theme (`Kit.colors`), each from Tailwind's own design system.
 */
const themeColors = async (
  stylesheets: Record<string, string>
): Promise<string[]> => {
  const colorsOf = async (css: string): Promise<Set<string>> => {
    const design = await __unstable__loadDesignSystem(css, {
      // oxlint-disable-next-line require-await -- Tailwind expects a promise
      loadStylesheet: async (id: string) => {
        const content = stylesheets[id];
        if (content === undefined) {
          throw new Error(`The stylesheet "${id}" is not in the kit`);
        }
        return { path: id, base: "/", content };
      },
    });
    return new Set(
      [...design.theme.namespace("--color").keys()].filter(
        (name): name is string => name !== null
      )
    );
  };
  const palette = await colorsOf('@import "tailwindcss";');
  const theme = await colorsOf(stylesheets[kitStylesheet] ?? "");
  return [...theme].filter((name) => !palette.has(name)).toSorted();
};

/** A property's key as written, if it is a name or a string. */
const keyName = (node: unknown): string | undefined => {
  const key: unknown =
    typeof node === "object" && node !== null
      ? Reflect.get(node, "key")
      : undefined;
  if (typeof key !== "object" || key === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(key, "name") ?? Reflect.get(key, "value");
  return typeof name === "string" ? name : undefined;
};

/** `node`'s nodes under `key`. */
const nodesOf = (node: unknown, key: string): unknown[] => {
  const value: unknown =
    typeof node === "object" && node !== null
      ? Reflect.get(node, key)
      : undefined;
  return Array.isArray(value) ? value : [];
};

/** The value of `node`, an object's property. */
const valueOf = (node: unknown): unknown =>
  typeof node === "object" && node !== null
    ? Reflect.get(node, "value")
    : undefined;

/**
 * Each kit component module's variant props and their values, from the
 * `cva` calls in its source (`Kit.components`): `variant` and `size` of
 * the button, say. A module with none has none to offer.
 */
const componentVariants = (
  components: readonly Entry[]
): Record<string, Record<string, string[]>> =>
  Object.fromEntries(
    components.map(({ specifier, id }) => {
      const variants: Record<string, string[]> = {};
      const pending: unknown[] = [parseSync(id, readText(id)).program];
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (typeof node !== "object" || node === null) {
          continue;
        }
        const callee: unknown = Reflect.get(node, "callee");
        if (
          Reflect.get(node, "type") === "CallExpression" &&
          typeof callee === "object" &&
          callee !== null &&
          Reflect.get(callee, "name") === "cva"
        ) {
          const [, options] = nodesOf(node, "arguments");
          const groups = nodesOf(options, "properties").find(
            (property) => keyName(property) === "variants"
          );
          for (const group of nodesOf(valueOf(groups), "properties")) {
            const prop = keyName(group);
            if (prop !== undefined) {
              variants[prop] = [
                ...new Set([
                  ...(variants[prop] ?? []),
                  ...nodesOf(valueOf(group), "properties").flatMap(
                    (each) => keyName(each) ?? []
                  ),
                ]),
              ];
            }
          }
        }
        const inner: unknown[] = Object.values(node);
        pending.push(...inner);
      }
      return [specifier, variants];
    })
  );

/** Node's built-ins, which the isolate has through `nodejs_compat`. */
const nodeBuiltins = [
  /^node:/u,
  ...builtinModules.filter((name) => !name.startsWith("_")),
];

/**
 * How App code is linted and formatted (`#ultracite-config`), worked out
 * here, where Ultracite's presets load (ultracite-config.ts), into a module
 * of Ultracite's bundle: the isolate only reads it.
 */
const ultraciteConfigModule: Plugin = {
  name: "ultracite-config",
  enforce: "pre",
  resolveId: (id) => (id === "#ultracite-config" ? "\0ultracite-config" : null),
  load: (id) =>
    id === "\0ultracite-config"
      ? `export default ${JSON.stringify(ultraciteConfig())};`
      : null,
};

/**
 * How the compiler's and Ultracite's bundles are built: one module each,
 * written in ASCII alone (V8 holds a module's source as one byte a
 * character only then, two otherwise, and these are megabytes).
 */
const isolateBuild = (entry: string, plugins: Plugin[]): InlineConfig => ({
  configFile: false,
  root,
  logLevel: "warn",
  mode: "production",
  resolve: { conditions: ["workerd", "worker", "browser"] },
  ssr: {
    noExternal: true,
    target: "webworker",
    // Production's, whatever `NODE_ENV` is (`kitResolve`).
    resolve: { conditions: ["workerd", "worker", "browser", "production"] },
  },
  define: production,
  plugins,
  build: {
    ssr: entry,
    write: false,
    // Rolldown's (`output.minify`), to write it in ASCII.
    minify: false,
    target: "es2022",
    rolldownOptions: {
      // oxc's WebAssembly is a module of the isolate: the compiler's
      // transform's and parser's, Ultracite's lint's and format's.
      external: ["cloudflare:workers", "#kit", "./oxc.wasm", ...nodeBuiltins],
      output: {
        minify: {
          compress: true,
          mangle: true,
          codegen: { asciiOnly: true },
        },
        format: "es",
        codeSplitting: false,
        paths: { "#kit": kitModule },
      },
    },
  },
});

/** The one module `config` builds to, named `what` where it doesn't. */
const oneModule = async (
  config: InlineConfig,
  what: string
): Promise<string> => {
  const [chunk, ...rest] = chunksOf(await build(config));
  if (chunk === undefined || rest.length > 0) {
    throw new Error(`${what} should build to one module`);
  }
  return chunk.code;
};

/**
 * What TanStack's route generator (src/route-tree.ts) imports but never
 * calls in the compiler: Prettier, for a route tree's formatting
 * (`enableRouteTreeFormatting` is off), jiti, for a virtual routes config
 * file (an App has none), and babel-dead-code-elimination, which
 * TanStack's router-utils re-exports for the router plugin's code splitting
 * and which loads @babel/traverse with a runtime `require`. Each stands in
 * as a module that throws if anything calls it, so a generator release
 * that starts to fails its first build here, never silently.
 */
const routeGeneratorStandIns: Record<string, string[]> = {
  prettier: ["format"],
  jiti: ["createJiti"],
  "babel-dead-code-elimination": [
    "deadCodeElimination",
    "findReferencedIdentifiers",
  ],
};

const standInPrefix = "\0route-generator-stand-in:";

const routeGeneratorStandIn: Plugin = {
  name: "route-generator-stand-in",
  enforce: "pre",
  resolveId: (id) =>
    Object.hasOwn(routeGeneratorStandIns, id) ? `${standInPrefix}${id}` : null,
  load: (id) => {
    if (!id.startsWith(standInPrefix)) {
      return null;
    }
    const name = id.slice(standInPrefix.length);
    const exported = routeGeneratorStandIns[name] ?? [];
    const stub = `() => { throw new Error(${JSON.stringify(`The route generator called ${name}, which the compiler leaves out (build.ts)`)}); }`;
    return [
      ...exported.map((each) => `export const ${each} = ${stub};`),
      "export default {};",
    ].join("\n");
  },
};

/**
 * The compiler's main module. It imports what it knows of the kit (`#kit`)
 * as a module of its own, `kit.json`, which the isolate is started with:
 * most of it is the type check's declarations, which the compiler's code
 * doesn't need to carry.
 */
const buildCompiler = async (): Promise<string> =>
  await oneModule(
    isolateBuild("src/worker.ts", [routeGeneratorStandIn]),
    "The compiler"
  );

/**
 * Ultracite's lint and format (src/ultracite-worker.ts), a module of its
 * own that core runs in an isolate of its own, with oxc.wasm: it isn't
 * loaded by an isolate that only builds, nor read by core but to start
 * one that lints.
 */
const buildUltracite = async (): Promise<string> =>
  await oneModule(
    isolateBuild("src/ultracite-worker.ts", [ultraciteConfigModule]),
    "Ultracite's lint"
  );

/**
 * The type checker's module (src/checker.ts), which core runs in an
 * isolate of its own beside the compiler's, with tsrs's WebAssembly and
 * the kit's types as modules of their own. It runs without Node.js
 * compatibility.
 */
const buildChecker = async (): Promise<string> => {
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: { noExternal: true, target: "webworker" },
    define: production,
    build: {
      ssr: "src/checker.ts",
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        external: ["cloudflare:workers", "#types", "./tsrs.wasm"],
        output: {
          format: "es",
          codeSplitting: false,
          paths: { "#types": typesModule },
        },
      },
    },
  };
  return await oneModule(config, "The type checker");
};

/** Modules with a version that changes with any change to them. */
const modulesOf = (code: Record<string, string>): KitModules => ({
  version: createHash("sha256")
    .update(JSON.stringify(code))
    .digest("hex")
    .slice(0, 16),
  modules: code,
});

/** The module core imports the compiler's version from, as `#version`. */
const releaseVersionModule = path.join(dist, "version.js");

/** The version a version module names, if it is there. */
const versionIn = (file: string): string | undefined =>
  existsSync(file)
    ? /version = "(?<version>[0-9a-f]+)"/u.exec(readText(file))?.groups?.version
    : undefined;

/**
 * Puts a release's `files` in `assets`, whole or not at all: written next
 * to where they go and moved there in one step, so a server reading its
 * assets never finds some of a release's files without the others. A
 * release that is there already is left as it is, but for its directory's
 * time, which says it is the newest again (`pruneReleases`): the same
 * version is the same files, and a server may be reading them.
 */
const writeRelease = (
  assets: string,
  version: string,
  files: Record<string, string | Uint8Array>
): void => {
  const release = path.join(assets, compilerAssets.directory(version));
  if (
    Object.keys(files).every((file) => existsSync(path.join(release, file)))
  ) {
    const now = new Date();
    utimesSync(release, now, now);
    return;
  }
  mkdirSync(path.dirname(release), { recursive: true });
  const written = mkdtempSync(path.join(assets, ".compiler-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(written, file), content);
    }
    // Only what a build that was killed left of this release, if anything.
    rmSync(release, { recursive: true, force: true });
    renameSync(written, release);
  } finally {
    rmSync(written, { recursive: true, force: true });
  }
};

/**
 * How many releases a build leaves in the assets, the newest first. A dev
 * server reads the release it started on until it has reloaded, about a
 * second after a build writes a new version, and removing that release
 * fails its page builds. Three covers a server that hasn't reloaded while
 * two more builds finished: the watcher's (watch.ts), or core's own build
 * as the server starts next to it. Every build keeps as many, so no build
 * has to know whether a server is running. What a release ships is the one
 * it built: its frontend build empties the assets first
 * (scripts/release/build-release.ts).
 */
const keptReleases = 3;

/**
 * Removes all but the `keptReleases` newest releases in `assets`, by the
 * time each was put there or last built again. This build's is the newest:
 * builds run one at a time (build-lock.ts). A release that goes while this
 * looks (a frontend build emptying the assets) is skipped.
 */
const pruneReleases = (assets: string): void => {
  const releases = path.join(assets, compilerAssets.directory(""));
  const found = readdirSync(releases).flatMap((name) => {
    try {
      return [{ name, at: statSync(path.join(releases, name)).mtimeMs }];
    } catch {
      return [];
    }
  });
  const newestFirst = found.toSorted((a, b) => b.at - a.at);
  for (const { name } of newestFirst.slice(keptReleases)) {
    rmSync(path.join(releases, name), { recursive: true, force: true });
  }
};

/**
 * Builds the kit, then the compiler: its files into `assets`, and the
 * version that names them into `versionModule`.
 *
 * Core has the version in its code and reads the files by it, so the two
 * are one identity and must change together. Each assets directory
 * therefore has a version module of its own: core's build writes the one
 * core ships, and core's tests write theirs (test/global-setup.ts). One
 * module for both would let a test run point a running dev server, which
 * reloads on it, at a release its own assets don't have.
 *
 * Everything it reads, it reads here, after the caller took the build's
 * lock (build-lock.ts).
 */
const buildAppCompiler = async (
  assets: string,
  versionModule: string
): Promise<void> => {
  // The kit's sources compile on oxc.wasm, as App code does.
  startOxc(await oxcWasmModule());
  const { entries: icons, icons: iconNames } = iconEntries();
  const components = uiEntries();
  const react = reactSpecifiers.map((specifier) => ({
    specifier,
    id: `${virtualEntry}${specifier}`,
  }));
  const router = {
    specifier: routerSpecifier,
    // Its ES module build, as the kit bundles every entry: its exports named.
    id: fileURLToPath(import.meta.resolve(routerSpecifier)),
  };
  const {
    code: kitCode,
    imports: moduleImports,
    sources,
  } = await buildKitModules([
    ...react,
    router,
    ...components,
    ...icons,
    ...sdkEntries(),
  ]);
  // The preview kit (spec 19.2.1): the same entries, React's development
  // builds, and React Fast Refresh, which the production kit never has.
  const { code: previewKitCode, imports: previewModuleImports } =
    await buildKitModules(
      [
        ...react,
        router,
        ...components,
        ...icons,
        ...sdkEntries([previewRefresh, previewRuntime]),
      ],
      "preview"
    );
  const imports = [
    ...reactImports,
    routerSpecifier,
    ...components.map(({ specifier }) => specifier),
    pageSdk,
    sdkRoot,
  ];
  const stylesheets = collectStylesheets();
  // Generated workflow code is type-checked against its SDK entries too,
  // and an App's server code against the SDK's server side.
  const typed = [
    ...imports,
    "lucide-react",
    ...generatedWorkflowSdkImports,
    // An App's server code is type-checked against what it and its
    // generated modules import (app-code.ts).
    ...serverSdkImports,
    // And its tests, against the SDK's testing module (app-code.ts).
    "@grasp-os/sdk/testing",
  ];
  const typeSources = collectTypes(typed);
  const kit: Kit = {
    imports,
    icons: iconNames,
    stylesheets,
    moduleCandidates: candidatesByModule(sources),
    moduleImports,
    previewModuleImports,
    components: componentVariants(components),
    colors: await themeColors(stylesheets),
  };
  const kitJson = JSON.stringify(kit);
  const typesJson = JSON.stringify(await typeChunks(typeSources, typed));
  const compiler = await buildCompiler();
  const ultracite = await buildUltracite();
  const packageBuilder = await buildPackageBuilder();
  const checker = await buildChecker();
  // The WebAssembly the type checker runs, as the package ships it.
  const tsrsWasm = tsrsBytes;
  // The WebAssembly the builder's esbuild runs, as the package ships it.
  const esbuild = esbuildWasm();
  // oxc's transform and parser, which the compiler's isolate runs, and
  // oxlint's and oxfmt's, which Ultracite's does, as pinned.
  const oxc = await oxcWasm();
  const kitModules = modulesOf(kitCode);
  const kitPreviewModules = modulesOf(previewKitCode);
  // The run hosts', App tests' and JSON workflows' isolates share one set:
  // each imports only its own entry of it (imports.ts).
  const workflowSdkModules = modulesOf(
    // Generated code imports one of the App workflows' entries: each once.
    await buildSdkModules([
      ...new Set([...sdkImports, ...generatedWorkflowSdkImports]),
    ])
  );
  const serverSdkModules = modulesOf(await buildSdkModules(serverSdkImports));
  // Everything a build depends on: the compiler, what it knows of the kit,
  // and the kit's and the SDK's modules the App's modules import.
  const version = createHash("sha256")
    .update(compiler)
    .update(kitJson)
    .update(kitModules.version)
    .update(kitPreviewModules.version)
    .update(workflowSdkModules.version)
    .update(serverSdkModules.version)
    .update(ultracite)
    .update(oxc)
    .update(packageBuilder)
    .update(esbuild)
    .update(checker)
    .update(typesJson)
    .update(tsrsWasm)
    .digest("hex")
    .slice(0, 16);
  writeRelease(assets, version, {
    [compilerAssets.source]: compiler,
    [compilerAssets.ultracite]: ultracite,
    [compilerAssets.oxcWasm]: oxc,
    [compilerAssets.kit]: kitJson,
    [compilerAssets.kitModules]: JSON.stringify(kitModules),
    [compilerAssets.kitPreviewModules]: JSON.stringify(kitPreviewModules),
    [compilerAssets.workflowSdkModules]: JSON.stringify(workflowSdkModules),
    [compilerAssets.serverSdkModules]: JSON.stringify(serverSdkModules),
    [compilerAssets.packageBuilder]: packageBuilder,
    [compilerAssets.esbuildWasm]: esbuild,
    [compilerAssets.checker]: checker,
    [compilerAssets.types]: typesJson,
    [compilerAssets.tsrsWasm]: tsrsWasm,
  });
  // Core imports only the version; the rest it reads from its static
  // assets when it starts a build, so it never loads them otherwise. The
  // version goes last, once its release is in place, and in one step: a
  // dev server that reloads on it finds the whole release. A module that
  // names this version already is left alone, so a build that changes
  // nothing (a test among the kit's sources was edited) reloads nothing.
  if (versionIn(versionModule) !== version) {
    mkdirSync(path.dirname(versionModule), { recursive: true });
    const written = `${versionModule}.${process.pid}.tmp`;
    writeFileSync(written, `export const version = "${version}";\n`);
    renameSync(written, versionModule);
  }
  pruneReleases(assets);
  const kitSize = Object.values(kitCode).join("").length;
  console.info(
    `App compiler ${version}: ${(compiler.length / 1e6).toFixed(1)} MB, Ultracite's lint ${(ultracite.length / 1e6).toFixed(1)} MB, and ${(kitJson.length / 1e6).toFixed(1)} MB of what it knows of the kit; kit ${kitModules.version}: ${Object.keys(kitCode).length} modules, ${(kitSize / 1e6).toFixed(1)} MB`
  );
};

// `node build.ts [assets] [version module]`: core's build runs this with
// its own static assets directory, core's tests with theirs and a version
// module of their own, and the dev watcher (watch.ts) as core's build does.
// One at a time per assets directory: the lock is taken before any source
// is read and held until the version is written and old releases are gone.
const assets = process.argv[2] ?? path.join(dist, "assets");
const versionModule = process.argv[3] ?? releaseVersionModule;
await withBuildLock(assets, async () => {
  await buildAppCompiler(assets, versionModule);
});
