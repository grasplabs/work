import { oxc } from "./oxc.ts";
import type { Transformed } from "./oxc.ts";

/**
 * What a preview build's modules call to register their components with
 * React Fast Refresh, and to track their hooks (spec 19.2.1): names no
 * App code has reason to use, which the module's header defines
 * (worker.ts `refreshHeader`).
 */
export const refreshNames = {
  register: "__graspRefreshReg",
  signature: "__graspRefreshSig",
} as const;

/**
 * Compiles one TypeScript or TSX file of React code to a JavaScript
 * module, as oxc's React transform does (oxc-wasm/src/transform.rs): the
 * React Compiler, then types removed and JSX turned into calls to
 * `react/jsx-runtime`, without the whitespace a reader needs. Like the
 * frontend's build, it fails on anything the React Compiler can't compile,
 * and compiles every component, a `"use no memo"` directive or not.
 *
 * With `refresh`, for a chat's preview (spec 19.2.1), React Fast Refresh's
 * instrumentation runs after the React Compiler, as React's own tooling
 * orders them: each component registered through `refreshNames`, with its
 * full hook signature. A component's memo cache needs no reset of the
 * compiler's when its source changes: React's development build, which a
 * preview runs, empties it whenever Fast Refresh swaps the component.
 */
export const compileReact = (
  path: string,
  source: string,
  { refresh = false }: { refresh?: boolean } = {}
): Transformed =>
  oxc().transform(path, source, {
    react: true,
    refresh: refresh ? refreshNames : null,
    minify: true,
    sourceMap: false,
  });

/**
 * Compiles one TypeScript file to a JavaScript module by removing its
 * types, nothing else: code that has no JSX or React. With `sourceMap`,
 * with a source map of it as a `data:` URL (`map`), which a stack trace's
 * place in the module is read back through to the file's line.
 */
export const stripTypes = (
  path: string,
  source: string,
  { sourceMap = false }: { sourceMap?: boolean } = {}
): Transformed =>
  oxc().transform(path, source, {
    react: false,
    refresh: null,
    minify: !sourceMap,
    sourceMap,
  });
