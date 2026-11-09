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
 * Every build runs at once, each into its own folder: the frontend's,
 * core's (what it writes into the built frontend goes beside it, copied
 * in after, as the frontend's build empties its folder first), connect's
 * and the migrations. One after another they took 94 s of e2e-build on a
 * CI runner, the parts' start (November 2026). The SDK docs are built
 * too: an App's chat reads them (e2e/app-built.e2e.ts).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, readFileSync, rmSync } from "node:fs";
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
    env: {
      ...process.env,
      // The workspace's binaries, core's first, as its scripts find them.
      PATH: [
        path.join(coreDir, "node_modules/.bin"),
        path.join(root, "node_modules/.bin"),
        process.env.PATH ?? "",
      ].join(path.delimiter),
      ...env,
    },
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

/** The built frontend, which core serves, and which its build empties first. */
const frontendDist = "../web/dist";

/**
 * Where what core's build writes into the built frontend (the App
 * compiler, the extractor) is built meanwhile, to be copied in once the
 * frontend is built. Relative to core's folder, where the steps run, so
 * no checkout's path goes into a shell command.
 */
const besideFrontendFromCore = "../../e2e/dist/frontend";
const besideFrontend = path.join(coreDir, besideFrontendFromCore);

if (import.meta.main) {
  // dev:build is the frontend's build, core's `build`, connect's build.
  const [frontend = "", ...afterFrontend] = stepsOf("dev:build");
  const devBuild = afterFrontend.filter((step) => step !== "vp run build");
  if (devBuild.length === afterFrontend.length) {
    throw new Error("core's dev:build no longer runs `vp run build`");
  }
  const coreBuild = stepsOf("build");
  rmSync(migratedStateDir, { recursive: true, force: true });
  rmSync(besideFrontend, { recursive: true, force: true });
  // From core's folder, as every step of core's scripts runs.
  await run("node ../../e2e/connect-config.ts");
  await Promise.all([
    run(frontend),
    ...coreBuild.map(async (step) => {
      await run(step.replaceAll(frontendDist, besideFrontendFromCore));
    }),
    ...devBuild.map(runStep),
    run(stepsOf("dev:migrate").join(" && "), {
      DEV_PERSIST_TO: migratedStateDir,
      CONNECT_WRANGLER_CONFIG: connectConfig,
    }),
  ]);
  cpSync(besideFrontend, path.join(coreDir, frontendDist), { recursive: true });
}
