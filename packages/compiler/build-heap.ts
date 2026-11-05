/**
 * Builds core's built-in blueprints with a release's compiler, as its
 * isolate runs it, under Node: the same V8 as workerd, so a heap cap
 * (`--max-heap-size`) holds the compiler to what an isolate may use.
 * build-heap.test.ts runs it, in two processes:
 *
 * - `node build-heap.ts files <blueprints> <out.json>` writes each
 *   blueprint's files with the modules the host generates for it
 *   (`server/_generated/`), as core's save does
 *   (apps/core/src/draft-references.ts).
 *   It loads the SDK and the App's code, so it runs without the cap.
 * - `node --max-heap-size=<MB> build-heap.ts build <release> <files.json>`
 *   builds each blueprint's screens, its preview and its server code in
 *   one compiler, as a shared isolate builds them one after another, and
 *   prints each build's outcome and the heap after it, one JSON line
 *   each. It fails should a build fail, and V8 ends it should the heap
 *   pass the cap.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

import { z } from "zod";

import { isServerModule } from "./src/app-code.ts";
import { compilerAssets, kitModule } from "./src/kit.ts";
import type { CompileTarget } from "./src/worker.ts";

/** The release identity the generated modules name: any will do. */
const identity = {
  resourceId: "app_heap0000000000000000000",
  resourceVersion: 1,
};

/** A module's namespace, as far as its default export. */
const defaultExport = z.looseObject({ default: z.unknown() });

/** A module's namespace, every export. */
const moduleSchema = z.record(z.string(), z.unknown());

const blueprintsSchema = z.record(z.string(), z.record(z.string(), z.string()));

/**
 * Each blueprint's files, by path relative to the App, and the modules
 * the host generates for it, by `files/app.ts`'s registration with the
 * functions its server modules export (`registerFunctions`, as the host's
 * entry registers them). Its server code imports
 * `@server/_generated/server`, which resolves to the blueprint's
 * `server-types.ts`, as its tsconfig maps it.
 */
const blueprintFiles = async (
  blueprints: string
): Promise<z.infer<typeof blueprintsSchema>> => {
  registerHooks({
    resolve: (specifier, context, next) => {
      if (
        specifier !== "@server/_generated/server" ||
        context.parentURL === undefined
      ) {
        return next(specifier, context);
      }
      const parent = new URL(context.parentURL).pathname;
      const folder = parent.slice(0, parent.lastIndexOf("/files/"));
      return next(
        pathToFileURL(path.join(folder, "server-types.ts")).href,
        context
      );
    },
  });
  const { generateModules, inspectApp, registerFunctions } =
    await import("@grasp-os/sdk/host");
  const all: z.infer<typeof blueprintsSchema> = {};
  const names = readdirSync(blueprints).filter((name) =>
    existsSync(path.join(blueprints, name, "files/app.ts"))
  );
  for (const name of names.toSorted()) {
    const dir = path.join(blueprints, name, "files");
    // oxlint-disable-next-line no-await-in-loop -- one App at a time
    const app: unknown = await import(
      pathToFileURL(path.join(dir, "app.ts")).href
    );
    const files: Record<string, string> = {};
    for (const file of readdirSync(dir, {
      recursive: true,
      encoding: "utf-8",
    })) {
      if (/\.tsx?$/u.test(file)) {
        files[file] = readFileSync(path.join(dir, file), "utf-8");
      }
    }
    const modules: Record<string, Record<string, unknown>> = {};
    for (const file of Object.keys(files).filter(isServerModule).toSorted()) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const namespace: unknown = await import(
        pathToFileURL(path.join(dir, file)).href
      );
      modules[file.slice("server/".length, -".ts".length)] =
        moduleSchema.parse(namespace);
    }
    // SAFETY: the App's default export; `registerFunctions` refuses
    // anything `app` didn't register.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const registered = defaultExport.parse(app).default as Parameters<
      typeof registerFunctions
    >[0];
    all[name] = {
      ...files,
      // oxlint-disable-next-line no-await-in-loop -- as above
      ...(await generateModules(
        inspectApp(registerFunctions(registered, modules)).manifest,
        identity
      )),
    };
  }
  return all;
};

/** The compiler's entrypoint, as far as this builds with it. */
interface Compiler {
  build: (
    target: CompileTarget,
    files: Record<string, string>
  ) => Promise<{ ok: boolean; diagnostics?: { severity: string }[] }>;
}

/**
 * Loads the release's compiler as its isolate does: its module, what it
 * knows of the kit as a JSON module, esbuild's WebAssembly compiled, and
 * `cloudflare:workers`, of which it uses the entrypoint class alone.
 */
const loadCompiler = async (release: string): Promise<Compiler> => {
  const stubs: Record<string, string> = {
    "cloudflare:workers":
      "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "./esbuild.wasm": `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(${JSON.stringify(path.join(release, compilerAssets.esbuildWasm))}));`,
  };
  registerHooks({
    resolve: (specifier, context, next) => {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `heap-stub:${specifier}`, shortCircuit: true };
      }
      if (specifier === kitModule) {
        return {
          url: pathToFileURL(path.join(release, compilerAssets.kit)).href,
          importAttributes: { type: "json" },
          shortCircuit: true,
        };
      }
      return next(specifier, context);
    },
    load: (url, context, next) =>
      url.startsWith("heap-stub:")
        ? {
            format: "module",
            source: stubs[url.slice("heap-stub:".length)],
            shortCircuit: true,
          }
        : next(url, context),
  });
  // A Worker's global scope, which esbuild's browser build reads.
  Reflect.set(globalThis, "self", globalThis);
  const compiler: unknown = await import(
    pathToFileURL(path.join(release, compilerAssets.source)).href
  );
  const AppCompiler: unknown = defaultExport.parse(compiler).default;
  if (typeof AppCompiler !== "function") {
    throw new TypeError("The release's compiler exports no entrypoint");
  }
  // SAFETY: the release's compiler module is src/worker.ts built, whose
  // default export is the `AppCompiler` entrypoint, `Compiler`'s shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Reflect.construct(AppCompiler, [{ props: {} }, {}]) as Compiler;
};

/** What each target builds of a blueprint's files: a screen build has only `#grasp` of what the host generates. */
const targets: Record<string, (file: string) => boolean> = {
  screens: (file) =>
    !file.startsWith(".grasp/") || file === ".grasp/references.ts",
  "preview-screens": (file) =>
    !file.startsWith(".grasp/") || file === ".grasp/references.ts",
  app: () => true,
};

const megabytes = (bytes: number): number => Math.round(bytes / 1e6);

const buildAll = async (release: string, filesJson: string): Promise<void> => {
  const all = blueprintsSchema.parse(
    JSON.parse(readFileSync(filesJson, "utf-8"))
  );
  const compiler = await loadCompiler(release);
  for (const [blueprint, files] of Object.entries(all)) {
    for (const [target, sent] of Object.entries(targets)) {
      // oxlint-disable-next-line no-await-in-loop -- one build at a time, as a shared isolate takes them
      const built = await compiler.build(
        // SAFETY: `targets` has compile targets only, as its keys.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        target as CompileTarget,
        Object.fromEntries(Object.entries(files).filter(([file]) => sent(file)))
      );
      const errors = (built.diagnostics ?? []).filter(
        ({ severity }) => severity === "error"
      );
      // What the build keeps, when run with --expose-gc.
      globalThis.gc?.();
      const { used_heap_size: used, total_heap_size: total } =
        getHeapStatistics();
      console.info(
        JSON.stringify({
          blueprint,
          target,
          ok: built.ok && errors.length === 0,
          usedMb: megabytes(used),
          totalMb: megabytes(total),
        })
      );
      if (!built.ok || errors.length > 0) {
        throw new Error(
          `${blueprint} doesn't build its ${target}: ${JSON.stringify(errors.slice(0, 3))}`
        );
      }
    }
  }
};

const [mode, from = "", to = ""] = process.argv.slice(2);
if (mode === "files") {
  writeFileSync(to, JSON.stringify(await blueprintFiles(from)));
} else if (mode === "build") {
  await buildAll(from, to);
} else {
  throw new Error(
    "Usage: build-heap.ts files <blueprints> <out.json> | build <release> <files.json>"
  );
}
