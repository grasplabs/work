/**
 * The package builder as a release has it (build.ts builds it into each),
 * and, run on its own, only the builder:
 *
 *   node build-package-builder.ts <dir>
 *
 * writes its module and esbuild's WebAssembly into `<dir>` under the names
 * a release gives them. The on-prem sandbox's builder tests
 * (scripts/workerd-sandbox-builds*.test.ts) run the builder alone, and a
 * whole release takes half a minute of CPU to build.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "vite-plus";
import type { InlineConfig, Rolldown } from "vite-plus";

import { compilerAssets } from "./src/kit.ts";

const root = import.meta.dirname;
const require = createRequire(path.join(root, "package.json"));

/**
 * What a release is built as, whatever `NODE_ENV` the building process has:
 * `vp test` runs with `test`, and a shell may have anything. React's
 * packages pick their development build by it, and Vite puts it in the
 * code, so without this the same sources built into another kit, under
 * another version, depending on who built them.
 */
export const production = {
  "process.env.NODE_ENV": JSON.stringify("production"),
};

/** The chunks of a Vite build's output. */
export const chunksOf = (
  result: Awaited<ReturnType<typeof build>>
): Rolldown.OutputChunk[] =>
  [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");

/**
 * The package builder's module (src/packages/worker.ts), which core runs
 * in an isolate of its own for each use. It runs without Node.js
 * compatibility: nothing it bundles may import Node's built-ins.
 */
export const buildPackageBuilder = async (): Promise<string> => {
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

/** esbuild's WebAssembly, which the builder's esbuild runs, as the package ships it. */
export const esbuildWasm = (): Buffer =>
  readFileSync(require.resolve("esbuild-wasm/esbuild.wasm"));

if (import.meta.main) {
  const [out] = process.argv.slice(2);
  if (out === undefined) {
    throw new Error("Usage: node build-package-builder.ts <dir>");
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, compilerAssets.packageBuilder),
    await buildPackageBuilder()
  );
  writeFileSync(path.join(out, compilerAssets.esbuildWasm), esbuildWasm());
}
