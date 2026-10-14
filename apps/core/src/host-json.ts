import { readJsonValue } from "@grasp-os/shared/operations";
import { valueDepth } from "@grasp-os/shared/value-depth";

// The host's reading of what App code answers, as a module of its own in
// an App's isolate (app-functions.ts): the host's own `readJsonValue`, by
// its source, so the isolate reads a value exactly as the host does.
//
// What could go wrong, and what stops it:
// - The bundler renames the function: Wrangler bundles core with esbuild's
//   `keepNames`, which renames a declaration whose name collides with
//   another's (`readJsonValue2`) while keeping its `.name` as written. So
//   the source is bound to a name of this module's own, as an expression,
//   and never called by `.name`; a named function expression still calls
//   itself by whatever name the bundler gave it.
// - The bundler adds a helper to the source: `keepNames` wraps named
//   functions nested in a body in `__name(...)`, and other transforms call
//   other `__` helpers, none of which the isolate has. Such a source is
//   refused, loudly, rather than loaded to fail on every answer. A minifier
//   renames the helpers past what this can see, so the test bundles the
//   module with core's own Wrangler settings, minified and not, and runs
//   the source it yields with nothing but the language's built-ins in
//   scope (host-json.bundle.test.ts).
// - The host's half of the isolate protocol comes to depend on the sealed
//   SDK: this is a host module, never an SDK export, so the run module
//   imports from a release's SDK only what `sdkProtocolVersion` pins.

/** The host module's name in the isolate: a platform name, loaded last. */
export const hostJsonModule = "grasp-host-json.js";

/** A call of a bundler helper (`__name(`, `__publicField(`, ...). */
const bundlerHelper = /(?:^|[^\w$])__[\w$]+\(/u;

/**
 * The host module's source: `jsonAnswer(value)`, the JSON text of a value
 * App code answered, or undefined for anything JSON can't carry as it is.
 * `read` is the reader whose source it carries: the host's own.
 */
export const hostJsonSource = (
  read: (
    value: unknown,
    depth: number,
    maxDepth: number
  ) => unknown = readJsonValue
): string => {
  const reader = read.toString();
  if (bundlerHelper.test(reader)) {
    throw new Error(
      "readJsonValue's source calls a bundler helper an App's isolate doesn't have: keep it free of nested named functions"
    );
  }
  return `const readJson = (${reader});

export const jsonAnswer = (value) => {
  const json = readJson(value, 1, ${valueDepth});
  return json === undefined ? undefined : JSON.stringify(json);
};
`;
};
