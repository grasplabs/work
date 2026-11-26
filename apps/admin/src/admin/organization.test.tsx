// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import {
  answeredAdmin,
  answeredSummary,
  gridRow,
  lineOf,
  openAdmin,
} from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import {
  emptyAdminSnapshot,
  readySnapshot,
  toldSnapshot,
} from "../../test/snapshots.ts";
import type { ClientSummary } from "../clients/summary.ts";
import type { Crm } from "../crm/crm.ts";

// An organization's page: its column of sections, its overview and what
// they say of its plan and agreements, as its core's snapshot reads. The
// snapshot is what core sent, passed through by the Worker
// (test/client-admins.test.ts).

const acme = gridRow({ id: "acme", name: "Acme" });

/** What Acme's Setup reads, for a page that opens it: nothing set up yet. */
const setupAnswers: Answers = {
  fetchClientSetup: null,
  fetchPinChoices: { releases: [] },
  fetchClientHosting: null,
  fetchProvisioningProgress: null,
  fetchClientAiStatus: null,
};

/** Acme's page at `path` (under its own), its core having answered `snapshot`. */
const openAcme = async (path: string, snapshot: AdminSnapshot, crm?: Crm) =>
  await openAdmin(`/organizations/acme${path}`, {
    fetchClientGrid: [acme],
    fetchClientAdmin: answeredAdmin({
      client: acme,
      snapshot,
      ...(crm === undefined ? {} : { crm }),
    }),
    ...setupAnswers,
  });

/** What the organization's level of the sidebar says. */
/** Where the organization stands, over each of its sections, in the page. */
const statusOf = (root: Element): string =>
  root.querySelector("main")?.textContent ?? "";

/** The organization's column of sections. */
const columnOf = (root: Element): Element | null =>
  root.querySelector(`nav[aria-label="${acme.name}"]`);

/** The link of the entry titled `title` in the column. */
const entryOf = (root: Element, title: string): Element | undefined =>
  [...(columnOf(root)?.querySelectorAll("a") ?? [])].find((link) =>
    [...link.querySelectorAll("span")].some(
      (span) => span.textContent === title
    )
  );

/** What a column entry says when things wait for Grasp there: "3 things need Grasp". */
const waitsMark = /\d+ things? needs? Grasp/u;

/** Whether the page says a part of its section isn't read yet (its source note). */
const notYetRead = (text: string): boolean =>
  text.includes("doesn’t hold it yet") || text.includes("once it is connected");

/** A live organization's figures on its overview, as text. */
const figuresOf = (root: Element): string =>
  root.querySelector('[aria-label="How it is doing"]')?.textContent ?? "";

/** The part of the page titled `title`. */
const partOf = (root: Element, title: string): Element | undefined =>
  [...root.querySelectorAll("section")].find(
    (section) => section.querySelector("h2")?.textContent === title
  );

describe("an organization's page", () => {
  it("lays out an organization: its column of sections in order, what waits where, and over the page how much is known", async () => {
    const { container } = await openAcme("", readySnapshot("Acme"));
    const titles = [
      "Overview",
      "Company",
      "Details",
      "Onboarding",
      "Steps",
      "Interviews",
      "Workflows",
      "Platform",
      "Setup",
      "Connectors",
      "AI use",
      "Hours",
      "Records",
      "Brain",
      "Log",
    ];
    const column = columnOf(container)?.textContent ?? "";
    const positions = titles.map((title) => column.indexOf(title));
    const text = container.querySelector("main")?.textContent ?? "";

    expect({
      inOrder:
        positions.every((at) => at >= 0) &&
        positions
          .toSorted((a, b) => a - b)
          .every((at, i) => at === positions[i]),
      onOverview: entryOf(container, "Overview")?.getAttribute("aria-current"),
      title: container.querySelector("main h1")?.textContent,
      // Its standing, over every section.
      standing: text.includes("Waiting for the go"),
      waits: ["Steps", "Details", "Interviews"].map((title) =>
        waitsMark.test(
          entryOf(container, title)?.closest("li")?.textContent ?? ""
        )
      ),
      source: text.includes("From the company’s own Grasp."),
      needs: [
        "85% of what Grasp needs is known: enough to open at 80%. The company comes in once Grasp gives its go.",
        "The contract is still being written.",
      ].map((need) => text.includes(need)),
    }).toStrictEqual({
      inOrder: true,
      onOverview: "page",
      title: "Acme",
      standing: true,
      waits: [true, false, false],
      source: false,
      needs: [true, false],
    });
  });

  it("shows an organization's sections in the sidebar in place of the admin's list, whatever its id", async () => {
    // An id that is also the name of the sidebar's own list.
    const main = gridRow({ id: "main", name: "Main Street" });
    const { container } = await openAdmin("/organizations/main", {
      fetchClientGrid: [main],
      fetchClientAdmin: answeredAdmin({
        client: main,
        snapshot: readySnapshot("Main Street"),
      }),
      ...setupAnswers,
    });
    const shown = [
      ...container.querySelectorAll(
        '[data-slot="sidebar-level"][data-state="active"]'
      ),
    ];

    expect(
      shown.map(
        (level) =>
          level
            .querySelector('[data-slot="sidebar-content"]')
            ?.getAttribute("aria-label") ?? null
      )
    ).toStrictEqual(["Main Street"]);
  });

  it("says an organization whose interviews closed short is at risk, and how long ago they closed", async () => {
    // Five days of interviews, told ten days ago: over, little known.
    const { container } = await openAcme(
      "",
      toldSnapshot("Closed", { days: 5, daysIn: 10, leadTalked: true })
    );

    expect(statusOf(container)).toMatch(
      /At risk.*The interviews closed 5 days ago/u
    );
  });

  it("counts the interviews' day and the risk as core does, so the page and Home agree", async () => {
    // Told ten days ago: core's day 11 of 14, three quarters gone with
    // less known than an even pace towards 80% (63%) gives.
    const told = toldSnapshot("Behind", {
      days: 14,
      daysIn: 10,
      leadTalked: true,
    });
    const { container } = await openAcme("", {
      ...told,
      gate: { ...told.gate, known: 40 },
    });

    expect(statusOf(container)).toMatch(/At risk.*Day 11 of 14/u);
  });

  it("calls an organization live while its gate is open, though Grasp never gave a go", async () => {
    const ready = readySnapshot("Acme");
    const { container } = await openAcme("", {
      ...ready,
      // A deployment that started open: no go recorded, no first
      // conversation brought in.
      gate: { ...ready.gate, open: true, openedAt: null },
      kickoff: null,
    });
    const next =
      container.querySelector('section[aria-labelledby="next"]')?.textContent ??
      "";

    expect({
      live: statusOf(container).includes("LiveOpen, without interviews"),
      onboarding: ["Give the go", "Bring in the conversation"].some((words) =>
        next.includes(words)
      ),
    }).toStrictEqual({ live: true, onboarding: false });
  });

  it("leads with what its own platform needs, settled on its Setup, before anything its core says", async () => {
    const failing = gridRow({
      id: "acme",
      name: "Acme",
      rollout: {
        failed: { releaseId: "2026.11.20-1", error: null },
        behind: 0,
        channelStopped: null,
      },
    });
    const { container } = await openAdmin("/organizations/acme", {
      fetchClientGrid: [failing],
      fetchClientAdmin: answeredAdmin({
        client: failing,
        snapshot: readySnapshot("Acme"),
      }),
      ...setupAnswers,
    });
    const next = container.querySelector('section[aria-labelledby="next"]');

    expect({
      deploy: next?.textContent?.includes("Its deploy of 2026.11.20-1 failed"),
      action: next?.querySelector('a[href="/organizations/acme/setup"]')
        ?.textContent,
      goAfter: (
        partOf(container, "What else needs Grasp")?.textContent ?? ""
      ).includes("The company comes in once Grasp gives its go."),
    }).toStrictEqual({
      deploy: true,
      action: "Open its Setup",
      goAfter: true,
    });
  });

  it("leads a paused organization's overview with resuming its interviews, on its steps", async () => {
    const { container } = await openAcme("", {
      ...toldSnapshot("Paused", { days: 14, daysIn: 3, leadTalked: true }),
      paused: true,
    });
    const next = container.querySelector('section[aria-labelledby="next"]');
    const action = next?.querySelector('a[href="/organizations/acme/steps"]');

    expect({
      paused: next?.textContent?.includes("The interviews are paused"),
      waits: next?.textContent?.includes("Waiting on Grasp"),
      action: action?.textContent,
    }).toStrictEqual({
      paused: true,
      waits: true,
      action: "Resume the interviews",
    });
  });

  it("shows a section under its own path, titled, saying only where what isn't read yet will come from", async () => {
    const snapshot = readySnapshot("Acme");
    const details = await openAcme("/details", snapshot);
    const detailsPage = {
      title: details.container.querySelector("main h1")?.textContent,
      about: details
        .main()
        .includes(
          "The company as its own papers have it, who Grasp deals with there, its contract and its members."
        ),
      // Not linked in Stripe yet.
      source: details
        .main()
        .includes(
          "Its billing and invoices: from Stripe, once it is connected."
        ),
      current: entryOf(details.container, "Details")?.getAttribute(
        "aria-current"
      ),
      overviewCurrent:
        entryOf(details.container, "Overview")?.getAttribute("aria-current") ??
        null,
    };
    const usage = await openAcme("/ai-use", snapshot);
    const usagePage = [
      usage.container.querySelector("main h1")?.textContent,
      notYetRead(usage.main()),
    ];
    const setup = await openAcme("/setup", snapshot);

    expect({
      details: detailsPage,
      usage: usagePage,
      setup: [
        setup.container.querySelector("main h1")?.textContent,
        notYetRead(setup.main()),
      ],
    }).toStrictEqual({
      details: {
        title: "Details",
        about: true,
        source: true,
        current: "page",
        overviewCurrent: null,
      },
      usage: ["AI use", false],
      setup: ["Setup", false],
    });
  });

  it("says nothing is known of a contract core doesn't hold, with no draft or fee, beside the agreements as core has them", async () => {
    const empty = emptyAdminSnapshot("Acme");
    const { container, main } = await openAcme("/details?tab=contract", {
      ...empty,
      agreements: {
        processing: true,
        assessment: false,
        council: "waiting",
        processingOn: "2026-09-02",
      },
      members: [
        {
          userId: "user-anna",
          name: "Anna",
          email: "anna@acme.test",
          role: "admin",
          joinedAt: "2026-09-03T09:00:00.000Z",
        },
        {
          userId: "user-bram",
          name: "Bram",
          email: "bram@acme.test",
          role: "user",
          joinedAt: "2026-09-04T09:00:00.000Z",
        },
      ],
    });
    const page = main();
    const agreed = partOf(container, "Agreed before the first interview");
    const agreementOf = (name: string): string =>
      [...(agreed?.querySelectorAll("li") ?? [])].find((item) =>
        item.textContent?.includes(name)
      )?.textContent ?? "";

    expect({
      toCome: page.includes("This section isn’t in the admin yet."),
      summary: {
        contract: ["Not known yet", "Being written", "not sent yet", "€0"].some(
          (words) => page.includes(words)
        ),
        runs: page.includes("Still runs"),
        fee: page.includes("Fee a month"),
      },
      parts: ["The terms", "What it gives the company", "Invoices"].map(
        (title) => partOf(container, title) ?? null
      ),
      agreements: {
        open: agreed?.textContent?.includes(
          "Without all three, nobody is invited. 2 are still open."
        ),
        processing: agreementOf("Agreement on handling data").includes(
          "In place since 2 Sep 2026"
        ),
        assessment: agreementOf(
          "The company’s look at the risks to its people"
        ).includes("Not signed yet"),
        council: agreementOf("Works council").includes("Still deciding"),
        others: agreed?.textContent?.includes("Who else handles the data"),
      },
    }).toStrictEqual({
      toCome: false,
      summary: { contract: false, runs: false, fee: false },
      parts: [null, null, null],
      agreements: {
        open: true,
        processing: true,
        assessment: true,
        council: true,
        others: true,
      },
    });
  });

  it("says the agreements aren't recorded yet while core holds nothing of them, instead of reading that as no works council", async () => {
    const { container } = await openAcme(
      "/details?tab=contract",
      emptyAdminSnapshot("Acme")
    );
    const part =
      partOf(container, "Agreed before the first interview")?.textContent ?? "";

    expect({
      description: part.includes(
        "Nothing is recorded of them yet. Without all three, nobody is invited."
      ),
      notRecorded: part.split("Not recorded yet").length - 1,
      noCouncil: part.includes("No works council"),
    }).toStrictEqual({ description: true, notRecorded: 3, noCouncil: false });
  });
});

describe("an organization's overview", () => {
  it("leads with what comes next and who it waits on, then lists what else needs Grasp, each opening where it is settled", async () => {
    const { container, text } = await openAcme("", readySnapshot("Acme"));
    const next =
      container.querySelector('section[aria-labelledby="next"]')?.textContent ??
      "";
    const more = partOf(container, "What else needs Grasp");
    const rows = [...(more?.querySelectorAll("a") ?? [])].map((link) => [
      link.textContent ?? "",
      link.getAttribute("href"),
    ]);

    expect({
      next: [
        "The company comes in once Grasp gives its go.",
        "Waiting on Grasp",
        "Give the go",
      ].map((words) => next.includes(words)),
      more: rows.map(([, href]) => href),
      waits:
        (more?.textContent ?? "").split("Waiting on the company").length - 1,
      lines: [
        "The agreement on handling data is not signed yet.",
        "The company has not signed off its look at the risks yet.",
      ].map((line) => (more?.textContent ?? "").includes(line)),
      // A contract core doesn't hold is nothing to settle.
      contract: text().includes("The contract is still being written."),
    }).toStrictEqual({
      next: [true, true, true],
      more: ["/organizations/acme/steps", "/organizations/acme/steps"],
      waits: 2,
      lines: [true, true],
      contract: false,
    });
  });

  it("says how a live company uses Grasp from its summary: people active last week, a few as 1–4, and its runs", async () => {
    const ready = readySnapshot("Acme");
    const openedAt = new Date(Date.parse(ready.now) - 7 * 86_400_000);
    const live = answeredAdmin({
      client: acme,
      snapshot: {
        ...ready,
        gate: { ...ready.gate, open: true, openedAt: openedAt.toISOString() },
      },
    });
    const usedBy = (people: (number | "1–4")[]): ClientSummary => {
      const summary = answeredSummary({ client: acme });
      if (summary.state !== "answered") {
        throw new Error("Expected an answered summary");
      }
      return {
        ...summary,
        summary: {
          ...summary.summary,
          activity: {
            runs: [{ day: ready.now.slice(0, 10), done: 12, failed: 2 }],
            workflowsLive: 3,
            appsLive: 2,
            agentsOn: 1,
            activePeople: people.map((count, at) => ({
              week: `2026-11-${String(2 + 7 * at).padStart(2, "0")}`,
              people: count,
            })),
          },
        },
      };
    };
    const open = async (summary: ClientSummary) =>
      await openAdmin("/organizations/acme", {
        fetchClientGrid: [acme],
        fetchClientAdmin: live,
        fetchClientSummaries: [summary],
        ...setupAnswers,
      });
    const many = await open(usedBy([4, 6, 2]));
    const manyFigures = figuresOf(many.container);
    const few = await open(usedBy([6, "1–4", 2]));

    expect({
      many: [
        "People active last week6of 0 members, +2 on the week before",
        "Runs, last 7 days142 failed",
        "Workflows live31 agent on",
      ].map((words) => manyFigures.includes(words)),
      few: figuresOf(few.container).includes(
        "People active last week1–4of 0 members"
      ),
      // The chart says a week of a few as such.
      chart: few.main().includes("In 1 week, 1 to 4."),
    }).toStrictEqual({ many: [true, true, true], few: true, chart: true });
  });

  it("says how a company uses Grasp isn't shared once it ended Grasp's staff access", async () => {
    const ready = readySnapshot("Acme");
    const summary = answeredSummary({ client: acme });
    const { container } = await openAdmin("/organizations/acme", {
      fetchClientGrid: [acme],
      fetchClientAdmin: answeredAdmin({
        client: acme,
        snapshot: {
          ...ready,
          gate: { ...ready.gate, open: true, openedAt: ready.now },
        },
      }),
      fetchClientSummaries: [
        summary.state === "answered"
          ? { ...summary, summary: { ...summary.summary, activity: null } }
          : summary,
      ],
      ...setupAnswers,
    });
    expect(figuresOf(container).match(/Not shared/gu)?.length).toBe(4);
  });

  it("lists what staff and the admin did lately, from the admin's own record", async () => {
    const at = new Date();
    const { container } = await openAdmin("/organizations/acme", {
      fetchClientGrid: [acme],
      fetchClientAdmin: answeredAdmin({
        client: acme,
        snapshot: readySnapshot("Acme"),
      }),
      ...setupAnswers,
      fetchClientSetup: {
        history: [
          {
            id: "1",
            at,
            actor: "system",
            action: "deploy.done",
            target: "2026.11.20-1",
            detail: null,
          },
          {
            id: "2",
            at,
            actor: "system",
            action: "provision.progress",
            target: null,
            detail: null,
          },
          {
            id: "3",
            at,
            actor: "staff@grasp.test",
            action: "client.create",
            target: null,
            detail: null,
          },
        ],
      },
    });
    const recent = partOf(container, "Recent activity")?.textContent ?? "";

    expect({
      deploy: recent.includes("Its deploy of 2026.11.20-1 is live."),
      byItself: recent.includes("Grasp, by itself"),
      added: recent.includes("Added it.staff@grasp.test"),
      // How far a setting up is goes on its Setup's history alone.
      progress: recent.includes("provision.progress"),
    }).toStrictEqual({
      deploy: true,
      byItself: true,
      added: true,
      progress: false,
    });
  });

  it("counts the interviews' days to the company's own plan", async () => {
    const { container } = await openAcme(
      "",
      toldSnapshot("Acme", { days: 21, daysIn: 3, leadTalked: true })
    );

    expect(statusOf(container)).toMatch(/Day \d+ of 21/u);
  });
});

describe("an organization's details", () => {
  it("shows the company as core has it, its people counted, and every part core doesn't hold as not known yet", async () => {
    // Its list of people in: three people in two teams.
    const { container, main } = await openAcme(
      "/details",
      {
        ...emptyAdminSnapshot("Noordkade"),
        roster: {
          teams: [
            {
              id: "finance",
              name: "Finance",
              lead: "eva",
              does: "",
              off: false,
            },
            { id: "sales", name: "Sales", lead: null, does: "", off: false },
          ],
          people: [
            ["eva", "Eva Bakker", "finance", "CFO"],
            ["ruben", "Ruben de Vries", "finance", ""],
            ["lotte", "Lotte Jansen", "sales", ""],
          ].map(([id = "", name = "", team = "", title = ""]) => ({
            id,
            name,
            email: `${id}@noordkade.test`,
            team,
            title,
            away: false,
          })),
        },
      },
      // No Attio key in Secrets Store, as the Worker answers then.
      { state: "not_connected", recordId: null }
    );
    const page = main();

    expect({
      title: container.querySelector("main h1")?.textContent,
      toCome: page.includes("This section isn’t in the admin yet."),
      // Core holds no website, so there is nothing to open.
      website: page.includes("in a new tab"),
      // Nobody is known for any part, so each says what it is for.
      contacts: [
        "Wants this to happen, and decides.",
        "Runs the company’s own onboarding and its workspace.",
        "Gets the invoices.",
        "Answers for how the company handles personal data.",
      ].map((what) => page.includes(what)),
      writes: container.querySelector('main a[href^="mailto:"]'),
      calls: page.includes("Once Attio is connected, this fills in by itself."),
      papers: [
        "Name on the contract",
        "Website",
        "Company register number",
        "VAT number",
        "Address",
      ].map((label) => lineOf(container, label)),
      // People of the company are counted, never named here.
      named: ["Eva Bakker", "Ruben de Vries", "Lotte Jansen"].some((person) =>
        page.includes(person)
      ),
    }).toStrictEqual({
      title: "Details",
      toCome: false,
      website: false,
      contacts: [true, true, true, true],
      writes: null,
      calls: true,
      // Core holds no contract, so the name it stands under there isn't known.
      papers: Array.from({ length: 5 }, () => "Not known yet"),
      named: false,
    });
  });
});

describe("an organization's workflows", () => {
  it("says none is named yet before a lead names the team's work", async () => {
    const { container, main } = await openAcme("/workflows", {
      ...emptyAdminSnapshot("Acme"),
      told: true,
    });

    expect({
      title: container.querySelector("main h1")?.textContent,
      none: main().includes(
        "None yet. A team’s work shows up here once its lead has named it."
      ),
      toCome: main().includes("This section isn’t in the admin yet."),
      table: container.querySelector("main table"),
    }).toStrictEqual({
      title: "Workflows",
      none: true,
      toCome: false,
      table: null,
    });
  });
});
