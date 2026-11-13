import { coreProject } from "./vite.config.ts";

// The Brain baseline (test/brain-baseline*.test.ts, its measured trials in
// parts, a file each: brain-baseline-parts.ts) and its CI scale size
// (test/brain-scale-*-of-*.test.ts, each arm in parts, a file each:
// brain-scale-arm.ts) in a group of their own:
// each run takes its trials one at a time, and beside a shard's other
// heavy core files the baseline ran four to eight times as long as alone,
// near its 300 s timeout (GRA-698), and the scale run two to two and a
// half times (GRA-1094). Experiment E02 (test/brain-recall-e02.test.ts)
// times each recall it asks, one at a time, so it runs here too. Projects run in groups, lowest first: this one
// after all the others, and in CI on shards of its own
// (scripts/test-shards.ts).
// No meaning hit of the test model reaches them: they measure the older
// Brain (test/brain-harness.ts), whose chats hold no `brain` grant, so none
// recalls core's Brain.
export default coreProject({
  name: "@grasp-os/core:brain",
  include: [
    "test/brain-baseline.test.ts",
    "test/brain-baseline-*-of-*.test.ts",
    "test/brain-recall-e02.test.ts",
    "test/brain-scale-*-of-*.test.ts",
  ],
  sequence: { groupOrder: 3 },
  // One file at a time, so none runs beside another's trials.
  fileParallelism: false,
});
