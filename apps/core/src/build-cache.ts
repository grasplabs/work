import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { buildReceipts } from "./db/core/schema.ts";

// The compiler's builds, kept in R2 and served again only as the build
// that passed its gates wrote them (screens.ts `cachedBuild`). Core's D1
// holds the trusted record of each (`build_receipts`): the SHA-256 and
// size of its bytes, and the key's lease, so builds of the same files run
// once whichever isolate asks.
//
// From the threat model (GRA-406), each way a cached build could stand in
// for one that never passed its gates, and what closes it:
//
// - Cache poisoning (a stray or forged object, a write cut short, bytes
//   that rotted): an object is served only when its bytes hash to its
//   receipt, which only core writes, and only the build holding the key's
//   lease, after the bytes are written, under an object of its own. R2's
//   own metadata is never trusted for it. An object no receipt names, or
//   with another hash, is never served: the build runs again.
// - Different inputs under one key: the key is the build's kind and
//   compiler call, a key schema (`keySchema`), the compiler's version (its
//   kit, SDKs and policy) and the SHA-256 of the exact files the build
//   reads (screens.ts `buildKey`).
// - Repeated integrity failure: a kept build whose bytes fail their check
//   is counted once on the receipt, however many read it; at
//   `quarantineAfter` such builds, the key is quarantined, its bad bytes are kept
//   for operators under `build-quarantine/`, an error is logged as the
//   alert, and nothing is served from or written to the cache for it. Its
//   builds still take the lease, so one runs at a time.
// - Builds of the same files at once in several isolates: the first takes
//   the key's lease and builds; the others wait for its receipt. One whose
//   holder died outlives it (`lease_expires_at`) and is taken again; a
//   receipt whose bytes are good is served whether or not the lease was
//   given back.
// - Cached bytes granting anything: a compile build holds App code alone.
//   Package bytes reach a screen, server or workflow through admission
//   where they are served or sealed (packages/serve.ts,
//   workflows/sealed-packages.ts), never through this cache.

/** Part of every cache key: a change to what a key means builds again. */
export const keySchema = "r1";

/** Integrity failures of one key before it is quarantined. */
export const quarantineAfter = 3;

/** How often a build waiting for another's receipt looks again. */
const pollMs = 250;

/** Where quarantined bytes are kept for operators. */
const quarantinePrefix = "build-quarantine/";

/** What a cached build's R2 reads and writes need. */
export interface CacheEnv {
  DB: D1Database;
  FILES: Pick<R2Bucket, "get" | "put">;
}

/** What the cache holds for a key, as checked against its receipt. */
export type CacheRead =
  | { state: "hit"; text: string; object: R2Object; objectKey: string }
  | { state: "miss" }
  | { state: "quarantined" };

const receiptOf = async (env: CacheEnv, key: string) =>
  await drizzle(env.DB)
    .select()
    .from(buildReceipts)
    .where(eq(buildReceipts.key, key))
    .get();

/**
 * Counts an integrity failure of `key`'s build kept at `builtAt`, whose
 * object held `text`, once for that build however many readers find it:
 * kept for operators, and past `quarantineAfter` builds that failed, the
 * key quarantined.
 */
const integrityFailed = async (
  env: CacheEnv,
  key: string,
  builtAt: Date | null,
  text: string
): Promise<void> => {
  if (builtAt === null) {
    return;
  }
  const [counted] = await drizzle(env.DB)
    .update(buildReceipts)
    .set({
      integrityFailures: sql`${buildReceipts.integrityFailures} + 1`,
      failedBuiltAt: builtAt,
      quarantinedAt: sql`CASE WHEN ${buildReceipts.integrityFailures} + 1 >= ${quarantineAfter} THEN ${Date.now()} ELSE ${buildReceipts.quarantinedAt} END`,
    })
    .where(
      and(
        eq(buildReceipts.key, key),
        eq(buildReceipts.builtAt, builtAt),
        or(
          isNull(buildReceipts.failedBuiltAt),
          ne(buildReceipts.failedBuiltAt, builtAt)
        )
      )
    )
    .returning({
      failures: buildReceipts.integrityFailures,
      quarantinedAt: buildReceipts.quarantinedAt,
    });
  if (counted === undefined) {
    // Counted already, by another reader of the same build.
    return;
  }
  try {
    await env.FILES.put(`${quarantinePrefix}${key}/${Date.now()}`, text);
  } catch (error) {
    log.error("build.cache_quarantine_write_failed", {
      key,
      ...errorFields(error),
    });
  }
  log.error("build.cache_integrity_failed", {
    key,
    failures: counted.failures,
  });
  if (counted.quarantinedAt !== null) {
    // The alert: operators look at what is kept under the prefix.
    log.error("build.cache_quarantined", { key, failures: counted.failures });
  }
};

/** Whether `key` is quarantined: its receipt alone. */
const isQuarantined = async (env: CacheEnv, key: string): Promise<boolean> => {
  const receipt = await receiptOf(env, key);
  return receipt !== undefined && receipt.quarantinedAt !== null;
};

/**
 * What the cache holds for `key`, checked against its receipt: the bytes
 * when they hash to it, otherwise nothing to serve.
 */
export const readVerified = async (
  env: CacheEnv,
  key: string
): Promise<CacheRead> => {
  // The receipt first, then the object it names: each holder keeps its
  // bytes under an object of its own (`objectKeyOf`), written once, so a
  // receipt and its object never race. A receipt that can't be read
  // throws: nothing vouches for cached bytes then. Bytes that can't be
  // read are a miss: the build runs, under the lease.
  const receipt = await receiptOf(env, key);
  if (receipt?.quarantinedAt !== null && receipt?.quarantinedAt !== undefined) {
    return { state: "quarantined" };
  }
  const objectKey = receipt?.objectKey ?? null;
  const expected = receipt?.sha256 ?? null;
  if (objectKey === null || expected === null) {
    return { state: "miss" };
  }
  let object: R2ObjectBody | null = null;
  let text: string | undefined;
  try {
    object = await env.FILES.get(objectKey);
    text = await object?.text();
  } catch (error) {
    log.warn("build.cache_read_failed", { key, ...errorFields(error) });
    return { state: "miss" };
  }
  if (object === null || text === undefined) {
    return { state: "miss" };
  }
  if ((await sha256Hex(text)) !== expected) {
    await integrityFailed(env, key, receipt?.builtAt ?? null, text);
    return { state: "miss" };
  }
  return { state: "hit", text, object, objectKey };
};

/**
 * Writes `text` again under `objectKey`, `key`'s kept build, as used now:
 * only while its receipt still names that object with those bytes, so a
 * refresh never brings back an object a newer build replaced.
 */
export const refreshKept = async (
  env: CacheEnv,
  key: string,
  objectKey: string,
  text: string,
  options: R2PutOptions
): Promise<void> => {
  const receipt = await receiptOf(env, key);
  if (
    receipt?.objectKey !== objectKey ||
    receipt.sha256 !== (await sha256Hex(text)) ||
    receipt.quarantinedAt !== null
  ) {
    return;
  }
  await env.FILES.put(objectKey, text, options);
};

/** The object `holder` keeps `key`'s bytes under: under the key's prefix, for the sweep. */
export const objectKeyOf = (key: string, holder: string): string =>
  `${key}~${holder}`;

/**
 * Takes `key`'s lease for `holder` for `ms`, if nobody holds it or the
 * one who does outlived it; whether it did. One statement: two builds
 * never both take it.
 */
const takeLease = async (
  env: CacheEnv,
  key: string,
  holder: string,
  ms: number
): Promise<boolean> => {
  const now = Date.now();
  const expires = new Date(now + ms);
  const [taken] = await drizzle(env.DB)
    .insert(buildReceipts)
    .values({ key, holder, leaseExpiresAt: expires })
    .onConflictDoUpdate({
      target: buildReceipts.key,
      set: { holder, leaseExpiresAt: expires },
      setWhere: or(
        isNull(buildReceipts.leaseExpiresAt),
        lt(buildReceipts.leaseExpiresAt, new Date(now))
      ),
    })
    .returning({ holder: buildReceipts.holder });
  return taken?.holder === holder;
};

/** Gives `key`'s lease back if `holder` holds it; logged, never thrown. */
const giveBack = async (
  env: CacheEnv,
  key: string,
  holder: string
): Promise<void> => {
  try {
    await drizzle(env.DB)
      .update(buildReceipts)
      .set({ holder: null, leaseExpiresAt: null })
      .where(and(eq(buildReceipts.key, key), eq(buildReceipts.holder, holder)));
  } catch (error) {
    log.error("build.cache_lease_release_failed", {
      key,
      ...errorFields(error),
    });
  }
};

/**
 * Keeps `text` as `key`'s build, written by `holder`: the bytes under an
 * object of the holder's own, then the receipt naming it, only while
 * `holder` still holds the lease. A holder that lost its lease writes at
 * most an object no receipt names, which the sweep removes; the build
 * that took the lease over is left alone. Nothing for a quarantined key.
 */
const keep = async (
  env: CacheEnv,
  key: string,
  holder: string,
  text: string,
  options: R2PutOptions
): Promise<void> => {
  const receipt = await receiptOf(env, key);
  if (
    receipt === undefined ||
    receipt.holder !== holder ||
    receipt.quarantinedAt !== null
  ) {
    return;
  }
  const objectKey = objectKeyOf(key, holder);
  await env.FILES.put(objectKey, text, options);
  await drizzle(env.DB)
    .update(buildReceipts)
    .set({
      objectKey,
      sha256: await sha256Hex(text),
      bytes: new TextEncoder().encode(text).byteLength,
      builtAt: new Date(),
    })
    .where(
      and(
        eq(buildReceipts.key, key),
        eq(buildReceipts.holder, holder),
        isNull(buildReceipts.quarantinedAt)
      )
    );
};

/** What a build answers, and whether its bytes may be kept. */
export interface Built {
  text: string;
  cache: boolean;
}

/** How a cached build came about, for its metrics. */
export type CacheOutcome = "hit" | "shared" | "built" | "quarantined";

/**
 * `key`'s build: from the cache when its bytes hash to its receipt;
 * otherwise built by `build` under the key's lease, and kept (`options`)
 * when it may be, or the build another isolate holding the lease kept
 * meanwhile. A build waited for at most `leaseMs`, the lease's own time:
 * past it, the lease is taken over.
 */
export const throughCache = async (
  env: CacheEnv,
  key: string,
  leaseMs: number,
  build: () => Promise<Built>,
  options: () => R2PutOptions,
  signal?: AbortSignal
): Promise<{
  text: string;
  outcome: CacheOutcome;
  /** For a hit, its object (when it was last used) and where it is. */
  object?: R2Object;
  objectKey?: string;
}> => {
  // Given up on before or while it read: it serves nothing.
  signal?.throwIfAborted();
  const first = await readVerified(env, key);
  signal?.throwIfAborted();
  if (first.state === "hit") {
    return {
      text: first.text,
      outcome: "hit",
      object: first.object,
      objectKey: first.objectKey,
    };
  }
  const holder = crypto.randomUUID();
  for (;;) {
    // Given up on while waiting: it takes no lease and serves nothing.
    signal?.throwIfAborted();
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    if (await takeLease(env, key, holder, leaseMs)) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- waiting for the holder
    await scheduler.wait(pollMs);
    signal?.throwIfAborted();
    // oxlint-disable-next-line no-await-in-loop -- waiting for the holder
    const now = await readVerified(env, key);
    // Given up on while it read: it serves nothing, not even a shared build.
    signal?.throwIfAborted();
    if (now.state === "hit") {
      return { text: now.text, outcome: "shared" };
    }
  }
  try {
    // Kept by another holder between the first read and taking the lease.
    const kept = await readVerified(env, key);
    signal?.throwIfAborted();
    if (kept.state === "hit") {
      return { text: kept.text, outcome: "shared" };
    }
    const built = await build();
    const quarantined = await isQuarantined(env, key);
    if (built.cache && !quarantined) {
      try {
        await keep(env, key, holder, built.text, options());
      } catch (error) {
        // The build stands: what it left of the cache has no receipt, and
        // is built again at its next use.
        log.error("build.cache_keep_failed", { key, ...errorFields(error) });
      }
    }
    return {
      text: built.text,
      outcome: quarantined ? "quarantined" : "built",
    };
  } finally {
    await giveBack(env, key, holder);
  }
};

/** Forgets the receipts naming `objectKeys`, the objects the sweep deleted. */
export const forgetReceipts = async (
  env: CacheEnv,
  objectKeys: readonly string[]
): Promise<void> => {
  const db = drizzle(env.DB);
  // Within D1's bound values.
  for (let start = 0; start < objectKeys.length; start += 90) {
    // oxlint-disable-next-line no-await-in-loop -- a chunk at a time
    await db
      .delete(buildReceipts)
      .where(
        and(
          inArray(buildReceipts.objectKey, objectKeys.slice(start, start + 90)),
          isNull(buildReceipts.holder),
          isNull(buildReceipts.quarantinedAt)
        )
      );
  }
};
