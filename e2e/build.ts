/**
 * Builds the e2e stack once, for CI's parts to start
 * (`GRASP_E2E_PREBUILT=true`, playwright.config.ts): core's code as its dev
 * script builds it (`dev:build`), and the stack's empty state with every
 * migration applied (`dev:migrate`, e2e/stack.ts's `migratedStateDir`),
 * which each stack starts from a copy of. Applying
 * them took about 12 s of each part's start (November 2026).
 *
 *   vp run e2e:build
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

import { connectConfig, migratedStateDir } from "./stack.ts";

const root = path.join(import.meta.dirname, "..");

const core = (script: string, env: Record<string, string> = {}): void => {
  execFileSync("vp", ["run", "--filter", "@grasp-os/core", script], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
};

if (import.meta.main) {
  core("dev:build");
  execFileSync("node", [path.join(import.meta.dirname, "connect-config.ts")], {
    stdio: "inherit",
  });
  rmSync(migratedStateDir, { recursive: true, force: true });
  core("dev:migrate", {
    DEV_PERSIST_TO: migratedStateDir,
    CONNECT_WRANGLER_CONFIG: connectConfig,
  });
}
