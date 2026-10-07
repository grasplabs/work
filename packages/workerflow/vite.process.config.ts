import { defineProject } from "vite-plus";

// The process-death tests: Node starts plain workerd on a disk directory,
// kills it with SIGKILL and starts it again (test/process/workerd.ts).
export default defineProject({
  test: {
    name: "@grasp-os/workerflow:process",
    root: import.meta.dirname,
    include: ["test/process/**/*.test.ts"],
    environment: "node",
    // Each test starts workerd a few times; bundling the fixture takes a
    // few seconds once per file.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
