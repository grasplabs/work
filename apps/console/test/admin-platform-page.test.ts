import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients, rollouts, rolloutTargets } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-platform-4e9a17";
const tenantToken = "test-tenant-admin-token-admin-platform-7c2b58";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };
const tags = /<[^>]*>/gu;
const spaces = /\s+/gu;

/** `html` as words, its tags gone. */
const textOf = (html: string): string =>
  html.replaceAll(tags, " ").replaceAll("&#x27;", "'").replaceAll(spaces, " ");

/** The part of the page a panel titled `title` holds: from its title to the next panel's. */
const panelOf = (text: string, title: string, next: string): string =>
  text.slice(text.indexOf(title), text.indexOf(next, text.indexOf(title) + 1));

/** An active client in ring `ring` running `releaseId`, as a deploy made it live. */
const liveClient = async (name: string, ring: number, releaseId: string) => {
  const clientId = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(name);
  account.admin = emptyAdminSnapshot(name);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        accountId: account.id,
        ring,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, releaseId)
  );
  return clientId;
};

describe("the admin's Platform page", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows the rollout waiting after ring 0 with its approval, who runs which release, and every company with the one on an old release needing a look first", async () => {
    const oldest = await publishRelease({ notes: "feat(core): the oldest" });
    const older = await publishRelease({ notes: "feat(core): the older" });
    const newest = await publishRelease({ notes: "feat(core): the newest" });
    await importReleases(env.RELEASES, db);
    const first = await liveClient("Firstco", 0, newest.id);
    const early = await liveClient("Earlyco", 1, older.id);
    await liveClient("Laggard", 2, oldest.id);
    const rolloutId = crypto.randomUUID();
    const now = new Date();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "release",
      releaseId: newest.id,
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

    const { status, html } = await page("/admin/platform");
    const text = textOf(html);
    const goingOut = panelOf(text, "Going out now", "Who runs what");
    const spread = panelOf(text, "Who runs what", "Every company");
    // After the page's own line, which starts with the same words.
    const companies = text.slice(
      text.indexOf("Every company", text.indexOf("Who runs what"))
    );

    expect({
      status,
      release: goingOut.includes(`Going out now: ${newest.id}`),
      // A waiting rollout is approved from here, as on its own page.
      approve: goingOut.includes("Approve ring 1"),
      ring0: goingOut.includes("Ring 0, first"),
      firstOnIt: goingOut.includes("Firstco Ring 0, first On it"),
      earlyWaits: goingOut.includes("Earlyco Ring 1, early Waits"),
      laggardBehind: companies.includes("2 releases behind the newest."),
      // The one that needs a look comes before the healthy ones.
      laggardFirst:
        companies.indexOf("Laggard") < companies.indexOf("Earlyco") &&
        companies.indexOf("Laggard") < companies.indexOf("Firstco"),
      opensSetup: html.includes(`href="/admin/organizations/${first}/setup"`),
      // What staff did, as the audit log keeps it: adding a company, never a deploy's steps.
      doneHere: text
        .slice(text.indexOf("Done here"))
        .includes("ops@grasp.test added Laggard"),
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
      doneHere: true,
    });
    const [a, b, c] = [
      spread.indexOf(newest.id),
      spread.indexOf(older.id),
      spread.indexOf(oldest.id),
    ];
    // The newest release first.
    expect(a >= 0 && a < b && b < c).toBeTruthy();
  });
});
