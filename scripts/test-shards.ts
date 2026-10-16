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
 * How long a shard with `files` takes, roughly: its groups one after
 * another, each as long as its work spread over the files it runs at
 * once, and never shorter than its longest file.
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
    group.work += file.seconds;
    group.longest = Math.max(group.longest, file.seconds);
    groups.set(file.group, group);
  }
  let total = 0;
  for (const { work, longest, serial } of groups.values()) {
    total += Math.max(serial ? work : work / concurrentFiles, longest);
  }
  return total;
};

/**
 * `files` split into `count` shards: the longest first, each into the
 * shard it lengthens least. The same files always split the same way, on
 * every runner.
 */
export const splitIntoShards = (
  files: readonly ShardFile[],
  count: number
): ShardFile[][] => {
  const shards: ShardFile[][] = Array.from({ length: count }, () => []);
  const longestFirst = files.toSorted(
    (a, b) => b.seconds - a.seconds || byKey(a.key, b.key)
  );
  for (const file of longestFirst) {
    let best = 0;
    let bestSeconds = Number.POSITIVE_INFINITY;
    for (const [index, shard] of shards.entries()) {
      const seconds = shardSeconds([...shard, file]);
      if (seconds < bestSeconds) {
        best = index;
        bestSeconds = seconds;
      }
    }
    shards[best]?.push(file);
  }
  return shards;
};
