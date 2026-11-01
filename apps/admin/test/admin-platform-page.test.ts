import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { clients, rollouts, rolloutTargets } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-platform-4e9a17";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const tags = /<[^>]*>/gu;
const spaces = /\s+/gu;

/** `html` as words, its tags gone. */
const textOf = (html: string): string =>
  html.replaceAll(tags, " ").replaceAll("&#x27;", "'").replaceAll(spaces, " ");

/** How many times `text` appears in `html`. */
const count = (html: string, text: string): number =>
  html.split(text).length - 1;

/** The part of the page a panel titled `title` holds: from its title to the next panel's. */
const panelOf = (text: string, title: string, next: string): string =>
  text.slice(text.indexOf(title), text.indexOf(next, text.indexOf(title) + 1));

/** An active client in ring `ring` running `releaseId`, as a deploy made it live. */
const liveClient = async (name: string, ring: number, releaseId: string) => {
  const clientId = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, ring, releaseId, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot(name);
  return clientId;
};

describe("the admin's Platform page", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows the rollout waiting after Alpha with its approval of Beta, who runs which release, and every company with the one on an old release needing a look first", async () => {
    const oldest = await placedRelease("feat(core): the oldest");
    const older = await placedRelease("feat(core): the older");
    const newest = await placedRelease("feat(core): the newest");
    const first = await liveClient("Firstco", 0, newest);
    const early = await liveClient("Earlyco", 1, older);
    await liveClient("Laggard", 2, oldest);
    const rolloutId = crypto.randomUUID();
    const now = new Date();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "release",
      releaseId: newest,
      status: "waiting",
      ring: 0,
      startedBy: "ops@grasp.test",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(rolloutTargets).values([
      { rolloutId, clientId: first, ring: 0, status: "done", updatedAt: now },
      {
        rolloutId,
        clientId: early,
        ring: 1,
        status: "pending",
        updatedAt: now,
      },
    ]);

    const { status, html } = await page("/platform");
    const text = textOf(html);
    const goingOut = panelOf(text, "Going out now", "Who runs what");
    const spread = panelOf(text, "Who runs what", "Every company");
    // After the page's own line, which starts with the same words.
    const companies = text.slice(
      text.indexOf("Every company", text.indexOf("Who runs what"))
    );

    expect({
      status,
      release: goingOut.includes(`Going out now: ${newest}`),
      // A waiting rollout is approved from here, as on its own page.
      approve: goingOut.includes("Approve Beta"),
      ring0: goingOut.includes("Alpha"),
      firstOnIt: goingOut.includes("Firstco Alpha On it"),
      earlyWaits: goingOut.includes("Earlyco Beta Waits"),
      laggardBehind: companies.includes("2 releases behind the newest."),
      // The one that needs a look comes before the healthy ones.
      laggardFirst:
        companies.indexOf("Laggard") < companies.indexOf("Earlyco") &&
        companies.indexOf("Laggard") < companies.indexOf("Firstco"),
      opensSetup: html.includes(`href="/organizations/${first}/setup"`),
      // The rollout, each release and starting one open their own pages under Platform.
      opensRollout: html.includes(`href="/platform/rollouts/${rolloutId}"`),
      opensRelease: html.includes(`href="/platform/releases/${older}"`),
      startsRollout: html.includes('href="/platform/rollouts#start-a-rollout"'),
      // Its releases and rollouts, under it in the sidebar and the page.
      underPlatform: [
        count(html, 'href="/platform/releases"'),
        count(html, 'href="/platform/rollouts"'),
      ],
      // What staff did, as the audit log keeps it: adding a company, never a deploy's steps.
      doneHere: text
        .slice(text.indexOf("Done here"))
        .includes("staff@grasp.test added Laggard"),
      // Beside Platform in the sidebar: the laggard, and the waiting rollout.
      sidebarCount: text.includes(
        "1 company needs a look; a rollout waits for approval"
      ),
    }).toMatchObject({
      status: 200,
      release: true,
      approve: true,
      ring0: true,
      firstOnIt: true,
      earlyWaits: true,
      laggardBehind: true,
      laggardFirst: true,
      opensSetup: true,
      opensRollout: true,
      opensRelease: true,
      startsRollout: true,
      underPlatform: [2, 2],
      doneHere: true,
      sidebarCount: true,
    });
    const [a, b, c] = [
      spread.indexOf(newest),
      spread.indexOf(older),
      spread.indexOf(oldest),
    ];
    // The newest release first.
    expect(a >= 0 && a < b && b < c).toBeTruthy();
  });
});
