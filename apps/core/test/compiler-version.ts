import path from "node:path";

/**
 * The module core's tests import as the compiler's `#version`
 * (vite.config.ts): the version of the compiler the global setup builds
 * into the tests' assets. Core's build writes its own, for the assets it
 * ships; with one module for both, a test run after a change to the kit
 * would point a running dev server at a compiler its assets don't have.
 */
export const testVersionModule = path.join(
  import.meta.dirname,
  "../dist/test-compiler-version.js"
);
