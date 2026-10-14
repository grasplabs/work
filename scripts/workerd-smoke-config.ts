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
}

/** The `config.capnp` text that serves core on plain workerd. */
export const smokeConfig = ({
  port,
  sandboxSocket,
  routerSecret,
  modules,
  storage,
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
    (name = "sandbox", external = (address = "unix:${sandboxSocket}", http = ())),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "core")],
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
    # No LOADER (experimental in workerd): apps, screens and App workflow
    # runs need workerd's --experimental. The workflow engine itself is a
    # Durable Object (WORKFLOW_RUNS), bound with the others.
  ],
  durableObjectNamespaces = [
    ${durableObjectNamespaces.join(",\n    ")},
  ],
  # On disk, as on-prem: workerd keeps no SQLite in memory, and in-memory
  # storage aborts workerd when an alarm fires (the audit log's retention).
  durableObjectStorage = (localDisk = "storage"),
);
`;
};
