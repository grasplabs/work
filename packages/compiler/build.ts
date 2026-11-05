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

import { rolldown } from "rolldown";
import type { Plugin as RolldownPlugin } from "rolldown";
import { dts } from "rolldown-plugin-dts";
import { __unstable__loadDesignSystem } from "tailwindcss";
import ts from "typescript";
import shadcnPreset from "ultracite/oxlint/shadcn";
import { build } from "vite-plus";
import type { InlineConfig, Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

import { withBuildLock } from "./build-lock.ts";
import { serverSdkImports } from "./src/app-code.ts";
import { extractCandidates } from "./src/candidates.ts";
import { compileModule } from "./src/compile.ts";
import {
  computeRunnerImports,
  computeSdkImports,
  openWorkflowSdkImports,
  sdkImports,
} from "./src/imports.ts";
import {
  compilerAssets,
  kitModule,
  jqWasmModule,
  typesModule,
  kitModuleName,
  kitStylesheet,
  previewRefresh,
  previewRuntime,
  referenceOf,
  screenHooks,
  screenRuntime,
  screenSdk,
  sdkRoot,
} from "./src/kit.ts";
import type { Kit, KitModules } from "./src/kit.ts";
import { platformModules } from "./src/packages/platform.ts";
import { compilerOptions, serverLibs } from "./src/type-check.ts";
import type { KitTypes } from "./src/type-check.ts";
import { ultraciteRules } from "./ultracite-rules.ts";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
const modules = path.join(root, "node_modules");
const ui = realpathSync(path.join(modules, "@grasp-os/ui"));
const sdk = realpathSync(path.join(modules, "@grasp-os/sdk"));
/**
 * The SDK's own dependency: its types name `@grasp-os/shared`'s (a
 * workflow's `emailMessage`, a run's errors), so the kit's type chunks
 * carry what they name of it, or a check would read each as `any`.
 */
const shared = realpathSync(path.join(sdk, "node_modules/@grasp-os/shared"));
/**
 * The Brain's contract, which the SDK re-exports (`@grasp-os/sdk/brain`)
 * and Knowledge's types come from: carried for the same reason.
 */
const brain = realpathSync(path.join(sdk, "node_modules/@grasp-os/brain"));
/**
 * The workflow SDK's jq (its `evaluate`): its types are the SDK's, and its
 * WebAssembly a module of every workflow isolate (`jqWasmModule`).
 */
const expressions = realpathSync(
  path.join(sdk, "node_modules/@grasp-os/workflow-expressions")
);
/** The platform's own packages the kit's types come from, by name. */
const ownPackages: Readonly<Record<string, string>> = {
  "@grasp-os/sdk": sdk,
  "@grasp-os/ui": ui,
  "@grasp-os/shared": shared,
  "@grasp-os/brain": brain,
  "@grasp-os/workflow-expressions": expressions,
};
const require = createRequire(path.join(root, "package.json"));

/** React as the kit's modules, App modules and packages import it. */
const reactSpecifiers = platformModules;
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
 * It is never a module of the kit, so never sent to a screen, and the
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
 * the form helpers (`Form`, `TextField`, …) screens render the SDK's
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
 * `@grasp-os/sdk`'s screen modules: the React SDK and the legacy hooks
 * App code imports, and the runtime that renders a screen in its frame
 * and mounts the session client (see kit.ts). They share the client's
 * module, so the provider the runtime mounts is the one the hooks read.
 */
const sdkEntries = (extra: readonly string[] = []): Entry[] =>
  [sdkRoot, screenHooks, screenSdk, screenRuntime, ...extra].map(
    (specifier) => {
      const target =
        exportsOf(sdk)[`.${specifier.slice("@grasp-os/sdk".length)}`];
      if (typeof target !== "string") {
        throw new TypeError(`@grasp-os/sdk doesn't export ${specifier}`);
      }
      return { specifier, id: path.join(sdk, target) };
    }
  );

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
 * What a release is built as, whatever `NODE_ENV` the building process has:
 * `vp test` runs with `test`, and a shell may have anything. React's
 * packages pick their development build by it, and Vite puts it in the
 * code, so without this the same sources built into another kit, under
 * another version, depending on who built them.
 */
const production = {
  "process.env.NODE_ENV": JSON.stringify("production"),
};

/**
 * What the preview kit is built as (spec 19.2.1): React's development
 * builds, the only ones React Fast Refresh works with, whatever `NODE_ENV`
 * the building process has, as for `production`.
 */
const development = {
  "process.env.NODE_ENV": JSON.stringify("development"),
};

/** Which kit a build is of: the one every screen loads, or a preview's. */
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
 * evaluated before a page exists (a check in a worker, a screen's module
 * graph before its frame renders), a module that reads `document` at load
 * fails, and every screen that imports it with it. Markdown's decoder
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
 * Compiles the kit's own sources with Babel and the React Compiler, the same
 * way as App files. They are the only TypeScript in the build.
 */
const reactCompiler: Plugin = {
  name: "kit-react-compiler",
  enforce: "pre",
  transform: (code, id) =>
    /\.tsx?$/u.test(id)
      ? { code: compileModule(code, path.relative(ui, id)) }
      : null,
};

const chunksOf = (
  result: Awaited<ReturnType<typeof build>>
): Rolldown.OutputChunk[] =>
  [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");

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
 * What every screen shares one instance of: React and what renders with it.
 * A page loads each kit module once, by its flat name, and the bundler puts
 * each file in one module, so there is one of each unless a dependency
 * brings a second copy from another directory. That fails the build, like
 * two versions of one package in the kit's types.
 */
const singlePackages = ["react", "react-dom", "scheduler"];

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
    // Babel compiles TypeScript here, with the React Compiler.
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
        // Components; screens only render on the client.
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

/** jq's WebAssembly, as workflow-expressions pins it. */
const jqWasmSource = path.join(expressions, "src/jq.wasm");

/**
 * jq's WebAssembly, which the workflow SDK's `evaluate` imports: not
 * bundled, but a module of the workflow isolate by its flat name
 * (`jqWasmModule`), as core loads it from the release (`jq.wasm`). It is
 * the only WebAssembly the SDK may import.
 */
const jqWasmExternal: Plugin = {
  name: "grasp-jq-wasm",
  // Before Vite's own WebAssembly plugin, which would inline it.
  enforce: "pre",
  resolveId: (source, importer) => {
    if (!source.endsWith(".wasm")) {
      return null;
    }
    const resolved =
      importer === undefined
        ? source
        : path.resolve(path.dirname(importer), source);
    if (realpathSync(resolved) !== jqWasmSource) {
      throw new Error(`The SDK may import no WebAssembly but jq's: ${source}`);
    }
    return { id: jqWasmModule, external: true };
  },
};

/**
 * The SDK's modules for `specifiers`, which App code runs with outside
 * screens: the workflow SDK, which App workflows import (`sdkImports`),
 * or what an App's server isolate loads (`serverSdkImports`), each a set
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
    plugins: [jqWasmExternal],
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
 * Drops JSDoc comments: most of TypeScript's and lucide-react's
 * declarations, and nothing a type check reads.
 */
const withoutDocComments = (source: string): string => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source
  );
  let result = "";
  let kept = 0;
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenStart();
    if (
      token === ts.SyntaxKind.MultiLineCommentTrivia &&
      source.startsWith("/**", start)
    ) {
      result += source.slice(kept, start);
      kept = scanner.getTokenEnd();
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
 * against (type-check.ts `serverTarget`), which no screen is. Third-party
 * declarations can have errors that don't matter here.
 */
const { paths: _appPaths, ...checkOptions } = compilerOptions;
const kitOptions: ts.CompilerOptions = ts.convertCompilerOptionsFromJson(
  {
    ...checkOptions,
    skipLibCheck: true,
    lib: [...compilerOptions.lib, ...serverLibs],
  },
  "/"
).options;

/**
 * Where TypeScript's own declarations are as the build's checks of the
 * kit read them (`readByKit`). The check of App code has its own: tsrs
 * carries TypeScript's libs, so none of these ship with the kit's types.
 */
const libLocation = "/node_modules/typescript/lib";

/**
 * The files a type check of the kit's sources reads, by the path the
 * isolate knows them by (see src/type-check.ts): TypeScript loads
 * everything App code may import, with the options the isolate checks
 * with, and every file it reads is kept. Packages are flattened into
 * `/node_modules/<name>`, the platform's own as their sources: what the
 * agent's reference holds, and what the type chunks are made of
 * (`typeChunks`). Two versions of one package would clash, and fail the
 * build.
 */
const collectTypes = (specifiers: string[]): Record<string, string> => {
  const entry = path.join(root, "kit-types.ts");
  const options = kitOptions;
  const host = ts.createCompilerHost(options);
  const read = new Map<string, string>();
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => {
    const content = readFile(file);
    if (content !== undefined) {
      read.set(file, content);
    }
    return content;
  };
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) =>
    file === entry
      ? ts.createSourceFile(file, importing(specifiers), ts.ScriptTarget.Latest)
      : getSourceFile(file, ...rest);
  const program = ts.createProgram([entry], options, host);
  const [error] = ts.getPreEmitDiagnostics(program);
  if (error !== undefined) {
    throw new Error(
      `The kit doesn't type-check: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`
    );
  }
  const types: Record<string, string> = {};
  for (const [file, content] of read) {
    const real = realpathSync(file);
    const inPackage = real.split("/node_modules/").at(-1) ?? real;
    const own = Object.entries(ownPackages).find(([, dir]) =>
      real.startsWith(`${dir}/`)
    );
    let name: string;
    if (own !== undefined) {
      const [packageName, dir] = own;
      name = `/node_modules/${packageName}${real.slice(dir.length)}`;
    } else if (inPackage === real) {
      // The compiler's own package.json, read for the entry.
      continue;
    } else {
      name = `/node_modules/${inPackage}`;
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
 * server, workflow and compute modules, …) and chunks for what those
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
 * by `declarationOf` their source, as TypeScript emits them with the
 * options the kit is loaded with, without checking them again:
 * `collectTypes` did. Declaration files among the sources are as they are.
 */
const emitOwnDeclarations = (
  specifiers: readonly string[]
): Map<string, string> => {
  const options: ts.CompilerOptions = {
    ...kitOptions,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    noCheck: true,
  };
  const entry = path.join(root, "kit-declarations.ts");
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) =>
    file === entry
      ? ts.createSourceFile(file, importing(specifiers), ts.ScriptTarget.Latest)
      : getSourceFile(file, ...rest);
  // TypeScript emits nothing for a file it reaches through node_modules,
  // a library's. The platform's own packages are reached that way too,
  // through the workspace's links, but are sources.
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    resolveOptions
  ) =>
    literals.map(({ text }) => {
      const resolved = ts.resolveModuleName(
        text,
        containingFile,
        resolveOptions,
        host,
        undefined,
        redirectedReference
      );
      const { resolvedModule } = resolved;
      return resolvedModule !== undefined &&
        isOwnSource(resolvedModule.resolvedFileName)
        ? {
            ...resolved,
            resolvedModule: {
              ...resolvedModule,
              isExternalLibraryImport: false,
            },
          }
        : resolved;
    });
  const program = ts.createProgram([entry], options, host);
  const declarations = new Map<string, string>();
  for (const file of program.getSourceFiles()) {
    if (!isOwnSource(file.fileName)) {
      continue;
    }
    if (file.isDeclarationFile) {
      declarations.set(file.fileName, file.text);
    } else {
      program.emit(
        file,
        (name, text) => {
          declarations.set(name, text);
        },
        undefined,
        true
      );
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
      dts({ dtsInput: true, tsconfig: false }),
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
 * the isolate's check reads them (src/type-check.ts), and its first
 * error, if any: in the program, its entry or a type chunk.
 */
const readByKit = (
  files: Readonly<Record<string, string>>,
  specifiers: readonly string[]
): { read: Set<string>; error: ts.Diagnostic | undefined } => {
  const entry = "/kit-types.ts";
  // Type chunks are checked too; the third-party declarations aren't.
  const options = { ...kitOptions, skipLibCheck: false };
  const read = new Set<string>();
  const directories = new Set(
    Object.keys(files).flatMap((file) =>
      file
        .split("/")
        .slice(1, -1)
        .map((_, index, parts) => `/${parts.slice(0, index + 1).join("/")}`)
    )
  );
  const readFile = (file: string): string | undefined => {
    if (!Object.hasOwn(files, file)) {
      return undefined;
    }
    read.add(file);
    return files[file];
  };
  const host: ts.CompilerHost = {
    getSourceFile: (file, languageVersion) => {
      const text = file === entry ? importing(specifiers) : readFile(file);
      return text === undefined
        ? undefined
        : ts.createSourceFile(file, text, languageVersion);
    },
    getDefaultLibFileName: (libOptions) =>
      `${libLocation}/${ts.getDefaultLibFileName(libOptions)}`,
    getDefaultLibLocation: () => libLocation,
    writeFile: () => {
      // Nothing is emitted.
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (file) => file === entry || Object.hasOwn(files, file),
    readFile,
    directoryExists: (directory) =>
      directory === "/" || directories.has(directory.replace(/\/+$/u, "")),
    getDirectories: () => [],
  };
  const program = ts.createProgram([entry], options, host);
  const checked = program
    .getSourceFiles()
    .filter(
      (file) =>
        file.fileName === entry ||
        Object.keys(ownPackages).some((name) =>
          file.fileName.startsWith(`/node_modules/${name}/`)
        )
    );
  const [error] = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...checked.flatMap((file) => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]),
  ];
  return { read, error };
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
      `The kit's type chunks don't type-check: ${error.file?.fileName ?? ""} ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`
    );
  }
  // TypeScript's own libs aren't the kit's: tsrs carries its own.
  const kept = Object.fromEntries(
    Object.entries(files).filter(
      ([file]) => read.has(file) && !file.startsWith(`${libLocation}/`)
    )
  );
  // Where each module App code may import resolves, as TypeScript resolves
  // it from an App file: the check maps exactly these names to these files
  // (type-check.ts `paths`), and nothing else of the kit.
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => Object.hasOwn(kept, file),
    readFile: (file) => (Object.hasOwn(kept, file) ? kept[file] : undefined),
    directoryExists: (directory) =>
      Object.keys(kept).some((file) =>
        file.startsWith(`${directory.replace(/\/+$/u, "")}/`)
      ),
  };
  const resolved: Record<string, string> = {};
  for (const specifier of specifiers) {
    const found = ts.resolveModuleName(specifier, "/app.ts", kitOptions, host)
      .resolvedModule?.resolvedFileName;
    if (found === undefined || !Object.hasOwn(kept, found)) {
      throw new Error(`The kit's types don't resolve ${specifier}`);
    }
    resolved[specifier] = found;
  }
  return { files: kept, resolved };
};

const componentsJsonSchema = z.looseObject({
  tailwind: z.looseObject({ css: z.string() }),
});

/** A class name as a stylesheet's `@utility` names one. */
const utilityName = /^-?[\w-]+$/u;

/**
 * Every class the kit's theme gives Tailwind by name, from Tailwind's own
 * design system of it, as `@utility` rules: what the design-system lint
 * reads as a class the theme declares. @shadcn/lint asks Tailwind which
 * classes it knows in a worker thread (`node:worker_threads`), which an
 * isolate has none of; without, it reads the theme's own declarations
 * and a grammar of its own, which know neither the theme's values
 * (`ease-house`) nor what its imports add (`animate-in`, tw-animate-css's).
 * With these it knows what Tailwind knows, as an exported App's lint,
 * whose worker runs, does.
 */
const kitClassRules = async (
  stylesheets: Record<string, string>
): Promise<string> => {
  const design = await __unstable__loadDesignSystem(
    stylesheets[kitStylesheet] ?? "",
    {
      // oxlint-disable-next-line require-await -- Tailwind expects a promise
      loadStylesheet: async (id: string) => {
        const content = stylesheets[id];
        if (content === undefined) {
          throw new Error(`The stylesheet "${id}" is not in the kit`);
        }
        return { path: id, base: "/", content };
      },
    }
  );
  return design
    .getClassList()
    .map(([name]) => name)
    .filter((name) => utilityName.test(name))
    .map((name) => `@utility ${name} {}`)
    .join("\n");
};

/**
 * The kit as the design-system lint reads it from disk (see src/lint.ts),
 * by path relative to the App. The kit's sources go in `ui/`: in
 * `node_modules`, the lint doesn't read components' sources, so it couldn't
 * name their variants. A tsconfig maps the kit's exports there; the
 * stylesheets the theme imports go in `node_modules`, where the lint looks.
 * The theme ends with every class Tailwind makes of it (`kitClassRules`).
 */
const collectLintProject = (
  stylesheets: Record<string, string>,
  classRules: string
): Record<string, string> => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app", private: true }),
    "ui/package.json": readText(path.join(ui, "package.json")),
  };
  for (const file of readdirSync(path.join(ui, "src"), {
    recursive: true,
    encoding: "utf-8",
  })) {
    const source = path.join(ui, "src", file);
    if (statSync(source).isFile() && !notShipped.test(file)) {
      files[`ui/src/${file}`] = readText(source);
    }
  }
  const components = componentsJsonSchema.parse(
    JSON.parse(readText(path.join(ui, "components.json")))
  );
  const theme = `ui/${components.tailwind.css}`;
  files[theme] =
    `${files[theme] ?? ""}\n/* Every class Tailwind makes of this theme, for the lint (build.ts). */\n${classRules}\n`;
  files["components.json"] = JSON.stringify({
    ...components,
    tailwind: { ...components.tailwind, css: `ui/${components.tailwind.css}` },
  });
  const paths: Record<string, string[]> = {};
  for (const [key, target] of Object.entries(exportsOf(ui))) {
    if (typeof target === "string") {
      const specifier = `@grasp-os/ui${key.slice(1)}`;
      paths[specifier] = [`./ui${target.slice(1)}`];
      // `components.json` names the components' directory by its alias.
      if (key.endsWith("/*")) {
        paths[specifier.slice(0, -2)] = [
          `./ui${path.posix.dirname(target.slice(1))}`,
        ];
      }
    }
  }
  files["tsconfig.json"] = JSON.stringify({ compilerOptions: { paths } });
  for (const [id, content] of Object.entries(stylesheets)) {
    if (id !== kitStylesheet) {
      files[`node_modules/${id.endsWith(".css") ? id : `${id}/index.css`}`] =
        content;
    }
  }
  return files;
};

const severity = z.enum(["off", "warn", "error"]);
const rulesSchema = z.record(
  z.string(),
  z.union([severity, z.tuple([severity]).rest(z.unknown())])
);

/** Node's built-ins, which the isolate has through `nodejs_compat`. */
const nodeBuiltins = [
  /^node:/u,
  ...builtinModules.filter((name) => !name.startsWith("_")),
];

/**
 * The React Compiler and TypeScript are CommonJS written for Node and
 * `require` Node's built-ins. An ES module has no `require`; the bundle's
 * `require` shim uses one if it is in scope, and `createRequire` makes one.
 * It takes the module's URL, and a Dynamic Worker's modules have no
 * `import.meta.url`, so this passes the URL the module would have. It goes
 * in after minifying, which would rename `require`.
 */
const requireShim = (moduleUrl: string): string =>
  `import { createRequire } from "node:module"; const require = createRequire("${moduleUrl}");`;

/**
 * Where the module would be, for the libraries that ask: TypeScript
 * (`__filename`, `__dirname`) and @shadcn/lint (`import.meta.url`). They
 * only look next to themselves for files that aren't there, and carry on
 * without them. Babel's generated code mentions them only as text.
 */
const moduleLocation = (moduleUrl: string) => ({
  "import.meta.url": JSON.stringify(moduleUrl),
  __filename: JSON.stringify(new URL(moduleUrl).pathname),
  __dirname: JSON.stringify("/"),
});

/**
 * The design-system lint (@shadcn/lint) loads its parser with a `require`
 * at runtime, which in the isolate only finds Node's built-ins: this hands
 * it the bundled typescript-eslint parser instead. oxc-parser, which it
 * tries first, has no build that runs in a Worker (its WASM one needs
 * threads); that `require` fails and it falls back to typescript-eslint.
 */
const shadcnParser: Plugin = {
  name: "shadcn-lint-parser",
  transform: (code, id) => {
    if (!id.endsWith("/@shadcn/lint/dist/index.js")) {
      return null;
    }
    const required = 'require("@typescript-eslint/parser")';
    if (!code.includes(required)) {
      throw new Error(
        "@shadcn/lint no longer requires its parser the way the build expects"
      );
    }
    return `import * as typescriptEslintParser from "@typescript-eslint/parser";
${code.replace(required, "typescriptEslintParser")}`;
  },
};

/**
 * Ultracite's rules (`#ultracite-rules`), worked out here, where its
 * presets, the plugins of their equivalents and oxlint load
 * (ultracite-rules.ts), into a module of Ultracite's bundle: the isolate
 * only reads them.
 * What of the presets has no equivalent is said once, as it is built.
 */
const ultraciteRulesModule: Plugin = {
  name: "ultracite-rules",
  enforce: "pre",
  resolveId: (id) => (id === "#ultracite-rules" ? "\0ultracite-rules" : null),
  load: (id) => {
    if (id !== "\0ultracite-rules") {
      return null;
    }
    const rules = ultraciteRules();
    console.log(
      `Ultracite's rules: ${Object.keys(rules.rules).length} linted, ${rules.fixable.length} fixed on a write; without an equivalent: ${rules.unmapped.join(", ")}`
    );
    return `export default ${JSON.stringify(rules)};`;
  },
};

/**
 * ESLint checks each rule's options against its JSON schema with Ajv,
 * which compiles a schema to code at runtime, which Workers forbid. Every
 * rule's options in the compiler are fixed (the design system's, and
 * Ultracite's), so the bundled ESLint checks none.
 */
const lintOptionsUnchecked: Plugin = {
  name: "lint-options-unchecked",
  transform: (code, id) => {
    if (!id.endsWith("/eslint/lib/config/config.js")) {
      return null;
    }
    const compiled = "validators.set(rule, getAjv().compile(schema));";
    if (!code.includes(compiled)) {
      throw new Error(
        "ESLint no longer compiles rule option schemas the way the build expects"
      );
    }
    return code.replace(compiled, "validators.set(rule, undefined);");
  },
};

/**
 * Packages the build would take a build of that doesn't run in the
 * isolate, taken as Node's `require` resolves them instead:
 * decode-named-character-reference (which unicorn loads), whose browser
 * build decodes with the DOM; and esquery (ESLint's selectors), whose ES
 * module ESLint's `require` would get as a namespace with no `parse`.
 */
const nodeResolved = new Set(["decode-named-character-reference", "esquery"]);

const resolvedAsNode: Plugin = {
  name: "resolved-as-node",
  enforce: "pre",
  resolveId: (id, importer) =>
    nodeResolved.has(id) && importer !== undefined
      ? createRequire(importer).resolve(id)
      : null,
};

/**
 * eslint-plugin-import-x resolves imports with unrs-resolver, which is
 * native and has no build that runs in a Worker (see `shadcnParser`); the
 * isolate has no project on disk to resolve them in anyway. It gets a
 * resolver that finds nothing: its rules that read what an import resolves
 * to pass over it, as they do any import they can't resolve, and the rest
 * read the file they are given.
 */
const importsUnresolved: Plugin = {
  name: "imports-unresolved",
  enforce: "pre",
  resolveId: (id, importer) =>
    id === "unrs-resolver" &&
    importer?.includes("/eslint-plugin-import-x/") === true
      ? "\0unrs-resolver"
      : null,
  load: (id) =>
    id === "\0unrs-resolver"
      ? `export class ResolverFactory {
  sync() { return { error: "No resolver in the isolate" }; }
  async async() { return { error: "No resolver in the isolate" }; }
}`
      : null,
};

/**
 * Two of the rules' plugins read their own package.json from disk as they
 * load, for their name and version: eslint-plugin-jsdoc, and
 * eslint-plugin-import-x (its meta). The isolate has no such file, so the
 * build puts the file in place of the read.
 */
const packageJsonReads: Record<string, string> = {
  "/eslint-plugin-jsdoc/src/":
    "JSON.parse(\n  readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),\n)",
  "/eslint-plugin-import-x/lib/meta.js": "cjsRequire('../package.json')",
};

const packageJsonInlined: Plugin = {
  name: "package-json-inlined",
  transform: (code, id) => {
    const read = Object.entries(packageJsonReads).find(([where]) =>
      id.includes(where)
    )?.[1];
    if (read === undefined || !code.includes(read)) {
      return null;
    }
    const text = readText(path.join(path.dirname(id), "../package.json"));
    return code.replace(read, text);
  },
};

/**
 * What the compiler's and Ultracite's bundles both need: the ESLint they
 * each run (the design system's lint, and Ultracite's) checks no rule's
 * options in the isolate, and reads selectors with esquery's CommonJS
 * build (`lintOptionsUnchecked`, `resolvedAsNode`).
 */
const isolateBuild = (
  entry: string,
  fileName: string,
  plugins: Plugin[]
): InlineConfig => {
  const moduleUrl = `file:///${fileName}`;
  return {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: {
      noExternal: true,
      target: "webworker",
      // Production's, whatever `NODE_ENV` is (`kitResolve`): micromark,
      // under Ultracite's jsdoc rules, ships a build for each.
      resolve: { conditions: ["workerd", "worker", "browser", "production"] },
    },
    define: { ...production, ...moduleLocation(moduleUrl) },
    plugins: [...plugins, resolvedAsNode, lintOptionsUnchecked],
    build: {
      ssr: entry,
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        external: ["cloudflare:workers", "#kit", ...nodeBuiltins],
        output: {
          format: "es",
          codeSplitting: false,
          paths: { "#kit": kitModule },
          postBanner: requireShim(moduleUrl),
        },
      },
    },
  };
};

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
 * The compiler's main module. It imports what it knows of the kit (`#kit`)
 * as a module of its own, `kit.json`, which the isolate is started with:
 * most of it is the type check's declarations, which the compiler's code
 * doesn't need to carry.
 */
const buildCompiler = async (): Promise<string> =>
  await oneModule(
    isolateBuild("src/worker.ts", compilerAssets.source, [shadcnParser]),
    "The compiler"
  );

/**
 * Ultracite's lint and format (src/ultracite-worker.ts), a module of its
 * own that core runs in an isolate of its own: about as large as the
 * compiler (ESLint with every rule's plugin, and Prettier), it isn't
 * loaded by an isolate that only builds, nor read by core but to start
 * one that lints.
 */
const buildUltracite = async (): Promise<string> =>
  await oneModule(
    isolateBuild("src/ultracite-worker.ts", compilerAssets.ultracite, [
      ultraciteRulesModule,
      packageJsonInlined,
      importsUnresolved,
    ]),
    "Ultracite's lint"
  );

/**
 * The package builder's module (src/packages/worker.ts), which core runs
 * in an isolate of its own for each use. It runs without Node.js
 * compatibility: nothing it bundles may import Node's built-ins.
 */
const buildPackageBuilder = async (): Promise<string> => {
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: { noExternal: true, target: "webworker" },
    define: production,
    build: {
      ssr: "src/packages/worker.ts",
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        // esbuild's WebAssembly is a module of the isolate of its own.
        external: ["cloudflare:workers", "./esbuild.wasm"],
        output: { format: "es", codeSplitting: false },
      },
    },
  };
  const [chunk, ...rest] = chunksOf(await build(config));
  if (chunk === undefined || rest.length > 0) {
    throw new Error("The package builder should build to one module");
  }
  return chunk.code;
};

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
 * fails its screen builds. Three covers a server that hasn't reloaded while
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
  const { entries: icons, icons: iconNames } = iconEntries();
  const components = uiEntries();
  const react = reactSpecifiers.map((specifier) => ({
    specifier,
    id: `${virtualEntry}${specifier}`,
  }));
  const {
    code: kitCode,
    imports: moduleImports,
    sources,
  } = await buildKitModules([
    ...react,
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
        ...components,
        ...icons,
        ...sdkEntries([previewRefresh, previewRuntime]),
      ],
      "preview"
    );
  const imports = [
    ...reactImports,
    ...components.map(({ specifier }) => specifier),
    screenHooks,
    screenSdk,
    sdkRoot,
  ];
  const stylesheets = collectStylesheets();
  // Generated workflow code and compute modules are type-checked against
  // their SDK entries too, and an App's server code against the SDK's
  // server side.
  const typed = [
    ...imports,
    "lucide-react",
    ...openWorkflowSdkImports,
    ...computeSdkImports,
    // An App's server code is type-checked against what it and its
    // generated modules import (app-code.ts).
    ...serverSdkImports,
    "@grasp-os/sdk/database",
    // And its tests, against the SDK's testing module (app-code.ts).
    "@grasp-os/sdk/testing",
    // And its workflows, against the SDK's workflow modules.
    ...sdkImports,
  ];
  const typeSources = collectTypes(typed);
  const kit: Kit = {
    imports,
    icons: iconNames,
    stylesheets,
    moduleCandidates: candidatesByModule(sources),
    moduleImports,
    previewModuleImports,
    lintProject: collectLintProject(
      stylesheets,
      await kitClassRules(stylesheets)
    ),
    // The repo's lint config extends the same preset.
    lintRules: rulesSchema.parse(shadcnPreset.rules),
  };
  const kitJson = JSON.stringify(kit);
  const typesJson = JSON.stringify(await typeChunks(typeSources, typed));
  // The sources the type chunks are made of, which the agent reads.
  const referenceJson = JSON.stringify(referenceOf(typeSources));
  const compiler = await buildCompiler();
  const ultracite = await buildUltracite();
  const packageBuilder = await buildPackageBuilder();
  const checker = await buildChecker();
  // The WebAssembly the type checker runs, as the package ships it.
  const tsrsWasm = readFileSync(require.resolve("@tsrs/wasm/tsrs.wasm"));
  // The WebAssembly the builder's esbuild runs, as the package ships it.
  const esbuildWasm = readFileSync(
    require.resolve("esbuild-wasm/esbuild.wasm")
  );
  // jq's, which every workflow isolate loads beside the SDK's modules.
  const jqWasm = readFileSync(jqWasmSource);
  const kitModules = modulesOf(kitCode);
  const kitPreviewModules = modulesOf(previewKitCode);
  // App workflows and the code generated from JSON workflows share one set:
  // each imports only its own entry of it (imports.ts).
  const workflowSdkModules = modulesOf(
    await buildSdkModules([
      ...sdkImports,
      ...openWorkflowSdkImports,
      ...computeSdkImports,
      ...computeRunnerImports,
    ])
  );
  const serverSdkModules = modulesOf(await buildSdkModules(serverSdkImports));
  // Everything a build depends on: the compiler, what it knows of the kit,
  // and the kit's and the SDK's modules the App's modules import; and the
  // agent's reference, which a change to the sources' comments alone
  // changes.
  const version = createHash("sha256")
    .update(compiler)
    .update(kitJson)
    .update(referenceJson)
    .update(kitModules.version)
    .update(kitPreviewModules.version)
    .update(workflowSdkModules.version)
    .update(serverSdkModules.version)
    .update(ultracite)
    .update(packageBuilder)
    .update(esbuildWasm)
    .update(jqWasm)
    .update(checker)
    .update(typesJson)
    .update(tsrsWasm)
    .digest("hex")
    .slice(0, 16);
  writeRelease(assets, version, {
    [compilerAssets.source]: compiler,
    [compilerAssets.ultracite]: ultracite,
    [compilerAssets.kit]: kitJson,
    [compilerAssets.kitModules]: JSON.stringify(kitModules),
    [compilerAssets.kitPreviewModules]: JSON.stringify(kitPreviewModules),
    [compilerAssets.workflowSdkModules]: JSON.stringify(workflowSdkModules),
    [compilerAssets.serverSdkModules]: JSON.stringify(serverSdkModules),
    [compilerAssets.packageBuilder]: packageBuilder,
    [compilerAssets.esbuildWasm]: esbuildWasm,
    [compilerAssets.reference]: referenceJson,
    [compilerAssets.jqWasm]: jqWasm,
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
