import { execFileSync } from "node:child_process";

import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";

import { coreProject } from "./vite.config.ts";

// Stephen's eval against a real model (GRA-720), on request only: it costs
// money, so it is in no project the root runs, and CI never runs it. It
// runs as vite.brain-model.config.ts runs the Brain baseline (GRA-676):
// the model is `STEPHEN_MODEL`, a gateway ref such as
// `anthropic/claude-sonnet-5`, or while unset the one a deployment's
// gateway asks by default for chat, listed first in the run's gateway and
// reached through core's model gateway and ledger over the real AI binding
// with your Wrangler login (`wrangler whoami`). The judge asks the same
// model. Run from the repository root, with the most it may spend, in US
// dollars:
//
//   STEPHEN_MODEL=anthropic/claude-sonnet-5 STEPHEN_MODEL_BUDGET_USD=5 \
//     vp -C apps/core test -c vite.stephen-model.config.ts
//
// `STEPHEN_MODEL_CASES` takes case IDs, comma-separated, to run only
// those (`R1,X2`). The budget is the ledger's deployment limit for the
// run: core refuses any request that could take the spend past it. The
// report and every model exchange go to the output as JSON lines
// (`STEPHEN_MODEL_REPORT`, `STEPHEN_MODEL_EXCHANGES`); keep them outside
// the repository.

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.STEPHEN_MODEL_BUDGET_USD);
if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs STEPHEN_MODEL_BUDGET_USD, in US dollars"
  );
}

/** The model under test: a gateway ref, the deployment default if unset. */
const [deploymentDefault] = defaultGatewayModels;
const model = process.env.STEPHEN_MODEL ?? deploymentDefault;

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: import.meta.dirname,
    encoding: "utf-8",
  }).trim();

/** Hours a run may take before Vitest stops it. */
const maxHours = 2;

export default coreProject(
  {
    name: "@grasp-os/core:stephen-model",
    include: ["test/stephen-real-model.test.ts"],
    testTimeout: maxHours * 60 * 60 * 1000,
    hookTimeout: maxHours * 60 * 60 * 1000,
  },
  {
    remoteBindings: true,
    bindings: {
      // A deployment's gateway as the console first configures it, with
      // the model under test listed first, which makes it the one chats ask.
      MODEL_GATEWAY: {
        gateway: "default",
        models: [
          model,
          ...defaultGatewayModels.filter((listed) => listed !== model),
        ],
      },
      STEPHEN_MODEL: {
        model,
        budgetUsd,
        cases: (process.env.STEPHEN_MODEL_CASES ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== ""),
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
