import { everythingCapOf } from "./test/fixtures/brain-eval/everything.ts";
import { coreProject } from "./vite.config.ts";

// The Brain evaluation against a real model (GRA-1813), on request only:
// it costs money, so it is in no project the root runs, and CI never runs
// it. Run it with `vp run brain:eval:model` (scripts/brain-eval-model.ts),
// which says first what it would do and cost, and runs this project only
// with a key and a budget. Its guard is the Brain baseline's (GRA-676,
// vite.brain-model.config.ts): the model is `BRAIN_MODEL`, as the gateway
// names it, the one the run's organization chooses, reached through core's
// model gateway and connect, then from the test's isolate to the
// provider's own API with the real key `BRAIN_MODEL_KEY`
// (test/brain-real-provider.ts). Never commit the key; give it in the
// shell. `BRAIN_MODEL_BUDGET_USD` is the most it may spend: required, as
// is the key, before anything starts.

/** Dollars the run may spend: required before anything is sent. */
const budgetUsd = Number(process.env.BRAIN_MODEL_BUDGET_USD);
if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
  throw new Error(
    "A real-model run needs BRAIN_MODEL_BUDGET_USD, in US dollars"
  );
}

/** The provider's real key: from the shell, never committed. */
const key = process.env.BRAIN_MODEL_KEY ?? "";
if (key === "") {
  throw new Error(
    "A real-model run needs BRAIN_MODEL_KEY, the key of the model's provider"
  );
}

/** The model under test, as the gateway names it. */
const named = process.env.BRAIN_MODEL;
const model =
  named === undefined || named === "" ? "mistral/mistral-large-latest" : named;

/** Tokens "everything" is cut at below the model's window; null for the window. */
const everythingTokens = everythingCapOf(
  process.env.BRAIN_EVAL_EVERYTHING_TOKENS
);

/** Hours a run may take before Vitest stops it. */
const maxHours = 4;

// No meaning hit of the test model reaches it: its pack arm recalls through
// core without the embedder (test/without-embedder.ts), by words and exact
// parts as defined.
export default coreProject(
  {
    name: "@grasp-os/core:brain-eval-model",
    include: ["test/brain-eval-model.test.ts"],
    fileParallelism: false,
    testTimeout: maxHours * 60 * 60 * 1000,
    hookTimeout: maxHours * 60 * 60 * 1000,
  },
  {
    bindings: {
      BRAIN_MODEL_KEY: key,
      BRAIN_EVAL_MODEL_RUN: {
        model,
        budgetUsd,
        everythingTokens,
      },
    },
  }
);
