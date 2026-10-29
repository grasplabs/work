import { execFileSync } from "node:child_process";

import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";

import { coreProject } from "./vite.config.ts";

// Experiment E02 (GRA-304) against a real reranking model, on request
// only: it costs money, so it is in no project the root runs, and CI never
// runs it. The model is `BRAIN_MODEL`, a gateway ref such as
// `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, or while unset
// the one a deployment's gateway asks by default. The run's gateway makes
// it the `quick` role's model, the one a rerank asks, reached through
// core's model gateway and ledger over the real AI binding with your
// Wrangler login (`wrangler whoami`). Run from the repository root, with
// the most it may spend, in US dollars:
//
//   BRAIN_MODEL=workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast BRAIN_MODEL_BUDGET_USD=1 \
//     vp -C apps/core test -c vite.brain-recall-model.config.ts
//
// It takes the repeats from `BRAIN_MODEL_REPEATS` (3 while unset). Each
// recall that reranks makes one call; a warm one makes none. The budget is
// the ledger's deployment limit for the run: core refuses any request that
// could take the spend past it. The run reports on its output as JSON
// lines (`BRAIN_RECALL_REPORT`); keep them outside the repository.

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);
if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs BRAIN_MODEL_BUDGET_USD, in US dollars"
  );
}

/** The model under test: a gateway ref, the deployment default if unset. */
const [deploymentDefault] = defaultGatewayModels;
const model = process.env.BRAIN_MODEL ?? deploymentDefault;

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf-8",
  }).trim();

/** Hours a run may take before Vitest stops it. */
const maxHours = 2;

export default coreProject(
  {
    name: "@grasp-os/core:brain-recall-model",
    include: ["test/brain-recall-real-model.test.ts"],
    testTimeout: maxHours * 60 * 60 * 1000,
    hookTimeout: maxHours * 60 * 60 * 1000,
  },
  {
    remoteBindings: true,
    bindings: {
      // A deployment's gateway as the console first configures it, with
      // the model under test listed first and playing the quick role.
      MODEL_GATEWAY: {
        gateway: "default",
        models: [
          model,
          ...defaultGatewayModels.filter((listed) => listed !== model),
        ],
        roles: { quick: model },
      },
      BRAIN_RECALL_MODEL: {
        model,
        repeats: Number(process.env.BRAIN_MODEL_REPEATS ?? "3"),
        budgetUsd,
        build: {
          sha: git("rev-parse", "HEAD"),
          dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
          profile:
            "workerd (Vitest pool, RUNTIME_PROFILE=workerd), AI binding remote over Wrangler login",
        },
      },
    },
  }
);
