// Vitest's sequencer for this repo (vite.config.ts): shards split by how
// long each file takes (scripts/test-shards.ts, with the times in
// scripts/test-durations.json), and in each shard a project's longest
// files first, so none starts last and holds its group up. Vitest's own split,
// by a hash of each file's path, and its order, by file size on a runner
// without a cache, knew neither.
import { readFileSync } from "node:fs";
import path from "node:path";

import { BaseSequencer } from "vite-plus/test/node";
import type { TestSpecification } from "vite-plus/test/node";

import { durationsFile, parseDurations } from "./test-durations.ts";
import { byKey, splitIntoShards } from "./test-shards.ts";
import type { ShardFile } from "./test-shards.ts";

/** Seconds per file, `<project> <file>`, as the progress logs name them. */
const durations = parseDurations(readFileSync(durationsFile, "utf-8"));

/** What a file nobody timed yet is taken to take: the median file's time. */
const unknownSeconds = ((): number => {
  const sorted = Object.values(durations).toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
})();

const keyOf = (spec: TestSpecification): string =>
  `${spec.project.name} ${path.relative(spec.project.config.root, spec.moduleId)}`;

const secondsOf = (spec: TestSpecification): number =>
  durations[keyOf(spec)] ?? unknownSeconds;

export default class DurationSequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[]
  ): Promise<TestSpecification[]> {
    const { shard } = this.ctx.config;
    if (shard === undefined || shard === null) {
      return await super.shard(files);
    }
    const specs = new Map(files.map((spec) => [keyOf(spec), spec]));
    const split = splitIntoShards(
      files.map((spec): ShardFile => ({
        key: keyOf(spec),
        group: spec.project.config.sequence.groupOrder,
        // `fileParallelism: false` resolves to one worker.
        serial: spec.project.config.maxWorkers === 1,
        seconds: secondsOf(spec),
      })),
      shard.count
    );
    return (split[shard.index - 1] ?? []).flatMap(({ key }) => {
      const spec = specs.get(key);
      return spec === undefined ? [] : [spec];
    });
  }

  // oxlint-disable-next-line class-methods-use-this -- Vitest calls it on its sequencer
  override async sort(
    files: TestSpecification[]
  ): Promise<TestSpecification[]> {
    return await Promise.resolve(
      files.toSorted(
        (a, b) =>
          a.project.config.sequence.groupOrder -
            b.project.config.sequence.groupOrder ||
          // Projects one after another, as Vitest's own order has them.
          byKey(a.project.name, b.project.name) ||
          secondsOf(b) - secondsOf(a)
      )
    );
  }
}
