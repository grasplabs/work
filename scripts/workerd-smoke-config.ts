/**
 * The workerd config the on-prem smoke run (`workerd-smoke.ts`) serves core
 * with: plain workerd, as on-prem runs it. So it says
 * `RUNTIME_PROFILE=workerd`: Code Mode's run record then claims no CPU limit
 * (apps/core/src/code-mode.ts), which plain workerd doesn't enforce. And it
 * binds `SANDBOX_HOST` to the sandbox supervisor (workerd-sandbox.ts), so
 * core inspects untrusted App code in workerd processes of its own, killed
 * at their deadline, never in its own (apps/core/src/sandboxed.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { d1Bindings, d1DatabasesOf, d1Service } from "./workerd-d1.ts";
import { r2Bindings, r2BucketsOf, r2Service } from "./workerd-r2.ts";
import { parseJsonc } from "./wrangler-config-rules.ts";

export const coreWranglerConfig = path.join(
  import.meta.dirname,
  "../apps/core/wrangler.jsonc"
);

/**
 * Every Durable Object namespace core binds, read from its wrangler.jsonc so
 * none is left out: a class defined but not bound fails every route that
 * reaches it.
 */
const coreDurableObjects = (): { name: string; className: string }[] =>
  z
    .object({
      durable_objects: z.object({
        bindings: z.array(
          z.object({ name: z.string(), class_name: z.string() })
        ),
      }),
    })
    .parse(parseJsonc(readFileSync(coreWranglerConfig, "utf-8")))
    .durable_objects.bindings.map(({ name, class_name: className }) => ({
      name,
      className,
    }));

/** What the config is made from. */
export interface SmokeConfigInputs {
  /** The local port core is served on. */
  port: number;
  /** The Unix socket the sandbox supervisor answers on. */
  sandboxSocket: string;
  /** The router secret every request to core must carry. */
  routerSecret: string;
  /** Core's modules, as capnp module entries. */
  modules: readonly string[];
  /**
   * The directory Durable Objects keep their SQLite databases in, core's
   * and the D1 service's: workerd has no SQLite in memory.
   */
  storage: string;
  /**
   * What the sealed-call step (workerd-smoke-sealed.ts) adds: the fake IdP
   * people sign in through, as a Worker of its own on `idpPort`; core's
   * assets (the compiler, the SDK and the kit a seal reads) from a folder;
   * and core's sign-in vars, for this machine only.
   */
  signIn?: {
    idpPort: number;
    idpModules: readonly string[];
    assets: string;
    vars: Readonly<Record<string, unknown>>;
  };
}

/**
 * The Worker that answers core's `ASSETS` from a folder, as Workers' static
 * assets do: by path, with the type each file's extension says, which core
 * checks (packages/compiler/src/index.ts). workerd's disk service answers
 * the bytes alone. The on-prem profile has no such service yet: GRA-985.
 */
export const assetsWorkerSource = `const types = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const found = await env.FILES.fetch(new URL(pathname, "http://files"));
    if (!found.ok) {
      return new Response("Not found", { status: 404 });
    }
    const dot = pathname.lastIndexOf(".");
    const type = types[dot === -1 ? "" : pathname.slice(dot)] ?? "application/octet-stream";
    return new Response(found.body, { headers: { "content-type": type } });
  },
};
`;

/** A capnp text literal of `value`. */
const capnpText = (value: string): string => JSON.stringify(value);

/** A binding of core's for each sign-in var: text, or JSON for anything else. */
const varBindings = (vars: Readonly<Record<string, unknown>>): string[] =>
  Object.entries(vars).map(([name, value]) =>
    typeof value === "string"
      ? `(name = "${name}", text = ${capnpText(value)})`
      : `(name = "${name}", json = ${capnpText(JSON.stringify(value))})`
  );

/** The `config.capnp` text that serves core on plain workerd. */
export const smokeConfig = ({
  port,
  sandboxSocket,
  routerSecret,
  modules,
  storage,
  signIn,
}: SmokeConfigInputs): string => {
  const durableObjects = coreDurableObjects();
  const durableObjectBindings = durableObjects.map(
    ({ name, className }) =>
      `(name = "${name}", durableObjectNamespace = (className = "${className}"))`
  );
  const durableObjectNamespaces = durableObjects.map(
    ({ className }) =>
      `(className = "${className}", uniqueKey = "${className}", enableSql = true)`
  );
  const signInServices =
    signIn === undefined
      ? ""
      : `
    # The fake IdP people sign in through (apps/core/test/idp-worker.ts),
    # never deployed: core sends sign-in here only while both it and core
    # are on this machine (apps/core/src/auth/config.ts devIdpOrigin).
    (name = "idp", worker = .idp),
    # Core's assets: the compiler, SDK and kit modules a seal reads, with
    # their types (\`assetsWorkerSource\`), over the folder they are in.
    (name = "assets", worker = .assets),
    (name = "asset-files", disk = (path = ${capnpText(signIn.assets)})),
    # Core's fetches reach the fake IdP on this machine, which workerd's
    # default outbound refuses as a private address.
    (name = "internet", network = (allow = ["public", "local"])),`;
  const signInSockets =
    signIn === undefined
      ? ""
      : `, (name = "idp", address = "127.0.0.1:${signIn.idpPort}", http = (), service = "idp")`;
  const signInBindings =
    signIn === undefined
      ? []
      : [`(name = "ASSETS", service = "assets")`, ...varBindings(signIn.vars)];
  const idpWorker =
    signIn === undefined
      ? ""
      : `
const idp :Workerd.Worker = (
  modules = [${signIn.idpModules.join(", ")}],
  compatibilityDate = "2026-09-15",
);

const assets :Workerd.Worker = (
  modules = [(name = "assets.js", esModule = embed "assets.js")],
  compatibilityDate = "2026-09-15",
  bindings = [(name = "FILES", service = "asset-files")],
);
`;
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  # One JSON line per log, with its level: the smoke reads them.
  structuredLogging = true,
  services = [
    (name = "core", worker = .core),
    (name = "storage", disk = (path = "${storage}", writable = true)),
    # Core's D1 databases, on the on-prem profile's D1 service: workerd
    # has D1's client but no D1 (apps/core/src/on-prem/d1.ts).
    ${d1Service("storage")},
    # Core's R2 buckets, on the on-prem profile's R2 service: workerd has
    # R2's client but no R2 (apps/core/src/on-prem/r2.ts).
    ${r2Service("storage")},
    # Where untrusted App code runs: the sandbox supervisor, outside core's
    # process, which plain workerd's lack of a CPU limit can't stall.
    (name = "sandbox", external = (address = "unix:${sandboxSocket}", http = ())),${signInServices}
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "core")${signInSockets}],
);

const core :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "ROUTER_SECRET", text = "${routerSecret}"),
    (name = "DURABLE_OBJECT_JURISDICTION", text = "none"),
    (name = "RUNTIME_PROFILE", text = "workerd"),
    (name = "SANDBOX_HOST", service = "sandbox"),
    ${durableObjectBindings.join(",\n    ")},
    ${d1Bindings(d1DatabasesOf(coreWranglerConfig)).join(",\n    ")},
    ${r2Bindings(r2BucketsOf(coreWranglerConfig)).join(",\n    ")},
    ${signInBindings.map((binding) => `${binding},`).join("\n    ")}
    # No LOADER (experimental in workerd) in core itself: on-prem, App
    # functions and builds run on the sandbox host, whose workerd
    # processes have one (workerd-sandbox.ts). The workflow engine is a
    # Durable Object (WORKFLOW_RUNS), bound with the others.
  ],
  durableObjectNamespaces = [
    ${durableObjectNamespaces.join(",\n    ")},
  ],
  # On disk, as on-prem: workerd keeps no SQLite in memory, and in-memory
  # storage aborts workerd when an alarm fires (the audit log's retention).
  durableObjectStorage = (localDisk = "storage"),
);
${idpWorker}`;
};
