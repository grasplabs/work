import type { AdminSummary } from "@grasp-os/shared/admin-summary";
// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import {
  act,
  answeredAdmin,
  answeredSummary,
  gridRow,
  openAdmin,
  settle,
  summaryOf,
  until,
} from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import { daysAgo, readySnapshot, toldSnapshot } from "../../test/snapshots.ts";
import type { ClientAdmin } from "../clients/admin.ts";
import type { GridRow } from "../clients/grid.ts";
import type { ClientSummary } from "../clients/summary.ts";
import type { PlatformSpend } from "./platform-spend-sums.ts";

// The admin's frame and its Home: the sidebar, the table of apps asked
// for, and Home's figures, what needs Grasp and every organization, from
// the grid and each organization's summary (test/admin-pages.test.ts:
// what the Worker reads of them).

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
  fetchPlatformSpend: null,
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

  it("reads what needs Grasp at a core from before the summary in full, and asks first for its update", async () => {
    const ready = row("ready");
    const { container } = await openAdmin("/platform/releases", {
      fetchClientGrid: [ready],
      fetchClientSummaries: [
        {
          client: ready,
          state: "older",
          admin: answeredAdmin({
            client: ready,
            snapshot: readySnapshot("Ready"),
          }),
        },
      ],
      fetchReleases: { releases: [], older: null, channelsOn: {} },
    });
    const counted =
      sidebarEntry(container, ready.name)?.textContent?.includes(
        "things need Grasp"
      ) ?? false;
    const inbox = [
      ...container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].find((tab) => tab.textContent?.includes("Inbox"));
    await act(() => {
      inbox?.click();
    });
    await settle();
    const lines = [
      ...container.querySelectorAll(
        '[data-slot="sidebar"] a[href^="/organizations/ready/"]'
      ),
    ].map((link) => [link.textContent ?? "", link.getAttribute("href")]);

    expect({
      counted,
      first: lines[0],
      // Said in full, as its snapshot has it.
      go: lines.some(([line]) =>
        (line ?? "").includes("85% of what Grasp needs is known")
      ),
    }).toStrictEqual({
      counted: true,
      first: [
        expect.stringContaining("Update to see its counts"),
        "/organizations/ready/setup",
      ],
      go: true,
    });
  });

  it("leaves out of the Apps asked for count a company that doesn't share it", async () => {
    const acme = row("acme");
    const ended = row("ended");
    const shared = answeredSummary({ client: acme, asked: 2 });
    const notShared = answeredSummary({ client: ended, asked: 5 });
    const { container } = await openAdmin("/platform/releases", {
      fetchClientGrid: [acme, ended],
      fetchClientSummaries: [
        shared,
        notShared.state === "answered"
          ? {
              ...notShared,
              summary: { ...notShared.summary, asked: null, activity: null },
            }
          : notShared,
      ],
      fetchReleases: { releases: [], older: null, channelsOn: {} },
    });
    const sidebar =
      container.querySelector('[data-slot="sidebar"]')?.textContent ?? "";

    expect(sidebar).toContain("2 apps asked for");
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

/** A summary whose onboarding and use are as given, the rest nothing begun. */
const summaryWith = (
  client: GridRow,
  onboarding: Partial<AdminSummary["onboarding"]>,
  more: Partial<AdminSummary> = {}
): ClientSummary => {
  const base = answeredSummary({ client });
  if (base.state !== "answered") {
    throw new Error("Expected an answered summary");
  }
  return {
    ...base,
    summary: {
      ...base.summary,
      onboarding: { ...base.summary.onboarding, open: false, ...onboarding },
      ...more,
    },
  };
};

/** How a company uses Grasp, as its summary shares it: 30 days of runs, and 8 weeks of people. */
const used = ({
  done = 0,
  failed = 0,
  people = [],
}: {
  done?: number;
  failed?: number;
  people?: (number | "1–4")[];
}): NonNullable<AdminSummary["activity"]> => ({
  runs: Array.from({ length: 30 }, (_, at) => ({
    day: daysAgo(29 - at).slice(0, 10),
    // Every run on the last day, today: in the last seven days.
    done: at === 29 ? done : 0,
    failed: at === 29 ? failed : 0,
  })),
  workflowsLive: 3,
  appsLive: 2,
  agentsOn: 1,
  activePeople: people.map((count, at) => ({
    week: daysAgo((people.length - 1 - at) * 7).slice(0, 10),
    people: count,
  })),
});

/** One month of what Grasp's AI cost, in all. */
const month = (period: string, micros: number) => ({
  period,
  micros,
  byFeature: [],
  byModel: [],
});

/** What Grasp's AI cost on its keys: each organization's, none in all unless given. */
const spendOf = (
  byOrganization: PlatformSpend["byOrganization"],
  months: { thisMonth?: number; lastMonth?: number } = {},
  unreported: PlatformSpend["unreported"] = []
): PlatformSpend => ({
  thisMonth: month("2026-11", months.thisMonth ?? 0),
  lastMonth: month("2026-10", months.lastMonth ?? 0),
  byOrganization,
  organizations: byOrganization.length,
  unread: [],
  unreported,
});

/** The text of Home's figure labelled `label`. */
const figureOf = (root: Element, label: string): string =>
  [...root.querySelectorAll('[aria-label="How Grasp is doing"] *')].find(
    (element) => element.textContent === label
  )?.parentElement?.parentElement?.textContent ?? "";

describe("Home", () => {
  it("says how every organization stands from its summary alone, each row opening it, and reads no organization's snapshot", async () => {
    const live = row("live", { name: "Live Co" });
    const talking = row("talking", { name: "Talking Co" });
    const down = row("down", { name: "Down Co" });
    const waiting = row("waiting", {
      name: "Waiting Co",
      status: "provisioning",
      hostname: null,
    });
    const older = row("older", { name: "Older Co" });
    const { container, calls } = await openAdmin("/", {
      fetchClientGrid: [live, talking, down, waiting, older],
      fetchClientSummaries: [
        summaryWith(
          live,
          {
            stage: "open",
            open: true,
            known: 86,
            openedAt: daysAgo(21),
          },
          { activity: used({ done: 40, failed: 3, people: [6, 8, 7] }) }
        ),
        summaryWith(
          talking,
          { stage: "interviews", day: 4, days: 14, known: 30, told: true },
          { activity: used({ people: ["1–4", "1–4", 0] }) }
        ),
        { client: down, state: "unreachable" },
        { client: waiting, state: "not_deployed" },
        {
          client: older,
          state: "older",
          admin: answeredAdmin({ client: older }),
        },
      ],
      fetchPlatformSpend: null,
    });
    const rowOf = (id: string) => rowText(container, id);

    expect({
      title: container.querySelector("main h1")?.textContent,
      live: [
        "Live",
        "For 21 days",
        "3 workflows live",
        "40 runs",
        "3 failed",
        "8 active last week",
      ].map((text) => rowOf("live").includes(text)),
      talking: [
        "Interviews",
        "Day 4 of 14",
        "30% of 80% known",
        "No runs",
        "1–4 active last week",
      ].map((text) => rowOf("talking").includes(text)),
      down: ["Not answering", "Its core didn’t answer", "Not read now"].map(
        (text) => rowOf("down").includes(text)
      ),
      waiting: ["Being set up", "Not deployed yet", "Not set up yet"].map(
        (text) => rowOf("waiting").includes(text)
      ),
      older: ["Update to see counts", "Update to see"].map((text) =>
        rowOf("older").includes(text)
      ),
      figures: {
        live: figureOf(container, "Live"),
        onboarding: figureOf(container, "Onboarding"),
        ai: figureOf(container, "Grasp AI this month"),
      },
      snapshots: calls.filter(({ fn }) => fn.startsWith("fetchClientAdmin"))
        .length,
    }).toStrictEqual({
      title: "Home",
      live: [true, true, true, true, true, true],
      talking: [true, true, true, true, true],
      down: [true, true, true],
      waiting: [true, true, true],
      older: [true, true],
      figures: {
        live: "Live1of 5 organizations",
        onboarding: "Onboarding1None at risk",
        ai: "Grasp AI this monthNot readIts cores couldn’t be read now",
      },
      snapshots: 0,
    });
  });

  it("says an organization is at risk when its interviews closed short, or three quarters of their days are gone with less known than an even pace gives", async () => {
    const companies: [string, Partial<AdminSummary["onboarding"]>][] = [
      // 11 of 14 days gone: an even pace towards 80% gives 63% by now.
      ["behind", { stage: "interviews", day: 11, days: 14, known: 40 }],
      // 10 of 14: not three quarters yet.
      ["early", { stage: "interviews", day: 10, days: 14, known: 10 }],
      // 11 of 14 with 70% known: ahead of the pace.
      ["ahead", { stage: "interviews", day: 11, days: 14, known: 70 }],
      // Over at 55% of 80%: core's `ready` is true once they are over.
      ["short", { stage: "waiting", known: 55, ready: true }],
      ["ready", { stage: "waiting", known: 85, ready: true }],
    ];
    const { container } = await openAdmin("/", {
      fetchClientGrid: companies.map(([id]) => row(id)),
      fetchClientSummaries: companies.map(([id, onboarding]) =>
        summaryWith(row(id), { told: true, ...onboarding })
      ),
      fetchPlatformSpend: null,
    });
    const state = (id: string) =>
      container
        .querySelector(`main table a[href="/organizations/${id}"]`)
        ?.closest("tr")
        ?.querySelectorAll("td")[0]?.textContent ?? "";

    expect({
      states: companies.map(([id]) => state(id)),
      onboarding: figureOf(container, "Onboarding"),
    }).toStrictEqual({
      states: [
        "At riskDay 11 of 14",
        "InterviewsDay 10 of 14",
        "InterviewsDay 11 of 14",
        "At riskClosed at 55% of 80%",
        "Waiting for the goEnough is known",
      ],
      onboarding: "Onboarding52 at risk",
    });
  });

  it("says how a company uses Grasp only while it shares it: after it ended Grasp's staff access, not shared", async () => {
    const sharing = row("sharing", { name: "Sharing Co" });
    const ended = row("ended", { name: "Ended Co" });
    const { container } = await openAdmin("/", {
      fetchClientGrid: [sharing, ended],
      fetchClientSummaries: [
        summaryWith(
          sharing,
          { stage: "open", open: true, openedAt: daysAgo(3) },
          { activity: used({ done: 12, people: [0, 9, 2] }) }
        ),
        summaryWith(
          ended,
          { stage: "open", open: true, openedAt: daysAgo(3) },
          { activity: null, asked: null }
        ),
      ],
      fetchPlatformSpend: null,
    });

    // Below 84rem each is a card: the same words.
    const cards =
      container.querySelector('main ul[aria-label="Organizations"]')
        ?.textContent ?? "";

    expect({
      cards: [
        cards.includes("12 runs, 0 failed; 9 active last week"),
        cards.includes("Last 7 days Not shared"),
      ],
      sharing: ["3 workflows live", "12 runs", "9 active last week"].map(
        (text) => rowText(container, "sharing").includes(text)
      ),
      ended: rowText(container, "ended").match(/Not shared/gu)?.length,
      endedCounts: ["workflows live", "runs", "active last week"].some((text) =>
        rowText(container, "ended").includes(text)
      ),
    }).toStrictEqual({
      cards: [true, true],
      sharing: [true, true, true],
      ended: 2,
      endedCounts: false,
    });
  });

  it("lists what needs Grasp as rows that open where each is settled, every organization's first before any one's next, and the rest in the Inbox", async () => {
    const failing = row("failing", {
      name: "Failing",
      rollout: {
        failed: { releaseId: "2026.11.20-1", error: null },
        behind: 0,
        channelStopped: null,
      },
    });
    const birch = row("birch", { name: "Birch" });
    const cobalt = row("cobalt", { name: "Cobalt" });
    const needs: AdminSummary["needs"] = [
      { kind: "go", count: 1 },
      { kind: "lead", count: 2 },
      { kind: "read", count: 1 },
    ];
    const { container } = await openAdmin("/", {
      fetchClientGrid: [failing, birch, cobalt],
      fetchClientSummaries: [failing, birch, cobalt].map((client) =>
        summaryWith(client, { stage: "waiting", ready: true }, { needs })
      ),
      fetchPlatformSpend: null,
    });
    const list = container.querySelector('[aria-label="Needs Grasp"]');
    const items = [...(list?.querySelectorAll("a") ?? [])].map((link) => [
      link.textContent ?? "",
      link.getAttribute("href"),
    ]);

    expect({
      first: items.slice(0, 3).map(([text]) => text),
      hrefs: items.slice(0, 4).map(([, href]) => href),
      shown: items.length,
      more: container
        .querySelector("main")
        ?.textContent?.includes("4 more in the sidebar’s Inbox."),
      needs: figureOf(container, "Needs Grasp"),
    }).toStrictEqual({
      first: [
        expect.stringContaining("Its deploy of 2026.11.20-1 failed"),
        // Birch's and Cobalt's, as their links say (hrefs).
        "Ready for Grasp’s go",
        "Ready for Grasp’s go",
      ],
      hrefs: [
        "/organizations/failing/setup",
        "/organizations/birch/steps",
        "/organizations/cobalt/steps",
        "/organizations/failing/steps",
      ],
      shown: 6,
      more: true,
      needs: "Needs Grasp13at 3 organizations",
    });
  });

  it("says what Grasp's AI cost this month against last, and each organization's use of it against its limit", async () => {
    const near = row("near", { name: "Near Co" });
    const own = row("own", { name: "Own Co" });
    const old = row("old", { name: "Old Co" });
    const { container } = await openAdmin("/", {
      fetchClientGrid: [near, own, old],
      fetchClientSummaries: [near, own, old].map((client) =>
        summaryWith(client, { stage: "open", open: true, openedAt: daysAgo(9) })
      ),
      fetchPlatformSpend: spendOf(
        [
          {
            clientId: "near",
            name: "Near Co",
            thisMonth: 191_000_000,
            lastMonth: 42_000_000,
            graspAi: { spent: 191_000_000, limit: 200_000_000 },
          },
          {
            clientId: "own",
            name: "Own Co",
            thisMonth: 0,
            lastMonth: 0,
            graspAi: null,
          },
        ],
        { thisMonth: 191_000_000, lastMonth: 100_000_000 },
        // Its release doesn't report what AI cost.
        [{ clientId: "old", name: "Old Co" }]
      ),
    });

    expect({
      figure: figureOf(container, "Grasp AI this month"),
      near: rowText(container, "near").includes("$191 of $200"),
      own: rowText(container, "own").includes("No limit reported"),
      old: rowText(container, "old").includes("Not reported by its release"),
    }).toStrictEqual({
      figure:
        "Grasp AI this month$191$100 last month · 1 near its limit · 1 not counted",
      near: true,
      own: true,
      old: true,
    });
  });

  it("reads what Grasp's AI cost once Home is opened after a link to it was pointed at, never saying it couldn't be read", async () => {
    const live = row("live");
    const { router, container } = await openAdmin("/platform/releases", {
      fetchClientGrid: [live],
      fetchClientSummaries: [
        summaryWith(live, { stage: "open", open: true, openedAt: daysAgo(2) }),
      ],
      fetchReleases: { releases: [], older: null, channelsOn: {} },
      fetchPlatformSpend: spendOf([], { thisMonth: 12_000_000 }),
    });
    await act(async () => {
      await router.preloadRoute({ to: "/" });
    });
    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await settle();

    expect(figureOf(container, "Grasp AI this month")).toBe(
      "Grasp AI this month$12$0 last month"
    );
  });

  it("shows every organization while what Grasp's AI cost is still being read, that alone said to be reading", async () => {
    const live = row("live", { name: "Live Co" });
    const held = Promise.withResolvers<null>();
    const { container } = await openAdmin(
      "/",
      {
        fetchClientGrid: [live],
        fetchClientSummaries: [
          summaryWith(live, {
            stage: "open",
            open: true,
            openedAt: daysAgo(4),
          }),
        ],
        // Every core is still being asked: never answered here.
        fetchPlatformSpend: async () => await held.promise,
      },
      { rest: false }
    );
    await until(() => rowText(container, "live") !== "");

    expect({
      row: rowText(container, "live").includes("Reading…"),
      live: figureOf(container, "Live"),
      // Its label over a placeholder: no figure yet.
      ai: container
        .querySelector('[aria-label="How Grasp is doing"]')
        ?.textContent?.endsWith("Grasp AI this month"),
    }).toStrictEqual({
      row: true,
      live: "Live1of 1 organization",
      ai: true,
    });
  });

  it("says plainly when there is nothing: no organizations yet, and nothing that needs Grasp", async () => {
    const empty = await openAdmin("/", { fetchPlatformSpend: null });
    const emptyMain = empty.main();
    const calm = row("calm");
    const quiet = await openAdmin("/", {
      fetchClientGrid: [calm],
      fetchClientSummaries: [
        summaryWith(calm, { stage: "open", open: true, openedAt: null }),
      ],
      fetchPlatformSpend: null,
    });

    expect({
      none: emptyMain.includes("No organizations yet"),
      nothing: quiet.main().includes("Nothing needs Grasp now"),
      next: rowText(quiet.container, "calm").includes("Nothing waits"),
    }).toStrictEqual({ none: true, nothing: true, next: true });
  });
});

describe("an organization's page and a new one", () => {
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

  it("offers to add an organization from Home, asking its name, web address, email domain, first admin and hosting", async () => {
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
