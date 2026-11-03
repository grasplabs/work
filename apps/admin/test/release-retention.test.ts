import { assetKey, blobKeys } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { channels, clients, releases } from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import {
  deleteExpiredBundles,
  unpromotedRetentionMs,
} from "../src/releases/retention.ts";
import { pinClient, promoteRelease } from "../src/rollout/channels.ts";
import { RolloutError } from "../src/rollout/errors.ts";
import { releaseToEdge } from "./edge.ts";
import { client, db, staff } from "./hosting.ts";
import { racingDb } from "./racing-db.ts";
import { buildRelease, putBlobs, putManifest } from "./releases.ts";
import type { TestRelease } from "./releases.ts";

// How long a release's bundle stays (src/releases/retention.ts). How it
// can fail:
// - a bundle deleted that something may still deploy: promoted past Edge,
//   on a channel, or pinned;
// - a blob deleted that a kept release shares;
// - a release's record lost with its bundle;
// - a release whose bundle is gone promoted or pinned, even when the pin
//   or promotion races retention's claim;
// - a release claimed though it was pinned as retention looked at it;
// - a blob deleted that a release still being imported names;
// - a blob deleted before every kept release's blobs are on record.

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

/**
 * Runs retention as the cron would, until it has no kept release's blobs
 * left to record: returns every release it claimed.
 */
const retain = async (database = db, now = new Date()): Promise<string[]> => {
  const claimed: string[] = [];
  for (let run = 0; run < 20; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run at a time
    claimed.push(...(await deleteExpiredBundles(database, env.RELEASES, now)));
  }
  return claimed;
};

/** What a refused action is refused with, or null when it went through. */
const refusalOf = async (action: Promise<unknown>) =>
  await action.then(
    () => null,
    (error: unknown) => (error instanceof RolloutError ? error.code : error)
  );

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

    const deleted = await retain();
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

    await retain();

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

    await retain();

    await expect(blobsLeft(kept)).resolves.toBe(blobKeys(kept.manifest).length);
    await expect(deletedAt(old)).resolves.toBeInstanceOf(Date);
  });

  it("refuses a pin that lands just after retention claimed the release", async () => {
    const old = await imported(
      "fix(core): pinned late",
      unpromotedRetentionMs + day
    );
    const clientId = await client();
    // Retention claims the release right before the pin's write lands.
    let claimed: Promise<string[]> | undefined;
    const racing = racingDb(async (database) => {
      claimed ??= retain(adminDatabase(database));
      await claimed;
    });

    const pinning = await refusalOf(
      pinClient({ ...env, DB: racing }, staff, { clientId, releaseId: old.id })
    );
    const pinned = await db
      .select({ pinnedReleaseId: clients.pinnedReleaseId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .get();

    expect({
      pinning,
      pinned: pinned?.pinnedReleaseId,
      claimed: (await deletedAt(old)) instanceof Date,
    }).toStrictEqual({
      pinning: "bundle_deleted",
      pinned: null,
      claimed: true,
    });
  });

  it("never claims a release pinned as retention looked at it", async () => {
    const old = await imported(
      "fix(core): pinned in time",
      unpromotedRetentionMs + day
    );
    const clientId = await client();
    // Earlier runs, before it expired, recorded every kept release's blobs.
    await retain(db, new Date(Date.now() - unpromotedRetentionMs));
    // Staff pin it right before retention's claim lands.
    let pinning: Promise<void> | undefined;
    const racing = racingDb(async () => {
      pinning ??= pinClient(env, staff, { clientId, releaseId: old.id });
      await pinning;
    });

    const claimed = await deleteExpiredBundles(
      adminDatabase(racing),
      env.RELEASES,
      new Date()
    );

    expect({
      claimed: claimed.includes(old.id),
      deletedAt: await deletedAt(old),
      blobs: await blobsLeft(old),
    }).toStrictEqual({
      claimed: false,
      deletedAt: null,
      blobs: blobKeys(old.manifest).length,
    });
  });

  it("leaves a blob a release still being imported names", async () => {
    const shared = `export default { pending: "${crypto.randomUUID()}" };`;
    const old = await imported(
      "fix(core): expired, sharing core",
      unpromotedRetentionMs + day,
      shared
    );
    // Published since with the same core, and not imported yet: one of
    // its own assets is missing, so its import fails and waits.
    const pending = await buildRelease({
      notes: "feat(core): still importing",
      core: shared,
      assets: { "/only-mine.txt": crypto.randomUUID() },
    });
    await putBlobs(pending);
    const mine = Object.keys(pending.manifest.assets).find(
      (hash) => !Object.hasOwn(old.manifest.assets, hash)
    );
    await env.RELEASES.delete(assetKey(mine ?? ""));
    await putManifest(pending);
    const result = await importReleases(env.RELEASES, db);

    await retain();

    expect({
      importFailed: result.failed.includes(pending.id),
      claimed: (await deletedAt(old)) instanceof Date,
      sharedCore: await coreLeft(old),
    }).toStrictEqual({ importFailed: true, claimed: true, sharedCore: true });
  });

  it("leaves a blob that a pending release's replaced manifest names", async () => {
    const shared = `export default { replaced: "${crypto.randomUUID()}" };`;
    const old = await imported(
      "fix(core): expired, sharing the replaced core",
      unpromotedRetentionMs + day,
      shared
    );
    // Published, then its manifest replaced before it was imported (a
    // broken upload put right): each time one of its own assets is
    // missing, so its import fails and waits.
    const publish = async (core: string, id?: string) => {
      const release = await buildRelease(
        {
          notes: "feat(core): put right",
          core,
          assets: { "/only-mine.txt": crypto.randomUUID() },
        },
        id
      );
      await putBlobs(release);
      const mine = Object.keys(release.manifest.assets).find(
        (hash) => !Object.hasOwn(old.manifest.assets, hash)
      );
      await env.RELEASES.delete(assetKey(mine ?? ""));
      await putManifest(release);
      return release;
    };
    const first = await publish(
      `export default { first: "${crypto.randomUUID()}" };`
    );
    const firstRun = await importReleases(env.RELEASES, db);
    await publish(shared, first.id);
    const secondRun = await importReleases(env.RELEASES, db, {
      now: new Date(Date.now() + day),
    });

    await retain();

    expect({
      failed: [
        firstRun.failed.includes(first.id),
        secondRun.failed.includes(first.id),
      ],
      claimed: (await deletedAt(old)) instanceof Date,
      sharedCore: await coreLeft(old),
    }).toStrictEqual({ failed: [true, true], claimed: true, sharedCore: true });
  });

  it("deletes nothing until every kept release's blobs are on record, a few a run", async () => {
    const old = await imported(
      "fix(core): waits its turn",
      unpromotedRetentionMs + day
    );
    // Imported before blobs were kept on record: more than one run records.
    for (let count = 0; count < 6; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await imported(`fix(core): kept ${count}`, day);
    }

    const first = await deleteExpiredBundles(db, env.RELEASES, new Date());
    const blobsAfterFirst = await blobsLeft(old);
    const later = await retain();

    expect({
      first,
      blobsAfterFirst,
      later: later.includes(old.id),
      oldCore: await coreLeft(old),
    }).toStrictEqual({
      first: [],
      blobsAfterFirst: blobKeys(old.manifest).length,
      later: true,
      oldCore: false,
    });
  });
});
