import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setSignIn } from "../src/clients/settings.ts";
import { act, audit, consoleDatabase } from "../src/db/act.ts";
import {
  clientDeploys,
  clientRuns,
  clients,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { startProvisioning } from "../src/provision/control.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { adminOf } from "./secrets-store-admin.ts";

mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/**
 * A client whose real run waits for Workers Paid, its account step as it
 * ends for a new account (the page's tests have no Cloudflare API to
 * settle one against). The caller disposes of `runs`.
 */
const waitingClient = async () => {
  const release = await publishRelease({ notes: "feat(core): waits" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const accountId = crypto.randomUUID().replaceAll("-", "");
  const runs = await introspectWorkflow(env.PROVISION_CLIENT);
  await runs.modifyAll(async (modifier) => {
    await modifier.mockStepResult(
      { name: "account" },
      { accountId, abandonedAccountId: null }
    );
  });
  await startProvisioning(env, staff, {
    clientId,
    name: "Acme",
    releaseId: release.id,
    ring: 1,
    signIn: {
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      googleHostedDomain: "acme.test",
    },
  });
  const [run] = await runs.get();
  if (run === undefined) {
    throw new Error("No run was created");
  }
  await run.waitForStepResult({ name: "client" });
  return { clientId, accountId, releaseId: release.id, runs };
};

/** A client recorded as `status`, without a run, on a new account id. */
const recordClient = async (
  status: "provisioning" | "active" = "provisioning",
  pinnedReleaseId: string | null = null
) => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const accountId = crypto.randomUUID().replaceAll("-", "");
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: `Acme ${id}`,
        accountId,
        ring: 3,
        status,
        pinnedReleaseId,
        createdBy: staff.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return { id, accountId };
};

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** Client `clientId`'s Setup, on `tab` (how it stands when none). */
const setupOf = async (clientId: string, tab?: string) =>
  await page(
    `/admin/organizations/${clientId}/setup${tab === undefined ? "" : `?tab=${tab}`}`
  );

/** Where the console sends a staff member's page load of `url`, and how. */
const movedFrom = async (url: string) => {
  const response = await exports.default.fetch(url, {
    headers: { "cf-access-jwt-assertion": await accessJwt(staff.email) },
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
};

/** The part of a page titled `title`: from its label to its end. */
const sectionOf = (html: string, title: string): string => {
  const at = html.indexOf(`aria-label="${title}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
};

describe("the company pages, in the admin", () => {
  it("moves the console's own pages to the admin for good, keeping what the address asked", async () => {
    const moves = await Promise.all(
      [
        "https://console.grasp.test/?phase=open",
        "https://console.grasp.test/clients/new?from=grid",
        "https://console.grasp.test/clients/acme?tab=settings",
      ].map(movedFrom)
    );

    expect(
      moves.map(({ status, location }) => ({
        status,
        to: location === null ? null : new URL(location, "https://x.test"),
      }))
    ).toMatchObject([
      { status: 301, to: { pathname: "/admin", search: "?phase=open" } },
      {
        status: 301,
        to: { pathname: "/admin/new-organization", search: "?from=grid" },
      },
      {
        status: 301,
        to: {
          pathname: "/admin/organizations/acme/setup",
          search: "?tab=settings",
        },
      },
    ]);
  });

  it("lists every organization with its own platform still to read from its account, and a way to add one", async () => {
    const live = await recordClient("active");

    // The live column is read after the page shows (test/client-grid.test.ts).
    const { status, html } = await page("/admin");

    expect({
      status,
      listed: html.includes(`href="/admin/organizations/${live.id}"`),
      column: html.includes("Its platform"),
      reading: html.includes("Reading…"),
      add: html.includes('href="/admin/new-organization"'),
    }).toStrictEqual({
      status: 200,
      listed: true,
      column: true,
      reading: true,
      add: true,
    });
  });

  it("offers the imported releases, with their notes, on adding an organization, and every sign-in field", async () => {
    const releaseId = await importedRelease("feat(core): newest of all");

    const { status, html } = await page("/admin/new-organization");

    expect({
      status,
      form:
        html.includes('name="clientId"') && html.includes('name="accountId"'),
      signIn: [
        'name="entraTenantId"',
        'name="googleHostedDomain"',
        'name="domains"',
        'name="admins"',
      ].every((field) => html.includes(field)),
      newest: html.includes(`${releaseId} · feat(core): newest of all`),
    }).toStrictEqual({ status: 200, form: true, signIn: true, newest: true });
  });

  it("shows a company waiting for Workers Paid the checklist in its Setup, with its account's dashboard", async () => {
    const { clientId, accountId, runs } = await waitingClient();
    await using _runs = runs;

    const { status, html } = await setupOf(clientId);
    const settingUp = sectionOf(html, "Setting it up");

    expect({
      status,
      checklist: settingUp.includes("upgrade it to Workers Paid"),
      dashboard: settingUp.includes(`https://dash.cloudflare.com/${accountId}`),
      confirm: settingUp.includes("Workers Paid is on"),
      hostname: html.includes(`${clientId}.grasp.test`),
    }).toStrictEqual({
      status: 200,
      checklist: true,
      dashboard: true,
      confirm: true,
      hostname: true,
    });
  });

  it("says a Workers Paid confirmation is in, in place of the button, while the run gets to it", async () => {
    const { clientId, runs } = await waitingClient();
    await using _runs = runs;
    // Once the run has checked for a confirmation and found none, it waits:
    // recorded then, as confirming does first, before the run has the event.
    const [run] = await runs.get();
    await run?.waitForStepResult({ name: "workers paid confirmed" });
    await audit(db, staff, { action: "client.workers_paid", clientId });

    const { html } = await setupOf(clientId);

    expect({
      confirmed: html.includes("Confirmed, waiting for the run."),
      button: html.includes("Workers Paid is on"),
    }).toStrictEqual({ confirmed: true, button: false });
  });

  it("shows a deploy under way with its release and the last step it finished", async () => {
    const { clientId, releaseId, runs } = await waitingClient();
    await using _runs = runs;
    const now = new Date();
    await db.insert(clientDeploys).values({
      id: crypto.randomUUID(),
      clientId,
      releaseId,
      status: "running",
      step: "migrations",
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });

    const { html } = await setupOf(clientId);

    expect(sectionOf(html, "Setting it up")).toContain(
      `Deploying ${releaseId}: migrations done.`
    );
  });

  it("shows a resumed run in its first steps, not the deploy an earlier run left", async () => {
    const { clientId, releaseId, runs } = await waitingClient();
    await using _runs = runs;
    const [run] = await runs.get();
    await run?.waitForStepResult({ name: "workers paid confirmed" });
    // Staff confirmed Workers Paid, an earlier run's deploy failed, and the
    // current run was claimed after both: it won't wait, and hasn't started
    // its own deploy yet.
    await audit(db, staff, { action: "client.workers_paid", clientId });
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(clientDeploys).values({
      id: crypto.randomUUID(),
      clientId,
      releaseId,
      status: "failed",
      step: "workers",
      error: "hostname_taken",
      startedBy: staff.email,
      createdAt: earlier,
      updatedAt: earlier,
    });
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() + 1000) })
      .where(eq(clientRuns.clientId, clientId));

    const { html } = await setupOf(clientId);
    const settingUp = sectionOf(html, "Setting it up");

    expect({
      settingUp: settingUp.includes(
        "Setting up: its Cloudflare account, then its record."
      ),
      deploying: settingUp.includes("Deploying"),
    }).toStrictEqual({ settingUp: true, deploying: false });
  });

  it("shows an active company nothing left to set up, and reads its account's numbers once the page shows", async () => {
    const client = await recordClient("active");

    const { status, html } = await setupOf(client.id);

    expect({
      status,
      settingUp: html.includes('aria-label="Setting it up"'),
      resume: html.includes("Resume"),
      numbers: sectionOf(html, "Its platform in numbers").includes(
        "Reading its account…"
      ),
    }).toStrictEqual({
      status: 200,
      settingUp: false,
      resume: false,
      numbers: true,
    });
  });

  it("offers to resume a company whose run is gone", async () => {
    const client = await recordClient();

    const { status, html } = await setupOf(client.id);

    expect({
      status,
      gone: html.includes("its run is gone"),
      resume: html.includes("Resume"),
      confirm: html.includes("Workers Paid is on"),
    }).toStrictEqual({ status: 200, gone: true, resume: true, confirm: false });
  });

  it("follows a run that stopped before it recorded the company where it was added, with why and a way to add it again", async () => {
    const release = await publishRelease({ notes: "feat(core): stops" });
    await importReleases(env.RELEASES, db);
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    await using runs = await introspectWorkflow(env.PROVISION_CLIENT);
    // The test's store holds no deployer token: the run's first step stops.
    await startProvisioning(env, staff, {
      clientId,
      name: "Acme",
      releaseId: release.id,
      ring: 1,
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test"],
        googleHostedDomain: "acme.test",
      },
    });
    const [run] = await runs.get();
    await run?.waitForStatus("errored");

    const moved = await movedFrom(
      `https://console.grasp.test/admin/organizations/${clientId}/setup`
    );
    const { status, html } = await page(
      `/admin/new-organization?following=${clientId}`
    );

    expect({
      moved: moved.location?.endsWith(
        `/admin/new-organization?following=${clientId}`
      ),
      status,
      reason: html.includes(
        "store_secret_missing: DEPLOYER_API_TOKEN is missing from Secrets Store"
      ),
      addAgain: html.includes('href="/admin/new-organization"'),
      resume: html.includes("Resume"),
    }).toStrictEqual({
      moved: true,
      status: 200,
      reason: true,
      addAgain: true,
      resume: false,
    });
  });

  it("shows a company's ring and sign-in to change, what waits for its next deploy, rotating its secrets, and its history", async () => {
    const client = await recordClient("active");
    // The key a sign-in change fingerprints its admins with, for its audit.
    const store = await adminOf(env.CLIENT_KEY);
    const key = await store.create("test-client-key");
    try {
      await setSignIn(env, staff, {
        clientId: client.id,
        signIn: {
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          googleHostedDomain: "acme.test",
        },
      });
    } finally {
      await store.delete(key);
    }

    const releases = await setupOf(client.id, "releases");
    const settings = await setupOf(client.id, "settings");
    const deploys = await setupOf(client.id, "deploys");
    const history = sectionOf(deploys.html, "Its history");

    expect({
      statuses: [releases.status, settings.status, deploys.status],
      ring:
        releases.html.includes('name="ring"') &&
        releases.html.includes('value="3"'),
      signIn:
        settings.html.includes('value="acme.test"') &&
        settings.html.includes('value="ada@acme.test"'),
      pending: settings.html.includes(
        "changed since its last deploy: apply it now"
      ),
      apply: settings.html.includes("Apply settings now"),
      rotate: sectionOf(settings.html, "Its secrets").includes(
        "Rotate secrets"
      ),
      history: ["client.sign_in", "client.create"].map((action) =>
        history.includes(action)
      ),
    }).toStrictEqual({
      statuses: [200, 200, 200],
      ring: true,
      signIn: true,
      pending: true,
      apply: true,
      rotate: true,
      history: [true, true],
    });
  });

  it("shows a live company's pin, to change or let go, and none of it for one being set up", async () => {
    const release = await importedRelease("feat(core): pinned to");
    const pinned = await recordClient("active", release);
    const unpinned = await recordClient("active");
    const settingUp = await recordClient("provisioning");

    const pinnedPage = await setupOf(pinned.id, "releases");
    const unpinnedPage = await setupOf(unpinned.id, "releases");
    const settingUpPage = await setupOf(settingUp.id, "releases");

    expect({
      pinned: {
        status: pinnedPage.status,
        says: pinnedPage.html.includes(`Pinned to ${release}`),
        unpin: pinnedPage.html.includes("Unpin"),
      },
      unpinned: {
        says: unpinnedPage.html.includes(
          "Not pinned: every rollout reaches it."
        ),
        unpin: unpinnedPage.html.includes("Unpin"),
      },
      settingUp: settingUpPage.html.includes("Pin it to"),
    }).toStrictEqual({
      pinned: { status: 200, says: true, unpin: true },
      unpinned: { says: true, unpin: false },
      settingUp: false,
    });
  });

  it("offers to roll a company back from the rollout that reached it, and not from one that didn't", async () => {
    const release = await importedRelease("feat(core): rolled out");
    const reached = await recordClient("active");
    const waiting = await recordClient("active");
    const now = new Date();
    const rolloutId = crypto.randomUUID();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "release",
      releaseId: release,
      status: "waiting",
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(rolloutTargets).values([
      {
        rolloutId,
        clientId: reached.id,
        ring: 3,
        status: "done",
        updatedAt: now,
      },
      {
        rolloutId,
        clientId: waiting.id,
        ring: 3,
        status: "pending",
        updatedAt: now,
      },
    ]);

    const reachedPage = await setupOf(reached.id, "releases");
    const waitingPage = await setupOf(waiting.id, "releases");

    expect({
      reached: reachedPage.html.includes("Roll it back"),
      waiting: waitingPage.html.includes("Roll it back"),
      rollout: reachedPage.html.includes(
        `href="/admin/platform/rollouts/${rolloutId}"`
      ),
    }).toStrictEqual({ reached: true, waiting: false, rollout: true });
  });

  it("answers 404 for a company that doesn't exist, or can't be one", async () => {
    const pages = await Promise.all(
      ["nobody-here", "Not_A_Client"].map(async (id) => await setupOf(id))
    );

    expect(pages.map(({ status }) => status)).toStrictEqual([404, 404]);
  });

  it("answers 404 for a page there isn't, with the way to the admin", async () => {
    const { status, html } = await page("/no-such-page");

    expect({
      status,
      says: html.includes("There&#x27;s no such page."),
      back:
        html.includes("Back to the admin") && html.includes('href="/admin"'),
    }).toStrictEqual({ status: 404, says: true, back: true });
  });
});
