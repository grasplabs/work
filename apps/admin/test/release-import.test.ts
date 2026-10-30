import {
  assetKey,
  limitEvidenceKey,
  manifestKey,
  moduleKey,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import { nextReleaseId as nextPublishedId } from "@grasp-os/shared/release-id";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  releaseImportFailures,
  releases,
} from "../src/db/schema.ts";
import {
  importReleases,
  MAX_IMPORTS_PER_RUN,
  MAX_MANIFEST_BYTES,
  MAX_BLOBS_PER_RELEASE,
  MAX_READS_PER_RUN,
} from "../src/releases/import.ts";
import type { ReleaseStore } from "../src/releases/import.ts";
import worker from "../src/server.ts";
import {
  buildRelease,
  evidenceFor,
  nextReleaseId,
  publishRelease,
  putBlobs,
  putLimitEvidence,
  putManifest,
  testLimits,
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

const MINUTE = 60 * 1000;

/** `minutes` from now: a later run, past a failed release's wait. */
const inMinutes = (minutes: number): Date =>
  new Date(Date.now() + minutes * MINUTE);

/** Runs an import, with the failures it logs kept out of the test output. */
const runImport = async (
  store: ReleaseStore = env.RELEASES,
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

/** `env.RELEASES`, counting the reads of each key. */
const countingStore = () => {
  const reads = new Map<string, number>();
  const store: ReleaseStore = {
    list: async (options) => await env.RELEASES.list(options),
    get: async (key: string) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return await env.RELEASES.get(key);
    },
  };
  return { store, reads };
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

/** A release of about as many blobs as one built from main today. */
/** 700 static assets of `token`'s own: as many blobs as a release from main. */
const largeAssets = (token: string): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: 700 }, (_, index) => [
      `/asset-${index}.txt`,
      `${token} ${index}`,
    ])
  );

/** A release of about as many blobs as one built from main today. */
const largeRelease = async (notes: string) =>
  await publishRelease({ notes, assets: largeAssets(crypto.randomUUID()) });

/** Every read `reads` counted, the manifests' included. */
const allReads = (reads: ReadonlyMap<string, number>): number =>
  [...reads.values()].reduce((sum, count) => sum + count, 0);

const blobReadsOf = (reads: ReadonlyMap<string, number>): number[] =>
  [...reads]
    .filter(([key]) => key.startsWith("blobs/"))
    .map(([, count]) => count);

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
        limitEvidenceSha256: row?.limitEvidenceSha256,
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
    const store: ReleaseStore = {
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

    // Attempts at 0; the first wait is five minutes, so again at 6; the
    // second is ten, so again at 17, not at 15.
    const seen: number[] = [];
    for (const minutes of [0, 4, 6, 15, 17]) {
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

  it("imports an older release past newer ones that are broken", async () => {
    const good = await publishRelease({ notes: "feat(core): older and good" });
    const broken = Array.from({ length: MAX_IMPORTS_PER_RUN + 1 }, () =>
      nextReleaseId()
    );
    await Promise.all(
      broken.map(
        async (id) => await env.RELEASES.put(manifestKey(id), "{ not json")
      )
    );

    const result = await runImport();

    expect(result.failed).toStrictEqual(expect.arrayContaining(broken));
    expect(result.imported).toContain(good.id);
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
    for (let count = 0; count <= MAX_IMPORTS_PER_RUN; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      published.push(await publishRelease({ notes: `feat(core): ${count}` }));
    }
    const [oldest, ...newest] = published.map((release) => release.id);

    const first = await runImport();

    expect(first.imported).toStrictEqual(newest.toReversed());
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
    const store: ReleaseStore = {
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

    // The second attempt's wait is ten minutes.
    await expect(failureRow(broken)).resolves.toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(now.getTime() + 10 * MINUTE),
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

  it("stops a run before a release whose reads don't fit, and imports it next run", async () => {
    // Each release reads a third of the budget and a little more: a run
    // has room for two.
    const assetCount = Math.floor(MAX_READS_PER_RUN / 3);
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

  it("imports a release of 700 blobs a batch a run, reading each blob once", async () => {
    const release = await largeRelease("feat(core): 700 blobs");
    const { store, reads } = countingStore();

    const first = await runImport(store);
    // Every read of the run, each manifest's and blob's alike.
    const readFirst = allReads(reads);
    const second = await runImport(store);
    const readSecond = allReads(reads) - readFirst;
    const blobReads = blobReadsOf(reads);

    expect({
      first: first.imported.includes(release.id),
      firstFailed: first.failed.includes(release.id),
      firstWithinReads: readFirst <= MAX_READS_PER_RUN,
      secondWithinReads: readSecond <= MAX_READS_PER_RUN,
      second: second.imported.includes(release.id),
      everyBlobOnce: blobReads.every((count) => count === 1),
      blobs: blobReads.length,
    }).toStrictEqual({
      first: false,
      firstFailed: false,
      firstWithinReads: true,
      secondWithinReads: true,
      second: true,
      everyBlobOnce: true,
      blobs: release.blobs.size,
    });
    await expect(importEvents(release.id)).resolves.toHaveLength(1);
  });

  it("checks a release from its first blob again once its manifest was replaced partway", async () => {
    const assets = largeAssets(crypto.randomUUID());
    const release = await publishRelease({
      notes: "feat(core): before",
      assets,
    });
    const { store, reads } = countingStore();
    const first = await runImport(store);
    // The blobs the first run checked, before the manifest changed.
    const checked = [...release.blobs.keys()].filter(
      (key) => (reads.get(key) ?? 0) === 1
    );
    // Another manifest under the same id: the same blobs, another note.
    const replaced = await buildRelease(
      { notes: "feat(core): after", assets },
      release.id
    );
    await putManifest(replaced);

    const second = await runImport(store);
    const third = await runImport(store);
    const row = await releaseRow(release.id);

    expect({
      first: first.imported.includes(release.id),
      checkedSome: checked.length > 0,
      // Each read again, so checked from the start, and not imported yet.
      readAgain: checked.every((key) => reads.get(key) === 2),
      second: second.imported.includes(release.id),
      third: third.imported.includes(release.id),
      note: row?.manifest.includes("feat(core): after"),
    }).toStrictEqual({
      first: false,
      checkedSome: true,
      readAgain: true,
      second: false,
      third: true,
      note: true,
    });
  });

  it("fails a large release on a blob in a later batch, and checks it from its first blob next attempt", async () => {
    const release = await largeRelease("feat(core): 700 blobs, one broken");
    const [lastKey, lastBytes] = [...release.blobs].at(-1) ?? [];
    if (lastKey === undefined || lastBytes === undefined) {
      throw new Error("expected a blob");
    }
    await env.RELEASES.put(
      lastKey,
      sameSizeOther(new TextDecoder().decode(lastBytes))
    );

    const first = await runImport();
    const second = await runImport();
    expect(second.failed).toContain(release.id);
    expect(first.failed).not.toContain(release.id);

    await env.RELEASES.put(lastKey, lastBytes);
    const { store, reads } = countingStore();
    await runImport(store, { now: inMinutes(10) });
    const third = await runImport(store, { now: inMinutes(10) });

    expect(third.imported).toContain(release.id);
    expect(blobReadsOf(reads)).toHaveLength(release.blobs.size);
  });

  it("reads the whole listing, a page at a time", async () => {
    const release = await publishRelease({ notes: "feat(core): paged" });
    const pages: string[] = [];
    // The real bucket, one release per page.
    const store: ReleaseStore = {
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

  it("runs on the admin's cron", async () => {
    const release = await publishRelease({ notes: "feat(core): cron" });

    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      env
    );

    await expect(releaseRow(release.id)).resolves.toBeDefined();
  });
});

describe("importing a release that raises a platform limit", () => {
  /** A published, imported release with `testLimits`: what the next ones raise over. */
  const importedPrevious = async () => {
    const previous = await publishRelease({ notes: "feat(core): before" });
    await runImport();
    await expect(releaseRow(previous.id)).resolves.toBeDefined();
    return { releaseId: previous.id, platformLimits: testLimits };
  };

  const raised = { ...testLimits, workflowSteps: 2000 };

  it("refuses one without evidence, with evidence made for another commit, release or capacity run, or for another value", async () => {
    const previousRelease = await importedPrevious();
    const otherCommit = "f".repeat(40);
    const refused = await Promise.all(
      [
        () => [],
        (release: { id: string; commit: string }) => [
          evidenceFor(
            { ...release, commit: otherCommit },
            "workflowSteps",
            2000
          ),
        ],
        (release: { id: string; commit: string }) => [
          evidenceFor(
            { ...release, id: previousRelease.releaseId },
            "workflowSteps",
            2000
          ),
        ],
        (release: { id: string; commit: string }) => [
          {
            ...evidenceFor(release, "workflowSteps", 2000),
            capacityRun: {
              jobId: 1,
              commit: otherCommit,
              profile: "cloudflare" as const,
            },
          },
        ],
        (release: { id: string; commit: string }) => [
          evidenceFor(release, "workflowSteps", 1500),
        ],
      ].map(
        async (limitEvidence, index) =>
          await publishRelease({
            notes: `feat(core): raised ${index}`,
            platformLimits: raised,
            previousRelease,
            limitEvidence,
          })
      )
    );

    const result = await runImport();

    const ids = refused.map((release) => release.id);
    expect(result.failed).toStrictEqual(expect.arrayContaining(ids));
    const rows = await Promise.all(ids.map(releaseRow));
    expect(rows.filter((row) => row !== undefined)).toStrictEqual([]);
    const failures = await Promise.all(
      ids.map(async (id) => await eventsFor("release.import_failed", id))
    );
    expect(failures.map((events) => events.length)).toStrictEqual(
      ids.map(() => 1)
    );
  });

  it("refuses one that raises over other limits than the release it names as previous has", async () => {
    const previousRelease = await importedPrevious();
    // Claims the raise was already there, so it would need no evidence.
    const hiding = await publishRelease({
      notes: "feat(core): hides a raise",
      platformLimits: raised,
      previousRelease: { ...previousRelease, platformLimits: raised },
    });

    const result = await runImport();

    expect(result.failed).toContain(hiding.id);
    await expect(releaseRow(hiding.id)).resolves.toBeUndefined();
  });

  it("refuses one that names a release built after it as previous", async () => {
    const early = await buildRelease({ notes: "feat(core): built first" });
    const later = await publishRelease({ notes: "feat(core): built later" });
    await runImport();
    const named = await buildRelease(
      {
        notes: "feat(core): names a later one",
        previousRelease: {
          releaseId: later.id,
          platformLimits: testLimits,
        },
      },
      early.id
    );
    await putBlobs(named);
    await putManifest(named);

    const result = await runImport();

    expect(result.failed).toContain(named.id);
  });

  it("imports one whose evidence is its own, and audits what it raises on which profiles", async () => {
    const previousRelease = await importedPrevious();
    const release = await publishRelease({
      notes: "feat(core): raised with evidence",
      platformLimits: raised,
      previousRelease,
      limitEvidence: (own) => [
        evidenceFor(own, "workflowSteps", 2000, "cloudflare"),
        evidenceFor(own, "workflowSteps", 2000, "workerd"),
      ],
    });

    const result = await runImport();

    expect(result.imported).toContain(release.id);
    const [event] = await importEvents(release.id);
    expect(JSON.parse(event?.detail ?? "{}")).toMatchObject({
      raised: "workflowSteps to 2000 on cloudflare+workerd",
    });
  });
});

describe("a release's limit evidence file", () => {
  it("is read once and checked before anything is stored: missing, unrecorded by R2, or another release's file refuses the import", async () => {
    const missing = await buildRelease({ notes: "feat(core): no evidence" });
    await putBlobs(missing);
    await env.RELEASES.put(manifestKey(missing.id), missing.manifestText);
    const unrecorded = await buildRelease({
      notes: "feat(core): evidence R2 didn't check",
    });
    await putBlobs(unrecorded);
    await env.RELEASES.put(
      limitEvidenceKey(unrecorded.id),
      unrecorded.limitEvidenceText ?? ""
    );
    await env.RELEASES.put(manifestKey(unrecorded.id), unrecorded.manifestText);
    const other = await buildRelease({ notes: "feat(core): another's file" });
    const borrowing = await buildRelease({
      notes: "feat(core): borrows a file",
    });
    await putBlobs(borrowing);
    await putLimitEvidence({
      id: borrowing.id,
      limitEvidenceText: other.limitEvidenceText,
    });
    await env.RELEASES.put(manifestKey(borrowing.id), borrowing.manifestText);
    const ids = [missing.id, unrecorded.id, borrowing.id];

    const result = await runImport();
    const rows = await Promise.all(ids.map(releaseRow));

    expect({
      failed: ids.filter((id) => result.failed.includes(id)),
      stored: rows.filter((row) => row !== undefined),
    }).toStrictEqual({ failed: ids, stored: [] });
  });

  it("is recorded with the release and its sha256, in the import's audit event", async () => {
    const release = await publishRelease({ notes: "feat(core): evidenced" });

    await runImport();
    const row = await releaseRow(release.id);
    const [event] = await importEvents(release.id);
    const sha256 = await sha256OfBytes(
      new TextEncoder().encode(release.limitEvidenceText ?? "")
    );

    expect({
      text: row?.limitEvidence,
      sha256: row?.limitEvidenceSha256,
      audited: (event?.detail ?? "").includes(
        `"limitEvidenceSha256":"${sha256}"`
      ),
    }).toStrictEqual({
      text: release.limitEvidenceText,
      sha256,
      audited: true,
    });
  });

  it("is taken with the SHA-256 CI also gives in its metadata, where R2 doesn't report its checksum to a Worker", async () => {
    const release = await buildRelease({ notes: "feat(core): metadata only" });
    await putBlobs(release);
    const bytes = new TextEncoder().encode(release.limitEvidenceText ?? "");
    await env.RELEASES.put(limitEvidenceKey(release.id), bytes, {
      customMetadata: { sha256: await sha256OfBytes(bytes) },
    });
    await env.RELEASES.put(manifestKey(release.id), release.manifestText);
    const forged = await buildRelease({ notes: "feat(core): wrong metadata" });
    await putBlobs(forged);
    await env.RELEASES.put(
      limitEvidenceKey(forged.id),
      forged.limitEvidenceText ?? "",
      { customMetadata: { sha256: "0".repeat(64) } }
    );
    await env.RELEASES.put(manifestKey(forged.id), forged.manifestText);

    const result = await runImport();

    expect({
      imported: result.imported.includes(release.id),
      refused: result.failed.includes(forged.id),
    }).toStrictEqual({ imported: true, refused: true });
  });

  it("isn't needed by a release built before limits were recorded", async () => {
    const release = await publishRelease({
      notes: "feat(core): from before limits",
      platformLimits: null,
    });

    const result = await runImport();

    expect(result.imported).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toMatchObject({
      limitEvidence: null,
      limitEvidenceSha256: null,
    });
  });
});
