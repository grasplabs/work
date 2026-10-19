import { coreProject } from "./vite.config.ts";

// The Brain baseline (test/brain-baseline.test.ts) in a group of its own:
// its one shared run takes its trials one at a time, and beside a shard's
// other heavy core files it ran four to eight times as long as alone,
// near its 300 s timeout (GRA-698). Projects run in groups, lowest first:
// this one after all the others, alone in whichever shard it lands.
export default coreProject({
  name: "@grasp-os/core:brain",
  include: ["test/brain-baseline.test.ts"],
  sequence: { groupOrder: 3 },
});
