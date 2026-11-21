// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import { answeredAdmin, gridRow, lineOf, openAdmin } from "../../test/app.tsx";
import type { Answers } from "../../test/app.tsx";
import {
  emptyAdminSnapshot,
  readySnapshot,
  toldSnapshot,
} from "../../test/snapshots.ts";
import type { Crm } from "../crm/crm.ts";
import { formatDate } from "./words.ts";

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

/** The part of the page titled `title`. */
const partOf = (root: Element, title: string): Element | undefined =>
  [...root.querySelectorAll("section")].find(
    (section) => section.querySelector("h2")?.textContent === title
  );

describe("an organization's page", () => {
  it("lays out an organization: its column of sections in order, and what waits where", async () => {
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
      "Integrations",
      "AI use",
      "Hours",
      "Records",
      "Brain",
      "Log",
    ];
    const column = columnOf(container)?.textContent ?? "";
    const positions = titles.map((title) => column.indexOf(title));
    const text = container.textContent ?? "";

    expect({
      inOrder:
        positions.every((at) => at >= 0) &&
        positions
          .toSorted((a, b) => a - b)
          .every((at, i) => at === positions[i]),
      onOverview: entryOf(container, "Overview")?.getAttribute("aria-current"),
      title: container.querySelector("main h1")?.textContent,
      known: column.includes("85% known. Ready for Grasp’s go"),
      waits: ["Steps", "Details", "Interviews"].map(
        (title) =>
          entryOf(container, title)?.textContent?.includes(
            "Something waits for Grasp"
          ) ?? false
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
      known: true,
      waits: [true, false, false],
      source: false,
      needs: [true, false],
    });
  });

  it("says the interviews closed on the last day their links worked", async () => {
    const snapshot = toldSnapshot("Closed", {
      days: 5,
      daysIn: 10,
      leadTalked: true,
    });
    // Five days from day 0: the links worked until the fifth, day 4.
    const last = new Date(`${snapshot.plan?.start ?? ""}T12:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 4);

    const { text } = await openAcme("", snapshot);

    expect(text()).toContain(
      `The interviews closed on ${formatDate(last.toISOString().slice(0, 10))}`
    );
  });

  it("sends what needs Grasp at a paused organization to its steps", async () => {
    const { container } = await openAcme("", {
      ...toldSnapshot("Paused", { days: 14, daysIn: 3, leadTalked: true }),
      paused: true,
    });
    const item = [...container.querySelectorAll("main li")].find((each) =>
      each.textContent?.includes("The interviews are paused")
    );

    expect({
      paused: item !== undefined,
      toSteps:
        item?.querySelector('a[href="/organizations/acme/steps"]') !==
          undefined &&
        item?.querySelector('a[href="/organizations/acme/steps"]') !== null,
    }).toStrictEqual({ paused: true, toSteps: true });
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
      usage.container.querySelector('[data-slot="source-note"]'),
    ];
    const setup = await openAcme("/setup", snapshot);

    expect({
      details: detailsPage,
      usage: usagePage,
      setup: [
        setup.container.querySelector("main h1")?.textContent,
        setup.container.querySelector('[data-slot="source-note"]'),
      ],
    }).toStrictEqual({
      details: {
        title: "Details",
        about: true,
        source: true,
        current: "page",
        overviewCurrent: null,
      },
      usage: ["AI use", null],
      setup: ["Setup", null],
    });
  });

  it("says nothing is known of a contract core doesn't hold, with no draft or fee, beside the agreements as core has them", async () => {
    const empty = emptyAdminSnapshot("Acme");
    const { container, text } = await openAcme("/details?tab=contract", {
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
    const page = text();
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
  it("lists what needs Grasp, the most pressing first, each opening the section it is settled in", async () => {
    const { container, text } = await openAcme("", readySnapshot("Acme"));
    const needs = partOf(container, "Needs Grasp");
    const said = needs?.textContent ?? "";
    // The go and both agreements; a contract core doesn't hold is nothing to settle.
    const lines = [
      "The company comes in once Grasp gives its go.",
      "The agreement on handling data is not signed yet.",
      "The company has not signed off its look at the risks yet.",
    ];

    expect({
      needs: lines.map((line) => said.includes(line)),
      mostPressingFirst: lines
        .map((line) => said.indexOf(line))
        .every((at, index, all) => index === 0 || at > (all[index - 1] ?? 0)),
      contract: said.includes("The contract is still being written."),
      opensSteps:
        needs?.querySelector('a[href="/organizations/acme/steps"]') !==
          undefined &&
        needs?.querySelector('a[href="/organizations/acme/steps"]') !== null,
      ported: !text().includes("This section isn’t in the admin yet."),
    }).toStrictEqual({
      needs: [true, true, true],
      mostPressingFirst: true,
      contract: false,
      opensSteps: true,
      ported: true,
    });
  });

  it("briefs the next call with where the company stands, leaving what to bring up to what needs Grasp beside it", async () => {
    const { container } = await openAcme("", readySnapshot("Acme"));
    const brief = partOf(container, "Before the next call")?.textContent ?? "";

    expect({
      stands: brief.includes("Agreed."),
      prepares: brief.includes("Prepare the call with Grasp"),
      // What needs Grasp stands once, in its own list.
      bringUp: brief.includes("The company comes in once Grasp gives its go."),
      // Core gives how much is known without its parts, and no drawn work.
      notKnownYet: brief.includes("Not known yet"),
      couldDoMore: brief.includes("Where Grasp could do more"),
    }).toStrictEqual({
      stands: true,
      prepares: true,
      bringUp: false,
      notKnownYet: false,
      couldDoMore: false,
    });
  });

  it("once the company is open, briefs it as open", async () => {
    const ready = readySnapshot("Acme");
    const weekAgo = new Date(Date.parse(ready.now) - 7 * 86_400_000);
    const { container } = await openAcme("", {
      ...ready,
      gate: { ...ready.gate, open: true, openedAt: weekAgo.toISOString() },
    });

    expect(partOf(container, "Before the next call")?.textContent).toContain(
      "Open since the go"
    );
  });

  it("counts the interviews' days to the company's own plan", async () => {
    const { text } = await openAcme(
      "",
      toldSnapshot("Acme", { days: 21, daysIn: 3, leadTalked: true })
    );

    expect(text()).toMatch(/Day \d+ of 21/u);
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
