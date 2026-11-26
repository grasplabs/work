import { build, initialize } from "esbuild-wasm/esm/browser.js";

/** esbuild, started once per isolate on the module it was loaded with. */
let started: Promise<void> | undefined;

/**
 * esbuild's `build`, once esbuild has started on `wasmModule` in this
 * isolate: the package builder's builds (build.ts) and its connectors'
 * (../connector.ts) share one start.
 */
export const startedEsbuild = async (
  wasmModule: WebAssembly.Module
): Promise<typeof build> => {
  started ??= initialize({ wasmModule, worker: false });
  await started;
  return build;
};
