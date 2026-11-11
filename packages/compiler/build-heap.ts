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
 *   builds each blueprint's pages, its preview and its server code in
 *   one compiler, as a shared isolate builds them one after another,
 *   each then type-checked by the release's checker, as core has it
 *   check them (src/checked-build.ts), and prints each build's outcome
 *   and the heap after its compile, one JSON line each. It fails should
 *   a build fail, and V8 ends it should the heap pass the cap.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

import { z } from "zod";

import { configPath, migrationsFolder, schemaPath } from "./src/app-code.ts";
import { withTypeCheck } from "./src/checked-build.ts";
import type { Unchecked } from "./src/checked-build.ts";
import type { Diagnostic } from "./src/diagnostic.ts";
import { compilerAssets, kitModule, typesModule } from "./src/kit.ts";
import type { TypeCheckRequest } from "./src/type-check.ts";
import type { CompileTarget } from "./src/worker.ts";

/** A module's namespace, as far as its default export. */
const defaultExport = z.looseObject({ default: z.unknown() });

/** A module's namespace, every export. */
const moduleSchema = z.record(z.string(), z.unknown());

const blueprintsSchema = z.record(z.string(), z.record(z.string(), z.string()));

/**
 * Each blueprint's files, by path relative to the App, and the modules
 * the host generates for it, by its config and schema with the
 * functions its server modules export (`registerApp`, as the host's
 * entry registers them). Its server code imports
 * `@server/_generated/server`, which resolves to the blueprint's
 * committed `files/server/_generated/server.ts`, as its tsconfig maps it.
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
        pathToFileURL(path.join(folder, "files/server/_generated/server.ts"))
          .href,
        context
      );
    },
  });
  const { generateModules, inspectApp, registerApp } =
    await import("@grasp-os/runtime/host");
  const { serverFunctionsIn } = await import("@grasp-os/runtime/definition");
  const { serverModuleOf } = await import("@grasp-os/runtime/server-modules");
  const all: z.infer<typeof blueprintsSchema> = {};
  const names = readdirSync(blueprints).filter((name) =>
    existsSync(path.join(blueprints, name, "files", configPath))
  );
  /** A blueprint's file's default export, or undefined without the file. */
  const defaultOf = async (dir: string, file: string): Promise<unknown> =>
    existsSync(path.join(dir, file))
      ? defaultExport.parse(
          await import(pathToFileURL(path.join(dir, file)).href)
        ).default
      : undefined;
  for (const name of names.toSorted()) {
    const dir = path.join(blueprints, name, "files");
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
    for (const file of Object.keys(files).toSorted()) {
      const module = serverModuleOf(file);
      if (module !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const namespace: unknown = await import(
          pathToFileURL(path.join(dir, file)).href
        );
        modules[module] = moduleSchema.parse(namespace);
      }
    }
    const migrations: unknown[] = [];
    for (const migrationFile of Object.keys(files)
      .filter((candidate) => migrationsFolder.isFile(candidate))
      .toSorted()) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      migrations.push(await defaultOf(dir, migrationFile));
    }
    // SAFETY: the App's parts, as its files export them; `registerApp`
    // refuses anything that isn't one.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const parts = {
      // oxlint-disable-next-line no-await-in-loop -- as above
      config: await defaultOf(dir, configPath),
      // oxlint-disable-next-line no-await-in-loop -- as above
      schema: await defaultOf(dir, schemaPath),
      modules,
      migrations,
    } as Parameters<typeof registerApp>[0];
    all[name] = {
      ...files,
      // oxlint-disable-next-line no-await-in-loop -- as above
      ...(await generateModules(
        inspectApp(registerApp(parts)).manifest,
        serverFunctionsIn(files)
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
  ) => Promise<Unchecked<{ ok: boolean; diagnostics?: Diagnostic[] }>>;
}

/** The type checker's entrypoint (src/checker.ts). */
interface Checker {
  check: (request: TypeCheckRequest) => Diagnostic[];
}

/** A module of the release's WebAssembly, compiled, as an isolate's module. */
const wasmStub = (release: string, file: string): string =>
  `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(${JSON.stringify(path.join(release, file))}));`;

/** The release's JSON modules, by the name its isolates import each by. */
const jsonModules: Readonly<Record<string, string>> = {
  [kitModule]: compilerAssets.kit,
  [typesModule]: compilerAssets.types,
};

/** The release module `file`'s default export, constructed as its isolate's entrypoint. */
const entrypointOf = async (
  release: string,
  file: string
): Promise<unknown> => {
  const loaded: unknown = await import(
    pathToFileURL(path.join(release, file)).href
  );
  const Entrypoint: unknown = defaultExport.parse(loaded).default;
  if (typeof Entrypoint !== "function") {
    throw new TypeError(`The release's ${file} exports no entrypoint`);
  }
  return Reflect.construct(Entrypoint, [{ props: {} }, {}]);
};

/**
 * Has the release's modules load as their isolates load them: the kit's
 * JSON modules, the WebAssembly compiled, and `cloudflare:workers`, of
 * which they use the entrypoint class alone.
 */
const hookRelease = (release: string): void => {
  const stubs: Record<string, string> = {
    "cloudflare:workers":
      "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "./esbuild.wasm": wasmStub(release, compilerAssets.esbuildWasm),
    "./tsrs.wasm": wasmStub(release, compilerAssets.tsrsWasm),
    "./oxc.wasm": wasmStub(release, compilerAssets.oxcWasm),
  };
  registerHooks({
    resolve: (specifier, context, next) => {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `heap-stub:${specifier}`, shortCircuit: true };
      }
      const json = Object.hasOwn(jsonModules, specifier)
        ? jsonModules[specifier]
        : undefined;
      if (json !== undefined) {
        return {
          url: pathToFileURL(path.join(release, json)).href,
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
};

/** What each target builds of a blueprint's files: a page build has only `#grasp` of what the host generates. */
const targets: Record<string, (file: string) => boolean> = {
  pages: (file) =>
    !file.startsWith(".grasp/") || file === ".grasp/references.ts",
  "preview-pages": (file) =>
    !file.startsWith(".grasp/") || file === ".grasp/references.ts",
  app: () => true,
};

const megabytes = (bytes: number): number => Math.round(bytes / 1e6);

/** The heap V8 holds once it has collected what it can, with --expose-gc. */
const heapUsed = (): number => {
  globalThis.gc?.();
  return getHeapStatistics().used_heap_size;
};

/** A build as the compiler answered it, kept for its check. */
const answerSchema = z.object({
  blueprint: z.string(),
  target: z.string(),
  answer: z.unknown(),
});

/**
 * Builds every blueprint's targets in one compiler, as its shared isolate
 * builds them, printing the heap after each, and keeps the answers in
 * `answersJson` for their checks (`checkAll`).
 */
const buildAll = async (
  release: string,
  filesJson: string,
  answersJson: string
): Promise<void> => {
  const all = blueprintsSchema.parse(
    JSON.parse(readFileSync(filesJson, "utf-8"))
  );
  hookRelease(release);
  // SAFETY: the release's compiler module is src/worker.ts built, whose
  // default export is the entrypoint of this shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const compiler = (await entrypointOf(
    release,
    compilerAssets.source
  )) as Compiler;
  const answers: z.infer<typeof answerSchema>[] = [];
  for (const [blueprint, files] of Object.entries(all)) {
    for (const [target, sent] of Object.entries(targets)) {
      // oxlint-disable-next-line no-await-in-loop -- one build at a time, as a shared isolate takes them
      const answer = await compiler.build(
        // SAFETY: `targets` has compile targets only, as its keys.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        target as CompileTarget,
        Object.fromEntries(Object.entries(files).filter(([file]) => sent(file)))
      );
      const used = heapUsed();
      const { total_heap_size: total } = getHeapStatistics();
      console.info(
        JSON.stringify({
          blueprint,
          target,
          ok: answer.built.ok,
          usedMb: megabytes(used),
          totalMb: megabytes(total),
        })
      );
      answers.push({ blueprint, target, answer });
    }
  }
  writeFileSync(answersJson, JSON.stringify(answers));
};

/**
 * Each tsrs instance made in this process, as its module's runs make
 * them: what its WebAssembly memory holds is no part of V8's heap, nor of
 * what `--max-heap-size` caps, yet an isolate's limit counts it.
 */
const instances: WebAssembly.Instance[] = [];
const recordInstances = (): void => {
  const { Instance } = WebAssembly;
  Reflect.set(
    WebAssembly,
    "Instance",
    new Proxy(Instance, {
      construct: (target, args: unknown[]): object => {
        const made: unknown = Reflect.construct(target, args);
        if (!(made instanceof Instance)) {
          throw new TypeError("WebAssembly made no instance");
        }
        // Only the last is read: those before it go.
        instances.splice(0, instances.length, made);
        return made;
      },
    })
  );
};

/** The WebAssembly memory of the last instance made, in bytes. */
const lastInstanceMemory = (): number => {
  const memory = instances.at(-1)?.exports.memory;
  return memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
};

/**
 * Type-checks each kept answer in the release's checker alone, as its own
 * isolate does, and finishes its build as core does (`withTypeCheck`),
 * printing what the check took: V8's heap and tsrs's WebAssembly memory.
 */
const checkAll = async (
  release: string,
  answersJson: string
): Promise<void> => {
  const answers = z
    .array(answerSchema)
    .parse(JSON.parse(readFileSync(answersJson, "utf-8")));
  hookRelease(release);
  recordInstances();
  // SAFETY: the release's checker module is src/checker.ts built, whose
  // default export is the entrypoint of this shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const checker = (await entrypointOf(
    release,
    compilerAssets.checker
  )) as Checker;
  for (const { blueprint, target, answer } of answers) {
    // SAFETY: the compiler's own answer, as `buildAll` kept it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const unchecked = answer as Unchecked<{
      ok: boolean;
      diagnostics?: Diagnostic[];
    }>;
    const diagnostics =
      unchecked.typeCheck === undefined
        ? []
        : checker.check(unchecked.typeCheck.request);
    // The instance is still alive: what it held, beside the heap.
    const wasm = unchecked.typeCheck === undefined ? 0 : lastInstanceMemory();
    const heap = heapUsed();
    const built = withTypeCheck(unchecked, diagnostics);
    const errors = (built.diagnostics ?? []).filter(
      ({ severity }) => severity === "error"
    );
    console.info(
      JSON.stringify({
        blueprint,
        target,
        ok: built.ok && errors.length === 0,
        heapMb: megabytes(heap),
        wasmMb: megabytes(wasm),
        totalMb: megabytes(heap + wasm),
      })
    );
    if (!built.ok || errors.length > 0) {
      throw new Error(
        `${blueprint} doesn't build its ${target}: ${JSON.stringify(errors.slice(0, 3))}`
      );
    }
  }
};

const [mode, from = "", to = "", out = ""] = process.argv.slice(2);
if (mode === "files") {
  writeFileSync(to, JSON.stringify(await blueprintFiles(from)));
} else if (mode === "build") {
  await buildAll(from, to, out);
} else if (mode === "check") {
  await checkAll(from, to);
} else {
  throw new Error(
    "Usage: build-heap.ts files <blueprints> <out.json> | build <release> <files.json> <answers.json> | check <release> <answers.json>"
  );
}
