import { describe, expect, it } from "vite-plus/test";

import {
  adminViewOf,
  historyOf,
  portfolioOf,
} from "../../src/admin/admin-view.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, vanrijn, hartog] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}, now = today) =>
  adminViewOf(org, { ...org.seed, ...more }, now);
const kinds = (org: Org, more: Partial<OrgState> = {}, now = today) =>
  at(org, more, now).needs.map((need) => need.kind);

describe("what needs Grasp at one organization", () => {
  it("starts as each sample says", () => {
    expect(kinds(noordkade)).toStrictEqual([
      "go",
      "conflict",
      "ask",
      "signin",
      "read",
    ]);
    expect(kinds(veldkamp)).toStrictEqual(["agreement"]);
    expect(kinds(vanrijn)).toStrictEqual(["transcript", "contract"]);
    expect(kinds(hartog)).toStrictEqual(["ending", "budget", "signin"]);
  });

  it("names a contract that is not signed, until it is", () => {
    expect(
      at(vanrijn).needs.find((need) => need.kind === "contract")
    ).toStrictEqual({
      kind: "contract",
      sent: "2026-10-01",
    });
    expect(kinds(vanrijn, { contract: { status: "draft" } })).toContain(
      "contract"
    );
    expect(
      kinds(vanrijn, { contract: { status: "signed", signed: today } })
    ).not.toContain("contract");
  });

  it("names a contract that ends with nothing after it, and not one that carries on", () => {
    expect(
      at(hartog).needs.find((need) => need.kind === "ending")
    ).toStrictEqual({
      kind: "ending",
      until: "2026-10-31",
      days: 29,
    });
    expect(kinds(hartog, { contract: { renews: true } })).not.toContain(
      "ending"
    );
    expect(kinds(hartog, { contract: { until: "2027-03-31" } })).not.toContain(
      "ending"
    );
  });

  it("names an integration that stopped, until Grasp has asked the company’s admin", () => {
    expect(kinds(hartog, { asked: { zendesk: today } })).not.toContain(
      "signin"
    );
    expect(kinds(noordkade, { asked: { zoom: today } })).not.toContain(
      "signin"
    );
  });

  it("names a month in which more AI was used than the contract covers", () => {
    const need = at(hartog).needs.find((each) => each.kind === "budget");
    expect(need).toMatchObject({
      kind: "budget",
      month: "2026-09",
      included: 600,
    });
    expect(need?.kind === "budget" ? need.spend : 0).toBeGreaterThan(600);
    // With more covered, it is no longer over.
    expect(kinds(hartog, { contract: { aiIncluded: 2000 } })).not.toContain(
      "budget"
    );
    // The interviews alone stay far inside what Noordkade's contract covers.
    expect(kinds(noordkade)).not.toContain("budget");
  });

  it("puts the most pressing first", () => {
    expect(kinds(hartog)[0]).toBe("ending");
    expect(kinds(noordkade)[0]).toBe("go");
    expect(kinds(noordkade, { opened: 8 })).not.toContain("go");
  });
});

describe("everything about one organization", () => {
  it("is open once Grasp gave its go, and not a day before", () => {
    expect(at(noordkade).open).toBeFalsy();
    expect(at(noordkade, { opened: 8 }).open).toBeTruthy();
    expect(at(hartog).open).toBeTruthy();
    expect(at(hartog, { day: 10 }).open).toBeFalsy();
  });

  it("counts everything up to the same day", () => {
    const view = at(hartog);
    expect(view.asOf).toBe(today);
    expect(view.invoices[0]?.date.localeCompare(view.asOf)).toBeLessThanOrEqual(
      0
    );
    expect(view.usage.months.at(-1)?.month).toBe("2026-10");
    for (const member of view.members) {
      expect(member.invited.localeCompare(view.asOf)).toBeLessThanOrEqual(0);
    }
    for (const integration of view.integrations) {
      expect(integration.since.localeCompare(view.asOf)).toBeLessThanOrEqual(0);
    }
  });

  it("keeps the onboarding as it was: the same people, interviews and workflows", () => {
    const view = at(noordkade);
    expect(view.people).toHaveLength(170);
    expect(view.knowledge.percent).toBe(80);
    expect(view.stage).toBe("interviews");
  });
});

describe("the history of an organization", () => {
  it("is the newest first, and never ahead of the day it is counted up to", () => {
    for (const org of SAMPLE_ORGS) {
      const view = at(org);
      const history = historyOf(view);
      const order = history.map((event) => event.on);
      expect(order).toStrictEqual(order.toSorted((a, b) => b.localeCompare(a)));
      for (const event of history) {
        expect(event.on.localeCompare(view.asOf)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("has the contract, the agreements, what was connected and every workflow that went live", () => {
    const history = historyOf(at(hartog));
    const on = (kind: string) =>
      history.filter((event) => event.kind === kind).map((event) => event.on);
    // Everyone who was invited, on the day they were; and everyone who came in.
    const count = (kind: "invited" | "joined") =>
      history.reduce(
        (sum, event) => sum + (event.kind === kind ? event.count : 0),
        0
      );
    expect({
      contractSent: on("contractSent"),
      contractSigned: on("contractSigned"),
      contractStarts: on("contractStarts"),
      agreement: on("agreement"),
      connected: on("connected").length,
      live: on("live"),
      go: on("go"),
      invited: count("invited"),
      joined: count("joined"),
    }).toStrictEqual({
      contractSent: ["2026-03-12"],
      contractSigned: ["2026-03-18"],
      contractStarts: ["2026-04-01"],
      agreement: ["2026-04-02", "2026-03-27", "2026-03-24"],
      connected: 7,
      live: ["2026-09-07", "2026-08-03", "2026-07-06", "2026-06-15"],
      go: ["2026-04-24"],
      invited: 14,
      joined: 13,
    });
  });

  it("has no signature for a contract that is only sent, and nothing that has not happened yet", () => {
    expect(historyOf(at(vanrijn)).map((event) => event.kind)).toStrictEqual([
      "invited",
      "conversation",
      "contractSent",
    ]);
    // A workflow that went live later is not in the history of an earlier day.
    const july = historyOf(at(hartog, {}, "2026-07-01"));
    expect(july.filter((event) => event.kind === "live")).toHaveLength(1);
  });
});

describe("every organization together", () => {
  const views = SAMPLE_ORGS.map((org) => at(org));

  it("adds up to what the list says", () => {
    const portfolio = portfolioOf(views);
    expect(portfolio).toMatchObject({ orgs: 4, ready: 1, open: 1 });
    // Three contracts run today: Van Rijn's is not signed.
    expect(portfolio.fees).toBe(
      noordkade.contract.fee + veldkamp.contract.fee + hartog.contract.fee
    );
    expect(portfolio.spend).toBeCloseTo(
      views.reduce((sum, view) => sum + view.usage.thisMonth.spend, 0),
      6
    );
    expect(portfolio.freed).toBeCloseTo(views[3]?.value.freed ?? Number.NaN, 6);
    expect(portfolio.value).toBeCloseTo(views[3]?.value.value ?? Number.NaN, 6);
  });
});
