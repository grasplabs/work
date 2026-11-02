import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { channels, releases } from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { RELEASE_LIST_LIMIT } from "../src/releases/queries.ts";
import { promoteRelease, releaseToEdge } from "../src/rollout/channels.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { staff } from "./hosting.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { publishRelease } from "./releases.ts";
import type { TestRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-release-pages-91c3e0";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const tags = /<[^>]*>/gu;
const spaces = /\s+/gu;

/** `html` as words, its tags gone. */
const textOf = (html: string): string =>
  html.replaceAll(tags, " ").replaceAll("&#x27;", "'").replaceAll(spaces, " ");

/** The list's row for release `id`, as words: from its link to the next row. */
const rowOf = (html: string, id: string): string => {
  const start = html.indexOf(`href="/platform/releases/${id}"`);
  const end = html.indexOf("<tr", start);
  return textOf(html.slice(start, end === -1 ? undefined : end));
};

describe("the release pages", () => {
  useStoreSecrets({ deployer: token });
  let first: TestRelease;
  let second: TestRelease;
  let third: TestRelease;

  beforeAll(async () => {
    const tag = crypto.randomUUID();
    first = await publishRelease({ notes: `feat(core): first ${tag}` });
    second = await publishRelease({ notes: `feat(core): second ${tag}` });
    third = await publishRelease({ notes: `fix(connect): third ${tag}` });
    await importReleases(env.RELEASES, db);
    await db.delete(channels);
    // The first went to Edge, then Beta; the third reached Edge after it.
    await releaseToEdge(env, [first.id]);
    await promoteRelease(env, staff, { channel: "beta", releaseId: first.id });
    await releaseToEdge(env, [third.id]);
  });

  it("list every imported release, newest first, by what it holds, with the channels each has been on", async () => {
    const { status, html } = await page("/platform/releases");
    const positions = [third, second, first].map((release) =>
      html.indexOf(`href="/platform/releases/${release.id}"`)
    );
    const tag = second.manifest.notes.slice("feat(core): second ".length);

    expect({
      status,
      listed: positions.every((position) => position >= 0),
      newestFirst:
        JSON.stringify(positions) ===
        JSON.stringify(positions.toSorted((a, b) => a - b)),
      // Its note without its commit type.
      titled: rowOf(html, third.id).includes(`Third ${tag}`),
      channels: [first, second, third].map((release) => {
        const row = rowOf(html, release.id);
        return { edge: row.includes(" Edge "), beta: row.includes(" Beta ") };
      }),
    }).toStrictEqual({
      status: 200,
      listed: true,
      newestFirst: true,
      titled: true,
      channels: [
        { edge: true, beta: true },
        { edge: false, beta: false },
        { edge: true, beta: false },
      ],
    });
  });

  it("show a release: what it holds, the channels it was on, who runs it, and its record", async () => {
    const release = await placedRelease("feat(core): run by one");
    const { clientId } = await livePlacedClient(cloudflare, release, {
      name: "Runnerco",
    });
    await releaseToEdge(env, [release]);

    const { status, html } = await page(`/platform/releases/${release}`);
    const text = textOf(html);
    const record = await db
      .select({ commitSha: releases.commitSha })
      .from(releases)
      .where(eq(releases.id, release))
      .get();

    expect({
      status,
      holds: text.includes("feat(core): run by one"),
      channel: text.includes("Edge, by system"),
      runs: html.includes(`href="/organizations/${clientId}/setup"`),
      runner: text.includes("Runnerco"),
      commit: text.includes(record?.commitSha ?? "no commit"),
      bundle: text.includes("Bundle Kept"),
    }).toStrictEqual({
      status: 200,
      holds: true,
      channel: true,
      runs: true,
      runner: true,
      commit: true,
      bundle: true,
    });
  });

  it("answer 404 for a release that isn't imported, or isn't a release id", async () => {
    const statuses = await Promise.all(
      ["/platform/releases/25.12.1", "/platform/releases/not-a-release"].map(
        async (path) => {
          const { status } = await page(path);
          return status;
        }
      )
    );

    expect(statuses).toStrictEqual([404, 404]);
  });

  it("say when there are more releases than the list shows", async () => {
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
  });
});
