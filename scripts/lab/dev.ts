/**
 * `vp run lab:dev`: the local stack (`vp run dev`, scripts/dev.ts) with its
 * models on a Claude subscription instead of the API, and the lab's bridge
 * that makes it so (bridge.ts). Connect runs with a config of the lab's
 * own (`scripts/lab/out/connect/wrangler.json`), connect's own plus its
 * on-prem relay pointed at the bridge (scripts/connect-relay-config.ts),
 * so every model call still goes through core's gateway and connect, and
 * only where connect sends it changes. Nothing else of the stack differs.
 *
 * The organization still needs an Anthropic key in Settings for the
 * gateway to route to Anthropic at all: any text does, as the bridge
 * never reads it (and the real one should not be there, so a call can't
 * reach the API by mistake). The lab checks that its calls reach the
 * bridge before it runs anything (core.ts, `openCore`).
 *
 * When one of the two stops, both stop.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import { writeRelayedConnectConfig } from "../connect-relay-config.ts";
import { bridgeOrigin } from "./bridge.ts";

/** Where the lab's connect config is written: in the lab's ignored `out/`. */
export const labConnectConfig = path.join(
  import.meta.dirname,
  "out/connect/wrangler.json"
);

if (import.meta.main) {
  writeRelayedConnectConfig(labConnectConfig, bridgeOrigin);
  const root = path.join(import.meta.dirname, "../..");
  const start = (script: string, env: NodeJS.ProcessEnv): ChildProcess =>
    spawn(process.execPath, [path.join(root, script)], {
      stdio: "inherit",
      cwd: root,
      env,
    });
  const children = [
    start("scripts/lab/bridge.ts", process.env),
    start("scripts/dev.ts", {
      ...process.env,
      CONNECT_WRANGLER_CONFIG: labConnectConfig,
    }),
  ];
  const stopAll = (): void => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
  };
  for (const child of children) {
    child.on("exit", (code) => {
      stopAll();
      process.exitCode = code ?? 0;
    });
  }
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
}
