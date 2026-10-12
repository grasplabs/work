import { isolateBase } from "@grasp-os/shared/runtime";

/**
 * How App code runs (its server, app.ts, and a draft's in its preview,
 * preview.ts; and its workflows, workflows/code.ts): no network, no
 * importable env, and a CPU limit per call, enforced by Cloudflare's
 * runtime (a busy loop ends there; memory is the runtime's limit per
 * isolate). Plain workerd (tests, local development, on-prem) doesn't
 * enforce `cpuMs`, so there a busy loop holds its process until it ends:
 * the on-prem guard is GRA-449, as for Code Mode (code-mode.ts). Its env
 * is only what its loader gives it.
 */
export const sandbox = {
  ...isolateBase,
  globalOutbound: null,
  // No `subRequests` cap: its only way out is the stubs in its env.
  limits: { cpuMs: 10_000 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;
