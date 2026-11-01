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
// - `/path/<name>`, `/loud-path/<name>`: one way a connector's code can
//   have workerd report an error with its message, through `loadConnector`
//   and as it is.
// - `/node`: what a connector has of Node.js: nothing (GRA-939).
// - `/marked`: a connector's own Response with the header a thrown error
//   crosses under.

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

/**
 * The ways a connector's code can have workerd served `--verbose` report an
 * error with its message, each its own isolate (`/path/<name>`), the
 * value its route's name.
 */
const paths: Readonly<Record<string, (value: string) => string>> = {
  thrown: (value) => `throw new Error(${JSON.stringify(value)});`,
  waitUntil: (value) =>
    `ctx.waitUntil(Promise.reject(new Error(${JSON.stringify(value)})));`,
};

/** A connector that does what path `name` does with `value`, then answers. */
const pathConnectorOf = (
  name: string,
  value: string
): string => `export default {
  async fetch(request, env, ctx) {
    ${paths[name]?.(value) ?? ""}
    await scheduler.wait(50);
    return new Response(${JSON.stringify(value)});
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
  const path = /^\/(?<loud>loud-)?path\/(?<name>\w+)$/u.exec(route)?.groups;
  if (path?.name !== undefined && Object.hasOwn(paths, path.name)) {
    const value = `${path.loud === undefined ? "quiet" : "loud"}-${path.name}-2c8e`;
    const code = pathConnectorOf(path.name, value);
    const stub =
      path.loud === undefined
        ? loadConnector(env.LOADER, code, env.EGRESS)
        : env.LOADER.load({
            ...isolateBase,
            mainModule: "connector.js",
            modules: { "connector.js": code },
            env: {},
            globalOutbound: env.EGRESS,
          });
    try {
      const response = await stub
        .getEntrypoint()
        .fetch("https://connector.internal/mcp");
      return await response.text();
    } catch (error) {
      // What connect's MCP client gets of a throw: the error, as it was.
      return error instanceof Error && error.message === value
        ? value
        : "another error";
    }
  }
  if (route === "/marked") {
    // A connector's own Response carrying the header a thrown error crosses
    // under: still its Response, without that header.
    const response = await loadConnector(
      env.LOADER,
      'export default { fetch: () => new Response("own", { headers: { "x-grasp-thrown": "1" } }) };\n',
      env.EGRESS
    )
      .getEntrypoint()
      .fetch("https://connector.internal/mcp");
    return `${await response.text()},${String(response.headers.get("x-grasp-thrown"))}`;
  }
  if (route === "/node") {
    // A connector has no Node.js (`isolateBase`): no `setImmediate`, no
    // `process`, no `node:timers`.
    const globals = await loadConnector(
      env.LOADER,
      'export default { fetch: () => new Response([typeof setImmediate, typeof process].join(",")) };\n',
      env.EGRESS
    )
      .getEntrypoint()
      .fetch("https://connector.internal/mcp");
    let timers: string;
    try {
      await loadConnector(
        env.LOADER,
        'import { setTimeout } from "node:timers";\nexport default { fetch: () => new Response(typeof setTimeout) };\n',
        env.EGRESS
      )
        .getEntrypoint()
        .fetch("https://connector.internal/mcp");
      timers = "loaded";
    } catch {
      timers = "refused";
    }
    return `${await globals.text()},${timers}`;
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
