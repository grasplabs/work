import { sql } from "drizzle-orm";

import type { Brain } from "./brain.ts";
import { brainSequences } from "./db/schema.ts";
import { toHex } from "./encoding.ts";

// Recalls kept for a moment, so the same question asked again in a turn or
// a run isn't read again (GRA-304). Kept in the isolate's memory only, for
// a few minutes at most, never written anywhere: what a recall quotes is
// the company's own words, and stays where it was read.
//
// A kept recall is found only under a key that holds everything its answer
// rests on, signed with a key of the deployment's own (so it is the
// deployment's alone, and can't be computed from outside): the policies
// and index it was read with, the reader's access revision (who they are,
// what they may read, whom their memory serves), the recall generation (a
// counter the database moves with every write that changes what a recall
// may find, 0011_recall_generation.sql), and the question, its filters,
// its bounds and whether it asked to rerank. Even so, a kept recall is
// used again only once its current use is checked again (recall.ts):
// every document version it cites still readable by its reader, every
// memory record still kept for them by the host, and the read recorded
// and noted again as any read is.

/** How long a recall is kept. */
export const recallCacheMs = 5 * 60_000;

/** Most recalls kept in one isolate; the least recently used go first. */
export const recallCacheEntries = 128;

/** Characters of quoted text a kept recall may hold; a larger one isn't kept. */
export const recallCacheCharactersMax = 256_000;

/** The recall generation, as the database counts it now: 0 before any write. */
export const recallGeneration = async <C>(brain: Brain<C>): Promise<number> => {
  const [row] = await brain.db
    .select({ value: brainSequences.value })
    .from(brainSequences)
    .where(sql`${brainSequences.name} = 'recall'`);
  return row?.value ?? 0;
};

/** `parts`, signed with the deployment's own key: a kept recall's key. */
export const recallCacheKey = async <C>(
  brain: Brain<C>,
  parts: readonly unknown[]
): Promise<string> => {
  const key = await brain.ports.keys.hmac("grasp-os brain recall cache", [
    "sign",
  ]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return toHex(new Uint8Array(mac));
};

/** A kept recall: what it was, and until when. */
interface Kept<T> {
  value: T;
  until: number;
}

/**
 * The isolate's kept recalls of one shape: made once per isolate, by the
 * recall that keeps them (recall.ts).
 */
export const recallCacheOf = <T>() => {
  /** By key, least recently used first. */
  const kept = new Map<string, Kept<T>>();
  return {
    /** The recall kept under `key` at `now`, if it is still kept. */
    lookUp: (key: string, now: number): T | undefined => {
      const found = kept.get(key);
      if (found === undefined) {
        return undefined;
      }
      kept.delete(key);
      if (found.until <= now) {
        return undefined;
      }
      // Used now: the most recently used.
      kept.set(key, found);
      return found.value;
    },
    /**
     * Keeps `value` under `key` from `now`, unless its quoted text (`size`
     * characters) is too large to keep; the least recently used goes when
     * the isolate keeps as many as it may.
     */
    keep: (key: string, value: T, size: number, now: number): void => {
      if (size > recallCacheCharactersMax) {
        return;
      }
      kept.delete(key);
      kept.set(key, { value, until: now + recallCacheMs });
      for (const oldest of kept.keys()) {
        if (kept.size <= recallCacheEntries) {
          break;
        }
        kept.delete(oldest);
      }
    },
    /** Forgets the recall kept under `key`: its use was checked and failed. */
    forget: (key: string): void => {
      kept.delete(key);
    },
  };
};
