import { coreProject } from "./vite.config.ts";

// The Brain evaluation (GRA-1726), on request only: it is in no project the
// root runs, so neither `vp test` nor CI runs it. Run it from the
// repository root with `vp run brain:eval` (scripts/brain-eval.ts), which
// runs this project, scores what it printed and keeps the result.
export default coreProject({
  name: "@grasp-os/core:brain-eval",
  include: ["test/brain-eval.test.ts"],
  // It times each recall: nothing else runs beside it.
  fileParallelism: false,
  testTimeout: 10 * 60 * 1000,
});
