/**
 * The split between CI's shards (test-shards.ts): every file runs exactly
 * once, the same way on every runner, and the long files spread out.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  projectStartSeconds,
  shardSeconds,
  splitIntoShards,
  spreadOver,
  startsFirst,
} from "./test-shards.ts";
import type { ShardFile, TimedFile } from "./test-shards.ts";

/** A file of the project its key starts with. */
const file = (
  key: string,
  seconds: number,
  { group = 0, serial = false }: { group?: number; serial?: boolean } = {}
): ShardFile => ({
  key,
  project: key.split(" ")[0] ?? key,
  seconds,
  group,
  serial,
});

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

  it("puts the longest files of a group in different shards", () => {
    const shards = keysOf(splitIntoShards(suite, 5));
    const longest = new Set(["core fair-admission", "core brain-baseline"]);

    for (const shard of shards) {
      expect(
        shard.filter((key) => longest.has(key)).length
      ).toBeLessThanOrEqual(1);
    }
  });

  it("never runs two groups in one shard", () => {
    for (const shard of splitIntoShards(suite, 6)) {
      expect(new Set(shard.map(({ group }) => group)).size).toBe(1);
    }
  });

  it("gives the shards left over to the group whose shards would end last", () => {
    const groups = splitIntoShards(suite, 6).map((shard) => shard[0]?.group);

    expect(groups).toStrictEqual([0, 0, 0, 0, 1, 2]);
  });

  it("refuses fewer shards than groups, which would have to run two together", () => {
    expect(() => splitIntoShards(suite, 2)).toThrow(
      "2 shards can't hold the tests' 3 groups apart: run at least 3."
    );
  });

  it("ends a group's shards close together: the longest within a fifth of the shortest", () => {
    const seconds = spreadOver(
      suite.filter(({ group }) => group === 0),
      2
    ).map(shardSeconds);

    expect(Math.max(...seconds)).toBeLessThan(Math.min(...seconds) * 1.2);
  });

  it("counts a group's files one after another where the project runs them so", () => {
    const parallel = [file("core a", 10), file("core b", 10)];
    const serial = parallel.map((each) => ({ ...each, serial: true }));

    expect(shardSeconds(serial)).toBe(projectStartSeconds + 20);
    expect(shardSeconds(parallel)).toBeLessThan(projectStartSeconds + 20);
  });

  it("adds a shard's groups up, as it runs them one after another", () => {
    expect(
      shardSeconds([file("core", 100), file("screens", 100, { group: 1 })])
    ).toBe(2 * projectStartSeconds + 200);
  });

  it("counts each project's start, so a project's files keep together", () => {
    const small = Array.from({ length: 12 }, (_, index) =>
      file(`${index % 2 === 0 ? "sdk" : "shared"} ${index}`, 5)
    );
    const projects = spreadOver(small, 2).map(
      (shard) => new Set(shard.map(({ project }) => project)).size
    );

    expect(projects).toStrictEqual([1, 1]);
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

  it("spreads the files recorded as taking no time, which still take time to load", () => {
    const instant = Array.from({ length: 40 }, (_, index) =>
      file(`instant-${index} file`, 0)
    );
    const counts = spreadOver(instant, 4).map((shard) => shard.length);

    expect(counts).toStrictEqual([10, 10, 10, 10]);
  });

  it("spreads short files evenly beside long ones that set every shard's time", () => {
    const long = Array.from({ length: 4 }, (_, index) =>
      file(`long ${index}`, 100)
    );
    const short = Array.from({ length: 20 }, (_, index) =>
      file(`short-${index} file`, 2)
    );
    const counts = spreadOver([...long, ...short], 4).map(
      (shard) => shard.length
    );

    expect(counts).toStrictEqual([6, 6, 6, 6]);
  });
});
