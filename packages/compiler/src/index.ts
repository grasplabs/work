/**
 * Screen compiler: builds an App's screens into ES modules and CSS, in a
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

import { version } from "#version";

import { compilerAssets, kitModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type PackageBuilder from "./packages/worker.ts";
import type ScreenCompiler from "./worker.ts";

export type { Diagnostic } from "./diagnostic.ts";
export type { KitModules } from "./kit.ts";
export type { BuildRequest, InspectRequest } from "./packages/worker.ts";
export type { ScreenBuild, ServerBuild, WorkflowBuild } from "./worker.ts";
export {
  buildFiles,
  limitErrors,
  serverFiles,
  workflowFiles,
  workflowIdOf,
  workflowPaths,
} from "./inputs.ts";
export { appModuleName, kitModuleName, screenRuntime } from "./kit.ts";
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
      `The screen compiler's ${file} is not among the static assets: build the compiler into them (packages/compiler/build.ts).`
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
      `The screen compiler's ${file} is not among the static assets: build the compiler into them (packages/compiler/build.ts).`
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
export const sdkModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.sdkModules);

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

/**
 * The compiler, in one isolate per release that every build shares, with
 * its code read from core's static assets. Kept warm, a build doesn't load
 * the compiler and the kit again, so a change to an App shows at once. It
 * is safe to share: the compiler parses and transforms App code but never
 * runs it, and the isolate has no bindings, no network and no subrequests
 * (`isolateSettings`). App code itself never runs here. The name holds
 * only the release's compiler version: workerd keeps a named isolate for
 * as long as the process runs, so a name per build would keep one
 * compiler for every build ever made.
 */
export const startScreenCompiler = (
  loader: WorkerLoader,
  assets: Fetcher
): Service<ScreenCompiler> =>
  loader
    .get(`compiler:${version}`, async () => {
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
    })
    .getEntrypoint<ScreenCompiler>();

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
