/**
 * The split between CI's shards (test-shards.ts): every file runs exactly
 * once, the same way on every runner, and the long files spread out.
 */
import { describe, expect, it } from "vite-plus/test";

import { shardSeconds, splitIntoShards, startsFirst } from "./test-shards.ts";
import type { ShardFile, TimedFile } from "./test-shards.ts";

const file = (
  key: string,
  seconds: number,
  { group = 0, serial = false }: { group?: number; serial?: boolean } = {}
): ShardFile => ({ key, seconds, group, serial });

/** Many short files and a few long ones, as a test suite has. */
const suite: ShardFile[] = [
  file("core fair-admission", 230),
  file("core brain-baseline", 155),
  file("core agent", 90),
  file("screens client", 180, { group: 1 }),
  file("screens stream", 75, { group: 1 }),
  file("on-prem runs", 95, { group: 2, serial: true }),
  file("on-prem calls", 20, { group: 2, serial: true }),
  ...Array.from({ length: 120 }, (_, index) =>
    file(`small ${index}`, 1 + (index % 7))
  ),
];

const keysOf = (shards: ShardFile[][]): string[][] =>
  shards.map((shard) => shard.map(({ key }) => key).toSorted());

describe("splitting the test files between shards", () => {
  it("runs every file in exactly one shard", () => {
    const shards = splitIntoShards(suite, 4);

    expect(shards).toHaveLength(4);
    expect(keysOf(shards).flat().toSorted()).toStrictEqual(
      suite.map(({ key }) => key).toSorted()
    );
  });

  it("splits the same files the same way, whatever order they come in", () => {
    expect(keysOf(splitIntoShards(suite.toReversed(), 4))).toStrictEqual(
      keysOf(splitIntoShards(suite, 4))
    );
  });

  it("puts the longest files in different shards", () => {
    const longest = new Set([
      "core fair-admission",
      "core brain-baseline",
      "screens client",
      "on-prem runs",
    ]);
    const shards = keysOf(splitIntoShards(suite, 4));

    for (const shard of shards) {
      expect(shard.filter((key) => longest.has(key))).toHaveLength(1);
    }
  });

  it("ends the shards close together: the longest within a fifth of the shortest", () => {
    const seconds = splitIntoShards(suite, 4).map(shardSeconds);

    expect(Math.max(...seconds)).toBeLessThan(Math.min(...seconds) * 1.2);
  });

  it("counts a group's files one after another where the project runs them so", () => {
    const parallel = [file("a", 10), file("b", 10)];
    const serial = parallel.map((each) => ({ ...each, serial: true }));

    expect(shardSeconds(serial)).toBe(20);
    expect(shardSeconds(parallel)).toBeLessThan(20);
  });

  it("adds a shard's groups up, as it runs them one after another", () => {
    expect(
      shardSeconds([file("core", 100), file("screens", 100, { group: 1 })])
    ).toBe(200);
  });

  it("starts a project's untimed files first, then its longest", () => {
    const files: TimedFile[] = [
      { key: "short", seconds: 2 },
      { key: "new b", seconds: undefined },
      { key: "long", seconds: 90 },
      { key: "new a", seconds: undefined },
      { key: "middle", seconds: 30 },
    ];

    expect(files.toSorted(startsFirst).map(({ key }) => key)).toStrictEqual([
      "new a",
      "new b",
      "long",
      "middle",
      "short",
    ]);
  });
});
