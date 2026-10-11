/**
 * The workerd config the on-prem smoke run (`workerd-smoke.ts`) serves core
 * with: plain workerd, as on-prem runs it. So it says
 * `RUNTIME_PROFILE=workerd`: Code Mode's run record then claims no CPU limit
 * (apps/core/src/code-mode.ts), which plain workerd doesn't enforce.
 */

/** What the config is made from. */
export interface SmokeConfigInputs {
  /** The local port core is served on. */
  port: number;
  /** The router secret every request to core must carry. */
  routerSecret: string;
  /** Core's modules, as capnp module entries. */
  modules: readonly string[];
}

/** The `config.capnp` text that serves core on plain workerd. */
export const smokeConfig = ({
  port,
  routerSecret,
  modules,
}: SmokeConfigInputs): string => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "core", worker = .core)],
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
    # No LOADER (experimental in workerd) and no WORKFLOWS (no engine):
    # apps and screens need workerd's --experimental, and workflows don't
    # run on-prem (apps/core/src/workflows/engine.ts).
  ],
  durableObjectNamespaces = [
    (className = "Workspace", uniqueKey = "workspace", enableSql = true),
    (className = "App", uniqueKey = "app", enableSql = true),
    (className = "AuditLog", uniqueKey = "audit-log", enableSql = true),
    (className = "Builtins", uniqueKey = "builtins", enableSql = true),
    (className = "Onboarding", uniqueKey = "onboarding", enableSql = true),
    (className = "ModelLedger", uniqueKey = "model-ledger", enableSql = true),
    (className = "DataStore", uniqueKey = "data-store", enableSql = true),
  ],
  # In-memory storage aborts workerd when a Durable Object alarm fires, so
  # the smoke run must not write audit events or run the 15-minute cron
  # trigger: either arms the audit log's retention alarm
  # (apps/core/src/audit-log.ts). That alarm is a day out, so it wouldn't
  # fire within one smoke run, but anything left running that long would
  # abort. On-prem runs use localDisk storage, where alarms work.
  durableObjectStorage = (inMemory = void),
);
`;
