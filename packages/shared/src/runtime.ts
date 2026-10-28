/**
 * The Workers compatibility date Grasp OS runs on, for Workers started from
 * code (Dynamic Workers, test isolates). The wrangler.jsonc files can't
 * import it and repeat it; change them together.
 */
export const compatibilityDate = "2026-09-15";

/**
 * The flags that turn Node.js compatibility off: both, since either
 * alone leaves `node:` modules (`node:timers` among them) in place.
 */
const withoutNode = ["no_nodejs_compat", "no_nodejs_compat_v2"];

/**
 * What every isolate started through the Worker Loader shares: this date,
 * no importable env, so its code sees only the env its loader gives it,
 * and no Node.js compatibility. `nodejs_compat` is on by default from
 * 2026-08-04: without `withoutNode`, App code, connectors and packages
 * would have `node:` modules and `process` though nothing of
 * theirs asks for them, and a timer imported by name from `node:timers`,
 * whose callback's throw nothing loaded first can catch (GRA-939). Only
 * the platform's own code that needs Node turns it on (`withNode`). Each
 * loader adds its own limits and `globalOutbound`.
 */
export const isolateBase: {
  compatibilityDate: string;
  compatibilityFlags: string[];
} = {
  compatibilityDate,
  compatibilityFlags: ["disallow_importable_env", ...withoutNode],
};

/**
 * `flags` with Node.js compatibility: for the platform's own code that is
 * written for Node (the compiler, extraction), never App code.
 */
export const withNode = (flags: readonly string[]): string[] => [
  ...flags.filter((flag) => !withoutNode.includes(flag)),
  "nodejs_compat",
];
