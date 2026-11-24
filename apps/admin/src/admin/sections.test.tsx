// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import { answeredAdmin, gridRow, openAdmin } from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import { daysAgo, emptyAdminSnapshot } from "../../test/snapshots.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import { orgSections, sectionTo, sectionWords } from "./sections.ts";
import { formatDate } from "./words.ts";

// An organization's integrations, workflows and members, and its sections
// when its core didn't answer or it was offboarded, as the Worker answers
// them (test/client-admins.test.ts reads them).

const acme = gridRow({ id: "acme", name: "Acme" });

/** What the sections that read beside the snapshot get: nothing yet. */
const sectionAnswers: Answers = {
  fetchClientSetup: null,
  fetchPinChoices: { releases: [] },
  fetchClientHosting: null,
  fetchProvisioningProgress: null,
  fetchClientAiStatus: null,
  fetchOrganizationTrail: [],
  fetchBrainReport: null,
};

/** `client`'s page at `path`, under its own, as `admin` answered. */
const openAt = async (client: GridRow, admin: ClientAdmin | null, path = "") =>
  await openAdmin(`/organizations/${client.id}${path}`, {
    fetchClientGrid: [client],
    fetchClientAdmin: admin,
    ...sectionAnswers,
  });

/** Acme's page at `path`, its core having answered `snapshot`. */
const openAcme = async (path: string, snapshot: AdminSnapshot) =>
  await openAt(acme, answeredAdmin({ client: acme, snapshot }), path);

/** Past its sign-in: its directory is in, every team's lead named. */
const signedIn = (snapshot: AdminSnapshot): AdminSnapshot => ({
  ...snapshot,
  roster: {
    teams: [{ id: "sales", name: "Sales", lead: "lea", does: "", off: false }],
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
});

/** What an Integrations section says, part by part. */
const integrationsOf = (root: Element) => {
  const main = root.querySelector("main")?.textContent ?? "";
  const headings = new Set(
    [...root.querySelectorAll("main h2")].map((heading) => heading.textContent)
  );
  return {
    nothing: headings.has("Nothing connected yet"),
    waits: main.includes("Grasp waits on the company’s own admin."),
    connected: headings.has("What the company connected"),
    notReported: main.includes(
      "The company’s own Grasp doesn’t report what it connected yet."
    ),
    stillToConnect: headings.has("Still to connect"),
    needsNotReported: main.includes(
      "The company’s own Grasp doesn’t report what its workflows need yet."
    ),
    source: main.includes(
      "What the company connected: the company’s own Grasp doesn’t hold it yet. What its workflows still need connected: from Composio, once it is connected."
    ),
    toCome: main.includes("This section isn’t in the admin yet."),
  };
};

/** The text of the list item naming `name`. */
const memberOf = (root: Element, name: string): string =>
  [...root.querySelectorAll("main li")].find((each) =>
    [...each.querySelectorAll("span")].some((span) => span.textContent === name)
  )?.textContent ?? "";

/** A client whose core doesn't answer now (`error`), never having answered. */
const unread = (
  client: GridRow,
  error: "timeout" | "not_deployed"
): ClientAdmin => ({
  client,
  state: "unreachable",
  lastAnsweredAt: null,
  error,
});

/** What every section but the Setup says of a client not read, in `state`'s words. */
const expected = (state: string[]) =>
  orgSections
    .filter((each) => each !== "setup")
    .map((section) => ({
      section,
      title: true,
      column: true,
      failed: false,
      fromCore: false,
      toSetup: true,
      state,
    }));

describe("an organization's integrations, workflows and members", () => {
  it("shows what a company connected only once it signed in, says core doesn't report its connections yet, and that what is still to connect comes from Composio", async () => {
    const before = await openAcme(
      "/integrations",
      emptyAdminSnapshot("Before")
    );
    const beforeSays = integrationsOf(before.container);
    const signed = await openAcme(
      "/integrations",
      signedIn(emptyAdminSnapshot("Signed"))
    );

    expect({
      before: beforeSays,
      signed: integrationsOf(signed.container),
    }).toStrictEqual({
      before: {
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
    const crmSync = { id: "workflow-crm", name: "CRM sync" };
    const snapshot: AdminSnapshot = {
      ...signedIn(emptyAdminSnapshot("Acme")),
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
    const integrations = await openAcme("/integrations", snapshot);
    const page = integrations.main();
    const workflows = await openAcme("/workflows", snapshot);
    const waiting = workflows.main();

    expect({
      drive: page.includes(
        `Connected by Anna de Vries on ${formatDate(daysAgo(3))}.`
      ),
      microsoft: page.includes("4 people connected their own"),
      again: page.includes("1 needs signing in again"),
      // Core sends the toolkit's slug, not the catalog's name for it.
      hubspot: page.includes("Hubspot"),
      forCrmSync: page.includes("For CRM sync"),
      notConnected: page.includes("Not connected"),
      asked: page.includes(
        `Asked for in 2 chats since ${formatDate(daysAgo(1))}, waiting on the person in the chat`
      ),
      notReported: page.includes("doesn’t report"),
      waiting: waiting.includes("Waiting on a connection"),
      crm: waiting.includes("crm: Hubspot, not connected"),
      mail: waiting.includes("mail: No connection approved yet"),
    }).toStrictEqual({
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
    const closed = await openAcme("/details?tab=members", {
      ...empty,
      members,
    });
    const closedSays = {
      anna: memberOf(closed.container, "Anna de Vries"),
      ben: memberOf(closed.container, "Ben Okafor").includes("Builder"),
      // No contract is known, so only the seats taken are counted.
      seats: closed.main().includes("2 seats taken"),
      toCome: closed.main().includes("This section isn’t in the admin yet."),
    };
    const open = await openAcme("/details?tab=members", {
      ...empty,
      members,
      gate: { ...empty.gate, open: true, openedAt: empty.now },
    });
    const openSays = { anna: memberOf(open.container, "Anna de Vries") };
    const nobody = await openAcme("/details?tab=members", empty);
    const joined = formatDate(daysAgo(3));

    expect({
      closed: closedSays,
      open: openSays,
      nobody: nobody.main().includes("Nobody has made an account yet."),
    }).toStrictEqual({
      closed: {
        anna: `AVAnna de Vriesanna@acme.testReady since ${joined}Role: Admin`,
        ben: true,
        seats: true,
        toCome: false,
      },
      open: {
        anna: `AVAnna de Vriesanna@acme.testIn since ${joined}Role: Admin`,
      },
      nobody: true,
    });
  });
});

describe("an organization's sections without its core", () => {
  it(
    "opens an organization whose core didn't answer on every section, each saying why nothing of it is read and what to do, and its Setup",
    // Room for every section of two organizations, opened one after
    // another, to fail on what a page shows, not on time.
    { timeout: 15_000 },
    async () => {
      const down = gridRow({ id: "down", name: "Down" });
      const waiting = gridRow({
        id: "waiting",
        name: "Waiting",
        status: "provisioning",
        hostname: null,
      });
      /** What each section of `client` says, but its Setup. */
      const sectionsOf = async (client: GridRow, admin: ClientAdmin) => {
        const said = [];
        for (const section of orgSections.filter((each) => each !== "setup")) {
          const path = sectionTo[section].replace(
            `/organizations/$clientId`,
            ""
          );
          // oxlint-disable-next-line no-await-in-loop -- one page at a time, as one tab opens them
          const { container, main } = await openAt(client, admin, path);
          const page = main();
          const column = container.querySelector(
            `nav[aria-label="${client.name}"]`
          )?.textContent;
          said.push({
            section,
            title:
              container.querySelector("main h1")?.textContent ===
              (section === "overview"
                ? client.name
                : sectionWords[section].title),
            column:
              (column?.includes("Details") ?? false) &&
              (column?.includes("Not read now") ?? false),
            failed: page.includes("This couldn’t be shown"),
            fromCore: ["Needs Grasp", "% known", "From the company"].some(
              (words) => page.includes(words)
            ),
            toSetup:
              container.querySelector(
                `main a[href="/organizations/${client.id}/setup"]`
              ) !== null,
            state: [
              "isn’t set up yet",
              "See its Setup progress",
              "’s Grasp didn’t answer",
              "Try again",
            ].filter((words) => page.includes(words)),
          });
        }
        return said;
      };
      const downAdmin = unread(down, "timeout");
      const waitingAdmin = unread(waiting, "not_deployed");
      const downSections = await sectionsOf(down, downAdmin);
      const waitingSections = await sectionsOf(waiting, waitingAdmin);
      const downPage = await openAt(down, downAdmin);
      const downWhy = downPage.main();
      const membersPage = await openAt(down, downAdmin, "/details?tab=members");
      const membersWhy = membersPage.main();
      const setupPage = await openAt(down, downAdmin, "/setup");
      const setup = setupPage.main();
      const waitingPage = await openAt(waiting, waitingAdmin);
      const waitingWhy = waitingPage.main();

      expect({
        downSections,
        waitingSections,
        downWhy: downWhy.includes("Its Grasp can’t be read now:"),
        membersWhy: membersWhy.includes("Its Grasp can’t be read now:"),
        // Its Setup is the admin's own record, read whatever its core does.
        setup: setup.includes("Setup"),
        waitingWhy: waitingWhy.includes(
          "Its Grasp isn’t deployed yet, so there is nothing of it to read."
        ),
      }).toStrictEqual({
        downSections: expected(["’s Grasp didn’t answer", "Try again"]),
        waitingSections: expected([
          "isn’t set up yet",
          "See its Setup progress",
        ]),
        downWhy: true,
        membersWhy: true,
        setup: true,
        waitingWhy: true,
      });
    }
  );

  it("says an offboarded organization was offboarded on each of its sections, and leaves it out of the sidebar", async () => {
    const gone = gridRow({ id: "gone", name: "Gone", status: "offboarded" });

    const shown = [];
    for (const path of ["", "/details", "/setup"]) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time, as one tab opens them
      const { container, main } = await openAt(gone, null, path);
      const sidebar =
        container.querySelector('[data-slot="sidebar"]')?.textContent ?? "";
      shown.push({
        said: main().includes(`${gone.name} was offboarded`),
        toOffboarded:
          container.querySelector('main a[href="/platform/offboarded"]') !==
          null,
        inSidebar: sidebar.includes(gone.name),
      });
    }

    expect(shown).toStrictEqual(
      Array.from({ length: 3 }, () => ({
        said: true,
        toOffboarded: true,
        inSidebar: false,
      }))
    );
  });

  it("has no page for a section an organization doesn't have, nor for an organization the admin doesn't know", async () => {
    const missing = await openAt(
      acme,
      answeredAdmin({ client: acme }),
      "/nothing"
    );
    // Read before the next page opens: one page at a time.
    const missingSays = missing.main();
    const unknown = await openAdmin("/organizations/client-unknown/details", {
      fetchClientGrid: [acme],
      fetchClientAdmin: null,
    });

    expect(
      [missingSays, unknown.main()].map((main) =>
        main.includes("This page is not here")
      )
    ).toStrictEqual([true, true]);
  });
});
