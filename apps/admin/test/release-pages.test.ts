import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { fetchAlerts } from "../src/alert-inbox.ts";
import {
  alertKinds,
  importAlertAttempts,
  sendStaffAlert,
} from "../src/alerts.ts";
import { adminDatabase } from "../src/db/act.ts";
import { releaseImportFailures, releases } from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { RELEASE_LIST_LIMIT } from "../src/releases/queries.ts";
import worker from "../src/server.ts";
import { mockAccess } from "./access.ts";
import { callServerFn, page } from "./pages.ts";
import {
  buildRelease,
  publishRelease,
  putBlobs,
  putManifest,
} from "./releases.ts";
import type { TestRelease } from "./releases.ts";

mockAccess();

// React escapes text, so compare with it escaped the same way.
const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

describe("the release pages", () => {
  let first: TestRelease;
  let second: TestRelease;
  let third: TestRelease;

  beforeAll(async () => {
    const token = crypto.randomUUID();
    first = await publishRelease({
      notes: `feat(core): first ${token}`,
      migrations: { "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);` },
      assets: { "/index.html": `<html>${token}</html>` },
    });
    second = await publishRelease({
      notes: `feat(core): second ${token}`,
      migrations: {
        "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);`,
        "0001_more.sql": `-- ${token}\nCREATE TABLE b (id TEXT);`,
      },
      assets: { "/index.html": `<html>${token} two</html>` },
    });
    third = await publishRelease({
      notes: `fix(connect): third ${token}`,
      connect: `export default { token: "${token}" };`,
      migrations: {
        "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);`,
        "0001_more.sql": `-- ${token}\nCREATE TABLE b (id TEXT);`,
      },
      assets: {
        "/index.html": `<html>${token} two</html>`,
        "/app.js": `console.info("${token}");`,
      },
      packages: { zod: "4.1.0" },
      crons: ["*/15 * * * *"],
    });
    await importReleases(env.RELEASES, adminDatabase(env.DB));
  });

  it("list every imported release by its version and what it holds, newest first", async () => {
    const { status, html } = await page("/platform/releases");

    expect(status).toBe(200);
    const positions = [third, second, first].map((release) =>
      html.indexOf(release.id)
    );
    expect(positions.every((position) => position >= 0)).toBeTruthy();
    expect(positions).toStrictEqual(positions.toSorted((a, b) => a - b));
    const token = second.manifest.notes.slice("feat(core): second ".length);
    // A feature starts the next major, the fix after it is that major's
    // first minor: counted in the order they were built, whatever order
    // the import took them in.
    const major = new RegExp(`v(\\d+)\\.0 · Second ${token}`, "u").exec(
      html
    )?.[1];
    const own = await page(`/platform/releases/${third.id}`);
    expect({
      second: major !== undefined,
      third: html.includes(`v${major ?? "?"}.1 · Third ${token}`),
      first: html.includes(`v${Number(major) - 1}.0 · First ${token}`),
      // Its id is still there, under its name.
      id: html.includes(`>${second.id}</span>`),
      // The same version on its own page, read alone.
      own: own.html.includes(`>v${major ?? "?"}.1</h1>`),
    }).toStrictEqual({
      second: true,
      third: true,
      first: true,
      id: true,
      own: true,
    });
  });

  it("show a release's Workers, modules and migrations", async () => {
    const { status, html } = await page(`/platform/releases/${second.id}`);

    expect(status).toBe(200);
    for (const text of [
      second.manifest.notes,
      second.manifest.commit,
      "grasp-os-core",
      "grasp-os-connect",
      "index.js",
      `${second.manifest.workers.core?.modules[0]?.size} B`,
      "0001_more.sql",
    ]) {
      expect(html).toContain(escaped(text));
    }
  });

  it("show what changed between two releases, with the notes in between", async () => {
    const { status, html } = await page(
      `/platform/releases/diff?from=${first.id}&to=${third.id}`
    );

    expect(status).toBe(200);
    const notes = html.slice(
      html.indexOf("Release notes"),
      html.indexOf("Compatibility date and packages")
    );
    expect(notes).toContain(escaped(second.manifest.notes));
    expect(notes).toContain(escaped(third.manifest.notes));
    expect(notes).not.toContain(escaped(first.manifest.notes));
    for (const change of [
      "DB/0001_more.sql",
      "/app.js",
      "/index.html",
      "cron */15 * * * *",
      "cron * * * * *",
      "4.0.0 to 4.1.0",
    ]) {
      expect(html).toContain(escaped(change));
    }
  });

  it("answer 404 for a release that isn't imported, or isn't a release id", async () => {
    const statuses = await Promise.all(
      [
        "/platform/releases/r000000-0000000",
        "/platform/releases/not-a-release",
        `/platform/releases/diff?from=${first.id}&to=r000000-0000000`,
        "/platform/releases/diff?from=..&to=x",
      ].map(async (path) => {
        const { status } = await page(path);
        return status;
      })
    );

    expect(statuses).toStrictEqual([404, 404, 404, 404]);
  });

  it("say when there are more releases than the list or the notes show", async () => {
    const db = adminDatabase(env.DB);
    const ids = Array.from(
      { length: RELEASE_LIST_LIMIT + 1 },
      (_, index) => `dev-old${index}x${crypto.randomUUID().slice(0, 8)}`
    );
    const [statement, ...statements] = ids.map((id, index) =>
      db.insert(releases).values({
        id,
        commitSha: "0".repeat(40),
        manifest: first.manifestText,
        manifestSha256: "0".repeat(64),
        // Older than every release the other tests show.
        builtAt: new Date(Date.UTC(2000, 0, 1, 0, index)),
        importedAt: new Date(),
      })
    );
    if (statement === undefined) {
      throw new Error("expected rows to insert");
    }
    await db.batch([statement, ...statements]);

    const { html } = await page("/platform/releases");

    expect(html).toContain(`The newest ${RELEASE_LIST_LIMIT} releases.`);
    // The list shows the newest 97 old ones (and the three above): its
    // last row links to the diff from the one before it, which isn't shown.
    // Named by its version. Recorded without the feature flag, as an older
    // admin records them, each still counts as the feature its note says:
    // the fourth oldest of all is the fourth major.
    expect(html).toContain(`?from=${ids[3]}&amp;to=${ids[4]}">Since v4.0<`);

    // From the oldest: the other 100 old ones and the three above lie
    // between, and the notes show the newest 100 of them.
    const diff = await page(
      `/platform/releases/diff?from=${ids[0]}&to=${third.id}`
    );
    expect(diff.status).toBe(200);
    expect(diff.html).toContain("and 3 more");
  });
});

/** Runs the admin's import cron once, the failures it logs kept out of the test output. */
const importCron = async (): Promise<void> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // A failed import is logged; the test reads the page and the inbox.
  });
  try {
    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      env
    );
  } finally {
    errors.mockRestore();
  }
};

/** The open alerts about release `releaseId`'s import, as the inbox lists them. */
const importAlertsOf = async (releaseId: string) => {
  const open = await callServerFn(fetchAlerts);
  return open
    .filter(
      (alert) =>
        alert.kind === "release_import_failing" && alert.subject === releaseId
    )
    .map(({ clientId, title, words, page: to }) => ({
      clientId,
      title,
      words,
      to: to.to,
    }));
};

describe("a release the import can't verify", () => {
  it("is listed on Releases with why, and raises an alert once it failed again and again, resolved once it imports", async () => {
    const release = await buildRelease({
      notes: "feat(core): its migration is missing for a while",
      migrations: {
        "0000_only.sql": `-- ${crypto.randomUUID()}\nCREATE TABLE t (id TEXT);`,
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
    const db = adminDatabase(env.DB);
    const dueNow = async () => {
      await db
        .update(releaseImportFailures)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(releaseImportFailures.releaseId, release.id));
    };

    await importCron();
    const once = await page("/platform/releases");
    const alertedOnce = await importAlertsOf(release.id);
    for (let attempt = 1; attempt < importAlertAttempts; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- attempts in order
      await dueNow();
      // oxlint-disable-next-line no-await-in-loop -- attempts in order
      await importCron();
    }
    const alerted = await importAlertsOf(release.id);
    await env.RELEASES.put(key, bytes);
    await dueNow();
    await importCron();
    const after = await page("/platform/releases");

    expect({
      listed: once.html.includes(release.id),
      why: once.html.includes(key),
      alertedOnce,
      alerted,
      afterImport: await importAlertsOf(release.id),
      listedAfter: after.html.includes("Not imported yet"),
    }).toStrictEqual({
      listed: true,
      why: true,
      alertedOnce: [],
      alerted: [
        {
          clientId: null,
          title: "Release import failing",
          words: alertKinds.release_import_failing.words({
            attempts: importAlertAttempts,
          }),
          to: "releases",
        },
      ],
      afterImport: [],
      listedAfter: false,
    });
  });

  it("resolves an open import alert once its release is imported, whichever run imported it", async () => {
    const release = await publishRelease({
      notes: "feat(core): imported while its alert stayed open",
    });
    await importCron();
    // An alert the run that imported it didn't clear.
    await sendStaffAlert(env, {
      clientId: null,
      kind: "release_import_failing",
      subject: release.id,
      numbers: { attempts: importAlertAttempts },
    });
    const before = await importAlertsOf(release.id);

    await importCron();

    expect({
      before: before.length,
      after: await importAlertsOf(release.id),
    }).toStrictEqual({ before: 1, after: [] });
  });
});
