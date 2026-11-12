import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { exports } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { orgSections, sectionTo, sectionWords } from "../src/admin/sections.ts";
import { formatDate } from "../src/admin/words.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  tags,
  spaces,
  daysAgo,
  recordClient,
  liveClient,
  sidebarOf,
  columnOf,
  integrationsOf,
  unread,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: an organization's integrations and members, and its sections when
// its core didn't answer, it was offboarded, or a request isn't vouched
// for; the rest in the other admin-pages*.test.ts files.

mockCloudflareApi(token, cloudflare);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

describe("the admin's frame", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are listed: an earlier test's accounts
  // are gone from the fake, and the overview counts every client.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows what a company connected only once it signed in, says core doesn't report its connections yet, and that what is still to connect comes from Composio", async () => {
    const before = await liveClient();
    before.core.admin = emptyAdminSnapshot("Before");
    const signed = await liveClient();
    const empty = emptyAdminSnapshot("Signed");
    // Its directory is in, with every team's lead named: past its sign-in.
    signed.core.admin = {
      ...empty,
      roster: {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: "Lea Lund",
            email: "",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
    };

    const beforePage = await page(
      `/organizations/${before.clientId}/integrations`
    );
    const signedPage = await page(
      `/organizations/${signed.clientId}/integrations`
    );

    expect({
      before: integrationsOf(beforePage),
      signed: integrationsOf(signedPage),
    }).toStrictEqual({
      before: {
        status: 200,
        nothing: true,
        waits: true,
        connected: false,
        notReported: false,
        stillToConnect: true,
        needsNotReported: true,
        source: true,
        toCome: false,
      },
      signed: {
        status: 200,
        nothing: false,
        waits: false,
        connected: true,
        notReported: true,
        stillToConnect: true,
        needsNotReported: true,
        source: true,
        toCome: false,
      },
    });
  });

  it("shows what a company connected, the app a workflow is bound to that isn't connected any more, and the workflow waiting on it", async () => {
    const acme = await liveClient();
    const empty = emptyAdminSnapshot("Acme");
    const crmSync = { id: "workflow-crm", name: "CRM sync" };
    acme.core.admin = {
      ...empty,
      // Past its sign-in: its directory is in, every team's lead named.
      roster: {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: "Lea Lund",
            email: "",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
      // As core sends it once a workflow's HubSpot was disconnected.
      integrations: {
        connected: [
          {
            source: "composio",
            provider: "google_drive",
            state: "works",
            hidden: false,
            connectedBy: "Anna de Vries",
            connectedAt: daysAgo(3),
            account: null,
            tools: ["GOOGLEDRIVE_LIST_FILES"],
          },
        ],
        personal: [
          { source: "native", provider: "microsoft", people: 4, again: 1 },
        ],
        needed: [
          {
            workflow: crmSync,
            alias: "crm",
            app: { source: "composio", provider: "hubspot" },
            state: "missing",
          },
          { workflow: crmSync, alias: "mail", app: null, state: "unbound" },
        ],
        requests: [
          {
            source: "native",
            provider: "microsoft",
            decidedBy: "person",
            waiting: 2,
            since: daysAgo(1),
          },
        ],
      },
    };

    const integrations = await page(
      `/organizations/${acme.clientId}/integrations`
    );
    const workflows = await page(`/organizations/${acme.clientId}/workflows`);

    const { html } = integrations;
    expect({
      status: [integrations.status, workflows.status],
      drive: html.includes(
        `Connected by Anna de Vries on ${formatDate(daysAgo(3))}.`
      ),
      microsoft: html.includes("4 people connected their own"),
      again: html.includes("1 needs signing in again"),
      // Core sends the toolkit's slug, not the catalog's name for it.
      hubspot: html.includes("Hubspot"),
      forCrmSync: html.includes("For CRM sync"),
      notConnected: html.includes("Not connected"),
      asked: html.includes(
        `Asked for in 2 chats since ${formatDate(daysAgo(1))}, waiting on the person in the chat`
      ),
      notReported: html.includes("doesn’t report"),
      waiting: workflows.html.includes("Waiting on a connection</h2>"),
      crm: workflows.html.includes("crm: Hubspot, not connected"),
      mail: workflows.html.includes("mail: No connection approved yet"),
    }).toStrictEqual({
      status: [200, 200],
      drive: true,
      microsoft: true,
      again: true,
      hubspot: true,
      forCrmSync: true,
      notConnected: true,
      asked: true,
      notReported: false,
      waiting: true,
      crm: true,
      mail: true,
    });
  });

  it("lists an organization's members with where each stands and their role, ready before Grasp opens and in after", async () => {
    const empty = emptyAdminSnapshot("Acme");
    const members: AdminSnapshot["members"] = [
      {
        userId: "user-anna",
        name: "Anna de Vries",
        email: "anna@acme.test",
        role: "admin",
        joinedAt: daysAgo(3),
      },
      {
        userId: "user-ben",
        name: "Ben Okafor",
        email: "ben@acme.test",
        role: "builder",
        joinedAt: daysAgo(1),
      },
    ];
    const closed = await liveClient();
    closed.core.admin = { ...empty, members };
    const open = await liveClient();
    open.core.admin = {
      ...empty,
      members,
      gate: { ...empty.gate, open: true, openedAt: empty.now },
    };
    const nobody = await liveClient();
    nobody.core.admin = empty;

    const closedPage = await page(
      `/organizations/${closed.clientId}/details?tab=members`
    );
    const openPage = await page(
      `/organizations/${open.clientId}/details?tab=members`
    );
    const nobodyPage = await page(
      `/organizations/${nobody.clientId}/details?tab=members`
    );
    /** The text of the list item naming `name`. */
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
    const rowOfMember = (html: string, name: string): string => {
      const at = html.indexOf(`>${name}</span>`);
      return at === -1
        ? ""
        : html
            .slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at))
            .replaceAll(tags, " ")
            .replaceAll(spaces, " ")
            .trim();
    };
    const joined = formatDate(daysAgo(3));

    expect({
      statuses: [closedPage, openPage, nobodyPage].map(({ status }) => status),
      closed: {
        anna: rowOfMember(closedPage.html, "Anna de Vries"),
        ben: rowOfMember(closedPage.html, "Ben Okafor").includes("Builder"),
        // No contract is known, so only the seats taken are counted.
        seats: closedPage.html.includes("2 seats taken"),
        toCome: closedPage.html.includes(
          "This section isn’t in the admin yet."
        ),
      },
      open: {
        anna: rowOfMember(openPage.html, "Anna de Vries"),
      },
      nobody: nobodyPage.html.includes("Nobody has made an account yet."),
    }).toStrictEqual({
      statuses: [200, 200, 200],
      closed: {
        anna: `AV Anna de Vries anna@acme.test Ready since ${joined} Role: Admin`,
        ben: true,
        seats: true,
        toCome: false,
      },
      open: {
        anna: `AV Anna de Vries anna@acme.test In since ${joined} Role: Admin`,
      },
      nobody: true,
    });
  });

  it("opens an organization whose core didn't answer on every section, each saying why nothing of it is read and what to do, and its Setup", async () => {
    const down = await liveClient();
    down.core.unhealthy = 1000;
    const waiting = await recordClient("provisioning");
    /** What a section of `client` says, on every section but its Setup. */
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- the test's own, kept beside it; it reads the shared harness
    const sectionsOf = async (client: { clientId: string; name: string }) => {
      const said = [];
      for (const section of orgSections.filter((each) => each !== "setup")) {
        const path = sectionTo[section].replace("$clientId", client.clientId);
        // oxlint-disable-next-line no-await-in-loop -- pages render one at a time
        const { status, html } = await page(path);
        said.push({
          section,
          status,
          title: html.includes(
            `${section === "overview" ? client.name : sectionWords[section].title}</h1>`
          ),
          column:
            columnOf(html, client.name).includes("Details") &&
            columnOf(html, client.name).includes("Not read now"),
          failed: html.includes("This couldn’t be shown"),
          fromCore: ["Needs Grasp", "% known", "From the company"].some(
            (text) => html.includes(text)
          ),
          toSetup: html.includes(
            `href="/organizations/${client.clientId}/setup"`
          ),
          state: [
            "isn’t set up yet",
            "See its Setup progress",
            "’s Grasp didn’t answer",
            "Try again",
          ].filter((text) => html.includes(text)),
        });
      }
      return said;
    };
    const downSections = await sectionsOf(down);
    const waitingSections = await sectionsOf(waiting);
    const downPage = await page(`/organizations/${down.clientId}`);
    const downMembers = await page(
      `/organizations/${down.clientId}/details?tab=members`
    );
    const downSetup = await page(`/organizations/${down.clientId}/setup`);
    const waitingPage = await page(`/organizations/${waiting.clientId}`);

    expect({
      downSections,
      waitingSections,
      downWhy: downPage.html.includes("Its Grasp can’t be read now:"),
      membersWhy: downMembers.html.includes("Its Grasp can’t be read now:"),
      // Its Setup is the admin's own record, read whatever its core does.
      setup: downSetup.html.includes("How it stands"),
      waitingWhy: waitingPage.html.includes(
        "Its Grasp isn’t deployed yet, so there is nothing of it to read."
      ),
    }).toStrictEqual({
      downSections: unread(["’s Grasp didn’t answer", "Try again"]),
      waitingSections: unread(["isn’t set up yet", "See its Setup progress"]),
      downWhy: true,
      membersWhy: true,
      setup: true,
      waitingWhy: true,
    });
  });

  it("says an offboarded organization was offboarded on each of its sections, and leaves it out of the sidebar", async () => {
    const gone = await recordClient("offboarded");

    const shown = [];
    for (const section of ["overview", "details", "setup"] as const) {
      const path = sectionTo[section].replace("$clientId", gone.clientId);
      // oxlint-disable-next-line no-await-in-loop -- pages render one at a time
      const { status, html } = await page(path);
      shown.push({
        status,
        said: html.includes(`${gone.name} was offboarded`),
        toOffboarded: html.includes('href="/platform/offboarded"'),
        inSidebar: sidebarOf(html).includes(gone.name),
      });
    }

    expect(shown).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        status: 200,
        said: true,
        toOffboarded: true,
        inSidebar: false,
      }))
    );
  });

  it("has no page for a section an organization doesn't have", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");

    const missing = await page(`/organizations/${acme.clientId}/nothing`);
    const unknown = await page("/organizations/client-unknown/details");

    expect([missing.status, unknown.status]).toStrictEqual([404, 404]);
  });

  it("gives a request Access doesn't vouch for nothing, asking no core", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");

    const answers = await Promise.all(
      [
        "/",
        "/?phase=ready",
        "/platform",
        "/new-organization",
        `/organizations/${acme.clientId}`,
        `/organizations/${acme.clientId}/contract`,
      ].map(async (path) => {
        const response = await exports.default.fetch(
          `https://ops.grasp.test${path}`
        );
        return { status: response.status, body: await response.text() };
      })
    );

    expect({
      answers,
      readers: acme.core.adminReaders,
    }).toStrictEqual({
      answers: [403, 403, 403, 403, 403, 403].map((status) => ({
        status,
        body: "Forbidden",
      })),
      readers: [],
    });
  });
});
