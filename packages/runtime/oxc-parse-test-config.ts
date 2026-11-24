import { fileURLToPath } from "node:url";

/**
 * What a project whose tests run the runtime's parser in workerd adds to its
 * config (src/oxc-parse.ts): Vitest resolves a test's imports with
 * Node's conditions, not workerd's, so `#oxc-parse` is pointed at the
 * Worker's module here, and oxc-parse.wasm is imported as a Worker
 * imports it, compiled with the bundle.
 */
export const oxcParseTestConfig = {
  alias: [
    {
      find: /^#oxc-parse$/u,
      replacement: fileURLToPath(
        new URL("src/oxc-parse-module.ts", import.meta.url)
      ),
    },
  ],
  modulesRules: [{ type: "CompiledWasm" as const, include: ["**/*.wasm"] }],
};
