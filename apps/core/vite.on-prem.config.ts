import { readFileSync } from "node:fs";

import { sandboxSocketFile } from "./test/sandbox-setup.ts";
import { coreProject } from "./vite.config.ts";

// Core on-prem: its tests in test/on-prem run with `SANDBOX_HOST` bound to
// the sandbox supervisor (scripts/workerd-sandbox.ts), which the project's
// setup starts, as on-prem binds it, so App code runs in its sandbox.
export default coreProject(
  {
    name: "@grasp-os/core:on-prem",
    include: ["test/on-prem/**/*.test.ts"],
    // Projects run in groups, lowest first: this one after the others.
    sequence: { groupOrder: 2 },
    // One file at a time: they share one supervisor, whose small pool two
    // files running at once would share too, each refused places the
    // other holds.
    fileParallelism: false,
  },
  { sandboxSocket: () => readFileSync(sandboxSocketFile, "utf-8") }
);
