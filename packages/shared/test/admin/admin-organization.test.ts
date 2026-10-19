import { describe, expect, it } from "vite-plus/test";

import {
  organizationOf,
  teamNamed,
} from "../../src/admin/admin-organization.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}) =>
  adminViewOf(org, { ...org.seed, ...more }, today);

describe("the organization as its chart shows it", () => {
  it("counts every team, its people, its leads and its work", () => {
    const view = at(noordkade);
    const chart = organizationOf(view);
    expect(chart.teams).toHaveLength(9);
    expect(chart).toMatchObject({
      taking: 9,
      leadsNamed: 9,
      people: 170,
      asked: 170,
      works: 20,
      known: 5,
    });
    expect(chart.talked).toBe(view.counts.completed);
    // Every piece of work stands under its own team, and its parts of the team's work add up to the whole.
    for (const team of chart.teams) {
      expect(
        team.works.every((work) => work.evidence.team === team.view.team.id)
      ).toBeTruthy();
    }
    for (const team of chart.teams.filter((each) => each.works.length > 0)) {
      expect(team.works.reduce((sum, work) => sum + work.share, 0)).toBeCloseTo(
        1
      );
    }
  });

  it("names who does each piece of work, and flags nobody when all is in order", () => {
    const chart = organizationOf(at(noordkade));
    const insurance = chart.teams.find(
      (team) => team.view.team.id === "insurance"
    );
    expect(insurance?.works.map((work) => work.doers.length)).toStrictEqual(
      insurance?.works.map((work) => work.evidence.doers)
    );
    expect(chart.teams.flatMap((team) => team.flags)).toStrictEqual([]);
  });

  it("finds the work that goes from one team to another, by the team’s own name", () => {
    const chart = organizationOf(at(noordkade));
    const between = chart.between.map((each) => `${each.from} > ${each.to}`);
    expect(between).toContain("sales > onboarding");
    expect(between).toContain("service > insurance");
    const sales = chart.teams.find((team) => team.view.team.id === "sales");
    const onboarding = chart.teams.find(
      (team) => team.view.team.id === "onboarding"
    );
    expect(sales?.to.some((each) => each.to === "onboarding")).toBeTruthy();
    expect(onboarding?.from.some((each) => each.from === "sales")).toBeTruthy();
  });

  it("takes a name only as it is written, as a word of its own", () => {
    const teams = [
      { id: "tax", name: "Tax" },
      { id: "finance", name: "Finance" },
      { id: "office", name: "Finance and administration" },
    ].map((team) => ({ ...team, people: 3, pace: 1, leader: "", does: "" }));
    expect(teamNamed("the tax office", teams, "x")).toBeNull();
    expect(teamNamed("Tax, when it is a return", teams, "x")).toBe("tax");
    expect(teamNamed("Finance and administration", teams, "x")).toBe("office");
    expect(teamNamed("Finance", teams, "x")).toBe("finance");
    // A team never hands its work to itself.
    expect(teamNamed("Finance", teams, "finance")).toBeNull();
  });
});

describe("a team that does not take part", () => {
  const all = at(noordkade);
  const view = at(noordkade, { left: ["sales"] });
  const sales = view.teams.find((team) => team.team.id === "sales");
  const before = all.teams.find((team) => team.team.id === "sales");

  it("is not waited for: whoever has not talked is not asked, and what was said stays said", () => {
    expect(sales).toMatchObject({ off: true, next: { kind: "off" } });
    expect(sales?.counts.completed).toBe(before?.counts.completed);
    expect(sales?.asked).toBe(before?.counts.completed);
    expect(
      sales?.people
        .filter((each) => each.state !== "completed")
        .every((each) => each.state === "away" && each.out)
    ).toBeTruthy();
    expect(view.asked).toBe(
      all.asked -
        ((before?.people.length ?? 0) - (before?.counts.completed ?? 0))
    );
  });

  it("does not hold up the stage or need anything", () => {
    // Veldkamp's team is not told yet: a team left out there is one lead fewer to wait for.
    const waiting = at(veldkamp, {
      client: "told",
      day: 1,
      agreed: { processing: true, assessment: true, council: "yes" },
    });
    const late = waiting.teams
      .filter((team) => team.sent === null)
      .map((team) => team.team.id);
    expect(late.length).toBeGreaterThan(0);
    expect(waiting.stages.leads).toBe("now");
    expect(
      at(veldkamp, {
        client: "told",
        day: 1,
        agreed: { processing: true, assessment: true, council: "yes" },
        left: late,
      }).stages.leads
    ).toBe("done");
    expect(
      organizationOf(view).teams.find((team) => team.view.team.id === "sales")
        ?.flags
    ).toStrictEqual([]);
    expect(organizationOf(view).taking).toBe(8);
  });

  it("keeps the work someone there told about, and leaves the rest out of the count", () => {
    const told = view.works.filter((work) => work.team === "sales");
    expect(told.every((work) => work.approved > 0)).toBeTruthy();
    expect(view.works.length).toBeLessThanOrEqual(all.works.length);
  });
});
