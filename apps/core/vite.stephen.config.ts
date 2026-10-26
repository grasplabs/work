import { coreProject } from "./vite.config.ts";

// Stephen's eval (test/stephen-eval.test.ts, GRA-720, and on Google
// Workspace, test/stephen-eval-google.test.ts) in a group of its
// own, as the Brain baseline is (vite.brain.config.ts): its one run asks
// its cases one at a time, each a whole turn through the Workspace object,
// connect and the gateway, and beside a shard's other heavy core files it
// would crowd them and they it. Projects run in groups, lowest first: this
// one after all the others.
export default coreProject({
  name: "@grasp-os/core:stephen",
  include: ["test/stephen-eval.test.ts", "test/stephen-eval-google.test.ts"],
  sequence: { groupOrder: 4 },
});
