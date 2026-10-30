import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { setSignIn } from "../src/clients/settings.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import {
  clientProvisions,
  clients,
  releases as releaseRows,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { RELEASE_LIST_LIMIT } from "../src/releases/queries.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { adminOf } from "./secrets-store-admin.ts";

mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/**
 * A client recorded as `status`, without a run: one being provisioned as
 * adding it records it, with no account of its own; an active one on an
 * account of its own, as the account-per-client path left it.
 */
const recordClient = async (
  status: "provisioning" | "active" = "provisioning",
  pinnedReleaseId: string | null = null
) => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: `Acme ${id}`,
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
  return { id };
};

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** A release row, imported as built at `builtAt`, with nothing of a manifest. */
const releaseRow = (id: string, builtAt: Date) => ({
  id,
  commitSha: "0".repeat(40),
  manifest: "{}",
  manifestSha256: "0".repeat(64),
  builtAt,
  importedAt: builtAt,
});

/** Client `clientId`'s Setup, on `tab` (how it stands when none). */
const setupOf = async (clientId: string, tab?: string) =>
  await page(
    `/organizations/${clientId}/setup${tab === undefined ? "" : `?tab=${tab}`}`
  );

/** Where the admin sends a staff member's page load of `url`, and how. */
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
  it("moves old addresses to where their page is now for good, keeping what the address asked", async () => {
    const moves = await Promise.all(
      [
        "https://ops.grasp.test/admin?phase=open",
        "https://ops.grasp.test/clients/new?from=grid",
        "https://ops.grasp.test/clients/acme?tab=settings",
      ].map(movedFrom)
    );

    expect(
      moves.map(({ status, location }) => ({
        status,
        to: location === null ? null : new URL(location, "https://x.test"),
      }))
    ).toMatchObject([
      { status: 301, to: { pathname: "/", search: "?phase=open" } },
      {
        status: 301,
        to: { pathname: "/new-organization", search: "?from=grid" },
      },
      {
        status: 301,
        to: {
          pathname: "/organizations/acme/setup",
          search: "?tab=settings",
        },
      },
    ]);
  });

  it("lists every organization with its own platform still to read from its account, and a way to add one", async () => {
    const live = await recordClient("active");

    // The live column is read after the page shows (test/client-grid.test.ts).
    const { status, html } = await page("/");

    expect({
      status,
      listed: html.includes(`href="/organizations/${live.id}"`),
      column: html.includes("Its platform"),
      reading: html.includes("Reading…"),
      add: html.includes('href="/new-organization"'),
    }).toStrictEqual({
      status: 200,
      listed: true,
      column: true,
      reading: true,
      add: true,
    });
  });

  it("asks who an organization is, its sign-in and its ring on adding it, and no account to adopt or release", async () => {
    const { status, html } = await page("/new-organization");

    expect({
      status,
      form: html.includes('name="clientId"') && html.includes('name="ring"'),
      account: html.includes('name="accountId"'),
      release: html.includes('name="releaseId"'),
      signIn: [
        'name="entraTenantId"',
        'name="googleHostedDomain"',
        'name="domains"',
        'name="admins"',
      ].every((field) => html.includes(field)),
    }).toStrictEqual({
      status: 200,
      form: true,
      account: false,
      release: false,
      signIn: true,
    });
  });

  it("shows a company just added its Hosting, to place and provision on an imported release", async () => {
    await importedRelease("feat(core): newest of all");
    const client = await recordClient();

    const { status, html } = await setupOf(client.id);
    const hosting = sectionOf(html, "Hosting");

    expect({
      status,
      place: hosting.includes("Place and start provisioning"),
      release: hosting.includes('id="hosting-release"'),
      account: html.includes("Account id"),
      hostname: html.includes(`${client.id}.grasp.test`),
    }).toStrictEqual({
      status: 200,
      place: true,
      release: true,
      account: false,
      hostname: true,
    });
  });

  it("says where a company's provisioning stopped and why, for staff to start it again from Hosting", async () => {
    const releaseId = await importedRelease("feat(core): stops");
    const client = await recordClient();
    const now = new Date();
    await db.insert(clientProvisions).values({
      id: crypto.randomUUID(),
      clientId: client.id,
      releaseId,
      status: "failed",
      step: "resources",
      error: "probe_unanswered",
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });

    const { html } = await setupOf(client.id);

    expect({
      stopped: html.includes(
        "Stopped after its resources step, resume it from Hosting"
      ),
      code: html.includes("probe_unanswered"),
      resume: sectionOf(html, "Hosting").includes("Resume provisioning"),
    }).toStrictEqual({ stopped: true, code: true, resume: true });
  });

  it("offers a stopped provisioning its own release to resume on, even one older than every release listed", async () => {
    // Built long ago, then a full list of newer ones: not among the
    // newest releases the page lists.
    const releaseId = "r000000001-0000000";
    const now = new Date();
    await db.insert(releaseRows).values(releaseRow(releaseId, new Date(0)));
    const newer = Array.from({ length: RELEASE_LIST_LIMIT }, (_, at) =>
      releaseRow(
        `r9${String(at).padStart(8, "0")}-0000000`,
        new Date(now.getTime() + at)
      )
    );
    for (let at = 0; at < newer.length; at += 10) {
      // oxlint-disable-next-line no-await-in-loop -- D1 binds so many values a statement
      await db.insert(releaseRows).values(newer.slice(at, at + 10));
    }
    const client = await recordClient();
    await db.insert(clientProvisions).values({
      id: crypto.randomUUID(),
      clientId: client.id,
      releaseId,
      status: "failed",
      step: "resources",
      error: "probe_unanswered",
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });

    const { html } = await setupOf(client.id);
    const hosting = sectionOf(html, "Hosting");

    expect({
      offered: hosting.includes(`value="${releaseId}"`),
      resume: hosting.includes("Resume provisioning"),
    }).toStrictEqual({ offered: true, resume: true });
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
    const historyTab = await setupOf(client.id, "history");
    const history = sectionOf(historyTab.html, "Its history");

    expect({
      statuses: [releases.status, settings.status, historyTab.status],
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
        `href="/platform/rollouts/${rolloutId}"`
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
      back: html.includes("Back to the admin") && html.includes('href="/"'),
    }).toStrictEqual({ status: 404, says: true, back: true });
  });
});
