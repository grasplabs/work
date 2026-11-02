import { execFileSync } from "node:child_process";

import { coreProject } from "./vite.config.ts";

// Experiment E02 (GRA-304) against a real reranking model, on request
// only: it costs money, so it is in no project the root runs, and CI never
// runs it. The model is `BRAIN_MODEL`, as the gateway names it, such as
// `mistral/mistral-large-latest` (the one while unset). The run's
// organization chooses it, so it is the one a rerank asks, reached through
// core's model gateway, ledger and connect, then from the test's isolate
// to the provider's own API with the real key `BRAIN_MODEL_KEY`
// (test/brain-real-provider.ts): Anthropic's, Mistral's or OpenRouter's.
// Never commit the key; give it in the shell. Run from the repository
// root, with the most it may spend, in US dollars:
//
//   BRAIN_MODEL=mistral/mistral-large-latest BRAIN_MODEL_KEY=… BRAIN_MODEL_BUDGET_USD=1 \
//     vp -C apps/core test -c vite.brain-recall-model.config.ts
//
// It takes the repeats from `BRAIN_MODEL_REPEATS` (3 while unset). Each
// recall that reranks makes one call; a warm one makes none. The budget is
// the ledger's deployment limit for the run, and the only cap on it: core
// refuses any request that could take the spend past it. The run reports
// on its output as JSON lines (`BRAIN_RECALL_REPORT`); keep them outside
// the repository.

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);
if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs BRAIN_MODEL_BUDGET_USD, in US dollars"
  );
}

/** The model under test, as the gateway names it. */
const model = process.env.BRAIN_MODEL ?? "mistral/mistral-large-latest";

/** The provider's real key: from the shell, never committed. */
const key = process.env.BRAIN_MODEL_KEY ?? "";

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
    bindings: {
      ...(key === "" ? {} : { BRAIN_MODEL_KEY: key }),
      BRAIN_RECALL_MODEL: {
        model,
        repeats: Number(process.env.BRAIN_MODEL_REPEATS ?? "3"),
        budgetUsd,
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
