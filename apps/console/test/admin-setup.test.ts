import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env } from "cloudflare:workers";
import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { setRing } from "../src/clients/settings.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { clientDeploys, clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admin-setup-5c1e90";
const tenantToken = "test-tenant-admin-token-admin-setup-2a7d63";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/**
 * An active client running a new release, as a deploy made it live, whose
 * core answers the admin with `snapshot`.
 */
const liveClient = async (snapshot: AdminSnapshot) => {
  const release = await publishRelease({ notes: "feat(core): the setup" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Acme ${clientId}`;
  const account = cloudflare.addAccount(name);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  account.admin = snapshot;
  return { clientId, name, account, release };
};

/** The part of a page titled `title`: from its label to its end. */
const sectionOf = (html: string, title: string): string => {
  const at = html.indexOf(`aria-label="${title}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
};

/** `html` without its tags, so words split by markup read as one line. */
const textOf = (html: string): string =>
  html.replaceAll(/<[^>]+>/gu, "").replaceAll("&#x27;", "'");

describe("an organization's Setup", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // The newest release is each test's own: an earlier test's clients are
  // gone from the fake, and are offboarded so nothing counts them.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows a company's own platform as the console runs it, tab by tab", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const base = `/admin/organizations/${acme.clientId}/setup`;

    const status = await page(base);
    const deploys = await page(`${base}?tab=deploys`);
    const resources = await page(`${base}?tab=resources`);
    const releases = await page(`${base}?tab=releases`);
    const settings = await page(`${base}?tab=settings`);
    const header = textOf(sectionOf(status.html, "How it stands"));
    const checklist = textOf(sectionOf(status.html, "From contract to go"));
    const howItRuns = textOf(sectionOf(status.html, "How it runs"));

    expect({
      statuses: [status, deploys, resources, releases, settings].map(
        (each) => each.status
      ),
      header: [
        `${acme.clientId}.`,
        "Healthy",
        acme.release.id,
        "Ring 1",
        "Open in the console",
        "Open in Cloudflare",
      ].map((text) => header.includes(text)),
      toConsole: status.html.includes(`href="/clients/${acme.clientId}"`),
      // Nothing needs a look on a company that runs the newest release.
      needs: status.html.includes("What needs a look"),
      // Its numbers aren't kept day by day: said, not made up.
      numbers: status.html.includes(
        "The console doesn’t keep these day by day yet."
      ),
      howItRuns: [
        "Router",
        "Core",
        "Connect",
        "grasp-os-core",
        "grasp-os-files",
        "AI Gateway",
      ].map((text) => howItRuns.includes(text)),
      // Deployed by the console, and the contract not held by core yet.
      checklist: [
        "Its own platform is deployed",
        "From Rooms, once it is connected.",
        "1 of 6 in place.",
      ].map((text) => checklist.includes(text)),
      deployed: checklist.includes(
        "Its own platform is deployed, in its own Cloudflare account in the EU: done"
      ),
      deploys: {
        last: textOf(sectionOf(deploys.html, "The last deploy")).includes(
          `Release · ${acme.release.id}`
        ),
        every: textOf(sectionOf(deploys.html, "Recent deploys")).includes(
          "Done"
        ),
        settingUp: deploys.html.includes("Setting it up"),
      },
      resources: [
        acme.account.id,
        "grasp-os-core",
        "grasp-os-connect",
        "grasp-os-knowledge",
        "grasp-os-audit-archive",
        "Read what runs",
      ].map((text) => resources.html.includes(text)),
      releases: {
        follows: releases.html.includes("Follows the rollouts"),
        runs: textOf(sectionOf(releases.html, "Recent releases")).includes(
          acme.release.id
        ),
        runsThis: releases.html.includes("Runs this"),
        latestRollout: releases.html.includes("Not in one yet"),
        // Only the newest are listed, and the whole list is a link away.
        allReleases: sectionOf(releases.html, "Recent releases").includes(
          'href="/releases"'
        ),
      },
      settings: textOf(sectionOf(settings.html, "Its secrets")).includes(
        "Generation1Last rotatedNeverLiveYes"
      ),
    }).toStrictEqual({
      statuses: [200, 200, 200, 200, 200],
      header: [true, true, true, true, true, true],
      toConsole: true,
      needs: false,
      numbers: true,
      howItRuns: [true, true, true, true, true, true],
      checklist: [true, true, true],
      deployed: true,
      deploys: { last: true, every: true, settingUp: false },
      resources: [true, true, true, true, true, true],
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
    // Its settings, deployed again, stopped at the smoke check.
    const later = new Date(Date.now() + 1000);
    await db.insert(clientDeploys).values({
      id: crypto.randomUUID(),
      clientId: acme.clientId,
      releaseId: acme.release.id,
      kind: "settings",
      status: "failed",
      step: "workers",
      error: "smoke_check_failed",
      startedBy: staff.email,
      createdAt: later,
      updatedAt: later,
    });
    const base = `/admin/organizations/${acme.clientId}/setup`;

    const status = await page(base);
    const deploys = await page(`${base}?tab=deploys`);
    const settings = await page(`${base}?tab=settings`);
    const needs = textOf(sectionOf(status.html, "What needs a look"));
    const lines = [
      "The last deploy failed (Settings): smoke_check_failed",
      "New secrets wait to reach it",
      "2 releases behind the newest.",
    ];
    const done = textOf(sectionOf(deploys.html, "Done here"));
    const last = textOf(sectionOf(deploys.html, "The last deploy"));

    expect({
      standing: textOf(sectionOf(status.html, "How it stands")).includes(
        "Needs a look"
      ),
      needs: lines.map((line) => needs.includes(line)),
      inOrder: lines
        .map((line) => needs.indexOf(line))
        .every((at, index, all) => index === 0 || at > (all[index - 1] ?? 0)),
      ring: textOf(sectionOf(status.html, "How it stands")).includes("Ring 2"),
      last: [
        "Workers: done",
        "Smoke check: failed",
        "Address: to come",
        "It stopped: smoke_check_failed",
      ].map((text) => last.includes(text)),
      done: ["Moved it to ring 2.", "Rotated its secrets.", staff.email].map(
        (text) => done.includes(text)
      ),
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
      needs: [true, true, true],
      inOrder: true,
      ring: true,
      last: [true, true, true, true],
      done: [true, true, true],
      created: false,
      secretsLive: true,
      waiting: true,
    });
  });

  it("opens on how it stands for a tab it doesn't have, and has no Setup for a client the console doesn't know", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const base = `/admin/organizations/${acme.clientId}/setup`;
    await db
      .update(clients)
      .set({ ring: 0 })
      .where(eq(clients.id, acme.clientId));

    const odd = await page(`${base}?tab=nothing`);
    const unknown = await page("/admin/organizations/client-unknown/setup");

    expect({
      status: odd.status,
      onStatus: odd.html.includes("From contract to go"),
      ring: textOf(sectionOf(odd.html, "How it stands")).includes(
        "Ring 0, first"
      ),
      unknown: unknown.status,
    }).toStrictEqual({
      status: 200,
      onStatus: true,
      ring: true,
      unknown: 404,
    });
  });
});
