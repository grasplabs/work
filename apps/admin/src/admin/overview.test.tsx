// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import {
  act,
  answeredAdmin,
  gridRow,
  openAdmin,
  settle,
  summaryOf,
} from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import { daysAgo, readySnapshot, toldSnapshot } from "../../test/snapshots.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";

// The admin's frame and its overview: the sidebar, the table of apps
// asked for, the list of organizations and today's list, from the grid
// and what each core answered (test/admin-pages.test.ts: what the Worker
// reads of them).

const row = (id: string, overrides: Partial<GridRow> = {}): GridRow =>
  gridRow({
    id,
    name: `Acme ${id}`,
    hostname: `${id}.grasp.test`,
    ...overrides,
  });

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

/**
 * The frame's answers: these clients, what their cores answered, and their
 * summaries, nothing needing Grasp in them.
 */
const frameOf = (
  rows: readonly GridRow[],
  admins: readonly ClientAdmin[],
  more: Answers = {}
): Answers => ({
  fetchClientGrid: rows,
  fetchClientAdmins: admins,
  fetchClientSummaries: admins.map((admin) => summaryOf(admin)),
  fetchReadiness: { checks: [], blocking: 0 },
  ...more,
});

/** An app a company asked Grasp for `ago` days ago. */
const asked = (name: string, ago: number) => ({
  id: crypto.randomUUID(),
  name,
  askedAt: daysAgo(ago),
});

/** The text of the overview's row for client `clientId`, in its table of organizations. */
const rowText = (root: Element, clientId: string): string =>
  root
    .querySelector(`main table a[href="/organizations/${clientId}"]`)
    ?.closest("tr")?.textContent ?? "";

/** Why an entry's organization isn't read, as its mark says it: its name, which its tooltip shows. */
const markOf = (entry: Element | undefined): string =>
  entry
    ?.querySelector('[data-slot="sidebar-menu-action"]')
    ?.getAttribute("aria-label") ?? "";

/** The sidebar's entry for `name`, under its organizations. */
const sidebarEntry = (root: Element, name: string): Element | undefined =>
  [...root.querySelectorAll('[data-slot="sidebar"] li')].find((item) =>
    item.textContent?.includes(name)
  );

describe("the admin's frame", () => {
  it("gives staff the admin's own sidebar with every organization, one not read now marked as such, and no other bar", async () => {
    const acme = row("acme");
    const down = row("down");
    const waiting = row("waiting", { status: "provisioning", hostname: null });
    const { container } = await openAdmin(
      "/platform/releases",
      frameOf(
        [acme, down, waiting],
        [
          answeredAdmin({ client: acme }),
          unread(down, "timeout"),
          unread(waiting, "not_deployed"),
        ],
        { fetchReleases: { releases: [], older: null, channelsOn: {} } }
      )
    );
    const sidebar =
      container.querySelector('[data-slot="sidebar"]')?.textContent ?? "";
    const places = [
      "Home",
      "Platform",
      "Apps asked for",
      "Organizations",
      "Labs",
      "Ask Grasp",
      "Stephen Lab",
      "Voice Lab",
    ].map((text) => sidebar.indexOf(text));
    const [acmeEntry, downEntry, waitingEntry] = [acme, down, waiting].map(
      ({ name }) => sidebarEntry(container, name)
    );

    expect({
      placesInOrder:
        places.every((position) => position >= 0) &&
        places.toSorted((a, b) => a - b).every((at, i) => at === places[i]),
      listed: [acmeEntry, downEntry, waitingEntry].map(
        (entry) => entry !== undefined
      ),
      acmeUnread: markOf(acmeEntry).includes("unreachable"),
      downUnreachable: markOf(downEntry).includes("unreachable"),
      waitingNotDeployed: markOf(waitingEntry).includes("not deployed"),
      // The mark explains itself to a pointer, open or folded: its tooltip.
      downExplained:
        downEntry
          ?.querySelector('[data-slot="sidebar-menu-action"]')
          ?.hasAttribute("aria-describedby") ?? false,
      landmarks: [...container.querySelectorAll("aside, nav")].map((each) =>
        each.getAttribute("aria-label")
      ),
      opensAcme:
        container.querySelector('a[href="/organizations/acme"]') !== null,
      oldBar:
        container.querySelector('[aria-label="Console"]') !== null ||
        (container.textContent ?? "").includes("Back to the console"),
    }).toStrictEqual({
      placesInOrder: true,
      listed: [true, true, true],
      acmeUnread: false,
      downUnreachable: true,
      waitingNotDeployed: true,
      downExplained: true,
      // The sidebar, its main list and its organizations each a landmark
      // of their own, then the page's bar and Platform's places.
      landmarks: ["Sidebar", "Main", "Organizations", "Breadcrumb", "Platform"],
      opensAcme: true,
      oldBar: false,
    });
  });

  it("counts and lists what needs Grasp from the summaries alone: a row a kind, naming nothing, with how many, and no core's snapshot read", async () => {
    const acme = row("acme");
    const { container, calls } = await openAdmin("/platform/releases", {
      fetchClientGrid: [acme],
      fetchClientSummaries: [
        summaryOf(answeredAdmin({ client: acme }), [
          { kind: "lead", count: 2 },
          { kind: "read", count: 1 },
        ]),
      ],
      fetchReleases: { releases: [], older: null, channelsOn: {} },
    });
    const inbox = [
      ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].find((tab) => tab.textContent?.includes("Inbox"));
    const tab = inbox?.textContent;
    // Its row on Home, before the Inbox is open.
    const count =
      sidebarEntry(container, acme.name)?.textContent?.includes(
        "3 things need Grasp"
      ) ?? false;
    await act(() => {
      inbox?.click();
    });
    await settle();
    // The Inbox's rows: each leads into Acme's sections.
    const rows = [
      ...container.querySelectorAll(
        '[data-slot="sidebar"] a[href^="/organizations/acme/"]'
      ),
    ].map((link) => [link.textContent?.trim(), link.getAttribute("href")]);

    expect({
      count,
      tab: tab?.includes("3") ?? false,
      rows,
      snapshots: calls.filter(({ fn }) => fn.startsWith("fetchClientAdmin"))
        .length,
    }).toStrictEqual({
      count: true,
      tab: true,
      rows: [
        [
          expect.stringContaining("Team leads who haven’t talked yet"),
          "/organizations/acme/steps",
        ],
        [
          expect.stringContaining("Interviews waiting to be read at Grasp"),
          "/organizations/acme/interviews",
        ],
      ],
      snapshots: 0,
    });
  });

  it("says nothing is asked for yet where the table of apps goes, with nothing to act on", async () => {
    const { container, main } = await openAdmin("/connectors", frameOf([], []));
    const page = container.querySelector("main");
    const heading = page?.querySelector("h1");

    expect({
      title: heading?.textContent,
      nothingAsked: main().includes("Nothing asked for yet"),
      table: page?.querySelector("table") ?? null,
      // Nothing to act on below its title.
      buttons: [...(page?.querySelectorAll("button") ?? [])].filter(
        (button) => button.closest("header") === null
      ).length,
    }).toStrictEqual({
      title: "Apps asked for",
      nothingAsked: true,
      table: null,
      buttons: 0,
    });
  });

  it("lists every app the companies asked Grasp for once, most asked first, and every company's request leading to it", async () => {
    const acme = row("acme");
    const globex = row("globex");
    // Two companies ask for Exact Online, spelled their own way; one asks
    // for Twinfield first.
    const admins = [
      answeredAdmin({
        client: acme,
        snapshot: {
          ...readySnapshot("Acme"),
          asked: [asked("Twinfield", 9), asked("Exact Online", 4)],
        },
      }),
      answeredAdmin({
        client: globex,
        snapshot: {
          ...readySnapshot("Globex"),
          asked: [asked("exact  online", 2)],
        },
      }),
    ];
    const apps = await openAdmin(
      "/connectors",
      frameOf([acme, globex], admins)
    );
    const table = apps.container.querySelector("main table");
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];
    const rowOf = (key: string) =>
      table?.querySelector(`a[href="/connectors?app=${key}"]`)?.closest("tr")
        ?.textContent ?? "";
    const text = table?.textContent ?? "";
    const sidebar =
      apps.container.querySelector('[data-slot="sidebar"]')?.textContent ?? "";
    const company = await openAdmin(
      "/organizations/globex/connectors",
      frameOf([acme, globex], admins, { fetchClientAdmin: admins[1] })
    );

    expect({
      rows: rows.length,
      links: ["exact-online", "twinfield"].map(
        (key) =>
          table?.querySelector(`a[href="/connectors?app=${key}"]`) !== null
      ),
      order: text.indexOf("Exact Online") < text.indexOf("Twinfield"),
      exact: rowOf("exact-online").includes(`${acme.name} and ${globex.name}`),
      twinfield: rowOf("twinfield").includes(acme.name),
      // Each company's requests added up, as the summaries count them.
      sidebar: sidebar.includes("3 apps asked for"),
      nothingAsked: apps.main().includes("Nothing asked for yet"),
      companyAsked:
        company.container.querySelector(
          'main a[href="/connectors?app=exact-online"]'
        ) !== null,
      companyWords: company.main().includes("Asked of Grasp"),
    }).toStrictEqual({
      rows: 2,
      links: [true, true],
      order: true,
      exact: true,
      twinfield: true,
      sidebar: true,
      nothingAsked: false,
      companyAsked: true,
      companyWords: true,
    });
  });
});

describe("the admin's overview", () => {
  it("lists every organization: one that answered with where it stands and what needs Grasp, one that didn't with why and no numbers", async () => {
    const acme = row("acme");
    const down = row("down");
    const waiting = row("waiting", { status: "provisioning", hostname: null });
    const { container, main } = await openAdmin(
      "/",
      frameOf(
        [acme, down, waiting],
        [
          answeredAdmin({ client: acme, snapshot: readySnapshot("Acme") }),
          unread(down, "timeout"),
          unread(waiting, "not_deployed"),
        ],
        {
          // Acme's summary: its core counts three things needing Grasp.
          fetchClientSummaries: [
            summaryOf(answeredAdmin({ client: acme }), [
              { kind: "go", count: 1 },
              { kind: "agreement", count: 2 },
            ]),
            summaryOf(unread(down, "timeout")),
            summaryOf(unread(waiting, "not_deployed")),
          ],
        }
      )
    );
    const page = container.querySelector("main");
    const acmeRow = rowText(container, acme.id);
    const downRow = rowText(container, down.id);
    const waitingRow = rowText(container, waiting.id);
    const tileOf = (label: string) =>
      [...(page?.querySelectorAll("span") ?? [])]
        .find((span) => span.textContent === label)
        ?.closest("div")?.textContent ?? "";

    expect({
      title: page?.querySelector("h1")?.textContent,
      acme: [
        "Agreed",
        "Not signed yet",
        "85% known. Ready for Grasp’s go",
        "Not known yet",
      ].map((text) => acmeRow.includes(text)),
      acmeNeeds: container
        .querySelector(`main table a[href="/organizations/acme"]`)
        ?.closest("tr")
        ?.querySelector(".text-status-attention.tabular-nums")?.textContent,
      acmeNamed: acmeRow.includes(acme.name),
      goToGive: main().includes(
        "85% of what Grasp needs is known: enough to open at 80%. The company comes in once Grasp gives its go."
      ),
      noTranscript: !main().includes("Bring in the first conversation"),
      down: {
        named: downRow.includes(down.name),
        why: downRow.includes("Unreachable"),
        numbers: ["% known", "Being written", "€"].some((text) =>
          downRow.includes(text)
        ),
      },
      waiting: {
        named: waitingRow.includes(waiting.name),
        why: waitingRow.includes("Not deployed"),
        numbers: ["% known", "Being written", "€"].some((text) =>
          waitingRow.includes(text)
        ),
      },
      counted: main().includes(
        "Counted from the 1 that answered now: 2 didn’t, and aren’t in these numbers."
      ),
      unknownSums: ["Under contract", "Hours a week freed"].map((label) =>
        tileOf(label).includes("—")
      ),
      acmeCount: sidebarEntry(container, acme.name)?.textContent?.includes(
        "3 things need Grasp"
      ),
    }).toStrictEqual({
      title: "Organizations",
      acme: [true, true, true, true],
      acmeNeeds: "3",
      acmeNamed: true,
      goToGive: true,
      noTranscript: true,
      down: { named: true, why: true, numbers: false },
      waiting: { named: true, why: true, numbers: false },
      counted: true,
      unknownSums: [true, false],
      acmeCount: true,
    });
  });

  it("says when Grasp paused the interviews, and marks where Grasp opens even at the last dot", async () => {
    const paused = row("paused");
    const told = toldSnapshot("Paused", {
      days: 14,
      daysIn: 3,
      leadTalked: true,
    });
    const { container, main } = await openAdmin(
      "/",
      frameOf(
        [paused],
        [
          answeredAdmin({
            client: paused,
            snapshot: {
              ...told,
              paused: true,
              gate: { ...told.gate, threshold: 98 },
            },
          }),
        ]
      )
    );
    const tableRow = container
      .querySelector(`main table a[href="/organizations/paused"]`)
      ?.closest("tr");

    expect({
      paused: main().includes(
        "The interviews are paused: nobody can open or finish theirs until Grasp resumes them."
      ),
      // The one mark where Grasp opens, after the last of the dots.
      marks: tableRow?.querySelectorAll(".h-3\\.5.w-px").length,
    }).toStrictEqual({ paused: true, marks: 1 });
  });

  it("puts every organization's most pressing need in today's list before any one's next", async () => {
    // Three needs each: nine, past the eight the list shows.
    const companies = ["Acme", "Birch", "Cobalt"].map((name) => ({
      name,
      row: row(name.toLowerCase(), { name }),
    }));
    const { container } = await openAdmin(
      "/",
      frameOf(
        companies.map(({ row: each }) => each),
        companies.map(({ name, row: each }) =>
          answeredAdmin({ client: each, snapshot: readySnapshot(name) })
        )
      )
    );
    const opens = [
      ...container.querySelectorAll(
        'section[aria-label="Needs Grasp today"] li a'
      ),
    ].map((link) => link.getAttribute("aria-label") ?? "");

    expect(
      companies.map(({ name }, index) =>
        (opens[index] ?? "").startsWith(`Open at ${name}:`)
      )
    ).toStrictEqual([true, true, true]);
  });

  it("puts a live organization's failed deploy and its falling behind first in today's list, each opening its Setup", async () => {
    const releaseId = "2026.11.20-1";
    const failing = row("failing", {
      name: "Failing",
      rollout: {
        failed: { releaseId, error: "attempt_lost: core" },
        behind: 3,
        channelStopped: null,
      },
    });
    const current = row("current", { name: "Current" });
    const { container } = await openAdmin(
      "/",
      frameOf(
        [failing, current],
        [
          answeredAdmin({
            client: failing,
            snapshot: readySnapshot("Failing"),
          }),
          answeredAdmin({
            client: current,
            snapshot: readySnapshot("Current"),
          }),
        ]
      )
    );
    const today = container.querySelector(
      'section[aria-label="Needs Grasp today"]'
    );
    const items = [...(today?.querySelectorAll("li") ?? [])].map((item) => ({
      text: item.textContent ?? "",
      setup: [...item.querySelectorAll("a")].some((link) =>
        (link.getAttribute("href") ?? "").endsWith("/setup")
      ),
    }));
    const at = (name: string) =>
      items.filter(({ text }) => text.includes(name));

    expect({
      failing: at("Failing")
        .slice(0, 2)
        .map(({ text, setup }) => ({
          deploy: text.includes(
            `Its deploy of ${releaseId} failed (attempt_lost: core). Retry it on its Setup once what stopped it is fixed.`
          ),
          behind: text.includes(
            "It runs 3 releases behind the one it should. Look at its Setup."
          ),
          setup,
        })),
      current: at("Current").some(({ setup }) => setup),
    }).toStrictEqual({
      failing: [
        { deploy: true, behind: false, setup: true },
        { deploy: false, behind: true, setup: true },
      ],
      current: false,
    });
  });
});

describe("the overview's counts and filters", () => {
  it("counts only leads who talked, and the days of each company's own plan", async () => {
    const waiting = row("waiting");
    const talking = row("talking");
    const { container } = await openAdmin(
      "/",
      frameOf(
        [waiting, talking],
        [
          answeredAdmin({
            client: waiting,
            snapshot: toldSnapshot("Waiting", {
              days: 21,
              daysIn: 3,
              leadTalked: false,
            }),
          }),
          answeredAdmin({
            client: talking,
            snapshot: toldSnapshot("Talking", {
              days: 21,
              daysIn: 3,
              leadTalked: true,
            }),
          }),
        ]
      )
    );

    expect({
      // Tom's link went out without Lisa: she still hasn't talked.
      waiting: rowText(container, "waiting").includes("0 of 1 talked"),
      // Three weeks, as its plan has it.
      talking: rowText(container, "talking").includes(" of 21. "),
    }).toStrictEqual({ waiting: true, talking: true });
  });

  it("counts an organization's days to its own plan over its page", async () => {
    const company = row("company");
    const admin = answeredAdmin({
      client: company,
      snapshot: toldSnapshot("Company", {
        days: 21,
        daysIn: 3,
        leadTalked: true,
      }),
    });
    const { container } = await openAdmin(
      "/organizations/company",
      frameOf([company], [], { fetchClientAdmin: admin })
    );

    // Over its page, under its title, on every section.
    expect(container.querySelector("main")?.textContent).toMatch(
      /Day \d+ of 21/u
    );
  });

  it("shows only the organizations in a phase when one is chosen", async () => {
    const acme = row("acme");
    const empty = row("empty");
    const waiting = row("waiting", { status: "provisioning", hostname: null });
    const answers = frameOf(
      [acme, empty, waiting],
      [
        answeredAdmin({ client: acme, snapshot: readySnapshot("Acme") }),
        answeredAdmin({ client: empty }),
        unread(waiting, "not_deployed"),
      ]
    );
    const listed = (root: Element) =>
      ["acme", "empty", "waiting"].map((id) => rowText(root, id) !== "");
    const ready = await openAdmin("/?phase=ready", answers);
    const readyRows = listed(ready.container);
    const agreements = await openAdmin("/?phase=agreements", answers);

    expect({
      ready: readyRows,
      agreements: listed(agreements.container),
    }).toStrictEqual({
      ready: [true, false, false],
      agreements: [false, true, false],
    });
  });

  it("opens an organization the admin knows, even one named like one of the admin's places", async () => {
    const acme = row("acme");
    // Named like one of the admin's sections, and still its own page.
    const platform = row("platform", {
      status: "provisioning",
      hostname: null,
    });
    const answers = frameOf([acme, platform], [], {
      fetchClientAdmin: (data: unknown) =>
        JSON.stringify(data).includes("platform")
          ? unread(platform, "not_deployed")
          : answeredAdmin({ client: acme }),
      fetchClientSetup: null,
      fetchPinChoices: { releases: [] },
      fetchClientHosting: null,
      fetchProvisioningProgress: null,
      fetchClientAiStatus: null,
    });
    const known = await openAdmin("/organizations/acme", answers);
    const knownTitle = known.container.querySelector("main h1")?.textContent;
    const named = await openAdmin("/organizations/platform", answers);

    expect({
      known: knownTitle,
      named: named.container.querySelector("main h1")?.textContent,
    }).toStrictEqual({ known: acme.name, named: platform.name });
  });

  it("offers to add an organization from the overview, asking its name, web address, email domain, first admin and hosting", async () => {
    const overview = await openAdmin("/", frameOf([], []));
    const link =
      overview.container.querySelector('a[href="/new-organization"]') !== null;
    const { container, main } = await openAdmin(
      "/new-organization",
      frameOf([], [], { fetchCreateOptions: { clientDomain: "grasp.test" } })
    );

    expect({
      link,
      title: container.querySelector("main h1")?.textContent,
      labels: [
        "Name",
        "Web address",
        "Company email domain",
        "First admin's email",
        "Grasp Cloud",
        "On-premises",
        "Keep data in the EU",
      ].map((text) => main().includes(text)),
      // Its platform's domain after the web address.
      suffix: main().includes(".grasp.test"),
    }).toStrictEqual({
      link: true,
      title: "New organization",
      labels: [true, true, true, true, true, true, true],
      suffix: true,
    });
  });
});
