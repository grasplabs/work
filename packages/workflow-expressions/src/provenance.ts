/**
 * The jq that evaluates workflow expressions, pinned to its exact bytes.
 *
 * jq 1.8.2 (MIT, with dtoa/decNumber/Oniguruma notices) as compiled to
 * WebAssembly by the jq-wasm package (MIT) with Emscripten, whose
 * runtime and libraries are in the module and its JavaScript glue:
 * Emscripten (MIT/NCSA), musl libc (MIT) and compiler-rt (Apache 2.0
 * with LLVM exceptions). Every notice is in licenses/.
 *
 * scripts/jq-wasm/build.ts takes the package's jq.wasm, refuses it unless
 * its SHA-256 is `upstreamSha256`, meters it (scripts/jq-wasm/meter.ts) and
 * writes src/jq.wasm, whose SHA-256 must be `sha256`. A test in scripts/ rebuilds it from the package and compares.
 * Changing any of these is a new evaluator: a reviewed profile revision.
 */
export const jqProvenance = {
  jqVersion: "1.8.2",
  package: "jq-wasm",
  packageVersion: "3.0.0-jq-1.8.2",
  license: "MIT",
  /** SHA-256 of jq-wasm's dist/build/jq.wasm, as published. */
  upstreamSha256:
    "27d493c06601e9cbc7112ef4198ee71a0dc3e9c9a4a1754e73888841da6c450a",
  /** SHA-256 of src/jq.wasm: the metered module that runs. */
  sha256: "b8e703a853dcab28c017c8d99ae4f5e1117f5cd5d57a3c84c5d04c96cd949e3f",
  /** The exported global the host fills with fuel before each run. */
  fuelExport: "fuel",
  /**
   * The memory cap of the metered module: a run that needs more fails as
   * resource exhaustion instead of growing (jq-wasm builds for 256 MiB).
   */
  maxMemoryBytes: 64 * 1024 * 1024,
} as const;
