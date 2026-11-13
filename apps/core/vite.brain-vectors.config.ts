import { coreProject } from "./vite.config.ts";

// How fast the Brain's store scans vector codes (GRA-1766), on request
// only: filling a store with 300,000 codes takes far longer than CI
// should, and it isn't in the root's projects. Run it from the repository
// root:
//
//   vp -C apps/core test -c vite.brain-vectors.config.ts
//
// It reports each size's timings as a `BRAIN_VECTOR_TIMING` JSON line.

/** Minutes the run may take before Vitest stops it. */
const maxMinutes = 60;

// No meaning hit of the test model reaches it: it scans codes it puts in the store itself, never through core's recall.
export default coreProject({
  name: "@grasp-os/core:brain-vectors",
  include: ["test/brain-next-vector-timings.test.ts"],
  testTimeout: maxMinutes * 60 * 1000,
  hookTimeout: maxMinutes * 60 * 1000,
});
