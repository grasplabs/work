/**
 * Builds the e2e stack once, for CI's parts to start
 * (`GRASP_E2E_PREBUILT=true`, playwright.config.ts): core's code as its dev
 * script builds it (`dev:build`), and the stack's empty state with every
 * migration applied (`dev:migrate`, e2e/stack.ts's `migratedStateDir`),
 * which each stack starts from a copy of. Applying them took about 12 s of
 * each part's start (November 2026).
 *
 *   vp run e2e:build
 *
 * What doesn't depend on another runs at once: the frontend's build, the
 * steps of core's `build` that don't write into it, connect's build and
 * the migrations; then the steps that write into the built frontend
 * (`../web/dist`, which its build empties first). One after another they
 * took 94 s of e2e-build on a CI runner, the parts' start (November 2026).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { connectConfig, migratedStateDir } from "./stack.ts";

const root = path.join(import.meta.dirname, "..");
const coreDir = path.join(root, "apps/core");

/** Core's npm scripts, which say how each part is built. */
const coreScripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(readFileSync(path.join(coreDir, "package.json"), "utf-8"))
  ).scripts;

/** Runs `command` in core's folder through the shell, as its scripts run. */
const run = async (
  command: string,
  env: Record<string, string> = {}
): Promise<void> => {
  const child = spawn(command, {
    cwd: coreDir,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const [code] = z
    .tuple([z.number().nullable()])
    .rest(z.unknown())
    .parse(await once(child, "exit"));
  if (code !== 0) {
    throw new Error(`${command} exited with ${code ?? "a signal"}`);
  }
};

const runStep = async (step: string): Promise<void> => {
  await run(step);
};

/** The steps of one of core's scripts, as it runs them one after another. */
const stepsOf = (script: string): string[] => {
  const command = coreScripts[script];
  if (command === undefined) {
    throw new Error(`apps/core/package.json has no ${script} script`);
  }
  return command.split("&&").map((step) => step.trim());
};

/** What writes into the built frontend, which its build empties first. */
const intoFrontend = (step: string): boolean => step.includes("../web/dist");

if (import.meta.main) {
  // dev:build is the frontend's build, core's `build`, connect's build.
  const [frontend = "", ...afterFrontend] = stepsOf("dev:build");
  const devBuild = afterFrontend.filter((step) => step !== "vp run build");
  if (devBuild.length === afterFrontend.length) {
    throw new Error("core's dev:build no longer runs `vp run build`");
  }
  const coreBuild = stepsOf("build");
  rmSync(migratedStateDir, { recursive: true, force: true });
  await run(`node ${path.join(import.meta.dirname, "connect-config.ts")}`);
  await Promise.all([
    (async () => {
      await run(frontend);
      await Promise.all(coreBuild.filter(intoFrontend).map(runStep));
    })(),
    ...coreBuild.filter((step) => !intoFrontend(step)).map(runStep),
    ...devBuild.map(runStep),
    run(stepsOf("dev:migrate").join(" && "), {
      DEV_PERSIST_TO: migratedStateDir,
      CONNECT_WRANGLER_CONFIG: connectConfig,
    }),
  ]);
}
