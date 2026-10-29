// The connect gateway (GRA-1217, its threat model): how a placed client's
// core reaches its own connect on Workers for Platforms, where Cloudflare
// refuses a service binding from one user Worker to another (10143,
// GRA-430). One ordinary platform Worker, holding the binding to the
// clients' dispatch namespace, is what each placed core's `CONNECT`
// binds, with `props: { script }` the admin sets from the client's
// inventory as it uploads core. The gateway forwards every method core
// calls to that script alone. Account-per-client deployments and on-prem
// keep their direct `CONNECT` service binding. Each stage has its own
// gateway (`grasp-connect-gateway`, `-staging`, ./names.ts), which reaches
// its stage's clients' dispatch namespace alone, the one its router binds.

/** What the admin sets on a placed core's binding to the gateway. */
export interface ConnectGatewayProps {
  /** The client's connect script in the namespace: `g<deployment>-grasp-os-connect`. */
  readonly script: string;
}

/**
 * A client connect's script name, as the admin names it
 * (`g<deployment>-grasp-os-connect`, apps/admin/src/hosting/inventory.ts):
 * the only scripts the gateway ever reaches.
 */
const clientConnectScript = /^g[a-z0-9][a-z0-9-]*-grasp-os-connect$/u;

/** The client connect `props` name, or undefined for props that name none. */
export const gatewayScriptOf = (props: unknown): string | undefined => {
  if (typeof props !== "object" || props === null) {
    return undefined;
  }
  const script: unknown = Reflect.get(props, "script");
  return typeof script === "string" && clientConnectScript.test(script)
    ? script
    : undefined;
};

/**
 * Names the gateway never forwards: what the runtime or a caller reads on
 * an object that isn't one of connect's methods (a thenable's `then`, a
 * socket's `connect`, conversions), the entrypoint's own `ctx` and `env`,
 * and anything private by convention. A denylist, not an allowlist: every
 * other name reaches connect, so it never keeps one of connect's methods
 * private. It needn't: whatever is forwarded only ever reaches the
 * client's own connect, which core reaches directly elsewhere.
 */
const notForwarded: ReadonlySet<string> = new Set([
  "constructor",
  "ctx",
  "env",
  "then",
  "connect",
  "toString",
  "toJSON",
  "valueOf",
]);

/** Whether the gateway forwards the method `key` to the client's connect. */
export const forwardsMethod = (key: string | symbol): key is string =>
  typeof key === "string" &&
  key !== "" &&
  !key.startsWith("_") &&
  !notForwarded.has(key);
