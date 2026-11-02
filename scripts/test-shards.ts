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
 * How long a shard with `files` takes, roughly: its groups one after
 * another, each as long as its work spread over the files it runs at
 * once, and never shorter than its longest file, and the start of each
 * of its projects.
 */
export const shardSeconds = (files: readonly ShardFile[]): number => {
  const groups = new Map<
    number,
    { work: number; longest: number; serial: boolean }
  >();
  for (const file of files) {
    const group = groups.get(file.group) ?? {
      work: 0,
      longest: 0,
      serial: file.serial,
    };
    group.work += costOf(file);
    group.longest = Math.max(group.longest, costOf(file));
    groups.set(file.group, group);
  }
  let total =
    new Set(files.map(({ project }) => project)).size * projectStartSeconds;
  for (const { work, longest, serial } of groups.values()) {
    total += Math.max(serial ? work : work / concurrentFiles, longest);
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
  const longestFirst = unitsOf(files).toSorted(
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
 * whose shards would end last. The same files always split the same way,
 * on every runner.
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
  const shardsOf = new Map(
    order.map((group) => [group, spreadOver(groups.get(group) ?? [], 1)])
  );
  const longestOf = (shards: readonly ShardFile[][]): number =>
    Math.max(...shards.map(shardSeconds));
  for (let left = count - order.length; left > 0; left -= 1) {
    let slowest = order[0] ?? 0;
    for (const group of order) {
      if (
        longestOf(shardsOf.get(group) ?? []) >
        longestOf(shardsOf.get(slowest) ?? [])
      ) {
        slowest = group;
      }
    }
    shardsOf.set(
      slowest,
      spreadOver(
        groups.get(slowest) ?? [],
        (shardsOf.get(slowest)?.length ?? 0) + 1
      )
    );
  }
  return order.flatMap((group) => shardsOf.get(group) ?? []);
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

/**
 * How long a shard may take, by `shardSeconds`, before CI adds another: a
 * run splits its files into the fewest shards that each end within it
 * (`shardCountFor`). Every shard is a runner, with about a minute of
 * checkout and install before its first test, and GitHub runs at most
 * about 60 of the organization's jobs at once, so fewer, longer shards
 * let more pull requests through. On GitHub's 4-CPU runners the model
 * matched the shards' measured test steps (24 shards: at most 301 s
 * modelled, 313 s measured, October 2026). Ten minutes keeps a shard well
 * inside the test step's 15 and the stall reporter's 13: the whole suite
 * in 13 shards instead of 24.
 */
export const shardTargetSeconds = 600;

/** The most shards a run splits into, however long its files take. */
export const maxShards = 16;

/**
 * The fewest shards, of at least one per group, that run `files` each
 * within `shardTargetSeconds`, or `maxShards` if none do; none for no
 * files.
 */
export const shardCountFor = (files: readonly ShardFile[]): number => {
  if (files.length === 0) {
    return 0;
  }
  const groups = new Set(files.map(({ group }) => group)).size;
  for (let count = groups; count < maxShards; count += 1) {
    const longest = Math.max(
      ...splitIntoShards(files, count).map(shardSeconds)
    );
    if (longest <= shardTargetSeconds) {
      return count;
    }
  }
  return Math.max(groups, maxShards);
};
