import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { brainMemories, brainMemoryCites } from "./db/schema.ts";

// What a memory record rests on (`brain_memory_cites`), as a condition of
// a query: every read that uses records as evidence follows current
// access, the owner's own records included (GRA-1085, GRA-1177): recall,
// a chat's memory, and entity and relation reads.

/**
 * That a record rests on nothing but `readable` (`brain_memory_cites`), as
 * a condition of a query of `brain_memories`: the collections everyone
 * reading may read now, which the host names (`memories.readableBy`). A
 * record resting on any other is never fetched, so it shapes no page,
 * cursor or rank (GRA-1085).
 */
export const citesReadable = (readable: readonly string[]): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM ${brainMemoryCites} WHERE ${brainMemoryCites.memoryId} = ${brainMemories.id} AND ${brainMemoryCites.collectionId} NOT IN (SELECT value FROM json_each(${JSON.stringify(readable)})))`;
