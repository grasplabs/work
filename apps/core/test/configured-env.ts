import { env } from "cloudflare:workers";

/** Where the runtime keeps the env as configured: on its global. */
const configuredKey = Symbol.for("grasp.configured-env");

/**
 * Core's test env as vite.config.ts configures it, taken once per
 * runtime, when the first test file's setup imports this module: the env
 * before any test changed it (see start-each-file.ts). Kept on the
 * runtime's global: were the module registry reset (`vi.resetModules()`),
 * a later file's setup would evaluate this module again and take what a
 * test left in the env for configured, and every later file would start
 * from it. A quota policy left so, under a generation of its own, put
 * each later file's own policies behind it (quotas.ts, `quotaPolicy`).
 */
const taken: unknown = Reflect.get(globalThis, configuredKey);
export const configuredEnv: ReadonlyMap<string, unknown> =
  taken instanceof Map ? taken : new Map(Object.entries(env));
Reflect.set(globalThis, configuredKey, configuredEnv);
