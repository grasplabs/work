/**
 * App compiler: builds an App's screens into ES modules and CSS, in a
 * Dynamic Worker of its own. The modules import each other and the kit's
 * modules by flat name (see kit.ts); a page maps those names to the code
 * with an import map.
 *
 * The compiler's code and what it knows of the kit are many times core's
 * size, and most requests never build. They are core's static assets
 * (`compilerAssets`), read when a build starts an isolate; core itself
 * imports only the version.
 */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { isolateBase, withNode } from "@grasp-os/shared/runtime";
import { inTurn, sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun, Turns } from "@grasp-os/shared/shared-runs";

import { version } from "#version";

import type TypeChecker from "./checker.ts";
import { compilerAssets, kitModule, typesModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type PackageBuilder from "./packages/worker.ts";
import type UltraciteLinter from "./ultracite-worker.ts";
import type AppCompiler from "./worker.ts";

export { isDesignRule } from "./diagnostic.ts";
export type { Diagnostic } from "./diagnostic.ts";
export { withTypeCheck } from "./checked-build.ts";
export type { TypeCheckPlan, Unchecked } from "./checked-build.ts";
export type { TypeCheckRequest } from "./type-check.ts";
export type { KitModules } from "./kit.ts";
export type { BuildRequest, InspectRequest } from "./packages/worker.ts";
export { expressionTypeCheck } from "./expression-types.ts";
export type {
  ExpressionScopeTypes,
  ExpressionTypeCheck,
  ExpressionTypeError,
  TypedExpression,
} from "./expression-types.ts";
export type {
  AppCodeBuild,
  CompileTarget,
  IncrementalTarget,
  ComputeModulesBuild,
  InspectTarget,
  GeneratedWorkflowBuild,
  ScreenBuild,
  TargetBuilds,
  TargetInspections,
} from "./worker.ts";
export {
  appCodeFiles,
  appCodeKind,
  appTestFiles,
  generatedModules,
  isAppLayout,
  isAppTestSuite,
  isUnderAppTests,
  serverEntryPath,
  serverEntrySource,
  strayTestFileMessage,
  strayTestFiles,
} from "./app-code.ts";
export {
  appCodeLimitErrors,
  buildFiles,
  computeModuleErrors,
  isDesignLinted,
  isGeneratedPath,
  isLintedCode,
  limitErrors,
  generatedWorkflowEntry,
  generatedWorkflowErrors,
} from "./inputs.ts";
export {
  appModuleName,
  computePackagesFile,
  kitModuleName,
  packageModuleName,
  packageModulePrefix,
  previewRuntime,
  screenRuntime,
} from "./kit.ts";
export {
  designContextKey,
  incrementSchema,
  lintKey,
  lintRecordOf,
  moduleRecordOf,
  screenIncrementKeys,
  screenSources,
} from "./increments.ts";
export type {
  BuildMetrics,
  IncrementalBuild,
  Increments,
  LintRecord,
  ModuleRecord,
} from "./increments.ts";
export { screenRefusals } from "./refusals.ts";
export { platformPeers, platformScope } from "./packages/platform.ts";
/** Part of every build's cache key: a new compiler or kit builds again. */
export { version as compilerVersion } from "#version";

/**
 * One of this release's compiler files, from core's static assets. The
 * assets answer unknown paths with the frontend's index.html, so anything
 * but the file's own type means it is missing.
 */
const readCompilerFile = async (
  assets: Fetcher,
  file: string,
  type: string
): Promise<string> => {
  const url = `https://assets${compilerAssets.directory(version)}/${file}`;
  const response = await assets.fetch(url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!(response.ok && contentType.includes(type))) {
    throw new Error(
      `The App compiler's ${file} is not among the static assets: build the compiler into them (packages/compiler/build.ts).`
    );
  }
  return await response.text();
};

/** One of this release's compiler files as bytes, as `readCompilerFile` reads text. */
const readCompilerBytes = async (
  assets: Fetcher,
  file: string,
  type: string
): Promise<ArrayBuffer> => {
  const url = `https://assets${compilerAssets.directory(version)}/${file}`;
  const response = await assets.fetch(url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!(response.ok && contentType.includes(type))) {
    throw new Error(
      `The App compiler's ${file} is not among the static assets: build the compiler into them (packages/compiler/build.ts).`
    );
  }
  return await response.arrayBuffer();
};

const isKitModules = (value: unknown): value is KitModules =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  "modules" in value;

const parseModules = async (
  assets: Fetcher,
  file: string
): Promise<KitModules> => {
  const parsed: unknown = JSON.parse(
    await readCompilerFile(assets, file, "json")
  );
  if (!isKitModules(parsed)) {
    throw new Error(`${file} is not in the expected shape.`);
  }
  return parsed;
};

/** The longest a read of platform code from the assets may take. */
export const platformCodeReadMs = 10_000;

/**
 * A read of platform code from the assets, shared by the builds that ask
 * for it while it runs, by assets binding and then by what is read and
 * its release's version, so builds that start together hold one copy,
 * for as long as a read may take (`sharedRun`): one whose request was
 * cancelled holds no other. With `keep`, what was read stays for the
 * isolate's life (only a read that worked); without, it goes once read.
 * With `turns`, it runs in turn with the other reads of those (`inTurn`).
 */
const reader = <T>(keep: boolean, turns?: Turns) => {
  const done = new WeakMap<Fetcher, Map<string, T>>();
  const running = new WeakMap<Fetcher, Map<string, SharedRun<T>>>();
  return async (
    assets: Fetcher,
    key: string,
    read: () => Promise<T>
  ): Promise<T> => {
    const reads = done.get(assets) ?? new Map<string, T>();
    const kept = reads.get(key);
    if (kept !== undefined) {
      return kept;
    }
    const reading = running.get(assets) ?? new Map<string, SharedRun<T>>();
    running.set(assets, reading);
    const code = await sharedRun(
      reading,
      key,
      platformCodeReadMs,
      turns === undefined
        ? read
        : async () => await inTurn(turns, platformCodeReadMs, read)
    );
    if (keep) {
      reads.set(key, code);
      done.set(assets, reads);
    }
    return code;
  };
};

/**
 * Loader isolates' code, never kept (`reader`): the compiler's source is
 * 22 MB as a string, its kit 11 MB of types, and the package builder's
 * esbuild WebAssembly 14 MB, while core's isolate has 128 MB for everything it does, the chat's
 * agent and the connections of the people on it included. Kept for good
 * in every isolate that ever built, they left too little for the rest,
 * and core ran out of memory (staging, November 2026). Only the Loader
 * needs them, to start an isolate: the compiler's stays warm under its
 * App's and release's name (`startAppCompiler`), and the Loader asks for its code
 * only when it isn't, so a warm build reads none of it.
 *
 * A cold check starts the compiler's isolate and Ultracite's together:
 * their reads at once would be about 60 MB of the 128 (Ultracite's is
 * mostly oxc's 11 MB of WebAssembly). So the reads of
 * platform code run one at a time (`platformCodeTurns`): each holds its
 * copy only until the Loader has it, and then the next reads.
 */
const platformCodeTurns: Turns = {};

const workerCodeRead = reader<WorkerLoaderWorkerCode>(false, platformCodeTurns);

/** esbuild's WebAssembly, never kept (`workerCodeRead`). */
const wasmRead = reader<ArrayBuffer>(false);

/**
 * esbuild's WebAssembly, as the package builder loads it: one read shared
 * by the builds that start at once, as it is the largest file it reads.
 */
const esbuildWasmOf = async (assets: Fetcher): Promise<ArrayBuffer> =>
  await wasmRead(
    assets,
    compilerAssets.esbuildWasm,
    async () =>
      await readCompilerBytes(assets, compilerAssets.esbuildWasm, "wasm")
  );

/**
 * The module sets every App imports, kept (`reader`): every screen build
 * picks its closure from them, and they are a few MB each.
 */
const modulesRead = reader<KitModules>(true);

/**
 * A set of modules from the static assets: each is read once per isolate,
 * as every App imports the same set (`reader`); a failed read isn't kept.
 */
const readModules = async (
  assets: Fetcher,
  file: string
): Promise<KitModules> =>
  await modulesRead(assets, file, async () => await parseModules(assets, file));

/** The kit's modules, which every App's modules import: one set per release. */
export const kitModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.kitModules);

/**
 * The preview kit's modules (spec 19.2.1), which a chat's preview of a
 * draft loads in place of the kit's: React's development builds and
 * React Fast Refresh. One set per release.
 */
export const kitPreviewModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.kitPreviewModules);

/**
 * The SDK's modules the isolates core runs outside the screens load (a
 * sealed run's, a JSON workflow's generated and compute modules', an
 * App's tests'): one set per release.
 */
export const workflowSdkModules = async (
  assets: Fetcher
): Promise<KitModules> =>
  await readModules(assets, compilerAssets.workflowSdkModules);

/**
 * The SDK modules an App's server isolate loads (`serverSdkImports`),
 * which a sealed release carries: one set per release.
 */
export const serverSdkModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.serverSdkModules);

/** The agent's reference, read once per isolate (`reader`): 2 MB, read at each of its tools' calls. */
const referenceRead = reader<Readonly<Record<string, string>>>(true);

/**
 * The SDK's and the UI kit's sources, by path (`@grasp-os/sdk/src/app.ts`):
 * what a chat's agent reads to write an App. The check reads the type
 * chunks the release rolls up from these same sources. One set per
 * release.
 */
export const referenceFiles = async (
  assets: Fetcher
): Promise<Readonly<Record<string, string>>> =>
  await referenceRead(assets, compilerAssets.reference, async () => {
    const parsed: unknown = JSON.parse(
      await readCompilerFile(assets, compilerAssets.reference, "json")
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Object.values(parsed).every((text) => typeof text === "string")
    ) {
      throw new Error(
        `${compilerAssets.reference} is not in the expected shape.`
      );
    }
    // SAFETY: an object of strings, checked above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return parsed as Record<string, string>;
  });

/**
 * How the compiler's isolate runs: no bindings, no importable env, no
 * network (`globalOutbound: null` and no subrequests), and at most one
 * build task's CPU per call (spec 18.1, `compilerTaskCpuMs`: 60 s), many
 * times what a large App takes. `nodejs_compat` is for the React
 * Compiler, which is written for Node.
 */
export const isolateSettings = {
  ...isolateBase,
  compatibilityFlags: withNode(isolateBase.compatibilityFlags),
  env: {},
  globalOutbound: null,
  limits: { cpuMs: platformLimits.compilerTaskCpuMs, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** The compiler's isolate as a Loader takes it, its code read from the assets. */
const compilerWorker = async (
  assets: Fetcher
): Promise<WorkerLoaderWorkerCode> =>
  await workerCodeRead(assets, `compiler:${version}`, async () => {
    const [source, kitJson] = await Promise.all([
      readCompilerFile(assets, compilerAssets.source, "javascript"),
      readCompilerFile(assets, compilerAssets.kit, "json"),
    ]);
    const kit: unknown = JSON.parse(kitJson);
    return {
      ...isolateSettings,
      mainModule: "compiler.js",
      modules: { "compiler.js": source, [kitModule]: { json: kit } },
    };
  });

/**
 * The name of `whose` warm compiler isolate: the App's (or independent
 * workflow's) ID and the release's compiler version, never anything of its
 * code; with no `whose`, the release's one isolate every App's builds
 * share. Each unique name is a Dynamic Worker billed per day, and workerd
 * keeps a named isolate for as long as the process runs: a name per build,
 * or per version of an App's code, would start and keep one compiler for
 * every build ever made.
 */
export const appCompilerName = (whose?: string): string =>
  whose === undefined ? `compiler:${version}` : `compiler:${version}:${whose}`;

/**
 * The compiler, warm in a named isolate with its code read from core's
 * static assets: a build doesn't load the compiler and the kit again, so a
 * change to an App shows at once. With `whose` (on Cloudflare), there is
 * one isolate per App and release, which keeps Apps apart: the isolate's
 * limits, and a recycle or a kill at them, are that App's builds' alone,
 * never another App's. Without it (off Cloudflare), every App's builds
 * share one: workerd never unloads a named isolate while the process
 * runs, so one per App would keep a compiler for every App ever built.
 * The compiler parses and transforms App code but never runs it, and the
 * isolate has no bindings, no network and no subrequests
 * (`isolateSettings`). Shared by several builds, its limits are theirs
 * together: a stop at them may be another build's doing
 * (`loadAppCompiler`).
 */
export const startAppCompiler = (
  loader: WorkerLoader,
  assets: Fetcher,
  /**
   * Whose builds it runs alone: the App's, or an independent workflow's,
   * ID. Omitted, every App's builds share it.
   */
  whose?: string
): Service<AppCompiler> =>
  loader
    .get(appCompilerName(whose), async () => await compilerWorker(assets))
    .getEntrypoint<AppCompiler>();

/**
 * The compiler in a fresh isolate of its own, for one build: what a stop
 * at its limits says is that build's alone, as it is in the shared one
 * only when nothing else compiled beside it.
 */
export const loadAppCompiler = async (
  loader: WorkerLoader,
  assets: Fetcher
): Promise<Service<AppCompiler>> =>
  loader.load(await compilerWorker(assets)).getEntrypoint<AppCompiler>();

/**
 * The App compiler's or the package builder's code as bytes, for the
 * on-prem sandbox host, which loads it in a process of its own
 * (apps/core/src/platform-sandbox.ts): its modules, whether it needs
 * `nodejs_compat`, and the CPU time a call may use, as `isolateSettings`
 * and `packageBuilderSettings` give them a Loader isolate.
 */
export interface PlatformCode {
  mainModule: string;
  modules: Record<string, { type: "js" | "json" | "wasm"; bytes: Uint8Array }>;
  nodejsCompat: boolean;
  cpuMs: number;
}

/**
 * The sandbox host's platform code, read once per isolate (`reader`):
 * on-prem, where core runs on plain workerd with no Loader to keep the
 * compiler warm, so every build hands it over.
 */
const platformCodeRead = reader<PlatformCode>(true, platformCodeTurns);

/**
 * The App compiler's code, read from core's static assets once per
 * isolate (`platformCodeRead`): the sandbox host runs one call per process,
 * so nothing there stays warm. The kit goes as its JSON text, which core
 * never parses.
 */
export const appCompilerCode = async (assets: Fetcher): Promise<PlatformCode> =>
  await platformCodeRead(assets, `compiler:${version}`, async () => {
    const [source, kit] = await Promise.all([
      readCompilerBytes(assets, compilerAssets.source, "javascript"),
      readCompilerBytes(assets, compilerAssets.kit, "json"),
    ]);
    return {
      mainModule: "compiler.js",
      modules: {
        "compiler.js": { type: "js", bytes: new Uint8Array(source) },
        [kitModule]: { type: "json", bytes: new Uint8Array(kit) },
      },
      nodejsCompat: true,
      cpuMs: isolateSettings.limits.cpuMs,
    };
  });

/**
 * How the type checker's isolate runs: no bindings, no importable env, no
 * network, no Node.js compatibility, and at most one build task's CPU per
 * call (spec 18.1, `compilerTaskCpuMs`), as the compiler's.
 */
export const checkerSettings = {
  ...isolateBase,
  env: {},
  globalOutbound: null,
  limits: { cpuMs: platformLimits.compilerTaskCpuMs, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * The name the type checker's isolate has in the Loader: its release's
 * version and nothing else, never an App's ID or code, so every App's
 * checks share one isolate (a Dynamic Worker is billed per name a day,
 * and an unnamed one is a new name each time). It is safe to share: tsrs
 * keeps nothing between checks (checker.ts), and the isolate has no
 * bindings and no network.
 */
export const typeCheckerName = `check:${version}`;

/** The type checker's code as a Loader takes it, read from the assets. */
const typeCheckerWorker = async (
  assets: Fetcher
): Promise<WorkerLoaderWorkerCode> =>
  await workerCodeRead(assets, typeCheckerName, async () => {
    const [source, typesJson, wasm] = await Promise.all([
      readCompilerFile(assets, compilerAssets.checker, "javascript"),
      readCompilerFile(assets, compilerAssets.types, "json"),
      readCompilerBytes(assets, compilerAssets.tsrsWasm, "wasm"),
    ]);
    const types: unknown = JSON.parse(typesJson);
    return {
      ...checkerSettings,
      mainModule: compilerAssets.checker,
      modules: {
        [compilerAssets.checker]: source,
        [typesModule]: { json: types },
        // Compiled as the isolate loads; the isolate itself can't.
        [compilerAssets.tsrsWasm]: { wasm },
      },
    };
  });

/**
 * The type checker (src/checker.ts), in the one isolate of its release
 * (`typeCheckerName`), its code read from core's static assets only when
 * the Loader has no isolate of that name warm.
 */
export const startTypeChecker = (
  loader: WorkerLoader,
  assets: Fetcher
): Service<TypeChecker> =>
  loader
    .get(typeCheckerName, async () => await typeCheckerWorker(assets))
    .getEntrypoint<TypeChecker>();

/**
 * The type checker in a fresh, unnamed isolate of its own, for one check
 * stopped in the shared one (`startTypeChecker`): what a stop there says
 * is that check's alone, never another App's beside it. Only ever after
 * a stop, as an unnamed isolate is a new Dynamic Worker each time.
 */
export const loadTypeChecker = async (
  loader: WorkerLoader,
  assets: Fetcher
): Promise<Service<TypeChecker>> =>
  loader.load(await typeCheckerWorker(assets)).getEntrypoint<TypeChecker>();

/**
 * The type checker's code, for the on-prem sandbox host, as
 * `appCompilerCode` gives the compiler's.
 */
export const typeCheckerCode = async (assets: Fetcher): Promise<PlatformCode> =>
  await platformCodeRead(assets, typeCheckerName, async () => {
    const [source, types, wasm] = await Promise.all([
      readCompilerBytes(assets, compilerAssets.checker, "javascript"),
      readCompilerBytes(assets, compilerAssets.types, "json"),
      readCompilerBytes(assets, compilerAssets.tsrsWasm, "wasm"),
    ]);
    return {
      mainModule: compilerAssets.checker,
      modules: {
        [compilerAssets.checker]: { type: "js", bytes: new Uint8Array(source) },
        [typesModule]: { type: "json", bytes: new Uint8Array(types) },
        [compilerAssets.tsrsWasm]: {
          type: "wasm",
          bytes: new Uint8Array(wasm),
        },
      },
      nodejsCompat: false,
      cpuMs: checkerSettings.limits.cpuMs,
    };
  });

/**
 * How the package builder's isolate runs: no bindings, no importable env,
 * no network (`globalOutbound: null` and no subrequests), no Node.js
 * compatibility (`isolateBase`), and at most one build task's CPU per call (spec 18.1,
 * `compilerTaskCpuMs`: 60 s), as the compiler's.
 */
export const packageBuilderSettings = {
  ...isolateBase,
  env: {},
  globalOutbound: null,
  limits: { cpuMs: platformLimits.compilerTaskCpuMs, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * The package builder (src/packages/worker.ts) in a fresh isolate of its
 * own, with its code read from core's static assets: one per resolve or
 * build, so nothing one App's packages leave in memory is there for the
 * next. It reads and bundles the bytes it is handed and runs none of
 * them.
 */
export const startPackageBuilder = async (
  loader: WorkerLoader,
  assets: Fetcher
): Promise<Service<PackageBuilder>> => {
  const code = await workerCodeRead(
    assets,
    `package-builder:${version}`,
    async () => {
      const [source, wasm] = await Promise.all([
        readCompilerFile(assets, compilerAssets.packageBuilder, "javascript"),
        esbuildWasmOf(assets),
      ]);
      return {
        ...packageBuilderSettings,
        mainModule: "package-builder.js",
        modules: {
          "package-builder.js": source,
          // Compiled as the isolate loads; the isolate itself can't.
          "esbuild.wasm": { wasm },
        },
      };
    }
  );
  return loader.load(code).getEntrypoint<PackageBuilder>();
};

/**
 * The package builder's code, for the on-prem sandbox host as
 * `appCompilerCode` gives the compiler's: esbuild's WebAssembly goes
 * as its bytes, which the sandbox host compiles as it loads the isolate.
 */
export const packageBuilderCode = async (
  assets: Fetcher
): Promise<PlatformCode> =>
  await platformCodeRead(assets, `package-builder:${version}`, async () => {
    const [source, wasm] = await Promise.all([
      readCompilerBytes(assets, compilerAssets.packageBuilder, "javascript"),
      esbuildWasmOf(assets),
    ]);
    return {
      mainModule: "package-builder.js",
      modules: {
        "package-builder.js": { type: "js", bytes: new Uint8Array(source) },
        "esbuild.wasm": { type: "wasm", bytes: new Uint8Array(wasm) },
      },
      nodejsCompat: false,
      cpuMs: packageBuilderSettings.limits.cpuMs,
    };
  });

/**
 * Ultracite's lint and format (src/ultracite-worker.ts) in an isolate as
 * the compiler's runs (`isolateSettings`), its code read from the assets
 * only to start the isolate and never kept (`workerCodeRead`): a build,
 * or a core isolate that never lints, reads none of it.
 */
const ultraciteWorker = async (
  assets: Fetcher
): Promise<WorkerLoaderWorkerCode> =>
  await workerCodeRead(assets, `ultracite:${version}`, async () => {
    const [source, wasm] = await Promise.all([
      readCompilerFile(assets, compilerAssets.ultracite, "javascript"),
      readCompilerBytes(assets, compilerAssets.oxcWasm, "wasm"),
    ]);
    return {
      ...isolateSettings,
      mainModule: compilerAssets.ultracite,
      modules: {
        [compilerAssets.ultracite]: source,
        // Compiled as the isolate loads; the isolate itself can't.
        [compilerAssets.oxcWasm]: { wasm },
      },
    };
  });

/**
 * Ultracite's lint, in one isolate per release that every App's writes
 * and checks share, kept warm as the compiler's is (`startAppCompiler`),
 * and as safe to share: it parses App code and never runs it. Apart from
 * the compiler's, so a lint never shares a build's limits.
 */
export const startUltracite = (
  loader: WorkerLoader,
  assets: Fetcher
): Service<UltraciteLinter> =>
  loader
    .get(`ultracite:${version}`, async () => await ultraciteWorker(assets))
    .getEntrypoint<UltraciteLinter>();

/** Ultracite's lint in a fresh isolate of its own, as `loadAppCompiler` the compiler. */
export const loadUltracite = async (
  loader: WorkerLoader,
  assets: Fetcher
): Promise<Service<UltraciteLinter>> =>
  loader.load(await ultraciteWorker(assets)).getEntrypoint<UltraciteLinter>();

/** Ultracite's lint's code, for the on-prem sandbox host, as `appCompilerCode` gives the compiler's. */
export const ultraciteCode = async (assets: Fetcher): Promise<PlatformCode> =>
  await platformCodeRead(assets, `ultracite:${version}`, async () => {
    const [source, wasm] = await Promise.all([
      readCompilerBytes(assets, compilerAssets.ultracite, "javascript"),
      readCompilerBytes(assets, compilerAssets.oxcWasm, "wasm"),
    ]);
    return {
      mainModule: compilerAssets.ultracite,
      modules: {
        [compilerAssets.ultracite]: {
          type: "js",
          bytes: new Uint8Array(source),
        },
        [compilerAssets.oxcWasm]: { type: "wasm", bytes: new Uint8Array(wasm) },
      },
      nodejsCompat: true,
      cpuMs: isolateSettings.limits.cpuMs,
    };
  });
