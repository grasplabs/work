import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setRing } from "../src/clients/settings.ts";
import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-setup-5c1e90";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/**
 * An active client running a new release, as a deploy made it live, whose
 * core answers the admin with `snapshot`.
 */
const liveClient = async (snapshot: AdminSnapshot) => {
  const release = await placedRelease("feat(core): the setup");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Acme ${clientId}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = snapshot;
  return { clientId, name, account, release };
};

/** A link into the company's own Grasp, to its audit trail. */
const toItsAuditTrail = /href="https:\/\/[^"/]+\/settings\/audit"/u;

/** The part of a page titled `title`: from its label to its end. */
const sectionOf = (html: string, title: string): string => {
  const at = html.indexOf(`aria-label="${title}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
};

/** `html` without its tags, so words split by markup read as one line. */
const textOf = (html: string): string =>
  html.replaceAll(/<[^>]+>/gu, "").replaceAll("&#x27;", "'");

describe("an organization's Setup", () => {
  useStoreSecrets({ deployer: token });
  // The newest release is each test's own: an earlier test's clients are
  // gone from the fake, and are offboarded so nothing counts them.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows a company's own platform as the admin runs it, tab by tab", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const base = `/organizations/${acme.clientId}/setup`;

    const status = await page(base);
    const history = await page(`${base}?tab=history`);
    const resources = await page(`${base}?tab=resources`);
    const releases = await page(`${base}?tab=releases`);
    const settings = await page(`${base}?tab=settings`);
    const header = textOf(sectionOf(status.html, "How it stands"));
    const checklist = textOf(sectionOf(status.html, "From contract to go"));
    const howItRuns = textOf(sectionOf(status.html, "How it runs"));
    const quotaPolicy = textOf(sectionOf(status.html, "Quota policy"));

    expect({
      statuses: [status, history, resources, releases, settings].map(
        (each) => each.status
      ),
      header: [
        `${acme.clientId}.`,
        "Healthy",
        acme.release,
        "Beta",
        "Open its Grasp",
        "Its activity",
      ].map((text) => header.includes(text)),
      // Its activity is the audit trail in its own Grasp.
      activity: toItsAuditTrail.test(sectionOf(status.html, "How it stands")),
      // Nothing of it is left to the old client pages.
      toOldPages: status.html.includes('href="/clients/'),
      // Nothing needs a look on a company that runs the newest release.
      needs: status.html.includes("What needs a look"),
      // Its numbers aren't kept day by day: said, not made up, and its
      // account's now read once the page shows.
      numbers: [
        "The admin doesn’t keep these day by day yet.",
        "Reading its account…",
      ].map((text) =>
        sectionOf(status.html, "Its platform in numbers").includes(text)
      ),
      // Its core asked which quota policy it applies: the platform's own,
      // as the admin sets none.
      quotaPolicy: [
        "In sync",
        "Core applies the platform's own, as the admin sets.",
        "The admin sets no policy",
      ].map((text) => quotaPolicy.includes(text)),
      howItRuns: [
        "Router",
        "Core",
        "Connect",
        "grasp-os-core",
        "grasp-os-files",
        "AI Gateway",
      ].map((text) => howItRuns.includes(text)),
      // Deployed by the admin, and the contract not held by core yet.
      checklist: [
        "Its own platform is deployed",
        "From Rooms, once it is connected.",
        "1 of 6 in place.",
      ].map((text) => checklist.includes(text)),
      deployed: checklist.includes(
        "Its own platform is deployed, in its own Cloudflare account in the EU: done"
      ),
      history: {
        kept: history.html.includes('aria-label="Its history"'),
        settingUp: history.html.includes("Setting it up"),
      },
      resources: [
        "grasp-os-core",
        "grasp-os-connect",
        "grasp-os-knowledge",
        "grasp-os-audit-archive",
        "Read what runs",
      ].map((text) => resources.html.includes(text)),
      releases: {
        follows: releases.html.includes("Follows the rollouts"),
        runs: textOf(sectionOf(releases.html, "Recent releases")).includes(
          acme.release
        ),
        runsThis: releases.html.includes("Runs this"),
        latestRollout: releases.html.includes("Not in one yet"),
        // Only the newest are listed, and the whole list is a link away.
        allReleases: sectionOf(releases.html, "Recent releases").includes(
          'href="/platform/releases"'
        ),
      },
      settings: textOf(sectionOf(settings.html, "Its secrets")).includes(
        "Generation1Last rotatedNeverLiveYes"
      ),
    }).toStrictEqual({
      statuses: [200, 200, 200, 200, 200],
      header: [true, true, true, true, true, true],
      activity: true,
      toOldPages: false,
      needs: false,
      numbers: [true, true],
      quotaPolicy: [true, true, true],
      howItRuns: [true, true, true, true, true, true],
      checklist: [true, true, true],
      deployed: true,
      history: { kept: true, settingUp: false },
      resources: [true, true, true, true, true],
      releases: {
        follows: true,
        runs: true,
        runsThis: true,
        latestRollout: true,
        allReleases: true,
      },
      settings: true,
    });
  });

  it("says what needs a look, most pressing first, and what staff did by hand", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    // Two releases since the one it runs.
    await publishRelease({ notes: "fix(core): one" });
    await publishRelease({ notes: "fix(core): two" });
    await importReleases(env.RELEASES, db);
    await rotateClientSecrets(db, staff, acme.clientId, new Date());
    await setRing(env, staff, { clientId: acme.clientId, ring: 2 });
    const base = `/organizations/${acme.clientId}/setup`;

    const status = await page(base);
    const history = await page(`${base}?tab=history`);
    const settings = await page(`${base}?tab=settings`);
    const needs = textOf(sectionOf(status.html, "What needs a look"));
    const lines = [
      "New secrets wait to reach it",
      "2 releases behind the newest.",
    ];
    const done = textOf(sectionOf(history.html, "Done here"));

    expect({
      standing: textOf(sectionOf(status.html, "How it stands")).includes(
        "Needs a look"
      ),
      needs: lines.map((line) => needs.includes(line)),
      inOrder: lines
        .map((line) => needs.indexOf(line))
        .every((at, index, all) => index === 0 || at > (all[index - 1] ?? 0)),
      ring: textOf(sectionOf(status.html, "How it stands")).includes(
        "Production"
      ),
      done: [
        "Moved it to Production.",
        "Rotated its secrets.",
        staff.email,
      ].map((text) => done.includes(text)),
      // What the system did itself isn't by hand.
      created: done.includes("client.create"),
      secretsLive: textOf(sectionOf(settings.html, "Its secrets")).includes(
        "Generation2"
      ),
      waiting: textOf(sectionOf(settings.html, "Its secrets")).includes(
        "LiveWith the next deploy"
      ),
    }).toStrictEqual({
      standing: true,
      needs: [true, true],
      inOrder: true,
      ring: true,
      done: [true, true, true],
      created: false,
      secretsLive: true,
      waiting: true,
    });
  });

  it("opens on how it stands for a tab it doesn't have, and has no Setup for a client the admin doesn't know", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const base = `/organizations/${acme.clientId}/setup`;
    await db
      .update(clients)
      .set({ ring: 0 })
      .where(eq(clients.id, acme.clientId));

    const odd = await page(`${base}?tab=nothing`);
    const unknown = await page("/organizations/client-unknown/setup");

    expect({
      status: odd.status,
      onStatus: odd.html.includes("From contract to go"),
      ring: textOf(sectionOf(odd.html, "How it stands")).includes("Alpha"),
      unknown: unknown.status,
    }).toStrictEqual({
      status: 200,
      onStatus: true,
      ring: true,
      unknown: 404,
    });
  });
});
