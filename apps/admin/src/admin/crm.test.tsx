// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import type { Crm, CrmRecords } from "../crm/crm.ts";
import { answeredAdmin, gridRow, lineOf, openAdmin } from "../test-app.tsx";

// An organization's company in Attio, under its Details, as Attio's answer
// reads (test/admin-crm.test.ts: what the Worker reads of Attio, and that
// nothing of the key or of anyone else reaches the browser).

const recordId = "7f0c2e4a-0b8e-4c55-9d7a-1f2e3d4c5b6a";

/** The day `days` ago. */
const dayAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Noordkade as Attio has it: two people, one deal Ruben owns, and `calls`. */
const noordkade = (calls: CrmRecords["calls"]): CrmRecords => ({
  company: {
    name: "Noordkade Finance",
    domains: ["noordkade.test"],
    categories: ["Financial Services", "B2B"],
    employeeRange: "51-250",
    url: `https://app.attio.com/grasp/company/${recordId}/overview`,
  },
  people: [
    { name: "Pieter de Boer", title: "Head of Finance", email: "" },
    { name: "Sanne de Wit", title: "COO", email: "sanne@noordkade.test" },
  ],
  deals: [
    {
      name: "Noordkade Finance: Business",
      stage: { title: "Won 🎉", kind: "won" },
      value: { amount: 21_780, currency: "EUR" },
      owner: "Ruben Jansen",
    },
  ],
  calls,
});

/** Acme's Details, with `crm`: its main part, and its Calls on their own. */
const detailsOf = async (crm: Crm) => {
  const page = await openAdmin("/organizations/acme/details", {
    fetchClientGrid: [gridRow()],
    fetchClientAdmin: answeredAdmin({ crm }),
  });
  const main = page.main();
  const heading = [...page.container.querySelectorAll("h2")].find(
    (each) => each.textContent === "Calls"
  );
  return {
    page,
    main,
    calls: heading?.closest("section")?.textContent ?? "",
  };
};

describe("an organization's company in Attio, as Attio's answer reads", () => {
  it("shows a linked company, its people and its deals, read only", async () => {
    const { page, main } = await detailsOf({
      state: "read",
      recordId,
      records: noordkade({ from: "meetings", calls: [] }),
    });

    expect({
      lines: ["Name in Attio", "Domains", "Categories", "Employees"].map(
        (label) => lineOf(page.container, label)
      ),
      opens: [...page.container.querySelectorAll("a")].some(
        (link) =>
          link.getAttribute("href") ===
          `https://app.attio.com/grasp/company/${recordId}/overview`
      ),
      deal: main.includes("Noordkade Finance: Business"),
      dealLine: main.includes("Won 🎉 · €21,780.00 · owned by Ruben Jansen"),
      people: [
        "Sanne de Wit",
        "COO · sanne@noordkade.test",
        "Pieter de Boer",
      ].map((text) => main.includes(text)),
      notConnected: main.includes("Attio isn’t connected"),
    }).toStrictEqual({
      lines: [
        "Noordkade Finance",
        "noordkade.test",
        "Financial Services and B2B",
        "51-250",
      ],
      opens: true,
      deal: true,
      dealLine: true,
      people: [true, true, true],
      notConnected: false,
    });
  });

  it("lists the calls from its meetings, the newest first, with the deal and who of the company was in each", async () => {
    const { calls } = await detailsOf({
      state: "read",
      recordId,
      records: noordkade({
        from: "meetings",
        calls: [
          {
            on: dayAgo(10),
            title: "Kickoff with the team leads",
            with: ["Sanne de Wit", "joost@noordkade.test"],
          },
          {
            on: dayAgo(40),
            title: "First conversation",
            with: ["Sanne de Wit"],
          },
        ],
      }),
    });
    const kickoff = calls.indexOf("Kickoff with the team leads");
    const first = calls.indexOf("First conversation");

    expect({
      deal: calls.includes(
        "Noordkade Finance: Business · Won 🎉 · Ruben Jansen"
      ),
      newestFirst: kickoff !== -1 && first !== -1 && kickoff < first,
      with: calls.includes("With Sanne de Wit and joost@noordkade.test"),
      notConnected: calls.includes("Once Attio is connected"),
    }).toStrictEqual({
      deal: true,
      newestFirst: true,
      with: true,
      notConnected: false,
    });
  });

  it("says the calls come from its notes when the workspace has no meetings", async () => {
    const { calls } = await detailsOf({
      state: "read",
      recordId,
      records: noordkade({
        from: "notes",
        calls: [{ on: dayAgo(4), title: "Call with Sanne", with: [] }],
      }),
    });

    expect({
      from: calls.includes("from its notes in Attio"),
      note: calls.includes("Call with Sanne"),
    }).toStrictEqual({ from: true, note: true });
  });

  it("says when Attio has no such company, and still offers the link", async () => {
    const { page, main } = await detailsOf({
      state: "unread",
      recordId,
      error: "not_found",
    });

    expect({
      line: main.includes(
        "Attio can’t be read for it now: Attio has no such company."
      ),
      form: page.container.querySelector('input[name="recordId"]') !== null,
    }).toStrictEqual({ line: true, form: true });
  });

  it("says when what Attio answered can't be read, showing none of it", async () => {
    const { main } = await detailsOf({
      state: "unread",
      recordId,
      error: "invalid_answer",
    });

    expect(main).toContain("what Attio answered can’t be read");
  });

  it("says Attio isn't connected", async () => {
    const { main } = await detailsOf({ state: "not_connected", recordId });

    expect(main).toContain(
      "Attio isn’t connected yet. Once it is, this fills in by itself. Add ATTIO_READ_KEY to the stage’s 1Password Environment, then run Deploy platform."
    );
  });
});
