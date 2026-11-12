import { env } from "cloudflare:workers";
import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { channels, clientProvisions, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { releaseToEdge } from "./edge.ts";
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

/** An active client on Stable running `releaseId`, as a deploy made it live. */
const liveClient = async (name: string, releaseId: string) => {
  const clientId = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const { core } = await livePlacedClient(cloudflare, releaseId, {
    id: clientId,
    name,
    signIn: null,
  });
  core.admin = emptyAdminSnapshot(name);
  return clientId;
};

describe("the admin's Platform page", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
    await db.delete(channels);
  });

  it("shows the channels with every company under its own, and apart the one whose deploy failed", async () => {
    const older = await placedRelease("feat(core): the older");
    const newest = await placedRelease("feat(core): the newest");
    const first = await liveClient("Firstco", newest);
    await liveClient("Earlyco", older);
    const failing = await liveClient("Laggard", older);
    await releaseToEdge(env, [newest]);
    // Its operation's latest run failed, as the grid reads it.
    await db
      .update(clientProvisions)
      .set({ status: "failed", error: "cloudflare_400_10000" })
      .where(eq(clientProvisions.clientId, failing));

    const { status, html } = await page("/platform");
    const text = textOf(html);
    const at = html.indexOf('aria-label="Needs a look"');
    const needsALook =
      at === -1 ? "" : textOf(html.slice(at, html.indexOf("</section>", at)));

    expect({
      status,
      edge: html.includes(`href="/platform/releases/${newest}"`),
      stableWaits: text.includes(
        "No release yet. Promote a release to Stable first"
      ),
      laggardFailed: needsALook.includes(`Its last deploy failed (${older}).`),
      // Only the one that needs a look is listed apart: the others stand under their channel.
      onlyLaggard:
        needsALook.includes("Laggard") &&
        !needsALook.includes("Earlyco") &&
        !needsALook.includes("Firstco"),
      opensSetup: html.includes(`href="/organizations/${first}/setup"`),
      // Its releases have a page of their own under it.
      releases: html.includes('href="/platform/releases"'),
    }).toStrictEqual({
      status: 200,
      edge: true,
      stableWaits: true,
      laggardFailed: true,
      onlyLaggard: true,
      opensSetup: true,
      releases: true,
    });
  });

  it("lists what staff did, and counts beside Platform the companies that need a look", async () => {
    const release = await placedRelease("feat(core): runs");
    await liveClient("Fineco", release);
    const failing = await liveClient("Laggard", release);
    await db
      .update(clientProvisions)
      .set({ status: "failed", error: "cloudflare_400_10000" })
      .where(eq(clientProvisions.clientId, failing));

    const { html } = await page("/platform/maintenance");
    const text = textOf(html);

    expect({
      // What staff did, as the audit log keeps it: adding a company, never a deploy's steps.
      doneHere: text
        .slice(text.indexOf("Done here"))
        .includes("staff@grasp.test added Laggard"),
      sidebarCount: text.includes("1 company needs a look"),
    }).toStrictEqual({ doneHere: true, sidebarCount: true });
  });
});
