import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { formatDate } from "../src/admin/words.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  liveClient,
  readySnapshot,
  toldSnapshot,
  columnOf,
  columnEntryOf,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Here: an organization's page, its column of sections and what they say
// of its plan and agreements; the rest in the other admin-pages*.test.ts
// files.

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

  it("lays out an organization as the prototype does: its column of sections in order, what waits where, and where the overview comes from", async () => {
    const acme = await liveClient();
    acme.core.admin = readySnapshot("Acme");

    const { status, html } = await page(`/organizations/${acme.clientId}`);
    const column = columnOf(html, acme.name);
    const titles = [
      "Overview",
      "Company",
      "Details",
      "Contract",
      "Members",
      "Onboarding",
      "Steps",
      "Organization",
      "Interviews",
      "Workflows",
      "Platform",
      "Setup",
      "Integrations",
      "AI use",
      "Hours",
      "Records",
      "Brain",
      "Data",
      "Log",
    ];
    const positions = titles.map((title) => column.indexOf(`>${title}</span>`));

    expect({
      status,
      inOrder:
        positions.every((at) => at >= 0) &&
        positions
          .toSorted((a, b) => a - b)
          .every((at, i) => at === positions[i]),
      // The overview is where the page is, under the company's own name.
      onOverview: columnEntryOf(column, "Overview").includes(
        'aria-current="page"'
      ),
      title: html.includes(`${acme.name}</h1>`),
      known: column.includes("85% known. Ready for Grasp’s go"),
      // The go and the agreements wait under Steps; a contract core doesn't hold waits nowhere.
      waits: ["Steps", "Contract", "Members", "Interviews"].map((title) =>
        columnEntryOf(column, title).includes("Something waits for Grasp")
      ),
      source: html.includes("From the company’s own Grasp."),
      // Every need of Acme, with where it is settled; none for a contract nobody knows of yet.
      needs: [
        "85% of what Grasp needs is known: enough to open at 80%. The company comes in once Grasp gives its go.",
        "The contract is still being written.",
      ].map((text) => html.includes(text)),
      opensContract: html.includes(
        `href="/organizations/${acme.clientId}/contract"`
      ),
    }).toStrictEqual({
      status: 200,
      inOrder: true,
      onOverview: true,
      title: true,
      known: true,
      waits: [true, false, false, false],
      source: true,
      needs: [true, false],
      opensContract: true,
    });
  });

  it("says the interviews closed on the last day their links worked", async () => {
    const closed = await liveClient();
    const snapshot = toldSnapshot("Closed", {
      days: 5,
      daysIn: 10,
      leadTalked: true,
    });
    closed.core.admin = snapshot;
    // Five days from day 0: the links worked until the fifth, day 4.
    const last = new Date(`${snapshot.plan?.start ?? ""}T12:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 4);

    const { html } = await page(`/organizations/${closed.clientId}`);

    expect(
      html.includes(
        `The interviews closed on ${formatDate(last.toISOString().slice(0, 10))}`
      )
    ).toBeTruthy();
  });

  it("sends what needs Grasp at a paused organization to its steps", async () => {
    const paused = await liveClient();
    paused.core.admin = {
      ...toldSnapshot("Paused", { days: 14, daysIn: 3, leadTalked: true }),
      paused: true,
    };

    const { status, html } = await page(`/organizations/${paused.clientId}`);
    const main = html.slice(html.indexOf("<main"));
    const at = main.indexOf("The interviews are paused");
    const item = at === -1 ? "" : main.slice(at, main.indexOf("</li>", at));

    expect({
      status,
      paused: at !== -1,
      toSteps: item.includes(`href="/organizations/${paused.clientId}/steps"`),
    }).toStrictEqual({ status: 200, paused: true, toSteps: true });
  });

  it("shows a section under its own path, titled, saying where what it shows comes from", async () => {
    const acme = await liveClient();
    acme.core.admin = readySnapshot("Acme");
    const base = `/organizations/${acme.clientId}`;

    const contract = await page(`${base}/contract`);
    const usage = await page(`${base}/ai-use`);
    const setup = await page(`${base}/setup`);

    expect({
      statuses: [contract, usage, setup].map(({ status }) => status),
      contract: {
        title: contract.html.includes("Contract</h1>"),
        about: contract.html.includes(
          "The seats taken, the agreements, and what is billed."
        ),
        // Not linked in Stripe yet.
        source: contract.html.includes(
          "Its billing and invoices: from Stripe, once it is connected."
        ),
        current: columnEntryOf(
          columnOf(contract.html, acme.name),
          "Contract"
        ).includes('aria-current="page"'),
        overviewCurrent: columnEntryOf(
          columnOf(contract.html, acme.name),
          "Overview"
        ).includes('aria-current="page"'),
      },
      usage: [
        usage.html.includes("AI use</h1>"),
        usage.html.includes("From the company’s own Grasp."),
      ],
      setup: [
        setup.html.includes("Setup</h1>"),
        setup.html.includes("From this admin."),
      ],
    }).toStrictEqual({
      statuses: [200, 200, 200],
      contract: {
        title: true,
        about: true,
        source: true,
        current: true,
        overviewCurrent: false,
      },
      usage: [true, true],
      setup: [true, true],
    });
  });

  it("says nothing is known of a contract core doesn't hold, with no draft or fee, beside the agreements as core has them", async () => {
    const acme = await liveClient();
    const empty = emptyAdminSnapshot("Acme");
    acme.core.admin = {
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
    };

    const { status, html } = await page(
      `/organizations/${acme.clientId}/contract`
    );
    /** The part of the page titled `title`, up to the next part. */
    const partOf = (title: string): string => {
      const at = html.indexOf(`>${title}</h2>`);
      return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
    };
    /** The agreement named `name`, up to the next one. */
    const agreementOf = (name: string): string => {
      const part = partOf("Agreed before the first interview");
      const at = part.indexOf(name);
      return at === -1 ? "" : part.slice(at, part.indexOf("</li>", at));
    };

    expect({
      status,
      toCome: html.includes("This section isn’t in the admin yet."),
      summary: {
        // Core holds no contract: no status, terms, fee or seats it gives.
        contract: ["Not known yet", "Being written", "not sent yet", "€0"].some(
          (text) => html.includes(text)
        ),
        seats: html.includes("are taken"),
        runs: html.includes("Still runs"),
        fee: html.includes("Fee a month"),
      },
      parts: [
        partOf("The terms"),
        partOf("What it gives the company"),
        partOf("Invoices"),
      ],
      agreements: {
        open: partOf("Agreed before the first interview").includes(
          "Without all three, nobody is invited. 2 are still open."
        ),
        processing: agreementOf("Agreement on handling data").includes(
          "In place since 2 Sep 2026"
        ),
        assessment: agreementOf(
          "The company’s look at the risks to its people"
        ).includes("Not signed yet"),
        council: agreementOf("Works council").includes("Still deciding"),
        others: partOf("Agreed before the first interview").includes(
          "Who else handles the data"
        ),
      },
    }).toStrictEqual({
      status: 200,
      toCome: false,
      summary: {
        contract: false,
        seats: true,
        runs: false,
        fee: false,
      },
      parts: ["", "", ""],
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
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");

    const { html } = await page(`/organizations/${acme.clientId}/contract`);
    const at = html.indexOf(">Agreed before the first interview</h2>");
    const part =
      at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));

    expect({
      description: part.includes(
        "Nothing is recorded of them yet. Without all three, nobody is invited."
      ),
      notRecorded: part.split("Not recorded yet").length - 1,
      noCouncil: part.includes("No works council"),
    }).toStrictEqual({ description: true, notRecorded: 3, noCouncil: false });
  });
});
