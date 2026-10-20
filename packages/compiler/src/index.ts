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
import { isolateBase } from "@grasp-os/shared/runtime";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";

import { version } from "#version";

import { compilerAssets, kitModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type PackageBuilder from "./packages/worker.ts";
import type AppCompiler from "./worker.ts";

export type { Diagnostic } from "./diagnostic.ts";
export type { KitModules } from "./kit.ts";
export type { BuildRequest, InspectRequest } from "./packages/worker.ts";
export type {
  AppCodeBuild,
  CompileTarget,
  ComputeModulesBuild,
  InspectTarget,
  OpenWorkflowBuild,
  ScreenBuild,
  ServerBuild,
  TargetBuilds,
  TargetInspections,
  WorkflowBuild,
} from "./worker.ts";
export {
  appCodeFiles,
  appCodeKind,
  appTestFiles,
  generatedFolder,
  generatedModules,
  isAppLayout,
  isAppTestSuite,
  isUnderAppTests,
  strayTestFileMessage,
  strayTestFiles,
  workflowBindingsPath,
  workflowBuildFiles,
} from "./app-code.ts";
export {
  appCodeLimitErrors,
  buildFiles,
  computeModuleErrors,
  limitErrors,
  openWorkflowEntry,
  openWorkflowErrors,
  serverFiles,
  workflowFiles,
  workflowIdOf,
  workflowPaths,
} from "./inputs.ts";
export {
  appModuleName,
  computePackagesFile,
  kitModuleName,
  packageModuleName,
  screenRuntime,
} from "./kit.ts";
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

/**
 * The sets of modules read so far, by file: each is read from the static
 * assets once per isolate, as every App imports the same set.
 */
const modulesRead = new Map<string, Promise<KitModules>>();

/** A set of modules from the static assets; a failed read isn't kept. */
const readModules = async (
  assets: Fetcher,
  file: string
): Promise<KitModules> => {
  let read = modulesRead.get(file);
  if (read === undefined) {
    read = parseModules(assets, file);
    modulesRead.set(file, read);
  }
  try {
    return await read;
  } catch (error) {
    modulesRead.delete(file);
    throw error;
  }
};

/** The kit's modules, which every App's modules import: one set per release. */
export const kitModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.kitModules);

/**
 * The workflow SDK's modules, which every App's workflows import
 * (`sdkImports`): one set per release.
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

/**
 * How the compiler's isolate runs: no bindings, no importable env, no
 * network (`globalOutbound: null` and no subrequests), and at most 20 s of
 * CPU per call, many times what a large App takes. `nodejs_compat` is for
 * the React Compiler, which is written for Node.
 */
export const isolateSettings = {
  ...isolateBase,
  compatibilityFlags: [...isolateBase.compatibilityFlags, "nodejs_compat"],
  env: {},
  globalOutbound: null,
  limits: { cpuMs: 20_000, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/** The compiler's isolate as a Loader takes it, its code read from the assets. */
const compilerWorker = async (
  assets: Fetcher
): Promise<WorkerLoaderWorkerCode> => {
  const [source, kitJson] = await Promise.all([
    readCompilerFile(assets, compilerAssets.source, "javascript"),
    readCompilerFile(assets, compilerAssets.kit, "json"),
  ]);
  const kit: unknown = JSON.parse(kitJson);
  return {
    ...isolateSettings,
    mainModule: "compiler.js",
    modules: {
      "compiler.js": source,
      [kitModule]: { json: kit },
    },
  };
};

/**
 * The compiler, in one isolate per release that every build shares, with
 * its code read from core's static assets. Kept warm, a build doesn't load
 * the compiler and the kit again, so a change to an App shows at once. It
 * is safe to share: the compiler parses and transforms App code but never
 * runs it, and the isolate has no bindings, no network and no subrequests
 * (`isolateSettings`). App code itself never runs here. The name holds
 * only the release's compiler version: workerd keeps a named isolate for
 * as long as the process runs, so a name per build would keep one
 * compiler for every build ever made. Being shared, its limits are every
 * build's together: a stop at them may be another build's doing
 * (`loadAppCompiler`).
 */
export const startAppCompiler = (
  loader: WorkerLoader,
  assets: Fetcher
): Service<AppCompiler> =>
  loader
    .get(`compiler:${version}`, async () => await compilerWorker(assets))
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
 * The platform code read so far, by assets binding and then by what it is
 * and its release's version: read once per isolate, as it is the
 * release's, so a build doesn't read 15 to 28 MB of it from the assets
 * before the sandbox has even taken it. Only a read that worked is kept.
 */
const platformCodeRead = new WeakMap<Fetcher, Map<string, PlatformCode>>();

/**
 * The reads running now, by the same keys: builds that start together
 * share one, for as long as a read may take (`sharedRun`), so one whose
 * request was cancelled holds no other build.
 */
const platformCodeReading = new WeakMap<
  Fetcher,
  Map<string, SharedRun<PlatformCode>>
>();

/** The longest a read of platform code from the assets may take. */
export const platformCodeReadMs = 10_000;

const memoisedCode = async (
  assets: Fetcher,
  key: string,
  read: () => Promise<PlatformCode>
): Promise<PlatformCode> => {
  const reads = platformCodeRead.get(assets) ?? new Map<string, PlatformCode>();
  platformCodeRead.set(assets, reads);
  const kept = reads.get(key);
  if (kept !== undefined) {
    return kept;
  }
  const reading =
    platformCodeReading.get(assets) ??
    new Map<string, SharedRun<PlatformCode>>();
  platformCodeReading.set(assets, reading);
  const code = await sharedRun(reading, key, platformCodeReadMs, read);
  reads.set(key, code);
  return code;
};

/**
 * The App compiler's code, read from core's static assets once per
 * isolate (`memoisedCode`): the sandbox host runs one call per process,
 * so nothing there stays warm. The kit goes as its JSON text, which core
 * never parses.
 */
export const appCompilerCode = async (assets: Fetcher): Promise<PlatformCode> =>
  await memoisedCode(assets, `compiler:${version}`, async () => {
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
 * How the package builder's isolate runs: no bindings, no importable env,
 * no network (`globalOutbound: null` and no subrequests), no Node.js
 * compatibility, and at most 30 s of CPU per call.
 */
export const packageBuilderSettings = {
  ...isolateBase,
  env: {},
  globalOutbound: null,
  limits: { cpuMs: 30_000, subRequests: 0 },
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
  const [source, wasm] = await Promise.all([
    readCompilerFile(assets, compilerAssets.packageBuilder, "javascript"),
    readCompilerBytes(assets, compilerAssets.esbuildWasm, "wasm"),
  ]);
  return loader
    .load({
      ...packageBuilderSettings,
      mainModule: "package-builder.js",
      modules: {
        "package-builder.js": source,
        // Compiled as the isolate loads; the isolate itself can't.
        "esbuild.wasm": { wasm },
      },
    })
    .getEntrypoint<PackageBuilder>();
};

/**
 * The package builder's code, for the on-prem sandbox host as
 * `appCompilerCode` gives the compiler's: esbuild's WebAssembly goes
 * as its bytes, which the sandbox host compiles as it loads the isolate.
 */
export const packageBuilderCode = async (
  assets: Fetcher
): Promise<PlatformCode> =>
  await memoisedCode(assets, `package-builder:${version}`, async () => {
    const [source, wasm] = await Promise.all([
      readCompilerBytes(assets, compilerAssets.packageBuilder, "javascript"),
      readCompilerBytes(assets, compilerAssets.esbuildWasm, "wasm"),
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
