import { coreProject } from "./vite.config.ts";

// The Brain baseline's larger scale sizes (GRA-678), on request only: they
// take far longer than CI should, and aren't in the root's projects. Run
// one size at a time from the repository root, for instance:
//
//   BRAIN_SCALE_CHUNKS=100000 vp -C apps/core test -c vite.brain-scale.config.ts
//
// CI runs the smallest size in test/brain-scale.test.ts.

/** Distractor chunks to grow the company by: 100,000 unless asked. */
const chunks = Number(process.env.BRAIN_SCALE_CHUNKS ?? "100000");

/** The distractors' seed: the default seed unless asked. */
const seed =
  process.env.BRAIN_SCALE_SEED === undefined
    ? undefined
    : Number(process.env.BRAIN_SCALE_SEED);

/** Repeats per task and arm: a cold and a warm one unless asked. */
const repeats = Number(process.env.BRAIN_SCALE_REPEATS ?? "2");

/** Hours the run may take before Vitest stops it. */
const maxHours = 6;

export default coreProject(
  {
    name: "@grasp-os/core:brain-scale",
    include: ["test/brain-scale-sizes.test.ts"],
    testTimeout: maxHours * 60 * 60 * 1000,
    hookTimeout: maxHours * 60 * 60 * 1000,
  },
  {
    bindings: {
      BRAIN_SCALE: { chunks, repeats, ...(seed === undefined ? {} : { seed }) },
    },
  }
);
