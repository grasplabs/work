import { isolateBase } from "@grasp-os/shared/runtime";

import { loadConnector } from "../../src/connector-isolate.ts";

// A stand-in connect on plain workerd (scripts/workerd-connector-console
// .test.ts, GRA-940), served `--verbose`, which prints an isolate's console
// and its uncaught errors with their message.
//
// - `/connector`: a connector's code through `loadConnector`, as connect
//   loads one for every native action call.
// - `/control`: the same code in the Loader as it is, which shows workerd's
//   output is read at all.

/** What a connector holds that no log may carry, by route. */
const values = {
  connector: "api-response-9d3a",
  control: "control-value-6b21",
} as const;

/**
 * A connector that logs `value` every way it can (each console method, one
 * kept as the module loads, one it puts back) and leaves
 * an error and a rejection uncaught, then answers it, as an API's response
 * it read.
 */
const connectorOf = (
  value: string
): string => `const value = ${JSON.stringify(value)};
const kept = console.log;
export default {
  async fetch() {
    kept(value);
    for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
      console[level](value);
    }
    console.log = (...args) => console.error(...args);
    console.log(value);
    Promise.reject(new Error(value));
    queueMicrotask(() => {
      throw new Error(value);
    });
    setTimeout(() => {
      throw new Error(value);
    }, 0);
    reportError(new Error(value));
    await scheduler.wait(50);
    return new Response(value);
  },
};
`;

interface ConnectEnv {
  readonly LOADER: WorkerLoader;
  /** Where the connector's requests would go: this Worker, never reached. */
  readonly EGRESS: Fetcher;
}

/** What a route answers: the connector's answer. */
const answerOf = async (route: string, env: ConnectEnv): Promise<unknown> => {
  if (route === "/connector") {
    const response = await loadConnector(
      env.LOADER,
      connectorOf(values.connector),
      env.EGRESS
    )
      .getEntrypoint()
      .fetch("https://connector.internal/mcp");
    return await response.text();
  }
  if (route !== "/control") {
    // workerd's readiness probe, and anything else: no isolate.
    return null;
  }
  const response = await env.LOADER.load({
    // As a connector's isolate runs (connector-isolate.ts), unsilenced.
    ...isolateBase,
    mainModule: "connector.js",
    modules: { "connector.js": connectorOf(values.control) },
    env: {},
    globalOutbound: env.EGRESS,
  })
    .getEntrypoint()
    .fetch("https://connector.internal/mcp");
  return await response.text();
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const answered = await answerOf(pathname, env);
    return Response.json({ answered, values });
  },
} satisfies ExportedHandler<ConnectEnv>;
