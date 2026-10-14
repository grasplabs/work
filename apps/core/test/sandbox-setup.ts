import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  nativeWorkerd,
  startSandboxSupervisor,
} from "../../../scripts/workerd-sandbox.ts";
import type { SandboxSupervisor } from "../../../scripts/workerd-sandbox.ts";

/**
 * Where the on-prem project's config reads the sandbox supervisor's socket
 * (vite.on-prem.config.ts), which this setup writes once it listens.
 */
export const sandboxSocketFile = path.join(
  import.meta.dirname,
  "../dist/test-sandbox-socket"
);

declare global {
  var coreSandbox: Promise<SandboxSupervisor> | undefined;
}

/**
 * Before the on-prem project's tests: starts the sandbox supervisor, as
 * on-prem runs it beside core, and stops it after them. Core's tests then
 * run with `SANDBOX_HOST` bound to it, as on-prem binds it.
 */
const setup = async (): Promise<() => Promise<void>> => {
  globalThis.coreSandbox ??= startSandboxSupervisor({
    workerd: nativeWorkerd,
    processes: 2,
    log: () => {
      // Quiet: the tests say what they check.
    },
  });
  const supervisor = await globalThis.coreSandbox;
  mkdirSync(path.dirname(sandboxSocketFile), { recursive: true });
  writeFileSync(sandboxSocketFile, supervisor.socket);
  return async () => {
    await supervisor.stop();
  };
};

export default setup;
