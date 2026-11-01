import { coreProject } from "./vite.config.ts";

// JSON workflows' items and branches at once, replayed with the host's own
// I/O made slower at random (src/workflows/host-latency.ts): local D1
// answers in well under a macrotask, which hides a replay that holds
// together only while the host is that quick.
export default coreProject(
  {
    name: "@grasp-os/core:latency",
    include: ["test/workflow-latency.test.ts"],
  },
  { bindings: { WORKFLOW_HOST_LATENCY_MS: "15" } }
);
