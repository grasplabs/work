/**
 * The split between CI's shards (test-shards.ts): every file runs exactly
 * once, the same way on every runner, and the long files spread out.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  concurrentFiles,
  installsOffline,
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
  {
    group = 0,
    serial = false,
    browser = false,
  }: { group?: number; serial?: boolean; browser?: boolean } = {}
): ShardFile => ({
  key,
  project: key.split(" ")[0] ?? key,
  seconds,
  group,
  serial,
  browser,
});

/** Many short files and a few long ones, as a test suite has. */
const suite: ShardFile[] = [
  file("core fair-admission", 230),
  file("core brain-baseline", 155),
  file("core agent", 90),
  file("pages client", 180, { group: 1 }),
  file("pages stream", 75, { group: 1 }),
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
    const groups = splitIntoShards(suite, 5).map((shard) => shard[0]?.group);

    expect(groups).toStrictEqual([0, 0, 0, 1, 2]);
  });

  it("gives a shard left over to a group it shortens, not to one its longest file holds up", () => {
    const files = [
      file("compiler long-build", 400, { group: 5, serial: true }),
      file("compiler short-build", 10, { group: 5, serial: true }),
      ...Array.from({ length: 40 }, (_, index) => file(`core ${index}`, 20)),
    ];
    const longestOfCompiler = (count: number): number =>
      Math.max(
        ...splitIntoShards(files, count)
          .filter((shard) => shard[0]?.group === 5)
          .map(shardSeconds)
      );
    const groups = splitIntoShards(files, 5).map((shard) => shard[0]?.group);

    // Two shards take the compiler's short build off the long one's;
    // a third would end no sooner, so the rest go to core.
    expect(longestOfCompiler(5)).toBe(projectStartSeconds + 400);
    expect(groups.filter((group) => group === 5)).toHaveLength(2);
    expect(groups.filter((group) => group === 0)).toHaveLength(3);
  });

  it("leaves empty the shards no group ends sooner with", () => {
    // As many at once as a runner works through: on three shards each
    // ends with its longest file, and more end no sooner.
    const atOnce = Math.floor(concurrentFiles);
    const files = Array.from({ length: 3 * atOnce }, (_, index) =>
      file(`core ${index}`, 100)
    );
    const shards = splitIntoShards(files, 5);

    expect(shards.map((shard) => shard.length)).toStrictEqual([
      atOnce,
      atOnce,
      atOnce,
      0,
      0,
    ]);
  });

  it("runs the files that install offline from pnpm's store in the first shard, whatever their time", () => {
    const offline = "scripts scripts/package-definition.test.ts";
    const files = [
      ...suite,
      file(offline, 1),
      ...Array.from({ length: 300 }, (_, index) =>
        file(`scripts ${index}`, 30)
      ),
    ];

    for (const count of [3, 6, 12]) {
      expect(splitIntoShards(files, count)[0]?.map(({ key }) => key)).toContain(
        offline
      );
    }
  });

  it("runs a browser project's files in the first shard, where CI installs the browser", () => {
    const browser = "kit test/kit.browser.test.tsx";
    const files = [
      ...suite,
      file(browser, 30, { browser: true }),
      ...Array.from({ length: 300 }, (_, index) =>
        file(`scripts ${index}`, 30)
      ),
    ];

    expect(splitIntoShards(files, 8)[0]?.map(({ key }) => key)).toContain(
      browser
    );
  });

  it("knows every test file that installs offline from pnpm's store", () => {
    const offlineFlag = ["--", "offline"].join("");
    const installing = execFileSync(
      "git",
      ["grep", "-l", "-e", offlineFlag, "--", "*.test.ts"],
      { cwd: path.join(import.meta.dirname, ".."), encoding: "utf-8" }
    )
      .split("\n")
      .filter((each) => each !== "")
      .map((each) => `scripts ${each}`);

    expect(installing.length).toBeGreaterThan(0);
    expect(installing.filter((key) => !installsOffline(key))).toStrictEqual([]);
  });

  it("refuses a file that installs offline outside the first group", () => {
    const offline = "scripts scripts/package-definition.test.ts";

    expect(() =>
      splitIntoShards([...suite, file(offline, 1, { group: 1 })], 4)
    ).toThrow("must be in the tests' first group");
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

  it("counts a project that runs its files one after another as such, after a group's files run at once, wherever they stand", () => {
    const builds = [
      file("compiler build-a", 60, { serial: true }),
      file("compiler build-b", 60, { serial: true }),
      file("compiler build-c", 60, { serial: true }),
    ];
    const others = [file("core a", 20), file("core b", 20)];

    // The builds' 180 s one after another, not spread over the files a
    // runner works through at once, and after the others' 40 s spread so,
    // wherever they stand in the shard.
    expect([
      shardSeconds([...others, ...builds]),
      shardSeconds([...builds, ...others]),
    ]).toStrictEqual([
      2 * projectStartSeconds + Math.max(40 / concurrentFiles, 20) + 180,
      2 * projectStartSeconds + Math.max(40 / concurrentFiles, 20) + 180,
    ]);
  });

  it("counts the serial files after the group's longest file when that file outlasts the rest run at once", () => {
    const builds = [
      file("compiler build-a", 90, { serial: true }),
      file("compiler build-b", 90, { serial: true }),
    ];

    expect(shardSeconds([file("core long", 300), ...builds])).toBe(
      2 * projectStartSeconds + 300 + 180
    );
  });

  it("gives a shard left over to a group of core's before one that ends a little later on paper, as core's runtime starts slower", () => {
    const brain = [
      file("@grasp-os/core:brain a", 60, { group: 3, serial: true }),
      file("@grasp-os/core:brain b", 60, { group: 3, serial: true }),
    ];
    const builds = [
      file("compiler a", 70, { group: 5, serial: true }),
      file("compiler b", 70, { group: 5, serial: true }),
    ];
    const groups = splitIntoShards([...brain, ...builds], 3).map(
      (shard) => shard[0]?.group
    );

    // 120 s of the brain's files and 140 s of builds: the brain's start
    // makes it the later.
    expect(groups).toStrictEqual([3, 3, 5]);
  });

  it("adds a shard's projects up, as Vitest starts each once the one before has ended", () => {
    expect(shardSeconds([file("admin a", 50), file("scripts a", 50)])).toBe(
      2 * projectStartSeconds + 100
    );
  });

  it("adds a shard's groups up, as it runs them one after another", () => {
    expect(
      shardSeconds([file("core", 100), file("pages", 100, { group: 1 })])
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
