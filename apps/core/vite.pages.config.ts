import { coreProject, pageTests } from "./vite.config.ts";

export default coreProject({
  name: "@grasp-os/core:pages",
  include: pageTests,
  // Projects run in groups, lowest first: this one after all the others.
  sequence: { groupOrder: 1 },
});
