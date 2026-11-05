/**
 * An App's files handed to a platform isolate a batch at a time: each call
 * sized well within its CPU time and far under Workers RPC's 32 MiB, and
 * a batch stopped at a bound split in half rather than tried again whole.
 */
import { PlatformBoundError } from "./platform-sandbox.ts";

/**
 * `sources` (path and text) in batches of at most `characters` and at
 * most `files` each, in order: a source larger than `characters` is a
 * batch of its own.
 */
export const batchesOf = (
  sources: readonly (readonly [string, string])[],
  {
    characters,
    files = Number.POSITIVE_INFINITY,
  }: { characters: number; files?: number }
): Record<string, string>[] => {
  const batches: Record<string, string>[] = [];
  let batch: Record<string, string> = {};
  let count = 0;
  let size = 0;
  for (const [path, source] of sources) {
    if (count > 0 && (size + source.length > characters || count >= files)) {
      batches.push(batch);
      batch = {};
      count = 0;
      size = 0;
    }
    batch[path] = source;
    count += 1;
    size += source.length;
  }
  if (count > 0) {
    batches.push(batch);
  }
  return batches;
};

/**
 * One call of Ultracite's lint or tidy (save-builds.ts, agent-builds.ts):
 * oxc lints 2,000 files of an App (21.5 MB) in 9 to 12 s of Cloudflare's
 * CPU and formats them in under 1 s (November 2026), so a batch of this
 * takes well under a second, and its files and answer stay far under
 * RPC's 32 MiB.
 */
export const ultraciteBatch = { files: 100, characters: 250_000 } as const;

/**
 * Calls `call` with `batch`; one stopped at a bound (`PlatformBoundError`)
 * is split in half and each half called again. `call` is to run once
 * (`run`'s `once`): the split is its retry. The paths of the files each
 * stopped alone, which nothing answered: its caller says what became of
 * them.
 */
export const callSplitting = async (
  batch: Record<string, string>,
  call: (batch: Record<string, string>) => Promise<void>
): Promise<string[]> => {
  try {
    await call(batch);
    return [];
  } catch (error) {
    if (!(error instanceof PlatformBoundError)) {
      throw error;
    }
    const entries = Object.entries(batch);
    if (entries.length < 2) {
      return entries.map(([path]) => path);
    }
    const half = Math.ceil(entries.length / 2);
    return [
      ...(await callSplitting(
        Object.fromEntries(entries.slice(0, half)),
        call
      )),
      ...(await callSplitting(Object.fromEntries(entries.slice(half)), call)),
    ];
  }
};
