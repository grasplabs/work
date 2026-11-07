import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sdkArtifactRefs, sdkArtifacts } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// The artifacts seals name: an App release's (app-releases.ts) and a JSON
// workflow build's (workflow-builds.ts), content-addressed and shared,
// collected once nothing references them. The standard scheme, a
// generation per artifact: each artifact is a row (`sdk_artifacts`), one
// live row per SHA-256, with a random generation made as the row is, and
// its bytes at `artifacts/<sha256>/<generation>`; each seal references the
// rows it names (`sdk_artifact_refs`, by the seal's random ID, which the
// row naming it keeps). A row is deleted, never marked dead, so the
// primary key on `sha256` is the one live row per artifact. A seal takes
// or makes all of its rows in one batch, and the sweep deletes in batches
// with R2's bulk delete, never row by row. What could go wrong, and what
// stops it:
//
// - A sweep deletes bytes a seal names: a seal takes the live row, or makes
//   one, and adds its reference in one transaction; the sweep deletes a row
//   only in a statement that finds no reference to it, and then only that
//   row's generation's key. A generation is never reused, so bytes uploaded
//   after a row went land on a new key, which no deletion of the old row
//   reaches. No time window, fence or retry is involved.
// - A seal names bytes never uploaded (its row made by another seal that
//   then stopped): every seal uploads every artifact it names to its row's
//   key before its row names them; the same bytes again change nothing.
// - A seal's references swept before its row names them: the row that
//   names a seal is written only while all of its references stand
//   (`sealReferencedSql`), so such a seal is refused, never sealed short.
// - References left by a seal that never finished: removed once their seal
//   is a day old and no row names it, and their rows collected after.
// - A seal's cleanup after an error drops references a live row names: the
//   final batch may have committed though D1 answered an error, so
//   references go only while no row names their seal (`unnamedSql`), the
//   same condition the sweep holds to.
// - Bytes left once a bulk delete failed after their rows went: each sweep
//   also lists the next page of keys, going on where the last sweep stopped
//   and from the start once the listing ended, and deletes those whose
//   generation is no row's (`sweepStrayKeys`); a key's generation is never
//   a row's again, so this deletes nothing a reference can come to name.

/** How long a seal's references stay while no row names it. */
export const unnamedSealMs = 24 * 60 * 60_000;

/** Where `sha256`'s bytes of generation `generation` are kept. */
export const artifactKey = (sha256: string, generation: string): string =>
  `artifacts/${sha256}/${generation}`;

/** A new seal's ID, which its references are under. */
export const newSeal = (): string => crypto.randomUUID();

/** How many uploads one seal runs at once. */
const uploadsAtOnce = 16;

/** The most keys one R2 delete takes. */
const keysPerDelete = 1000;

/**
 * References each of `artifacts` (bytes by SHA-256) from seal `seal`,
 * taking each live row or making one, all in one batch, one transaction:
 * three statements, however many artifacts. Then uploads every one to its
 * row's key, `uploadsAtOnce` at a time; every upload settles before a
 * failure is thrown.
 */
export const storeArtifacts = async (
  env: Env,
  seal: string,
  artifacts: Iterable<readonly [string, Uint8Array]>
): Promise<void> => {
  const bytes = new Map(artifacts);
  if (bytes.size === 0) {
    return;
  }
  const hashes = JSON.stringify([...bytes.keys()]);
  const now = Date.now();
  // `WHERE true` keeps SQLite from reading ON CONFLICT as a join's.
  const results = await env.DB.batch<{
    sha256: string;
    generation: string;
  }>([
    env.DB.prepare(
      `INSERT INTO sdk_artifacts (sha256, generation, created_at)
       SELECT value, lower(hex(randomblob(16))), ?1 FROM json_each(?2) WHERE true
       ON CONFLICT (sha256) DO NOTHING`
    ).bind(now, hashes),
    env.DB.prepare(
      `INSERT INTO sdk_artifact_refs (seal, sha256, created_at)
       SELECT ?1, value, ?2 FROM json_each(?3) WHERE true
       ON CONFLICT (seal, sha256) DO NOTHING`
    ).bind(seal, now, hashes),
    env.DB.prepare(
      `SELECT sha256, generation FROM sdk_artifacts
       WHERE sha256 IN (SELECT value FROM json_each(?1))`
    ).bind(hashes),
  ]);
  const generations = new Map(
    (results.at(-1)?.results ?? []).map(({ sha256, generation }) => [
      sha256,
      generation,
    ])
  );
  const entries = [...bytes];
  const failures: PromiseRejectedResult[] = [];
  for (let start = 0; start < entries.length; start += uploadsAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a bounded group at a time
    const stored = await Promise.allSettled(
      entries
        .slice(start, start + uploadsAtOnce)
        .map(async ([sha256, body]) => {
          const generation = generations.get(sha256);
          if (generation === undefined) {
            throw new Error(`Artifact ${sha256} has no row`);
          }
          // The very bytes hashed, so what is stored is what the hash names.
          await env.FILES.put(artifactKey(sha256, generation), body, {
            sha256,
          });
        })
    );
    for (const result of stored) {
      if (result.status === "rejected") {
        failures.push(result);
      }
    }
  }
  const [failure] = failures;
  if (failure !== undefined) {
    throw failure.reason;
  }
};

/**
 * Holds while seal `seal` references every artifact the JSON array at
 * `path` of `text` names by `sha256`, as the statement runs: what the row
 * that names the seal is written under.
 */
export const sealReferencedSql = (
  seal: string,
  text: string,
  path: string
): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM json_each(${text}, ${path}) AS named
    WHERE NOT EXISTS (SELECT 1 FROM sdk_artifact_refs AS refs
      WHERE refs.seal = ${seal}
        AND refs.sha256 = json_extract(named.value, '$.sha256')))`;

/** The live generation of each of `hashes` that has a row. */
export const generationsOf = async (
  env: Env,
  hashes: readonly string[]
): Promise<Map<string, string>> => {
  const rows = await drizzle(env.DB)
    .select({
      sha256: sdkArtifacts.sha256,
      generation: sdkArtifacts.generation,
    })
    .from(sdkArtifacts)
    .where(inList(sdkArtifacts.sha256, hashes));
  return new Map(rows.map(({ sha256, generation }) => [sha256, generation]));
};

/** That no reference names the artifact row `sdk_artifacts`, as SQL. */
const unreferenced = sql`NOT EXISTS (SELECT 1 FROM sdk_artifact_refs AS refs
  WHERE refs.sha256 = sdk_artifacts.sha256)`;

/**
 * Deletes the R2 keys of `gone`, the rows just deleted, up to
 * `keysPerDelete` a call. A failure is logged: the rows are gone, so no
 * reference can come to name those keys again, and what is left is
 * garbage no load reads.
 */
const deleteKeys = async (
  env: Env,
  gone: readonly { sha256: string; generation: string }[]
): Promise<void> => {
  const keys = gone.map(({ sha256, generation }) =>
    artifactKey(sha256, generation)
  );
  for (let start = 0; start < keys.length; start += keysPerDelete) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one bulk delete after another
      await env.FILES.delete(keys.slice(start, start + keysPerDelete));
    } catch (error) {
      log.error("artifact.keys_delete_failed", {
        keys: keys.length,
        ...errorFields(error),
      });
    }
  }
};

/**
 * Deletes the rows of `hashes` nothing references, in one statement that
 * checks, then their bytes (`deleteKeys`).
 */
export const collectArtifacts = async (
  env: Env,
  hashes: readonly string[]
): Promise<void> => {
  if (hashes.length === 0) {
    return;
  }
  const gone = await drizzle(env.DB)
    .delete(sdkArtifacts)
    .where(and(inList(sdkArtifacts.sha256, hashes), unreferenced))
    .returning({
      sha256: sdkArtifacts.sha256,
      generation: sdkArtifacts.generation,
    });
  await deleteKeys(env, gone);
};

/**
 * That no row names the seal of the reference `sdk_artifact_refs`, as SQL:
 * no release, workflow version or test run.
 */
const unnamedSql = sql`NOT EXISTS (SELECT 1 FROM sdk_release_manifests AS manifests
    WHERE manifests.seal_id = sdk_artifact_refs.seal)
  AND NOT EXISTS (SELECT 1 FROM workflow_resource_versions AS versions
    WHERE versions.seal_id = sdk_artifact_refs.seal)
  AND NOT EXISTS (SELECT 1 FROM workflow_candidate_runs AS candidates
    WHERE candidates.reservation = sdk_artifact_refs.seal)`;

/**
 * Removes seal `seal`'s references, only while no row names it
 * (`unnamedSql`), then collects what they named (`collectArtifacts`): for
 * a seal whose row wasn't written, or went. A row written though its batch
 * answered an error keeps them.
 */
export const releaseSeal = async (env: Env, seal: string): Promise<void> => {
  const dropped = await drizzle(env.DB)
    .delete(sdkArtifactRefs)
    .where(and(eq(sdkArtifactRefs.seal, seal), unnamedSql))
    .returning({ sha256: sdkArtifactRefs.sha256 });
  await collectArtifacts(
    env,
    dropped.map(({ sha256 }) => sha256)
  );
};

/** `releaseSeal`, logging a failure rather than throwing it. */
export const releaseSealQuietly = async (
  env: Env,
  seal: string
): Promise<void> => {
  try {
    await releaseSeal(env, seal);
  } catch (error) {
    log.warn("seal.release_failed", { seal, ...errorFields(error) });
  }
};

/** Where artifacts' keys are, and how one is read: `<sha256>/<generation>`. */
const artifactsPrefix = "artifacts/";

/**
 * Where the stray-key sweep keeps the last key it listed, which the next
 * sweep lists after: outside `artifacts/`, so never listed itself.
 */
export const strayCursorKey = "sweeps/artifact-keys-after";
const strayKeyPattern =
  /^artifacts\/(?<sha256>[0-9a-f]{64})\/(?<generation>[0-9a-f-]+)$/u;

/**
 * Deletes, from the next page of artifact keys, the keys whose generation
 * is no live row's: bytes a failed bulk delete left. A generation is never
 * a row's again once its row went, and a seal uploads only to the
 * generation of a row its reference keeps, so no such key is one a
 * reference names or comes to name. One bounded page a sweep, after the
 * last key the previous sweep listed (`strayCursorKey`), and from the start
 * once the listing ended, so the whole prefix is covered in turn.
 */
export const sweepStrayKeys = async (env: Env): Promise<void> => {
  const saved = await env.FILES.get(strayCursorKey);
  const startAfter = saved === null ? undefined : await saved.text();
  const page = await env.FILES.list({
    prefix: artifactsPrefix,
    startAfter,
    limit: keysPerDelete,
  });
  // Where the next sweep goes on: after this page, or from the start.
  const last = page.objects.at(-1)?.key;
  await (page.truncated && last !== undefined
    ? env.FILES.put(strayCursorKey, last)
    : env.FILES.delete(strayCursorKey));
  const keys = page.objects.flatMap(({ key }) => {
    const { sha256, generation } = strayKeyPattern.exec(key)?.groups ?? {};
    return sha256 === undefined || generation === undefined
      ? []
      : [{ key, sha256, generation }];
  });
  if (keys.length === 0) {
    return;
  }
  const live = await generationsOf(
    env,
    keys.map(({ sha256 }) => sha256)
  );
  const stray = keys.filter(
    ({ sha256, generation }) => live.get(sha256) !== generation
  );
  if (stray.length > 0) {
    try {
      await env.FILES.delete(stray.map(({ key }) => key));
    } catch (error) {
      log.error("artifact.stray_delete_failed", {
        keys: stray.length,
        ...errorFields(error),
      });
    }
  }
};

/** The most unreferenced artifact rows one statement of the sweep deletes. */
export const collectBatch = 500;

/** How many such statements one sweep runs, at most. */
const collectBatches = 20;

/**
 * The retention sweep's artifact step, at `now`: removes the references
 * of seals no row names a day after they were made, then deletes the
 * artifact rows nothing references, `collectBatch` a statement, each
 * checking in the statement that deletes, and their bytes; then one page
 * of stray keys (`sweepStrayKeys`).
 */
export const sweepArtifacts = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  await db
    .delete(sdkArtifactRefs)
    .where(
      and(
        lt(sdkArtifactRefs.createdAt, new Date(now.getTime() - unnamedSealMs)),
        unnamedSql
      )
    );
  for (let batch = 0; batch < collectBatches; batch += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    const gone = await db
      .delete(sdkArtifacts)
      .where(
        and(
          sql`sdk_artifacts.sha256 IN (SELECT sha256 FROM sdk_artifacts
            WHERE ${unreferenced} LIMIT ${collectBatch})`,
          unreferenced
        )
      )
      .returning({
        sha256: sdkArtifacts.sha256,
        generation: sdkArtifacts.generation,
      });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await deleteKeys(env, gone);
    if (gone.length < collectBatch) {
      break;
    }
  }
  await sweepStrayKeys(env);
};
