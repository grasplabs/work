import {
  assetKey,
  blobsOf,
  manifestKey,
  moduleKey,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import { nextReleaseId as nextPublishedId } from "@grasp-os/shared/release-id";
import { signatureKey } from "@grasp-os/shared/release-signature";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  signReleaseManifest,
  testReleaseSigningKey,
} from "../../../packages/shared/test/release-signing-keys.ts";
import { alertEventSchema } from "../src/alerts/alert.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  alerts,
  auditEvents,
  channels,
  releaseImportFailures,
  releaseImportProgress,
  releases,
} from "../src/db/schema.ts";
import {
  importReleases,
  MAX_RELEASES_PER_RUN,
  MAX_MANIFEST_BYTES,
  MAX_BLOBS_PER_RELEASE,
  MAX_REQUESTS_PER_RUN,
} from "../src/releases/import.ts";
import type { ImportStore } from "../src/releases/import.ts";
import { channelReleases } from "../src/rollout/targets.ts";
import worker from "../src/server.ts";
import {
  buildRelease,
  nextReleaseId,
  publishRelease,
  putBlobs,
  putManifest,
} from "./releases.ts";
import type { TestRelease } from "./releases.ts";

const db = adminDatabase(env.DB);

const releaseRow = async (id: string) => {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  return row;
};

const eventsFor = async (action: string, id: string) =>
  await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.target, id)));

const importEvents = async (id: string) =>
  await eventsFor("release.import", id);

const failureRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(releaseImportFailures)
    .where(eq(releaseImportFailures.releaseId, id));
  return row;
};

const progressRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(releaseImportProgress)
    .where(eq(releaseImportProgress.releaseId, id));
  return row;
};

const MINUTE = 60 * 1000;

/** `minutes` from now: a later run, past a failed release's wait. */
const inMinutes = (minutes: number): Date =>
  new Date(Date.now() + minutes * MINUTE);

/** Runs an import, with the failures it logs kept out of the test output. */
const runImport = async (
  store: ImportStore = env.RELEASES,
  options: { now?: Date } = {}
) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Failed imports are logged; the tests read the result instead.
  });
  try {
    return await importReleases(store, db, options);
  } finally {
    errors.mockRestore();
  }
};

const tally = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/**
 * `env.RELEASES`, counting the reads and the heads of each key, R2 failing
 * a read of `failing` as long as `failing.times` lasts (Infinity: always).
 */
const countingStore = (failing?: { key: string; times: number }) => {
  const reads = new Map<string, number>();
  const heads = new Map<string, number>();
  const store: ImportStore = {
    list: async (options) => await env.RELEASES.list(options),
    head: async (key: string) => {
      tally(heads, key);
      return await env.RELEASES.head(key);
    },
    get: async (key: string) => {
      tally(reads, key);
      if (failing !== undefined && key === failing.key && failing.times > 0) {
        failing.times -= 1;
        throw new Error("We encountered an internal error. Please try again.");
      }
      return await env.RELEASES.get(key);
    },
  };
  return { store, reads, heads };
};

/** Where a release's one static asset is stored. */
const assetOf = (release: TestRelease): string => {
  const [hash] = Object.keys(release.manifest.assets);
  if (hash === undefined) {
    throw new Error("expected an asset");
  }
  return assetKey(hash);
};

/** Replaces `text` with text of the same length but other bytes. */
const sameSizeOther = (text: string): string =>
  text.replaceAll(/[0-9a-f]/gu, (char) => (char === "0" ? "1" : "0"));

/**
 * 1,150 static assets, each of `token`'s own but those at the indexes
 * `others` names, which are `other`'s: with a release's modules and
 * migrations, about as many blobs as a release built from main today
 * (1,163).
 */
const largeAssets = (
  token: string,
  { other = token, others = 0 }: { other?: string; others?: number } = {}
): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: 1150 }, (_, index) => [
      `/asset-${index}.txt`,
      `${index < others ? other : token} ${index}`,
    ])
  );

/** A release of about as many blobs as one built from main today. */
const largeRelease = async (notes: string) =>
  await publishRelease({ notes, assets: largeAssets(crypto.randomUUID()) });

/** The admin's every-minute cron, at minute `minute` of an hour: every fifth its tick. */
const cronAt = (minute: number) =>
  createScheduledController({
    cron: "* * * * *",
    scheduledTime: Date.UTC(2026, 10, 27, 12, minute),
  });

/** Every read `reads` counted, the manifests' included. */
const allReads = (reads: ReadonlyMap<string, number>): number =>
  [...reads.values()].reduce((sum, count) => sum + count, 0);

describe("importing releases", () => {
  it("records a published release once its blobs verify, and audits it", async () => {
    const release = await publishRelease({ notes: "feat(core): one" });

    const result = await runImport();

    expect(result.imported).toContain(release.id);
    const row = await releaseRow(release.id);
    expect(row).toMatchObject({
      commitSha: release.manifest.commit,
      manifest: release.manifestText,
      manifestSha256: await sha256OfBytes(
        new TextEncoder().encode(release.manifestText)
      ),
      builtAt: new Date(release.manifest.createdAt),
    });
    const events = await importEvents(release.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "system",
      clientId: null,
      detail: JSON.stringify({
        commit: release.manifest.commit,
        manifestSha256: row?.manifestSha256,
      }),
    });
  });

  it("changes nothing when it runs again", async () => {
    const release = await publishRelease({ notes: "feat(core): again" });
    await runImport();
    const first = await releaseRow(release.id);

    const again = await runImport();

    expect(again.imported).not.toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toStrictEqual(first);
    await expect(importEvents(release.id)).resolves.toHaveLength(1);
  });

  it("records a release once when two runs import it at the same time", async () => {
    const release = await publishRelease({ notes: "feat(core): overlap" });
    // Both runs have seen the release as new before either records it:
    // each waits at the manifest until the other has reached it too.
    let arrived = 0;
    const { promise: barrier, resolve: bothArrived } =
      Promise.withResolvers<boolean>();
    const store: ImportStore = {
      head: async (key: string) => await env.RELEASES.head(key),
      list: async (options) => await env.RELEASES.list(options),
      get: async (key: string) => {
        if (key === manifestKey(release.id)) {
          arrived += 1;
          if (arrived === 2) {
            bothArrived(true);
          }
          await barrier;
        }
        return await env.RELEASES.get(key);
      },
    };

    const results = await Promise.all([runImport(store), runImport(store)]);

    expect(
      results.map((result) => result.imported.includes(release.id))
    ).toStrictEqual([true, true]);
    await expect(releaseRow(release.id)).resolves.toBeDefined();
    await expect(importEvents(release.id)).resolves.toHaveLength(1);
  });

  it("imports a manifest with top-level fields it doesn't know, keeping it as published", async () => {
    const built = await buildRelease({ notes: "feat(core): more fields" });
    const manifestText = `${JSON.stringify(
      {
        ...built.manifest,
        compatibility: { interfaces: { connect: { serves: 3, calls: {} } } },
        platformLimits: { workflowSteps: 1000 },
      },
      null,
      2
    )}\n`;
    await putBlobs(built);
    await putManifest({ ...built, manifestText });

    const result = await runImport();

    expect(result.imported).toContain(built.id);
    await expect(releaseRow(built.id)).resolves.toMatchObject({
      manifest: manifestText,
    });
  });

  it("skips a release until its manifest is written", async () => {
    const release = await buildRelease({ notes: "feat(core): halfway" });
    await putBlobs(release);

    const before = await runImport();

    expect([...before.imported, ...before.failed]).not.toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();

    await putManifest(release);
    const after = await runImport();

    expect(after.imported).toContain(release.id);
  });

  it("refuses a release whose blob isn't what its manifest says", async () => {
    // Its own module: blobs are shared by content, and this one is replaced.
    const release = await buildRelease({
      notes: "feat(core): tampered",
      core: `export default { tampered: "${crypto.randomUUID()}" };`,
    });
    await putBlobs(release);
    const [module] = release.manifest.workers.core?.modules ?? [];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    // The same size, so it's the hash that gives it away.
    const original = new TextDecoder().decode(
      release.blobs.get(moduleKey(module.sha256))
    );
    await env.RELEASES.put(moduleKey(module.sha256), sameSizeOther(original));
    await putManifest(release);

    const result = await runImport();

    expect(result.failed).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();
    await expect(importEvents(release.id)).resolves.toHaveLength(0);
  });

  it("refuses a release whose static asset isn't what its manifest says, whatever its size", async () => {
    const token = crypto.randomUUID();
    const sameSize = await buildRelease({
      notes: "feat(core): tampered asset",
      assets: { "/index.html": `<html>${token}</html>` },
    });
    const resized = await buildRelease({
      notes: "feat(core): resized asset",
      assets: { "/index.html": `<html>${token} resized</html>` },
    });
    await Promise.all([putBlobs(sameSize), putBlobs(resized)]);
    await env.RELEASES.put(
      assetOf(sameSize),
      `<html>${sameSizeOther(token)}</html>`
    );
    await env.RELEASES.put(assetOf(resized), "<html></html>");
    await Promise.all([putManifest(sameSize), putManifest(resized)]);

    const result = await runImport();

    expect(result.failed).toStrictEqual(
      expect.arrayContaining([sameSize.id, resized.id])
    );
    await expect(releaseRow(sameSize.id)).resolves.toBeUndefined();
    await expect(releaseRow(resized.id)).resolves.toBeUndefined();
  });

  it("imports a release whose model files the bucket holds as CI stores them, never reading them whole", async () => {
    const release = await buildRelease({
      notes: "feat(core): a model",
      modelFiles: { tokens: `tokens ${crypto.randomUUID()}` },
    });
    await putBlobs(release);
    await putManifest(release);
    const { store, reads } = countingStore();

    const result = await runImport(store);

    expect(result.imported).toContain(release.id);
    for (const { r2Key } of release.manifest.modelFiles) {
      expect(reads.get(r2Key)).toBeUndefined();
    }
  });

  it("refuses a release whose model file is missing, has other bytes, or was stored without its SHA-256", async () => {
    const tokens = `tokens ${crypto.randomUUID()}`;
    const refused = await Promise.all(
      ["missing", "other bytes", "no checksum"].map(
        async (notes) =>
          await buildRelease({
            notes: `feat(core): ${notes}`,
            modelFiles: { tokens: `${notes} ${tokens}` },
          })
      )
    );
    await Promise.all(refused.map(putBlobs));
    const [missing, other, unchecked] = refused.map(
      ({ manifest }) => manifest.modelFiles[0]?.r2Key ?? ""
    );
    await env.RELEASES.delete(missing ?? "");
    // Other bytes of the same size, stored with their own SHA-256.
    const replaced = sameSizeOther(`other bytes ${tokens}`);
    await env.RELEASES.put(other ?? "", replaced, {
      sha256: await sha256OfBytes(new TextEncoder().encode(replaced)),
    });
    await env.RELEASES.put(unchecked ?? "", `no checksum ${tokens}`);
    await Promise.all(refused.map(putManifest));

    const result = await runImport();

    expect(result.failed).toStrictEqual(
      expect.arrayContaining(refused.map(({ id }) => id))
    );
    for (const { id } of refused) {
      // oxlint-disable-next-line no-await-in-loop -- three releases
      await expect(releaseRow(id)).resolves.toBeUndefined();
    }
  });

  it("refuses a release with a missing blob, and imports it once the blob is there", async () => {
    const release = await buildRelease({
      notes: "feat(core): missing blob",
      // Its own migration: blobs are shared by content, and this one is
      // deleted for a while.
      migrations: {
        "0000_only.sql": `-- ${crypto.randomUUID()}
CREATE TABLE t (id TEXT);`,
      },
    });
    const [key, bytes] =
      [...release.blobs].find(([blobKey]) =>
        blobKey.startsWith("blobs/migrations/")
      ) ?? [];
    if (key === undefined || bytes === undefined) {
      throw new Error("expected a migration");
    }
    await putBlobs(release);
    await env.RELEASES.delete(key);
    await putManifest(release);

    const failed = await runImport();
    expect(failed.failed).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();

    await env.RELEASES.put(key, bytes);
    const retried = await runImport(env.RELEASES, { now: inMinutes(6) });
    expect(retried.imported).toContain(release.id);
    await expect(failureRow(release.id)).resolves.toBeUndefined();
  });

  it("waits longer after each failed attempt, and audits each", async () => {
    const broken = nextReleaseId();
    await env.RELEASES.put(manifestKey(broken), "{ not json");
    const { store, reads } = countingStore();
    const attempts = () => reads.get(manifestKey(broken)) ?? 0;

    // Attempts at 0; the first wait is 50 seconds, up to the next run, so
    // again at 1.5; the second is 100 seconds, so again at 4, not at 3.
    const seen: number[] = [];
    for (const minutes of [0, 0.5, 1.5, 3, 4]) {
      // oxlint-disable-next-line no-await-in-loop -- runs in order
      await runImport(store, { now: inMinutes(minutes) });
      seen.push(attempts());
    }
    expect(seen).toStrictEqual([1, 1, 2, 2, 3]);

    await expect(failureRow(broken)).resolves.toMatchObject({ attempts: 3 });
    const events = await eventsFor("release.import_failed", broken);
    expect(events.map((event) => event.detail)).toStrictEqual([
      JSON.stringify({ attempts: 1 }),
      JSON.stringify({ attempts: 2 }),
      JSON.stringify({ attempts: 3 }),
    ]);
  });

  it("tries a bounded number of releases a run, broken ones too, and reaches an older good one while they wait", async () => {
    const good = await publishRelease({ notes: "feat(core): older and good" });
    const broken = Array.from({ length: MAX_RELEASES_PER_RUN + 1 }, () =>
      nextReleaseId()
    );
    await Promise.all(
      broken.map(
        async (id) => await env.RELEASES.put(manifestKey(id), "{ not json")
      )
    );

    const first = await runImport();
    const second = await runImport();

    expect({
      // The newest first, as many as a run tries.
      firstFailed: first.failed,
      firstImported: first.imported.includes(good.id),
      // Those wait for their next attempt: the rest go on.
      secondFailed: second.failed,
      secondImported: second.imported.includes(good.id),
    }).toStrictEqual({
      firstFailed: broken.slice(1).toReversed(),
      firstImported: false,
      secondFailed: broken.slice(0, 1),
      secondImported: true,
    });
  });

  it("refuses a manifest that names another release, or isn't a manifest", async () => {
    const release = await publishRelease({ notes: "feat(core): elsewhere" });
    const moved = nextReleaseId();
    await env.RELEASES.put(manifestKey(moved), release.manifestText);
    const garbled = nextReleaseId();
    await env.RELEASES.put(manifestKey(garbled), "{ not json");
    const huge = nextReleaseId();
    await env.RELEASES.put(
      manifestKey(huge),
      `{"padding":"${"x".repeat(MAX_MANIFEST_BYTES)}"}`
    );
    const bom = await buildRelease({ notes: "feat(core): bom" });
    await putBlobs(bom);
    await env.RELEASES.put(manifestKey(bom.id), `\uFEFF${bom.manifestText}`);
    const invalidUtf8 = nextReleaseId();
    await env.RELEASES.put(
      manifestKey(invalidUtf8),
      Uint8Array.from([0x7b, 0xff, 0x7d])
    );

    const result = await runImport();

    const refused = [moved, garbled, huge, bom.id, invalidUtf8];
    expect(result.failed).toStrictEqual(expect.arrayContaining(refused));
    const rows = await Promise.all(refused.map(releaseRow));
    expect(rows.filter((row) => row !== undefined)).toStrictEqual([]);
  });

  it("imports the newest releases first, the rest on the next run", async () => {
    const published = [];
    for (let count = 0; count <= MAX_RELEASES_PER_RUN; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      published.push(await publishRelease({ notes: `feat(core): ${count}` }));
    }
    const [oldest, ...newest] = published.map((release) => release.id);

    const first = await runImport();

    expect(first.imported).toStrictEqual(newest.toReversed());
    // One left unread: retention waits for it (src/releases/retention.ts).
    expect(first.caughtUp).toBeFalsy();
    await expect(releaseRow(oldest ?? "")).resolves.toBeUndefined();

    const second = await runImport();

    expect(second.imported).toContain(oldest);
  });

  it("takes the newest release by year, month and N as numbers, never as text", async () => {
    // A month after every other release in the file's bucket.
    const month = new Date(Date.UTC(2099, 11, 15));
    const ids: string[] = [];
    for (let n = 1; n <= 10; n += 1) {
      ids.push(nextPublishedId(ids, month));
    }
    const [ninth = "", tenth = ""] = ids.slice(-2);
    for (const id of [ninth, tenth]) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      const release = await buildRelease({ notes: `feat(core): ${id}` }, id);
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      await putBlobs(release);
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      await putManifest(release);
    }

    const result = await runImport();

    expect(result.imported.slice(0, 2)).toStrictEqual([tenth, ninth]);
  });

  it("counts two runs' failures of the same release at once as two attempts", async () => {
    const broken = nextReleaseId();
    await env.RELEASES.put(manifestKey(broken), "{ not json");
    // Both runs have seen the release as due before either records its
    // failure: each waits at the manifest until the other has reached it.
    let arrived = 0;
    const { promise: barrier, resolve: bothArrived } =
      Promise.withResolvers<boolean>();
    const store: ImportStore = {
      head: async (key: string) => await env.RELEASES.head(key),
      list: async (options) => await env.RELEASES.list(options),
      get: async (key: string) => {
        if (key === manifestKey(broken)) {
          arrived += 1;
          if (arrived === 2) {
            bothArrived(true);
          }
          await barrier;
        }
        return await env.RELEASES.get(key);
      },
    };
    const now = inMinutes(0);

    await Promise.all([runImport(store, { now }), runImport(store, { now })]);

    // The second attempt's wait is 100 seconds.
    await expect(failureRow(broken)).resolves.toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(now.getTime() + 100 * 1000),
    });
    const events = await eventsFor("release.import_failed", broken);
    const details = events.map((event) => event.detail ?? "");
    expect(details.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      JSON.stringify({ attempts: 1 }),
      JSON.stringify({ attempts: 2 }),
    ]);
  });

  it("refuses a release naming more blobs than it may, before reading them", async () => {
    const token = crypto.randomUUID();
    // Its manifest alone: none of its blobs is read.
    const release = await buildRelease({
      notes: "feat(core): too many blobs",
      assets: Object.fromEntries(
        Array.from({ length: MAX_BLOBS_PER_RELEASE + 1 }, (_, index) => [
          `/asset-${index}.txt`,
          `${token} ${index}`,
        ])
      ),
    });
    await putManifest(release);
    const { store, reads } = countingStore();

    const result = await runImport(store);

    expect(result.failed).toContain(release.id);
    expect(
      [...reads.keys()].filter((key) => key.startsWith("blobs/"))
    ).toStrictEqual([]);
  });

  it("stops a run in a release its requests don't cover, and imports it next run", async () => {
    // Each release costs a third of a run's requests to R2 and a little
    // more, read whole or by heads alike: a run has room for two.
    const assetCount = Math.floor(MAX_REQUESTS_PER_RUN / 3);
    const token = crypto.randomUUID();
    const assets = Object.fromEntries(
      Array.from({ length: assetCount }, (_, index) => [
        `/asset-${index}.txt`,
        `${token} ${index}`,
      ])
    );
    // Ids are handed out in call order: oldest first.
    const built = await Promise.all(
      [0, 1, 2].map(
        async (count) =>
          await buildRelease({ notes: `feat(core): big ${count}`, assets })
      )
    );
    // Blobs are content-addressed, so the three share their assets: each is
    // stored once, not three times, which keeps the test well inside its
    // timeout on a loaded machine.
    const blobs = new Map(built.flatMap((release) => [...release.blobs]));
    await putBlobs({ blobs });
    await Promise.all(
      built.map(async (release) => {
        await putManifest(release);
      })
    );
    const [oldest, middle, newest] = built.map((release) => release.id);

    const first = await runImport();
    const second = await runImport();

    expect(first.imported).toStrictEqual([newest, middle]);
    expect(second.imported).toContain(oldest);
  });

  it("imports a release in one run, and one sharing most of its blobs by reading only its new ones", async () => {
    const token = crypto.randomUUID();
    const first = await publishRelease({
      notes: "feat(core): first of two",
      assets: largeAssets(token),
    });
    const { store, reads, heads } = countingStore();

    const firstRun = await runImport(store);
    const firstReads = allReads(reads);
    const firstHeads = allReads(heads);
    // As a merge changes it: 76 of its blobs new, as main's last did.
    const second = await publishRelease({
      notes: "feat(core): second of two",
      assets: largeAssets(token, { other: crypto.randomUUID(), others: 76 }),
    });
    const fresh = [...second.blobs.keys()].filter(
      (key) => !first.blobs.has(key)
    );
    const secondRun = await runImport(store);

    expect({
      blobs: first.blobs.size,
      firstImported: firstRun.imported.includes(first.id),
      // Its manifest, its signature and each blob, read once: nothing
      // imported holds them.
      firstRequests: firstReads + firstHeads,
      secondImported: secondRun.imported.includes(second.id),
      fresh: fresh.length,
      // Its manifest, its signature and its new blobs read; the rest by
      // their heads alone.
      secondReads: allReads(reads) - firstReads,
      freshReadOnce: fresh.every((key) => reads.get(key) === 1),
      secondHeads: allReads(heads) - firstHeads,
    }).toStrictEqual({
      blobs: 1154,
      firstImported: true,
      firstRequests: 1156,
      secondImported: true,
      fresh: 76,
      secondReads: 78,
      freshReadOnce: true,
      secondHeads: 1154 - 76,
    });
    expect(firstReads + firstHeads).toBeLessThanOrEqual(MAX_REQUESTS_PER_RUN);
    await expect(importEvents(second.id)).resolves.toHaveLength(1);
  });

  it("refuses a release whose blob an imported release names but the bucket no longer holds as it was", async () => {
    const token = crypto.randomUUID();
    const imported = await publishRelease({
      notes: "feat(core): imported",
      core: `export default { shared: "${token}" };`,
      assets: { "/a.txt": `a ${token}`, "/b.txt": `b ${token}` },
    });
    await runImport();
    const [gone, resized] = Object.values(imported.manifest.assets).map(
      ({ r2Key }) => r2Key
    );
    const [module] = imported.manifest.workers.core?.modules ?? [];
    if (gone === undefined || resized === undefined || module === undefined) {
      throw new Error("expected two assets and a core module");
    }
    // Each later release shares one blob of the imported release that the
    // bucket then changes (the deleted file, the resized file, the core
    // module), with a core module and a static file of its own besides,
    // all stored as CI stores them; the bucket changes after.
    const shared = `export default { shared: "${token}" };`;
    const specs: [string, Record<string, string>, string | undefined][] = [
      ["missing", { "/a.txt": `a ${token}` }, undefined],
      ["other size", { "/b.txt": `b ${token}` }, undefined],
      ["other hash", {}, shared],
    ];
    const sharing = await Promise.all(
      specs.map(async ([notes, assets, core]) => {
        const release = await buildRelease({
          notes: `feat(core): ${notes}`,
          core: core ?? `export default { own: "${notes} ${token}" };`,
          assets: { ...assets, "/own.txt": `${notes} ${token}` },
        });
        await putBlobs(release);
        return release;
      })
    );
    const [missing, otherSize, otherHash] = sharing;
    if (
      missing === undefined ||
      otherSize === undefined ||
      otherHash === undefined
    ) {
      throw new Error("expected three releases");
    }
    await env.RELEASES.delete(gone);
    await env.RELEASES.put(resized, `b ${token} and more`);
    // Other bytes of the same size, stored with their own SHA-256.
    const replaced = sameSizeOther(
      new TextDecoder().decode(imported.blobs.get(module.r2Key))
    );
    await env.RELEASES.put(module.r2Key, replaced, {
      sha256: await sha256OfBytes(new TextEncoder().encode(replaced)),
    });
    await Promise.all(sharing.map(putManifest));
    const { store, reads } = countingStore();

    const result = await runImport(store);

    const refused = [missing.id, otherSize.id, otherHash.id];
    expect({
      failed: refused.every((id) => result.failed.includes(id)),
      saved: await Promise.all(refused.map(releaseRow)),
      // Found out by its head: never read.
      moduleRead: reads.get(module.r2Key),
    }).toStrictEqual({
      failed: true,
      saved: [undefined, undefined, undefined],
      moduleRead: undefined,
    });
  });

  it("reads a blob the imported release checked again where another manifest serves it under another extension", async () => {
    const token = crypto.randomUUID();
    const imported = await publishRelease({
      notes: "feat(core): served as script",
      assets: { "/a.js": `a ${token}` },
    });
    await runImport();
    const [key] = Object.keys(imported.manifest.assets).map(assetKey);
    // The same blob, at the same key and size, now said to be a stylesheet:
    // its content key takes the extension, so it isn't one.
    const renamed = nextReleaseId();
    await putManifest({
      ...imported,
      id: renamed,
      manifestText: imported.manifestText
        .replace(`"releaseId": "${imported.id}"`, `"releaseId": "${renamed}"`)
        .replace('"/a.js"', '"/a.css"'),
    });
    const { store, reads } = countingStore();

    const result = await runImport(store);

    expect({
      failed: result.failed.includes(renamed),
      read: reads.get(key ?? ""),
    }).toStrictEqual({ failed: true, read: 1 });
  });

  it("tries a read R2 fails again, and imports the release in the same run", async () => {
    const release = await largeRelease("feat(core): a read fails twice");
    const [, key] = blobsOf(release.manifest).map((blob) => blob.key);
    if (key === undefined) {
      throw new Error("expected blobs");
    }
    const { store, reads } = countingStore({ key, times: 2 });

    const result = await runImport(store);

    expect({
      imported: result.imported.includes(release.id),
      reads: reads.get(key),
      failure: await failureRow(release.id),
    }).toStrictEqual({ imported: true, reads: 3, failure: undefined });
  });

  it("fails a release whose read R2 keeps failing, audited, and goes on from that blob at its next attempt", async () => {
    const release = await largeRelease("feat(core): a read keeps failing");
    const order = blobsOf(release.manifest).map((blob) => blob.key);
    const at = 600;
    const key = order[at] ?? "";
    const failing = { key, times: Number.POSITIVE_INFINITY };
    const { store, reads } = countingStore(failing);

    const first = await runImport(store);
    const triedFirst = reads.get(key);
    const audited = await eventsFor("release.import_failed", release.id);
    failing.times = 0;
    const second = await runImport(store, { now: inMinutes(2) });

    expect({
      failed: first.failed.includes(release.id),
      audited: audited.map((event) => event.detail),
      // Tried once and again after each of its waits.
      triedFirst,
      imported: second.imported.includes(release.id),
      // Every blob before it checked once, over both attempts.
      beforeOnce: order.slice(0, at).every((each) => reads.get(each) === 1),
      itAgain: reads.get(key),
      saved: (await releaseRow(release.id)) !== undefined,
    }).toStrictEqual({
      failed: true,
      audited: [JSON.stringify({ attempts: 1 })],
      triedFirst: 4,
      imported: true,
      beforeOnce: true,
      itAgain: 5,
      saved: true,
    });
  });

  it("leaves nothing of an attempt behind once a run beside it imported the release", async () => {
    const release = await largeRelease("feat(core): imported beside");
    // In its second batch, so the first batch's progress is on record.
    const key = blobsOf(release.manifest).map((blob) => blob.key)[300] ?? "";
    const { promise: reached, resolve: reach } =
      Promise.withResolvers<boolean>();
    const { promise: importedBeside, resolve: imported } =
      Promise.withResolvers<boolean>();
    // R2 fails the slow run at that blob, each time, once the other run
    // imported the release.
    const slow: ImportStore = {
      list: async (options) => await env.RELEASES.list(options),
      head: async (blob: string) => await env.RELEASES.head(blob),
      get: async (blob: string) => {
        if (blob.startsWith("blobs/")) {
          reach(true);
        }
        if (blob === key) {
          await importedBeside;
          throw new Error(
            "We encountered an internal error. Please try again."
          );
        }
        return await env.RELEASES.get(blob);
      },
    };

    const slowRun = runImport(slow);
    await reached;
    // Past the slow run's attempt, which makes the next wait.
    const besideRun = await runImport(env.RELEASES, { now: inMinutes(2) });
    imported(true);
    const slowResult = await slowRun;
    const [failure, progress, failedEvents, imports] = await Promise.all([
      failureRow(release.id),
      progressRow(release.id),
      eventsFor("release.import_failed", release.id),
      importEvents(release.id),
    ]);

    expect({
      beside: besideRun.imported.includes(release.id),
      slowFailed: slowResult.failed.includes(release.id),
      failure,
      progress,
      failedEvents: failedEvents.length,
      imports: imports.length,
    }).toStrictEqual({
      beside: true,
      slowFailed: true,
      failure: undefined,
      progress: undefined,
      failedEvents: 0,
      imports: 1,
    });
  });

  it("goes on from the batches a run that died recorded, once its attempt's wait is over", async () => {
    const release = await largeRelease("feat(core): a run dies");
    const order = blobsOf(release.manifest).map((blob) => blob.key);
    const key = order[600] ?? "";
    const { store, reads } = countingStore();
    // The run dies at that blob, never answered: nothing after it runs.
    const { promise: never } = Promise.withResolvers<never>();
    const dying: ImportStore = {
      ...store,
      get: async (blob: string) =>
        blob === key ? await never : await store.get(blob),
    };

    void runImport(dying);
    await vi.waitFor(
      async () => {
        const progress = await progressRow(release.id);
        expect(progress?.verifiedBlobs).toBe(500);
      },
      { timeout: 20_000, interval: 50 }
    );
    const atOnce = await runImport(store);
    const waiting = await failureRow(release.id);
    const later = await runImport(store, { now: inMinutes(2) });

    expect({
      // Its attempt counted before the run died: the next waits.
      triedAtOnce: atOnce.imported.includes(release.id),
      attempts: waiting?.attempts,
      imported: later.imported.includes(release.id),
      // The two batches on record aren't read again.
      recordedOnce: order.slice(0, 500).every((each) => reads.get(each) === 1),
    }).toStrictEqual({
      triedAtOnce: false,
      attempts: 1,
      imported: true,
      recordedOnce: true,
    });
  });

  it("checks a release from its first blob again once its manifest was replaced after a failed attempt", async () => {
    const assets = largeAssets(crypto.randomUUID());
    const release = await publishRelease({
      notes: "feat(core): before",
      assets,
    });
    const order = blobsOf(release.manifest).map((blob) => blob.key);
    // Its last static file: blobs no other release names.
    const last = order.findLast((key) => key.startsWith("blobs/assets/"));
    const failing = { key: last ?? "", times: Number.POSITIVE_INFINITY };
    const { store, reads } = countingStore(failing);
    const first = await runImport(store);
    // The blobs the first attempt checked, before the manifest changed.
    const checked = order.filter((key) => reads.get(key) === 1);
    failing.times = 0;
    // Another manifest under the same id: the same blobs, another note.
    const replaced = await buildRelease(
      { notes: "feat(core): after", assets },
      release.id
    );
    await putManifest(replaced);

    const second = await runImport(store, { now: inMinutes(2) });
    const row = await releaseRow(release.id);

    expect({
      first: first.failed.includes(release.id),
      checkedSome: checked.length > 0,
      // Each read again: checked from the start.
      readAgain: checked.every((key) => reads.get(key) === 2),
      second: second.imported.includes(release.id),
      note: row?.manifest.includes("feat(core): after"),
    }).toStrictEqual({
      first: true,
      checkedSome: true,
      readAgain: true,
      second: true,
      note: true,
    });
  });

  it("imports the releases after one that doesn't verify", async () => {
    const broken = await buildRelease({
      notes: "feat(core): broken, before",
      core: `export default { broken: "${crypto.randomUUID()}" };`,
    });
    await putBlobs(broken);
    const [module] = broken.manifest.workers.core?.modules ?? [];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    await env.RELEASES.put(module.r2Key, "not the module");
    await putManifest(broken);
    const next = await publishRelease({ notes: "feat(core): after broken" });

    const first = await runImport();
    const later = await publishRelease({ notes: "feat(core): later still" });
    const second = await runImport();

    expect({
      next: first.imported.includes(next.id),
      broken: first.failed.includes(broken.id),
      later: second.imported.includes(later.id),
    }).toStrictEqual({ next: true, broken: true, later: true });
    await expect(
      eventsFor("release.import_failed", broken.id)
    ).resolves.toHaveLength(1);
  });

  it("refuses a release that isn't signed, was changed after it was signed, or was signed with a key nobody trusts, alerting staff, and imports the next", async () => {
    const encoder = new TextEncoder();
    const unsigned = await buildRelease({ notes: "feat(core): unsigned" });
    const changed = await buildRelease({ notes: "feat(core): changed" });
    const stranger = await buildRelease({ notes: "feat(core): stranger" });
    const local = await buildRelease(
      { notes: "feat(core): local" },
      "dev-unsigned"
    );
    for (const release of [unsigned, changed, stranger, local]) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await putBlobs(release);
    }
    await env.RELEASES.put(manifestKey(unsigned.id), unsigned.manifestText);
    await env.RELEASES.put(manifestKey(local.id), local.manifestText);
    // Signed as published, then changed by whoever holds the bucket's key.
    const altered = changed.manifestText.replace(
      "feat(core): changed",
      "feat(core): chang3d"
    );
    await env.RELEASES.put(
      signatureKey(await sha256OfBytes(encoder.encode(altered))),
      await signReleaseManifest(
        encoder.encode(changed.manifestText),
        testReleaseSigningKey
      )
    );
    await env.RELEASES.put(manifestKey(changed.id), altered);
    await env.RELEASES.put(
      signatureKey(await sha256OfBytes(encoder.encode(stranger.manifestText))),
      await signReleaseManifest(encoder.encode(stranger.manifestText), {
        kty: "OKP",
        crv: "Ed25519",
        x: "A2VEuP3eHRFGIPqELZm-RDZnYWKhUXJLPFsDL5Y8xVY",
        d: "7Bs1IAjNMwqAVTTNRQkEsTjYn2p3b4Vz3RhHn0GXi8o",
      })
    );
    await env.RELEASES.put(manifestKey(stranger.id), stranger.manifestText);
    const next = await publishRelease({ notes: "feat(core): signed after" });

    const result = await runImport();

    const refused = [unsigned.id, changed.id, stranger.id, local.id];
    const alerted = await Promise.all(
      refused.map(async (id) => {
        const [row] = await db
          .select()
          .from(alerts)
          .where(eq(alerts.key, `import:${id}`));
        const event = alertEventSchema.parse(JSON.parse(row?.event ?? "null"));
        return "code" in event ? event.code : undefined;
      })
    );
    const rows = await Promise.all(refused.map(releaseRow));
    expect({
      failed: result.failed.toSorted(),
      imported: result.imported.includes(next.id),
      rows: rows.filter(Boolean),
      alerted,
    }).toStrictEqual({
      failed: refused.toSorted(),
      imported: true,
      rows: [],
      alerted: refused.map(() => "UnverifiedReleaseError"),
    });
  });

  it("refuses an unsigned release under an old id nobody used, as anyone holding the bucket's key could write one", async () => {
    const old = "26.10.999";
    const release = await buildRelease({ notes: "feat(core): planted" }, old);
    await putBlobs(release);
    await env.RELEASES.put(manifestKey(old), release.manifestText);

    const result = await runImport();

    expect({
      failed: result.failed.includes(old),
      saved: await releaseRow(old),
    }).toStrictEqual({ failed: true, saved: undefined });
  });

  it("reads the whole listing, a page at a time", async () => {
    const release = await publishRelease({ notes: "feat(core): paged" });
    const pages: string[] = [];
    // The real bucket, one release per page.
    const store: ImportStore = {
      head: async (key: string) => await env.RELEASES.head(key),
      get: async (key: string) => await env.RELEASES.get(key),
      list: async (options) => {
        const page = await env.RELEASES.list({ ...options, limit: 1 });
        pages.push(page.delimitedPrefixes.join(","));
        return page;
      },
    };

    const result = await runImport(store);

    expect(pages.length).toBeGreaterThan(1);
    expect(result.imported).toContain(release.id);
  });

  it("takes a release to Edge as it saves it, even when the run dies right after", async () => {
    const release = await publishRelease({ notes: "feat(core): then dies" });
    await db.delete(channels);
    // The bucket as far as this run sees it: only this release.
    const store: ImportStore = {
      head: async (key: string) => await env.RELEASES.head(key),
      list: async (options) => {
        const page = await env.RELEASES.list(options);
        return {
          ...page,
          delimitedPrefixes: page.delimitedPrefixes.filter(
            (prefix) => prefix === `releases/${release.id}/`
          ),
        };
      },
      get: async (key: string) => await env.RELEASES.get(key),
    };
    // The run dies once the batch that saves the release has landed:
    // nothing after it runs.
    let dead = false;
    const dying = new Proxy(env.DB, {
      get: (target, property) => {
        if (dead) {
          throw new Error("The run died");
        }
        const value: unknown = Reflect.get(target, property);
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            dead = (await releaseRow(release.id)) !== undefined;
            return results;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const died = await importReleases(store, adminDatabase(dying)).then(
      () => false,
      () => true
    );

    const { edge } = await channelReleases(db);
    const promoted = await eventsFor("channel.promote", release.id);

    expect({
      died,
      saved: (await releaseRow(release.id)) !== undefined,
      edge,
      promoted: promoted.length,
    }).toStrictEqual({
      died: true,
      saved: true,
      edge: release.id,
      promoted: 1,
    });
  });

  it("runs on the admin's cron, every minute and on its five-minute tick", async () => {
    const minute = await publishRelease({ notes: "feat(core): minute" });
    await worker.scheduled(cronAt(1), env);
    const tick = await publishRelease({ notes: "feat(core): tick" });
    await worker.scheduled(cronAt(5), env);

    await expect(releaseRow(minute.id)).resolves.toBeDefined();
    await expect(releaseRow(tick.id)).resolves.toBeDefined();
  });
});
