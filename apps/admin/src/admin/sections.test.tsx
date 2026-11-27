// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  answeredAdmin,
  gridRow,
  loadPages,
  openAdmin,
} from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import { daysAgo, emptyAdminSnapshot } from "../../test/snapshots.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import { orgSections, sectionTo, sectionWords } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { formatDate } from "./words.ts";

// An organization's integrations, workflows and members, and its sections
// when its core didn't answer or it was offboarded, as the Worker answers
// them (test/client-admins.test.ts reads them).

/**
 * Every organization page's code, loaded before a block's first test: most
 * of a page's first opening was loading and transforming its code (its
 * charts, its controls), and nearly every test here opens a page the file
 * hasn't opened yet. That load is the file's, not a test's: on a busy
 * machine it took up to 18 s, so it has a limit of its own. The second
 * block finds it all loaded.
 */
const loadOrganizationPages = async (): Promise<void> => {
  await loadPages("/organizations/$clientId");
};
const loadMs = 30_000;

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
    notReported: headings.has("Its connections aren’t reported"),
    asked: headings.has("Asked of Grasp"),
    source: main.includes(
      "What the company connected: the company’s own Grasp doesn’t hold it yet. What its workflows still need connected: from Composio, once it is connected."
    ),
    toCome: main.includes("This section isn’t in the admin yet."),
  };
};

/** The facts of the member named `name`, as their row in the members' table says them. */
const memberOf = (root: Element, name: string): string[] => {
  const row = [...root.querySelectorAll("main tr")].find(
    (each) => each.querySelector("th")?.textContent === name
  );
  return [...(row?.querySelectorAll("td") ?? [])].map(
    (cell) => cell.textContent ?? ""
  );
};

/** The members' figure labelled `label`: its value, then what it says under it. */
const memberFigureOf = (root: Element, label: string): string[] => {
  const name = [...root.querySelectorAll('[aria-label="Its members"] p')].find(
    (element) => element.textContent === label
  );
  const figures = name?.parentElement?.nextElementSibling;
  return [...(figures?.children ?? [])].map((part) => part.textContent ?? "");
};

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

/** Every section but the Setup, the admin's own record, read whatever its core does. */
const coreSections = orgSections.filter((each) => each !== "setup");

const downRow = gridRow({ id: "down", name: "Down" });
const downAdmin = unread(downRow, "timeout");
const waitingRow = gridRow({
  id: "waiting",
  name: "Waiting",
  status: "provisioning",
  hostname: null,
});
const waitingAdmin = unread(waitingRow, "not_deployed");

/** What `section` of `client` says, its core not read as `admin` has it. */
const sectionOf = async (
  client: GridRow,
  admin: ClientAdmin,
  section: OrgSection
) => {
  const path = sectionTo[section].replace(`/organizations/$clientId`, "");
  const { container, main } = await openAt(client, admin, path);
  const page = main();
  const column = container.querySelector(
    `nav[aria-label="${client.name}"]`
  )?.textContent;
  return {
    title:
      container.querySelector("main h1")?.textContent ===
      (section === "overview" ? client.name : sectionWords[section].title),
    // Its sections in the sidebar's level, and over each one how it
    // stands: not answering, or being set up.
    column:
      (column?.includes("Details") ?? false) &&
      ["Not answering", "Being set up"].some((words) => page.includes(words)),
    failed: page.includes("This couldn’t be shown"),
    fromCore: [
      "What else needs Grasp",
      "People active last week",
      "Talked",
      "From the company",
    ].some((words) => page.includes(words)),
    toSetup:
      container.querySelector(
        `main a[href="/organizations/${client.id}/setup"]`
      ) !== null,
    state: [
      "isn’t set up yet",
      "See how its setting up goes",
      "’s Grasp didn’t answer",
      "Try again",
    ].filter((words) => page.includes(words)),
  };
};

/** What a section says of a client not read, in `state`'s words. */
const expected = (state: string[]) => ({
  title: true,
  column: true,
  failed: false,
  fromCore: false,
  toSetup: true,
  state,
});

describe("an organization's integrations, workflows and members", () => {
  beforeAll(loadOrganizationPages, loadMs);

  it.each([
    {
      when: "before it signed in",
      snapshot: emptyAdminSnapshot("Before"),
      says: { nothing: true, waits: true, notReported: false },
    },
    {
      when: "once it signed in",
      snapshot: signedIn(emptyAdminSnapshot("Signed")),
      says: { nothing: false, waits: false, notReported: true },
    },
  ])(
    "shows nothing connected before a company signed in, and that core doesn't report its connections once it has ($when), with the apps it asked Grasp for either way",
    async ({ snapshot, says }) => {
      const { container } = await openAcme("/connectors", {
        ...snapshot,
        asked: [{ id: "asked-1", name: "Exact Online", askedAt: daysAgo(2) }],
      });

      expect(integrationsOf(container)).toStrictEqual({
        ...says,
        asked: true,
        source: true,
        toCome: false,
      });
    }
  );

  const crmSync = { id: "workflow-crm", name: "CRM sync" };
  /** As core sends it once a workflow's HubSpot was disconnected. */
  const disconnected: AdminSnapshot = {
    ...signedIn(emptyAdminSnapshot("Acme")),
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

  it("shows what a company connected, and the app a workflow is bound to that isn't connected any more", async () => {
    const integrations = await openAcme("/connectors", disconnected);
    const page = integrations.main();

    expect({
      drive: page.includes(`${formatDate(daysAgo(3))}, by Anna de Vries`),
      tools: page.includes("1 tool its admin allowed"),
      microsoft: page.includes("4 people"),
      again: page.includes("1 to sign in again"),
      // Core sends the toolkit's slug, not the catalog's name for it.
      hubspot: page.includes("Hubspot"),
      forCrmSync: page.includes("For CRM sync"),
      notConnected: page.includes("Not connected"),
      asked: page.includes(
        `Asked for in 2 chats since ${formatDate(daysAgo(1))}, waiting on the person in the chat`
      ),
      notReported: page.includes("doesn’t report"),
    }).toStrictEqual({
      drive: true,
      tools: true,
      microsoft: true,
      again: true,
      hubspot: true,
      forCrmSync: true,
      notConnected: true,
      asked: true,
      notReported: false,
    });
  });

  it("shows the workflow waiting on an app that isn't connected any more", async () => {
    const workflows = await openAcme("/workflows", disconnected);
    const waiting = workflows.main();

    expect({
      waiting: waiting.includes("Waiting on a connection"),
      crm: waiting.includes("crm: Hubspot, not connected"),
      mail: waiting.includes("mail: No connection approved yet"),
    }).toStrictEqual({ waiting: true, crm: true, mail: true });
  });

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
  const joined = formatDate(members[0]?.joinedAt ?? "");

  it("lists an organization's members with where each stands and their role, ready before Grasp opens", async () => {
    const closed = await openAcme("/details?tab=members", {
      ...empty,
      members,
    });

    expect({
      anna: memberOf(closed.container, "Anna de Vries"),
      ben: memberOf(closed.container, "Ben Okafor").includes("Builder"),
      // No contract is known, so only the seats taken are counted.
      seats: memberFigureOf(closed.container, "Seats taken"),
      // A row writes to the member.
      writes: closed.container
        .querySelector('main a[aria-label="Write to Anna de Vries"]')
        ?.getAttribute("href"),
      toCome: closed.main().includes("This section isn’t in the admin yet."),
    }).toStrictEqual({
      anna: ["anna@acme.test", `Ready since ${joined}`, "Admin"],
      ben: true,
      seats: ["2", "No contract known yet"],
      writes: "mailto:anna@acme.test",
      toCome: false,
    });
  });

  it("lists an organization's members as in once Grasp opened", async () => {
    const open = await openAcme("/details?tab=members", {
      ...empty,
      members,
      gate: { ...empty.gate, open: true, openedAt: empty.now },
    });

    expect(memberOf(open.container, "Anna de Vries")).toStrictEqual([
      "anna@acme.test",
      `In since ${joined}`,
      "Admin",
    ]);
  });

  it("says when nobody of an organization has made an account yet", async () => {
    const nobody = await openAcme("/details?tab=members", empty);

    expect(nobody.main()).toContain("Nobody has made an account yet.");
  });
});

describe("an organization's sections without its core", () => {
  beforeAll(loadOrganizationPages, loadMs);

  // One page a test: a busy machine slows each page down, so a test that
  // opened several took several times as long.
  const unreadOnes = [
    {
      which: "an organization whose core didn't answer",
      client: downRow,
      admin: downAdmin,
      state: ["’s Grasp didn’t answer", "Try again"],
    },
    {
      which: "one not deployed yet",
      client: waitingRow,
      admin: waitingAdmin,
      state: ["isn’t set up yet", "See how its setting up goes"],
    },
  ];

  it.each(
    coreSections.flatMap((section) =>
      unreadOnes.map((unreadOne) => ({ section, ...unreadOne }))
    )
  )(
    "opens its $section for $which, saying why nothing of it is read and what to do",
    async ({ section, client, admin, state }) => {
      await expect(sectionOf(client, admin, section)).resolves.toStrictEqual(
        expected(state)
      );
    }
  );

  it.each([
    {
      page: "the page of an organization whose core didn't answer",
      client: downRow,
      admin: downAdmin,
      path: "",
      says: "Its Grasp can’t be read now:",
    },
    {
      page: "its members",
      client: downRow,
      admin: downAdmin,
      path: "/details?tab=members",
      says: "Its Grasp can’t be read now:",
    },
    {
      page: "the page of one not deployed yet",
      client: waitingRow,
      admin: waitingAdmin,
      path: "",
      says: "Its Grasp isn’t deployed yet, so there is nothing of it to read.",
    },
  ])(
    "says why it can't be read on $page",
    async ({ client, admin, path, says }) => {
      const { main } = await openAt(client, admin, path);

      expect(main()).toContain(says);
    }
  );

  it("opens the Setup of an organization whose core didn't answer: the admin's own record, read whatever its core does", async () => {
    const { main } = await openAt(downRow, downAdmin, "/setup");

    expect(main()).toContain("Setup");
  });

  const gone = gridRow({ id: "gone", name: "Gone", status: "offboarded" });

  it.each(["", "/details", "/setup"])(
    "says an offboarded organization was offboarded on its page at '%s', and leaves it out of the sidebar",
    async (path) => {
      const { container, main } = await openAt(gone, null, path);
      const sidebar =
        container.querySelector('[data-slot="sidebar"]')?.textContent ?? "";

      expect({
        said: main().includes(`${gone.name} was offboarded`),
        toOffboarded:
          container.querySelector('main a[href="/platform/offboarded"]') !==
          null,
        inSidebar: sidebar.includes(gone.name),
      }).toStrictEqual({ said: true, toOffboarded: true, inSidebar: false });
    }
  );

  it("has no page for a section an organization doesn't have", async () => {
    const missing = await openAt(
      acme,
      answeredAdmin({ client: acme }),
      "/nothing"
    );

    expect(missing.main()).toContain("This page is not here");
  });

  it("has no page for an organization the admin doesn't know", async () => {
    const unknown = await openAdmin("/organizations/client-unknown/details", {
      fetchClientGrid: [acme],
      fetchClientAdmin: null,
    });

    expect(unknown.main()).toContain("This page is not here");
  });
});
