/**
 * How every isolate on the on-prem sandbox host runs, whatever a call
 * says: the host sets it, not its caller (sandbox-host.ts,
 * sandbox-session.ts). The same as core's `sandbox` (apps/core/src/
 * sandbox.ts: `isolateBase` and spec 18.1's server invocation CPU), which
 * a test holds them to; plain workerd ignores `cpuMs`, which is why the
 * supervisor bounds the time. Written out rather than imported: the
 * sandbox host loads this module as it is, its types stripped, beside
 * only its own (scripts/workerd-sandbox.ts), so it can't import the
 * platform's limits or runtime modules.
 */
export const isolateSettings = {
  compatibilityDate: "2026-09-15",
  compatibilityFlags: [
    "disallow_importable_env",
    "no_nodejs_compat",
    "no_nodejs_compat_v2",
  ],
  limits: { cpuMs: 10_000 },
};
