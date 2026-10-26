import { coreProject } from "./vite.config.ts";

// The Brain baseline (test/brain-baseline.test.ts) and its CI scale size
// (test/brain-scale*.test.ts, an arm per file) in a group of their own:
// each run takes its trials one at a time, and beside a shard's other
// heavy core files the baseline ran four to eight times as long as alone,
// near its 300 s timeout (GRA-698), and the scale run two to two and a
// half times (GRA-1094). Projects run in groups, lowest first: this one
// after all the others, and in CI on shards of its own
// (scripts/test-shards.ts).
export default coreProject({
  name: "@grasp-os/core:brain",
  include: [
    "test/brain-baseline.test.ts",
    "test/brain-scale.test.ts",
    "test/brain-scale-agent.test.ts",
    "test/brain-scale-full-context.test.ts",
  ],
  sequence: { groupOrder: 3 },
  // One file at a time, so none runs beside another's trials.
  fileParallelism: false,
});
