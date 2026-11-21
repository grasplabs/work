// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import {
  emptyAdminSnapshot,
  readySnapshot,
  toldSnapshot,
} from "../../test/snapshots.ts";
import { answeredAdmin, gridRow, openAdmin } from "../test-app.tsx";
import type { Answers } from "../test-app.tsx";
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
const openAcme = async (path: string, snapshot: AdminSnapshot) =>
  await openAdmin(`/organizations/acme${path}`, {
    fetchClientGrid: [acme],
    fetchClientAdmin: answeredAdmin({ client: acme, snapshot }),
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
