import { hasNodeModules, quietModules } from "./quiet-isolate.ts";

// What an isolate core or connect loads itself may print (GRA-910,
// GRA-940). On Cloudflare a Loader isolate's console output is dropped
// unless a tail is attached, and then it goes to the tail alone. Plain
// workerd prints it to the loading Worker's own stdout and stderr, the
// deployment's logs, where whatever the code logs (a record, a caller's
// input, a document's text, an API's response to a connector) would be read
// by whoever reads those logs. Connect loads a connector's isolate for every
// native action call, on either profile (apps/connect/src/connectors.ts).
// Core loads isolates itself off Cloudflare only with
// `SANDBOX_IN_PROCESS=unbounded` (apps/core/src/sandboxed.ts), which is for
// tests and local development, but nothing stops a deployment setting it.
//
// So every isolate core or connect loads goes through `quietLoader`: its
// main module imports the quiet module first (quiet-isolate.ts), which
// silences every console method before any other module loads and keeps
// what the code leaves uncaught from anything workerd served `--verbose`
// reports for an isolate, but for what that module's header lists as
// beyond it (GRA-939). That holds on either profile; on Cloudflare it drops
// nothing the runtime wouldn't. Core can't tell whether its own process was
// served `--verbose`, so under `SANDBOX_IN_PROCESS=unbounded` not doing so
// is the operator's rule (core's env.d.ts).
//
// An isolate with a tail is left as it is: its tail (core's server-logs.ts)
// is how a builder sees what the App's server code wrote, and a silenced
// console would hand the tail nothing. On plain workerd that output still
// reaches the process's logs too, which `SANDBOX_IN_PROCESS=unbounded`
// accepts (core's env.d.ts); GRA-919 delivers it to the tail's destinations
// instead. Connect attaches no tail.

/**
 * What `quietLoader` needs of a Loader's code: the Worker Loader's own
 * `WorkerLoaderWorkerCode`, read structurally so this package needs no
 * Workers types.
 */
export interface QuietableCode {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, unknown>>;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly tails?: readonly unknown[];
  readonly streamingTails?: readonly unknown[];
}

/** A Worker Loader, as `quietLoader` wraps one. */
export interface QuietableLoader<Code extends QuietableCode, Stub> {
  readonly get: (
    name: string | null,
    getCode: () => Code | Promise<Code>
  ) => Stub;
  readonly load: (code: Code) => Stub;
}

/** `code` with its console silenced first, unless it has a tail. */
const quietCode = <Code extends QuietableCode>(code: Code): Code => {
  if ((code.tails?.length ?? 0) > 0 || (code.streamingTails?.length ?? 0) > 0) {
    return code;
  }
  const main = code.modules[code.mainModule];
  // An ES module given as `{ js }` stays one: a module given as text is
  // read by its name's extension, which `{ js }` doesn't need.
  const js: unknown =
    typeof main === "object" && main !== null && "js" in main
      ? main.js
      : undefined;
  const given = typeof js === "string" ? js : main;
  if (typeof given !== "string") {
    // Anything else (CommonJS, Python, a missing module) can't import the
    // quiet module first: refused rather than loaded unsilenced.
    throw new TypeError(
      `An isolate's main module must be an ES module to be silenced: ${code.mainModule} isn't one.`
    );
  }
  const modules = quietModules(
    code.mainModule,
    { ...code.modules, [code.mainModule]: given },
    // Its `node:timers` caught too, where it has them.
    {
      nodejsCompat: hasNodeModules({
        compatibilityDate: code.compatibilityDate ?? "",
        compatibilityFlags: code.compatibilityFlags,
      }),
    }
  );
  const quieted = modules[code.mainModule];
  return {
    ...code,
    modules:
      typeof main === "string" || typeof quieted !== "string"
        ? modules
        : { ...modules, [code.mainModule]: { js: quieted } },
  };
};

/**
 * `loader`, loading every isolate with its console silenced first unless
 * it has a tail (see the header). Core and connect read their `LOADER`
 * through this, so no isolate either loads prints to the deployment's logs.
 */
export const quietLoader = <Code extends QuietableCode, Stub>(
  loader: QuietableLoader<Code, Stub>
): QuietableLoader<Code, Stub> => ({
  get: (name, getCode) =>
    loader.get(name, async () => quietCode(await getCode())),
  load: (code) => loader.load(quietCode(code)),
});
