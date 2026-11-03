import { defineProject } from "vite-plus";

// The compiler's tests, one file at a time: each build test starts Node,
// TypeScript and three bundles, which take the runner's CPUs. Run at once
// in one CI shard, several starved each other past their tests' timeout
// (merge-group runs of #1864, November 2026), so the shard split counts
// them one after another too (scripts/test-shards.ts, `serial`). Its unit
// tests take milliseconds; one at a time costs them nothing.
export default defineProject({
  test: {
    fileParallelism: false,
  },
});
