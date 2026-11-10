// Splits the test files between CI's shards by how long they take, so the
// shards end at about the same time (scripts/test-sequencer.ts applies it).
// Vitest's own split is by a hash of each file's path: even in file count,
// but core's heaviest files could land in one shard, which then ran close
// to its step's timeout while another had minutes to spare.

/** Orders strings by code point, the same on every runner. */
export const byKey = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** A test file as the split sees it. */
export interface ShardFile {
  /** Unique: the project's name and the file's path in it. */
  readonly key: string;
  /** The project's name: a shard starts each of its projects' pools. */
  readonly project: string;
  /** The project's `sequence.groupOrder`: a shard runs its groups one after another. */
  readonly group: number;
  /** Whether the project runs its files one at a time (`fileParallelism: false`). */
  readonly serial: boolean;
  /** Whether the project runs its files in a browser (`browser.enabled`). */
  readonly browser: boolean;
  /** How long the file's tests take, in seconds. */
  readonly seconds: number;
}

/**
 * How many files a shard's runner works through at once, on average: a
 * group's work divided by how long it took, from CI's test-progress
 * artifacts (October 2026). Each of the runner's 4 Vitest workers shares
 * its CPUs with the workerd it drives, so fewer than 4.
 */
export const concurrentFiles = 2.5;

/**
 * The least a file is taken to take: loading it and the reset before it,
 * which the progress logs don't time. A file of tests that each finish
 * within a millisecond is recorded as taking none.
 */
export const fileOverheadSeconds = 1;

/**
 * What starting a project's pools in a shard takes: its global setup,
 * its workers' runtimes and, for core's projects, the built-ins' install,
 * before its first file. A shard of one group that ran small files of a
 * dozen projects worked through only 1.25 files at a time (October 2026,
 * GRA-1094): counted, it keeps a project's files on few shards.
 */
export const projectStartSeconds = 30;

const costOf = (file: ShardFile): number =>
  Math.max(file.seconds, fileOverheadSeconds);

/** All of `files`' time, however it overlaps. */
const workOf = (files: readonly ShardFile[]): number =>
  files.reduce((total, file) => total + costOf(file), 0);

/**
 * How long a shard with `files` takes, roughly: its projects one after
 * another, each its start and then as long as its files run at once
 * (their work spread over the files a runner works through together, or
 * its longest file if that is longer), or, for a project that runs its
 * files one after another (`serial`), their work added up. Vitest starts a
 * project's files once the project before it in the shard has ended: in
 * CI the scripts' longest build began after the admin's last file, and
 * core's first file 40 s after the scripts' last, its runtime starting
 * only then (November 2026). A project runs its files one at a time when
 * two at once starve each other, such as the compiler's builds, each of
 * which starts Node, TypeScript and three bundles across the runner's CPUs.
 */
export const shardSeconds = (files: readonly ShardFile[]): number => {
  let total = 0;
  for (const own of Map.groupBy(files, ({ project }) => project).values()) {
    const work = workOf(own);
    const longest = Math.max(...own.map(costOf));
    total +=
      projectStartSeconds +
      (own[0]?.serial === true
        ? work
        : Math.max(work / concurrentFiles, longest));
  }
  return total;
};

/**
 * A project whose files, run at once, take no longer than this goes to
 * one shard whole: spread out to even the shards' times, it started its
 * pools on each of them for a few seconds of tests.
 */
export const wholeProjectSeconds = 2 * projectStartSeconds;

/**
 * `files` in the units the split places: a small project's files
 * together (`wholeProjectSeconds`), every other file on its own.
 */
const unitsOf = (files: readonly ShardFile[]): ShardFile[][] => {
  const projects = Map.groupBy(files, ({ project }) => project);
  return [...projects.values()].flatMap((own) =>
    workOf(own) / (own[0]?.serial === true ? 1 : concurrentFiles) <=
    wholeProjectSeconds
      ? [own]
      : own.map((file) => [file])
  );
};

/**
 * The test files that install offline from pnpm's store, by `key`: they
 * run in the first shard, whatever the split, as CI restores the store,
 * about 9 s of a shard's setup, only there (.github/workflows/ci.yml,
 * `test`). They must be in the tests' first group, whose first shard is
 * the run's first. test-shards.test.ts checks that every test file that
 * installs offline matches.
 */
export const installsOffline = (key: string): boolean =>
  /^scripts scripts\/package-definition[\w-]*\.test\.ts$/u.test(key);

/**
 * Whether a test file runs in the first shard, whatever the split: those
 * that install offline (`installsOffline`), and those of a project run in
 * a browser, as CI installs the test shards' browser only there too.
 */
export const runsInFirstShard = ({ key, browser }: ShardFile): boolean =>
  browser || installsOffline(key);

/** A unit by its first file's key, for an order that is the same on every runner. */
const keyOfUnit = (unit: readonly ShardFile[]): string => unit[0]?.key ?? "";

/**
 * `files` spread over `count` shards: the longest unit first, each into
 * the shard it lengthens least, and of shards it lengthens alike, the one
 * with the least work.
 */
export const spreadOver = (
  files: readonly ShardFile[],
  count: number
): ShardFile[][] => {
  const shards: ShardFile[][] = Array.from({ length: count }, () => []);
  const units = unitsOf(files);
  const pinned = (unit: readonly ShardFile[]): boolean =>
    unit.some(runsInFirstShard);
  for (const unit of units.filter(pinned)) {
    shards[0]?.push(...unit);
  }
  const longestFirst = units
    .filter((unit) => !pinned(unit))
    .toSorted(
      (a, b) => workOf(b) - workOf(a) || byKey(keyOfUnit(a), keyOfUnit(b))
    );
  for (const unit of longestFirst) {
    let best = 0;
    let bestSeconds = Number.POSITIVE_INFINITY;
    let bestWork = Number.POSITIVE_INFINITY;
    for (const [index, shard] of shards.entries()) {
      const seconds = shardSeconds([...shard, ...unit]);
      const work = workOf(shard);
      if (
        seconds < bestSeconds ||
        (seconds === bestSeconds && work < bestWork)
      ) {
        best = index;
        bestSeconds = seconds;
        bestWork = work;
      }
    }
    shards[best]?.push(...unit);
  }
  return shards;
};

/**
 * `files` split into `count` shards of one group each, the group's files
 * spread over its shards with `spreadOver`. A shard that held two groups
 * ran them one after another, each starting its projects' pools after the
 * last file of the one before had ended: up to two minutes of start-up
 * per group on a CI runner, for a group of one file (October 2026,
 * GRA-1094). Of one group each, a shard starts only its own, and a group
 * kept apart to run alone (vite.brain.config.ts) has its runner to itself.
 * Each group gets one shard, and each shard left over goes to the group
 * whose shards would end last, of those that end later than their longest
 * unit alone would: a group held up by one long file (the compiler's
 * longest build) gains nothing from more, which then go where they help.
 * The same files always split the same way, on every runner.
 */
export const splitIntoShards = (
  files: readonly ShardFile[],
  count: number
): ShardFile[][] => {
  const groups = Map.groupBy(files, ({ group }) => group);
  const order = [...groups.keys()].toSorted((a, b) => a - b);
  if (count < order.length) {
    throw new Error(
      `${count} shards can't hold the tests' ${order.length} groups apart: run at least ${order.length}.`
    );
  }
  const misplaced = files.filter(
    (each) => runsInFirstShard(each) && each.group !== order[0]
  );
  if (misplaced.length > 0) {
    throw new Error(
      `${misplaced.map(({ key }) => key).join(", ")} must be in the tests' first group to run in the first shard.`
    );
  }
  const shardsOf = new Map(
    order.map((group) => [group, spreadOver(groups.get(group) ?? [], 1)])
  );
  const longestOf = (shards: readonly ShardFile[][]): number =>
    Math.max(...shards.map(shardSeconds));
  /** The soonest a group's shards can end, however many: its longest unit's. */
  const floorOf = new Map(
    order.map((group) => [group, longestOf(unitsOf(groups.get(group) ?? []))])
  );
  for (let left = count - order.length; left > 0; left -= 1) {
    let slowest: number | undefined;
    let slowestSeconds = Number.NEGATIVE_INFINITY;
    for (const group of order) {
      const seconds = longestOf(shardsOf.get(group) ?? []);
      const shortens = seconds > (floorOf.get(group) ?? 0);
      if (shortens && seconds > slowestSeconds) {
        slowest = group;
        slowestSeconds = seconds;
      }
    }
    if (slowest === undefined) {
      // Every group ends with its longest unit: more shards end no sooner.
      break;
    }
    shardsOf.set(
      slowest,
      spreadOver(
        groups.get(slowest) ?? [],
        (shardsOf.get(slowest)?.length ?? 0) + 1
      )
    );
  }
  const shards = order.flatMap((group) => shardsOf.get(group) ?? []);
  // A shard each for the rest, empty: Vitest runs none of its files.
  return [
    ...shards,
    ...Array.from({ length: count - shards.length }, (): ShardFile[] => []),
  ];
};

/** A file as the order within its project sees it: its time, if anyone took it. */
export interface TimedFile {
  readonly key: string;
  readonly seconds: number | undefined;
}

/**
 * Which of two files of a project starts first: one nobody timed yet, as
 * Vitest's own order has it, then the longer. A new file may be long, and
 * one that starts last holds its group up for all of its time.
 */
export const startsFirst = (a: TimedFile, b: TimedFile): number => {
  if (a.seconds === undefined || b.seconds === undefined) {
    return (
      Number(a.seconds !== undefined) - Number(b.seconds !== undefined) ||
      byKey(a.key, b.key)
    );
  }
  return b.seconds - a.seconds || byKey(a.key, b.key);
};
