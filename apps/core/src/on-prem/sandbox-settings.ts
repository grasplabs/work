/**
 * How every isolate on the on-prem sandbox host runs, whatever a call
 * says: the host sets it, not its caller (sandbox-host.ts,
 * sandbox-session.ts). The same as core's `sandbox` (apps/core/src/
 * sandbox.ts: `isolateBase` and its CPU limit), which a test holds them
 * to; plain workerd ignores `cpuMs`, which is why the supervisor bounds
 * the time.
 */
export const isolateSettings = {
  compatibilityDate: "2026-09-15",
  compatibilityFlags: ["disallow_importable_env"],
  limits: { cpuMs: 10_000 },
};
