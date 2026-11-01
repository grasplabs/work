import { execFileSync } from "node:child_process";

import { coreProject } from "./vite.config.ts";

// Stephen's eval against a real model (GRA-720), on request only: it costs
// money, so no project the root runs has it; it runs by hand or weekly in
// CI (.github/workflows/stephen-eval.yml, stephen-weekly.yml). It runs as
// vite.brain-model.config.ts runs the Brain baseline (GRA-676): the model
// is `STEPHEN_MODEL`, as the gateway names it, such as
// `anthropic/claude-sonnet-5` or `mistral/mistral-large-latest` (the
// latter while unset), the one the run's organization chooses, reached
// through core's model gateway, ledger and connect, then from the test's
// isolate to the provider's own API with the real key `STEPHEN_MODEL_KEY`
// (test/brain-real-provider.ts): Anthropic's, Mistral's or OpenRouter's.
// Never commit the key; give it in the shell. The judge asks the same
// model. Run from the repository root, with the most it may spend, in US
// dollars:
//
//   STEPHEN_MODEL=anthropic/claude-sonnet-5 STEPHEN_MODEL_KEY=… STEPHEN_MODEL_BUDGET_USD=5 \
//     vp -C apps/core test -c vite.stephen-model.config.ts
//
// `STEPHEN_MODEL_CASES` takes case IDs, comma-separated, to run only
// those (`R1,X2`). The budget is the ledger's deployment limit for the
// run, and the only cap on it here: core refuses any request that could
// take the spend past it. The report and every model exchange go to the
// output as JSON lines (`STEPHEN_MODEL_REPORT`, `STEPHEN_MODEL_EXCHANGES`);
// keep them outside the repository.

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.STEPHEN_MODEL_BUDGET_USD);
if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs STEPHEN_MODEL_BUDGET_USD, in US dollars"
  );
}

/** The model under test, as the gateway names it. */
const named = process.env.STEPHEN_MODEL;
// CI passes an unset setting as empty.
const model =
  named === undefined || named === "" ? "mistral/mistral-large-latest" : named;

/** The provider's real key: from the shell or CI's secret, never committed. */
const key = process.env.STEPHEN_MODEL_KEY ?? "";

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
    bindings: {
      ...(key === "" ? {} : { STEPHEN_MODEL_KEY: key }),
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
            "workerd (Vitest pool, RUNTIME_PROFILE=workerd), the provider's own API with a real key",
        },
      },
    },
  }
);
