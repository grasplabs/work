import { blobKeys } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { channels, clients, releases } from "../src/db/schema.ts";
import {
  deleteExpiredBundles,
  unpromotedRetentionMs,
} from "../src/releases/retention.ts";
import { promoteRelease, releaseToEdge } from "../src/rollout/channels.ts";
import { RolloutError } from "../src/rollout/errors.ts";
import { db, staff } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { TestRelease } from "./releases.ts";

// How long a release's bundle stays (src/releases/retention.ts). How it
// can fail:
// - a bundle deleted that something may still deploy: promoted past Edge,
//   on a channel, or pinned;
// - a blob deleted that a kept release shares;
// - a release's record lost with its bundle;
// - a release whose bundle is gone promoted or pinned.

const day = 24 * 60 * 60 * 1000;

/** A release imported `ago` before now, its blobs in the bucket. */
const imported = async (
  notes: string,
  ago: number,
  core = `export default { ${crypto.randomUUID().slice(0, 4)}: 1 };`
): Promise<TestRelease> => {
  const release = await buildRelease({ notes, core });
  await putBlobs(release);
  const at = new Date(Date.now() - ago);
  await db.insert(releases).values({
    id: release.id,
    commitSha: release.manifest.commit,
    manifest: release.manifestText,
    manifestSha256: "0".repeat(64),
    builtAt: at,
    importedAt: at,
  });
  return release;
};

/** Whether `release`'s own core module, which no other release shares, is still in the bucket. */
const coreLeft = async (release: TestRelease): Promise<boolean> => {
  const key = release.manifest.workers.core?.modules[0]?.r2Key ?? "";
  return (await env.RELEASES.head(key)) !== null;
};

/** Which of `release`'s blobs are still in the bucket. */
const blobsLeft = async (release: TestRelease): Promise<number> => {
  const found = await Promise.all(
    blobKeys(release.manifest).map(async (key) => await env.RELEASES.head(key))
  );
  return found.filter((object) => object !== null).length;
};

/** When `release`'s bundle was recorded deleted: null while kept, undefined without a record. */
const deletedAt = async (release: TestRelease) => {
  const row = await db
    .select({ bundleDeletedAt: releases.bundleDeletedAt })
    .from(releases)
    .where(eq(releases.id, release.id))
    .get();
  return row?.bundleDeletedAt;
};

describe("release retention", () => {
  beforeEach(async () => {
    await db.update(clients).set({ pinnedReleaseId: null });
    await db.delete(channels);
  });

  it("deletes the bundle of a release never promoted past Edge after 14 days, and keeps its record", async () => {
    const old = await imported(
      "fix(core): only on edge",
      unpromotedRetentionMs + day
    );
    const recent = await imported("fix(core): recent", day);

    const deleted = await deleteExpiredBundles(db, env.RELEASES, new Date());
    const promoting = await promoteRelease(env, staff, {
      channel: "edge",
      releaseId: old.id,
    }).then(
      () => null,
      (error: unknown) => (error instanceof RolloutError ? error.code : error)
    );

    expect({
      deleted: deleted.includes(old.id) && !deleted.includes(recent.id),
      oldCore: await coreLeft(old),
      recentBlobs: await blobsLeft(recent),
      record: (await deletedAt(old)) instanceof Date,
      promoting,
    }).toStrictEqual({
      deleted: true,
      oldCore: false,
      recentBlobs: blobKeys(recent.manifest).length,
      record: true,
      // Nothing can deploy it any more.
      promoting: "bundle_deleted",
    });
  });

  it("keeps the bundle of a release promoted past Edge, or on a channel, however old", async () => {
    const promoted = await imported(
      "feat(core): went to beta",
      unpromotedRetentionMs + day
    );
    await releaseToEdge(env, [promoted.id]);
    await promoteRelease(env, staff, {
      channel: "beta",
      releaseId: promoted.id,
    });
    const onEdge = await imported(
      "feat(core): edge's now",
      unpromotedRetentionMs + day
    );
    await releaseToEdge(env, [onEdge.id]);

    await deleteExpiredBundles(db, env.RELEASES, new Date());

    expect({
      promoted: await deletedAt(promoted),
      onEdge: await deletedAt(onEdge),
      blobs: await blobsLeft(onEdge),
    }).toStrictEqual({
      promoted: null,
      onEdge: null,
      blobs: blobKeys(onEdge.manifest).length,
    });
  });

  it("leaves a blob a kept release shares", async () => {
    const shared = "export default { shared: 1 };";
    const old = await imported(
      "fix(core): old",
      unpromotedRetentionMs + day,
      shared
    );
    const kept = await imported("fix(core): kept", day, shared);

    await deleteExpiredBundles(db, env.RELEASES, new Date());

    await expect(blobsLeft(kept)).resolves.toBe(blobKeys(kept.manifest).length);
    await expect(deletedAt(old)).resolves.toBeInstanceOf(Date);
  });
});
