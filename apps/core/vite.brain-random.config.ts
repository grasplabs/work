import { coreProject } from "./vite.config.ts";

// The Brain's random permission test (test/brain-next-random.test.ts) over
// more seeds than CI runs, on request only. From the repository root:
//
//   BRAIN_RANDOM_SEEDS=2000 vp -C apps/core test -c vite.brain-random.config.ts
//
// and one seed a failure printed, again:
//
//   BRAIN_RANDOM_FROM=1234 BRAIN_RANDOM_SEEDS=1 vp -C apps/core test -c vite.brain-random.config.ts

/** The first seed: 1 unless asked. */
const from = Number(process.env.BRAIN_RANDOM_FROM ?? "1");

/** How many seeds, one after another from `from`: 500 unless asked. */
const count = Number(process.env.BRAIN_RANDOM_SEEDS ?? "500");

// Its arm without a vector recalls through core without the embedder
// (test/without-embedder.ts), so the test model never reaches it.
export default coreProject(
  {
    name: "@grasp-os/core:brain-random",
    include: ["test/brain-next-random.test.ts"],
  },
  { bindings: { BRAIN_RANDOM: { from, count } } }
);
