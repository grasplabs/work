import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { isolateBase } from "@grasp-os/shared/runtime";

// How connect loads a native connector's code: the one place it does
// (connectors.ts, `nativeServer`). A fresh isolate per call, with an empty
// env, limits the runtime enforces, and the call's egress handler as its
// only way out.
//
// Whatever the connector logs stays in it (GRA-940): it is loaded through
// `quietLoader`, whose quiet module silences its console before any of its
// modules runs, and keeps what it leaves uncaught from being printed. On
// Cloudflare a Loader isolate's output is dropped anyway, with no tail
// attached, and connect attaches none. On plain workerd it would land in
// connect's own stdout and stderr, the deployment's logs, carrying the
// API's responses and the caller's input it printed.

/**
 * How a connector's isolate runs: no importable env, and limits per call,
 * enforced by the runtime. Its env is empty; its one way out is the egress
 * handler, its `globalOutbound`, set per call.
 */
const isolate = {
  ...isolateBase,
  // Unlike App code, it calls a provider's API, a bounded number of times.
  limits: { cpuMs: 10_000, subRequests: 50 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * A fresh isolate of connector `code` (one ES module) in `loader`,
 * silenced, reaching the network only through `globalOutbound`.
 */
export const loadConnector = (
  loader: WorkerLoader,
  code: string,
  globalOutbound: Fetcher
): WorkerStub =>
  quietLoader(loader).load({
    ...isolate,
    mainModule: "connector.js",
    modules: { "connector.js": code },
    env: {},
    globalOutbound,
  });
