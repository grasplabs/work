import { execFileSync } from "node:child_process";

import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";

import { coreProject } from "./vite.config.ts";

// The Brain baseline against a real model (GRA-676), on request only: it
// costs money, so it is in no project the root runs, and CI never runs it.
// The model is the one a deployment's gateway asks by default for chat,
// reached through core's model gateway and ledger over the real AI binding
// with your Wrangler login (`wrangler whoami`). Run from the repository
// root, first the estimate, which spends nothing:
//
//   BRAIN_MODEL_MODE=estimate vp -C apps/core test -c vite.brain-model.config.ts
//
// then a split, with the most it may spend, in US dollars:
//
//   BRAIN_MODEL_MODE=run BRAIN_MODEL_SPLIT=validation BRAIN_MODEL_BUDGET_USD=5 \
//     vp -C apps/core test -c vite.brain-model.config.ts
//
// The budget is the ledger's deployment limit for the run: core refuses any
// request that could take the spend past it, so the run stops there. Each
// run reports on its output as JSON lines (`BRAIN_MODEL_REPORT`); keep them
// outside the repository.

const mode = process.env.BRAIN_MODEL_MODE;
if (mode !== "estimate" && mode !== "run") {
  throw new Error("Set BRAIN_MODEL_MODE to estimate or run");
}

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);
if (mode === "run" && !(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs BRAIN_MODEL_BUDGET_USD, in US dollars"
  );
}

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf-8",
  }).trim();

/** Hours a run may take before Vitest stops it. */
const maxHours = 4;

export default coreProject(
  {
    name: "@grasp-os/core:brain-model",
    include: ["test/brain-real-model.test.ts"],
    testTimeout: maxHours * 60 * 60 * 1000,
    hookTimeout: maxHours * 60 * 60 * 1000,
  },
  {
    // Only a run reaches Cloudflare; the estimate runs the stub.
    remoteBindings: mode === "run",
    bindings: {
      // A deployment's gateway as the console first configures it, and as
      // core configures it while none is set: Workers AI's models, on the
      // account's own AI Gateway.
      MODEL_GATEWAY: { gateway: "default", models: [...defaultGatewayModels] },
      BRAIN_MODEL: {
        mode,
        split: process.env.BRAIN_MODEL_SPLIT ?? "validation",
        repeats: Number(process.env.BRAIN_MODEL_REPEATS ?? "3"),
        ...(mode === "run" ? { budgetUsd } : {}),
        outputAllowance: Number(
          process.env.BRAIN_MODEL_OUTPUT_ALLOWANCE ?? "500"
        ),
        build: {
          sha: git("rev-parse", "HEAD"),
          dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
          profile:
            mode === "run"
              ? "workerd (Vitest pool, RUNTIME_PROFILE=workerd), AI binding remote over Wrangler login"
              : "workerd (Vitest pool, RUNTIME_PROFILE=workerd), stub provider",
        },
      },
    },
  }
);
