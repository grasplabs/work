import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { env } from "cloudflare:workers";
import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { followPaceOf } from "../src/admin/setup.tsx";
import { getClientSetup } from "../src/clients/setup.ts";
import { adminDatabase } from "../src/db/act.ts";
import { clientDeploys, clients } from "../src/db/schema.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import { getClientHosting } from "../src/hosting/placement.ts";
import { importReleases } from "../src/releases/import.ts";
import { setClientChannel } from "../src/rollout/channels.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { aiStatusOf, emptyAdminSnapshot } from "./cloudflare-api.ts";
import { onChannel } from "./hosting.ts";
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
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name,
    signIn: null,
  });
  core.admin = snapshot;
  return { clientId, name, core, release };
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
    const releases = await page(`${base}?tab=releases`);
    const settings = await page(`${base}?tab=settings`);
    const header = textOf(sectionOf(status.html, "How it stands"));
    const workers = textOf(sectionOf(status.html, "Its Workers"));

    expect({
      statuses: [status, history, releases, settings].map(
        (each) => each.status
      ),
      header: [
        `${acme.clientId}.`,
        "Healthy",
        acme.release,
        "Stable",
        "Open its Grasp",
        "Its activity",
      ].map((text) => header.includes(text)),
      // Its activity is the audit trail in its own Grasp.
      activity: toItsAuditTrail.test(sectionOf(status.html, "How it stands")),
      // Nothing of it is left to the old client pages.
      toOldPages: status.html.includes('href="/clients/'),
      // Nothing needs a look on a company that runs the newest release.
      needs: status.html.includes("What needs a look"),
      // Its account's numbers are said only once read, and only when
      // something is off: nothing of them before.
      numbers: status.html.includes("Its platform in numbers"),
      // What runs in its account, and under it what its deploys keep there.
      workers: [
        "grasp-os-core",
        "grasp-os-connect",
        "grasp-os-knowledge",
        "grasp-os-files",
        "grasp-os-audit-archive",
        "Read what runs",
      ].map((text) => workers.includes(text)),
      // No AI Gateway runs for it any more: its AI is its own provider's.
      gateway: workers.includes("AI Gateway"),
      history: {
        kept: history.html.includes('aria-label="Its history"'),
        settingUp: history.html.includes("Setting it up"),
      },
      releases: {
        follows: releases.html.includes("Follows its channel"),
        runs: textOf(sectionOf(releases.html, "Recent releases")).includes(
          acme.release
        ),
        runsThis: releases.html.includes("Runs this"),
        shouldRun: releases.html.includes("No release on its channel yet"),
        lastDeploy: releases.html.includes("None yet"),
        // Only the newest are listed, and the whole list is a link away.
        allReleases: sectionOf(releases.html, "Recent releases").includes(
          'href="/platform/releases"'
        ),
      },
      settings: textOf(sectionOf(settings.html, "Its secrets")).includes(
        "Generation1Last rotatedNeverLiveYes"
      ),
    }).toStrictEqual({
      statuses: [200, 200, 200, 200],
      header: [true, true, true, true, true, true],
      activity: true,
      toOldPages: false,
      needs: false,
      numbers: false,
      workers: [true, true, true, true, true, true],
      gateway: false,
      history: { kept: true, settingUp: false },
      releases: {
        follows: true,
        runs: true,
        runsThis: true,
        shouldRun: true,
        lastDeploy: true,
        allReleases: true,
      },
      settings: true,
    });
  });

  it("says what needs a look, most pressing first, and what staff did by hand", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const beta = await publishRelease({ notes: "fix(core): on beta" });
    await importReleases(env.RELEASES, db);
    await onChannel(beta.id, "beta");
    await rotateClientSecrets(db, staff, acme.clientId, new Date());
    await setClientChannel(env, staff, {
      clientId: acme.clientId,
      channel: "beta",
    });
    // Its deploy of Beta's release failed, as the reconciler records it.
    const now = new Date();
    await db.insert(clientDeploys).values({
      clientId: acme.clientId,
      releaseId: beta.id,
      runId: `deploy-${crypto.randomUUID().slice(0, 8)}`,
      status: "failed",
      error: "cloudflare_400_10000",
      startedAt: now,
      endedAt: now,
    });
    const base = `/organizations/${acme.clientId}/setup`;

    const status = await page(base);
    const history = await page(`${base}?tab=history`);
    const settings = await page(`${base}?tab=settings`);
    const needs = textOf(sectionOf(status.html, "What needs a look"));
    const lines = [
      `Its deploy of ${beta.id} failed`,
      "New secrets wait to reach it",
    ];
    const done = textOf(sectionOf(history.html, "Its history"));

    expect({
      standing: textOf(sectionOf(status.html, "How it stands")).includes(
        "Needs a look"
      ),
      needs: lines.map((line) => needs.includes(line)),
      inOrder: lines
        .map((line) => needs.indexOf(line))
        .every((at, index, all) => index === 0 || at > (all[index - 1] ?? 0)),
      channel: textOf(sectionOf(status.html, "How it stands")).includes("Beta"),
      done: ["Moved it to Beta.", "Rotated its secrets.", staff.email].map(
        (text) => done.includes(text)
      ),
      // Said in words, never as the log names it.
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
      channel: true,
      done: [true, true, true],
      created: false,
      secretsLive: true,
      waiting: true,
    });
  });

  it("reads itself again every few seconds while a deploy is due or out, and only now and then once it runs what it should or its deploy failed", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const paceOf = async (): Promise<number | null> => {
      const setup = await getClientSetup(env, acme.clientId);
      if (setup === null) {
        throw new Error("The client has no Setup");
      }
      return followPaceOf(setup, await getClientHosting(env, acme.clientId));
    };

    const settled = await paceOf();
    // A newer release reaches its channel: the reconciler deploys it at
    // its next tick, with nobody on this page doing anything.
    const beta = await publishRelease({ notes: "fix(core): rolled out" });
    await importReleases(env.RELEASES, db);
    await onChannel(beta.id, "beta");
    await setClientChannel(env, staff, {
      clientId: acme.clientId,
      channel: "beta",
    });
    const due = await paceOf();
    const now = new Date();
    await db.insert(clientDeploys).values({
      clientId: acme.clientId,
      releaseId: beta.id,
      runId: `deploy-${crypto.randomUUID().slice(0, 8)}`,
      status: "deploying",
      startedAt: now,
    });
    const out = await paceOf();
    // Failed on the release it should run: it waits for staff to retry.
    await db
      .update(clientDeploys)
      .set({ status: "failed", error: "cloudflare_400_10000", endedAt: now })
      .where(eq(clientDeploys.clientId, acme.clientId));
    const failed = await paceOf();

    expect({
      watched: settled !== null,
      closerWhileDue: due !== null && settled !== null && due < settled,
      asCloseWhileOut: out === due,
      failedAsSettled: failed === settled,
    }).toStrictEqual({
      watched: true,
      closerWhileDue: true,
      asCloseWhileOut: true,
      failedAsSettled: true,
    });
  });

  it("says its AI in one line from what its core reports: working, what its failing calls show since the first such failure, or not connected", async () => {
    const now = Date.now();
    const status = (
      lastOkAt: number | null,
      failure: {
        since: number;
        last: number;
        kind: string;
        shows: ProviderTrouble;
      } | null
    ): AiStatusReport =>
      aiStatusOf([
        {
          provider: "openai",
          kind: "organization",
          lastOkAt,
          lastFailedAt: failure?.last ?? null,
          lastFailure: failure?.kind ?? null,
          failingClass: failure?.shows ?? null,
          failingSince: failure?.since ?? null,
        },
        // Grasp's own key's calls say nothing of the company's AI.
        {
          provider: "anthropic",
          kind: "platform",
          lastOkAt: now,
          lastFailedAt: null,
          lastFailure: null,
          failingClass: null,
          failingSince: null,
        },
      ]);
    // Since its first such failure after the call that last worked, not
    // since its latest.
    const failingSince = now - 2 * 60 * 1000;
    // Its time only: within two minutes of midnight UTC it was yesterday,
    // and the line names the day too.
    const since = `${new Date(failingSince).toISOString().slice(11, 16)} UTC`;
    const failingAs = async (kind: string, shows: ProviderTrouble) => {
      const client = await liveClient(emptyAdminSnapshot("Acme"));
      client.core.ai = status(now - 60 * 60 * 1000, {
        since: failingSince,
        last: now - 1000,
        kind,
        shows,
      });
      return client;
    };
    const working = await liveClient(emptyAdminSnapshot("Acme"));
    working.core.ai = status(now - 5 * 60 * 1000 - 10 * 1000, null);
    const shown = [
      working,
      await failingAs("auth", "refused"),
      await failingAs("provider_down", "not_answering"),
      await failingAs("quota", "limiting"),
      await liveClient(emptyAdminSnapshot("Acme")),
    ];

    const sectionFor = async (clientId: string): Promise<string> => {
      const { html } = await page(`/organizations/${clientId}/setup`);
      return sectionOf(html, "AI");
    };
    const sections: string[] = [];
    for (const { clientId } of shown) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      sections.push(await sectionFor(clientId));
    }
    const lines = sections.map(textOf);
    const expected = [
      "AI: OpenAI connected · working · last used 5 min ago",
      "AI: OpenAI connected · refusing the key since ",
      "AI: OpenAI connected · not answering since ",
      "AI: OpenAI connected · limiting requests since ",
      "AI: not connected yet",
    ];

    expect({
      lines: lines.map((line, at) => line?.includes(expected[at] ?? "")),
      since: lines.slice(1, 4).map((line) => line?.includes(since)),
      // Read only: nothing to press.
      buttons: sections.some((html) => html.includes("<button")),
    }).toStrictEqual({
      lines: [true, true, true, true, true],
      since: [true, true, true],
      buttons: false,
    });
  });

  it("reads the AI of a core on an earlier release, whose report says nothing of failing calls, as working", async () => {
    const now = Date.now();
    const client = await liveClient(emptyAdminSnapshot("Acme"));
    // As that release answers: no `failingClass` or `failingSince`.
    client.core.ai = {
      providers: [
        {
          provider: "openai",
          kind: "organization",
          lastOkAt: now - 5 * 60 * 1000 - 10 * 1000,
          lastFailedAt: null,
          lastFailure: null,
        },
      ],
    };

    const { html } = await page(`/organizations/${client.clientId}/setup`);

    expect(textOf(sectionOf(html, "AI"))).toContain(
      "AI: OpenAI connected · working · last used 5 min ago"
    );
  });

  it("reads the AI of a core that answers with a redirect elsewhere as unknown, never following it", async () => {
    const client = await liveClient(emptyAdminSnapshot("Acme"));
    client.core.aiRedirect = true;

    const { html } = await page(`/organizations/${client.clientId}/setup`);

    expect(textOf(sectionOf(html, "AI"))).toContain(
      "AI: couldn’t be read just now."
    );
  });

  it("opens on how it stands for a tab it doesn't have, and has no Setup for a client the admin doesn't know", async () => {
    const acme = await liveClient(emptyAdminSnapshot("Acme"));
    const base = `/organizations/${acme.clientId}/setup`;
    await db
      .update(clients)
      .set({ channel: "edge" })
      .where(eq(clients.id, acme.clientId));

    const odd = await page(`${base}?tab=nothing`);
    const unknown = await page("/organizations/client-unknown/setup");

    expect({
      status: odd.status,
      onStatus: odd.html.includes('aria-label="Its Workers"'),
      channel: textOf(sectionOf(odd.html, "How it stands")).includes("Edge"),
      unknown: unknown.status,
    }).toStrictEqual({
      status: 200,
      onStatus: true,
      channel: true,
      unknown: 404,
    });
  });
});
