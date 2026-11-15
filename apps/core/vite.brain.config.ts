import { coreProject } from "./vite.config.ts";

// Experiment E02 (test/brain-recall-e02.test.ts) times each recall it
// asks, one at a time, so it runs in a group of its own: beside a shard's
// other heavy core files its timings would measure them. Projects run in
// groups, lowest first: this one after all the others, and in CI on shards
// of its own (scripts/test-shards.ts).
export default coreProject({
  name: "@grasp-os/core:brain",
  include: ["test/brain-recall-e02.test.ts"],
  sequence: { groupOrder: 3 },
  // One file at a time, so none runs beside another's trials.
  fileParallelism: false,
});
