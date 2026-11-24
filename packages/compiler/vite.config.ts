import { defineProject } from "vite-plus";

// The compiler's tests, one file at a time: each build test starts Node,
// TypeScript and three bundles, which take the runner's CPUs. Run at once
// in one CI shard, several starved each other past their tests' timeout
// (merge-group runs of #1864, November 2026), so the shard split counts
// them one after another too (scripts/test-shards.ts, `serial`). Its unit
// tests take milliseconds; one at a time costs them nothing.
//
// A group of their own (projects run in groups, lowest first), so CI gives
// them shards of their own (scripts/test-shards.ts). In a shard with core,
// Vitest ran them one by one after core's files had ended: 6 minutes of
// builds, their `beforeAll` included, after core's 6, the slowest shard of
// every full run, 12 to 14 minutes of the step's 15 (November 2026).
//
// The release most of them build on is built once per run, not once per
// test (build-baseline-setup.ts).
export default defineProject({
  test: {
    globalSetup: ["./build-baseline-setup.ts"],
    fileParallelism: false,
    sequence: { groupOrder: 5 },
  },
});
