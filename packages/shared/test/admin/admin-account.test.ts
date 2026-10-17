import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  addMonths,
  agreementsOf,
  contractOf,
  ENDING_DAYS,
  integrationsOf,
  invoicesOf,
  membersOf,
  seatsOf,
  VAT,
} from "../../src/admin/admin-account.ts";
import { viewOf } from "../../src/admin/onboarding-admin.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, vanrijn, hartog] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}) =>
  viewOf(org, { ...org.seed, ...more });

describe("days", () => {
  it("count on by the calendar, across months and years", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("a month on is the same day, or the last day the month has", () => {
    expect(addMonths("2026-10-01", 1)).toBe("2026-11-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2027-09-30", -3)).toBe("2027-06-30");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });
});

describe("the contract", () => {
  it("runs between its two dates once it is signed", () => {
    expect(contractOf(noordkade, noordkade.seed, today).running).toBeTruthy();
    expect(
      contractOf(noordkade, noordkade.seed, "2026-09-30").running
    ).toBeFalsy();
    expect(
      contractOf(noordkade, noordkade.seed, "2027-10-01").running
    ).toBeFalsy();
    // Sent and not signed: it does not run, whatever the day.
    expect(contractOf(vanrijn, vanrijn.seed, "2026-12-01").running).toBeFalsy();
  });

  it("that carries on by itself has a last day for notice, and never counts as ending", () => {
    const contract = contractOf(noordkade, noordkade.seed, "2027-09-01");
    expect(contract.noticeBy).toBe("2027-06-30");
    expect(contract.daysLeft).toBe(29);
    expect(contract.ending).toBeFalsy();
  });

  it("that does not carry on ends: Grasp hears of it from sixty days before", () => {
    expect(contractOf(hartog, hartog.seed, today)).toMatchObject({
      daysLeft: 29,
      ending: true,
      noticeBy: null,
    });
    expect(
      contractOf(
        hartog,
        hartog.seed,
        addDays(hartog.contract.until, -ENDING_DAYS)
      ).ending
    ).toBeTruthy();
    expect(
      contractOf(
        hartog,
        hartog.seed,
        addDays(hartog.contract.until, -ENDING_DAYS - 1)
      ).ending
    ).toBeFalsy();
    expect(
      contractOf(hartog, hartog.seed, addDays(hartog.contract.until, 1)).ending
    ).toBeFalsy();
  });

  it("is the organization’s own, with what Grasp changed on top", () => {
    const changed = contractOf(
      vanrijn,
      {
        ...vanrijn.seed,
        contract: { status: "signed", signed: today, seats: 12 },
      },
      "2026-11-02"
    );
    expect(changed).toMatchObject({
      status: "signed",
      seats: 12,
      fee: vanrijn.contract.fee,
      running: true,
    });
  });
});

describe("the invoices", () => {
  it("come one a month from the day the contract starts, VAT included, the newest first", () => {
    const contract = contractOf(hartog, hartog.seed, today);
    const invoices = invoicesOf(hartog, contract, today);
    expect(invoices.map((invoice) => invoice.date)).toStrictEqual([
      "2026-10-01",
      "2026-09-01",
      "2026-08-01",
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
      "2026-04-01",
    ]);
    expect(invoices.map((invoice) => invoice.number)).toContain("HARTO-0001");
    expect(new Set(invoices.map((invoice) => invoice.number)).size).toBe(
      invoices.length
    );
    for (const invoice of invoices) {
      expect(invoice.amount).toBeCloseTo(hartog.contract.fee * (1 + VAT), 2);
    }
    // Only the newest is still to pay.
    expect(invoices.map((invoice) => invoice.status)).toStrictEqual([
      "due",
      "paid",
      "paid",
      "paid",
      "paid",
      "paid",
      "paid",
    ]);
  });

  it("stop when the contract ends, and there are none without a signed one", () => {
    const later = "2027-03-01";
    expect(
      invoicesOf(hartog, contractOf(hartog, hartog.seed, later), later)[0]?.date
    ).toBe("2026-10-01");
    expect(
      invoicesOf(
        vanrijn,
        contractOf(vanrijn, vanrijn.seed, "2026-12-01"),
        "2026-12-01"
      )
    ).toStrictEqual([]);
  });

  it("match what the client’s own billing page shows for Noordkade", () => {
    const [first] = invoicesOf(
      noordkade,
      contractOf(noordkade, noordkade.seed, today),
      today
    );
    expect(first).toMatchObject({
      number: "NOORD-0001",
      date: "2026-10-01",
      amount: 1815,
    });
  });
});

describe("the agreements", () => {
  it("stand as the organization starts: signed with their paper, waiting, or not needed", () => {
    expect(
      agreementsOf(noordkade, noordkade.seed).map((each) => each.state)
    ).toStrictEqual(["signed", "signed", "signed"]);
    expect(agreementsOf(noordkade, noordkade.seed)[0]).toMatchObject({
      on: "2026-09-16",
      by: "the COO",
      version: "2026-07",
    });
    expect(
      agreementsOf(veldkamp, veldkamp.seed).map((each) => each.state)
    ).toStrictEqual(["signed", "signed", "waiting"]);
    expect(
      agreementsOf(vanrijn, vanrijn.seed).map((each) => each.state)
    ).toStrictEqual(["open", "open", "none"]);
  });

  it("put in place by hand carry the day it was done, and no paper yet", () => {
    const state: OrgState = {
      ...vanrijn.seed,
      agreed: { ...vanrijn.seed.agreed, processing: true },
      papers: { processing: today },
    };
    expect(agreementsOf(vanrijn, state)[0]).toStrictEqual({
      what: "processing",
      state: "signed",
      on: today,
      by: null,
      version: null,
      file: null,
    });
  });

  it("signed with their paper keep its day when the day by hand was left empty", () => {
    const state: OrgState = {
      ...noordkade.seed,
      papers: { processing: "" },
    };
    expect(agreementsOf(noordkade, state)[0]).toMatchObject({
      on: "2026-09-16",
      by: "the COO",
    });
  });

  it("taken back are open again, whatever paper there was", () => {
    const state: OrgState = {
      ...noordkade.seed,
      agreed: { ...noordkade.seed.agreed, assessment: false },
    };
    expect(agreementsOf(noordkade, state)[1]).toMatchObject({
      state: "open",
      on: null,
      file: null,
    });
  });
});

describe("the members", () => {
  it("are ready until Grasp opens, and in after", () => {
    const before = membersOf(at(noordkade), today, false);
    expect(before.filter((member) => member.state === "ready")).toHaveLength(9);
    expect(
      before
        .filter((member) => member.state === "invited")
        .map((member) => member.email)
    ).toStrictEqual(["hr@noordkade.nl"]);
    const open = membersOf(at(hartog), today, true);
    expect(open.filter((member) => member.state === "active")).toHaveLength(13);
    expect(open.find((member) => member.id === "lotte")?.state).toBe("invited");
    // Nobody was in before the platform opened.
    for (const member of before) {
      expect(member.seen).toBeNull();
    }
  });

  it("show only who was invited by then", () => {
    expect(
      membersOf(at(hartog), "2026-04-10", false).map((member) => member.id)
    ).toStrictEqual(["arjen", "mirjam", "stefan", "member-ruben"]);
  });

  it("keep the same people as the client’s own Members page, with Grasp’s seat marked", () => {
    const members = membersOf(at(noordkade), today, false);
    expect(
      members.filter((member) => member.grasp).map((member) => member.email)
    ).toStrictEqual(["ruben@joingrasp.com"]);
    expect(members.find((member) => member.name === "Sanne de Wit")?.role).toBe(
      "owner"
    );
  });

  it("take what Grasp did by hand: a role, an invitation, access taken away", () => {
    const invited = {
      id: "invited-x",
      name: "Mila Bos",
      email: "mila@example.com",
      title: "Planner",
      role: "viewer" as const,
      invited: today,
    };
    const state: Partial<OrgState> = {
      roles: { karin: "owner" },
      removed: ["wim"],
      invited: [invited],
      resent: { lotte: today },
    };
    const members = membersOf(at(veldkamp, state), today, false);
    expect(members.find((member) => member.id === "karin")).toMatchObject({
      role: "owner",
      changed: true,
    });
    expect(members.find((member) => member.id === "wim")?.state).toBe(
      "removed"
    );
    expect(members.find((member) => member.id === "invited-x")).toMatchObject({
      state: "invited",
      byGrasp: true,
    });
    expect(members.find((member) => member.id === "lotte")?.resent).toBe(today);
    // A seat is taken by everyone invited, except whoever lost their access.
    expect(seatsOf(members, veldkamp.contract)).toStrictEqual({
      used: 3,
      of: 15,
    });
  });
});

describe("what is connected", () => {
  it("follows the company’s own steps: first the sign-in, then the rest", () => {
    expect(integrationsOf(at(vanrijn), today)).toStrictEqual([]);
    expect(
      integrationsOf(at(vanrijn, { client: "directory" }), today).map(
        (each) => each.kind
      )
    ).toStrictEqual(["signIn"]);
    expect(
      integrationsOf(at(vanrijn, { client: "leads" }), today).map(
        (each) => each.kind
      )
    ).toStrictEqual(["signIn", "hr", "documents", "pulse"]);
  });

  it("shows only what was connected by then", () => {
    expect(
      integrationsOf(at(hartog), "2026-04-20").map((each) => each.id)
    ).toStrictEqual(["microsoft-365", "hibob", "sharepoint", "pulse"]);
    expect(integrationsOf(at(hartog), today)).toHaveLength(7);
  });

  it("reads Noordkade’s from the client’s own Integrations page", () => {
    const names = integrationsOf(at(noordkade), today).map((each) => each.name);
    expect(names).toStrictEqual(
      expect.arrayContaining([
        "Microsoft 365",
        "Salesforce",
        "Exact Online",
        "Zoom",
        "AFAS",
        "Pulse",
      ])
    );
    expect(
      integrationsOf(at(noordkade), today)
        .filter((each) => each.again)
        .map((each) => each.name)
    ).toStrictEqual(["Zoom"]);
  });

  it("remembers the day Grasp asked for a new sign-in", () => {
    const zendesk = integrationsOf(
      at(hartog, { asked: { zendesk: today } }),
      today
    ).find((each) => each.id === "zendesk");
    expect(zendesk).toMatchObject({ again: true, asked: today });
  });
});
