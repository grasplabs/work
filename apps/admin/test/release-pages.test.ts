import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { releases } from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { RELEASE_LIST_LIMIT } from "../src/releases/queries.ts";
import { mockAccess } from "./access.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
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
      // Its id is still there, under its name, with its commit beside it.
      id: html.includes(
        `>${second.id} · ${second.manifest.commit.slice(0, 7)}</span>`
      ),
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
        "/platform/releases/25.12.1",
        "/platform/releases/not-a-release",
        `/platform/releases/diff?from=${first.id}&to=25.12.1`,
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
