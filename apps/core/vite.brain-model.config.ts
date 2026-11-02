import { execFileSync } from "node:child_process";

import { coreProject } from "./vite.config.ts";

// The Brain baseline against a real model (GRA-676), on request only: it
// costs money, so it is in no project the root runs, and CI never runs it.
// The model is `BRAIN_MODEL`, as the gateway names it, such as
// `anthropic/claude-sonnet-5` or `mistral/mistral-large-latest` (the
// latter while unset). The run's organization chooses it, so it is the one
// its chats ask, reached through core's model gateway, ledger and connect,
// then from the test's isolate to the provider's own API with the real key
// `BRAIN_MODEL_KEY` (test/brain-real-provider.ts): Anthropic's, Mistral's
// or OpenRouter's. Never commit the key; give it in the shell. A model the
// gateway doesn't offer is refused before anything is sent. Run from the
// repository root, first the estimate, which spends nothing and needs no
// key:
//
//   BRAIN_MODEL=anthropic/claude-sonnet-5 BRAIN_MODEL_MODE=estimate vp -C apps/core test -c vite.brain-model.config.ts
//
// then a split (dev, validation or sealed), with the most it may spend, in
// US dollars:
//
//   BRAIN_MODEL=anthropic/claude-sonnet-5 BRAIN_MODEL_KEY=… BRAIN_MODEL_MODE=run BRAIN_MODEL_SPLIT=validation BRAIN_MODEL_BUDGET_USD=5 \
//     vp -C apps/core test -c vite.brain-model.config.ts
//
// Both take the repeats from `BRAIN_MODEL_REPEATS` (3 while unset), so give
// the estimate the repeats the run will have.
//
// The budget is the ledger's deployment limit for the run, and the only
// cap on it: core refuses any request that could take the spend past it,
// so the run stops there. Each run reports on its output as JSON lines
// (`BRAIN_MODEL_REPORT`); keep them outside the repository.

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

/** The model under test, as the gateway names it. */
const model = process.env.BRAIN_MODEL ?? "mistral/mistral-large-latest";

/** The provider's real key, for a run: from the shell, never committed. */
const key = process.env.BRAIN_MODEL_KEY ?? "";

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
    bindings: {
      // Only a run reaches the provider; the estimate runs the stub.
      ...(mode === "run" && key !== "" ? { BRAIN_MODEL_KEY: key } : {}),
      BRAIN_MODEL: {
        mode,
        model,
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
              ? "workerd (Vitest pool, RUNTIME_PROFILE=workerd), the provider's own API with a real key"
              : "workerd (Vitest pool, RUNTIME_PROFILE=workerd), stub provider",
        },
      },
    },
  }
);
