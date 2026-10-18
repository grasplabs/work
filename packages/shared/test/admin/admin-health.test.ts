import { describe, expect, it } from "vite-plus/test";

import {
  briefOf,
  BRIEF_ITEMS,
  WITH_COMPANY,
} from "../../src/admin/admin-brief.ts";
import { brainOf, healthOf, phaseOf } from "../../src/admin/admin-health.ts";
import type { HealthArea, HealthLevel } from "../../src/admin/admin-health.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, vanrijn, hartog] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}) =>
  adminViewOf(org, { ...org.seed, ...more }, today);
const level = (
  org: Org,
  area: HealthArea,
  more: Partial<OrgState> = {}
): HealthLevel =>
  healthOf(at(org, more)).find((signal) => signal.area === area)?.level ??
  "none";

describe("the phase an organization is in", () => {
  it("follows where each sample stands", () => {
    expect(SAMPLE_ORGS.map((org) => phaseOf(at(org)))).toStrictEqual([
      "ready",
      "agreements",
      "start",
      "open",
    ]);
  });

  it("is open once Grasp gave its go, and ready again when the go is taken back", () => {
    const opened = at(noordkade, { opened: 8 });
    expect(phaseOf(opened)).toBe("open");
    expect(phaseOf(at(noordkade, { opened: null }))).toBe("ready");
  });
});

describe("the health of an organization", () => {
  it("has one signal for every area, always in the same order", () => {
    for (const org of SAMPLE_ORGS) {
      expect(healthOf(at(org)).map((signal) => signal.area)).toStrictEqual([
        "connections",
        "interviews",
        "brain",
        "workflows",
        "account",
      ]);
    }
  });

  it("needs Grasp where a connection stopped, until someone signs in again", () => {
    expect(level(hartog, "connections")).toBe("attention");
    const view = at(hartog);
    const stopped = view.integrations.filter(
      (integration) => integration.again
    );
    expect(stopped.length).toBeGreaterThan(0);
  });

  it("says nothing about interviews that have not started", () => {
    expect(level(vanrijn, "interviews")).toBe("none");
    expect(level(veldkamp, "interviews")).toBe("none");
  });

  it("counts the brain as good once enough is known to open", () => {
    expect(level(noordkade, "brain")).toBe("good");
    expect(level(noordkade, "brain", { threshold: 95 })).not.toBe("good");
  });

  it("needs Grasp for the contract and for AI beyond what it covers", () => {
    const account = healthOf(at(hartog)).find(
      (signal) => signal.area === "account"
    );
    expect(account).toMatchObject({
      level: "attention",
      needs: ["ending", "budget"],
    });
    expect(level(vanrijn, "account")).toBe("attention");
    expect(
      level(vanrijn, "account", {
        contract: { status: "signed", signed: today },
      })
    ).toBe("good");
  });
});

describe("the brain of an organization", () => {
  it("counts only agreed interviews, by the team of who gave them", () => {
    const view = at(noordkade);
    const brain = brainOf(view);
    expect(brain.interviews).toBe(
      view.interviews.filter((interview) => interview.approved).length
    );
    expect(brain.teams.reduce((sum, team) => sum + team.agreed, 0)).toBe(
      brain.interviews
    );
  });

  it("counts the facts agreed to, not those taken out at the read-back", () => {
    const view = at(noordkade);
    const approved = view.interviews.filter((interview) => interview.approved);
    expect(approved.some((interview) => interview.out > 0)).toBeTruthy();
    expect(brainOf(view).facts).toBe(
      approved.reduce(
        (sum, interview) => sum + interview.facts - interview.out,
        0
      )
    );
  });

  it("puts the largest gap in what is known first", () => {
    const { sources } = brainOf(at(veldkamp));
    const gaps = sources.map((each) => each.weight * (1 - each.known));
    expect(gaps).toStrictEqual(gaps.toSorted((a, b) => b - a));
  });

  it("has heard nobody before the interviews", () => {
    expect(brainOf(at(vanrijn))).toMatchObject({
      covered: 0,
      facts: 0,
      interviews: 0,
    });
  });
});

describe("the brief for the next call", () => {
  it("brings up what the company itself can act on, the most pressing first, at most a few", () => {
    const view = at(noordkade);
    const brief = briefOf(view);
    expect(brief.bringUp).toStrictEqual(
      view.needs
        .filter((need) => WITH_COMPANY.includes(need.kind))
        .slice(0, BRIEF_ITEMS)
    );
    // Reading interviews is Grasp's own to do, not something for the call.
    expect(brief.bringUp.map((need) => need.kind)).not.toContain("read");
    expect(briefOf(at(vanrijn)).bringUp.map((need) => need.kind)).toStrictEqual(
      ["contract"]
    );
    expect(brief.missing.length).toBeLessThanOrEqual(BRIEF_ITEMS);
    expect(brief.missing.every((each) => each.known < 1)).toBeTruthy();
  });

  it("lists the next steps until Grasp opens, then where it could do more", () => {
    expect(briefOf(at(vanrijn)).next.map((todo) => todo.kind)).toStrictEqual([
      "transcriptRead",
      "askSponsor",
    ]);
    const open = briefOf(at(hartog));
    expect(open.next).toStrictEqual([]);
    expect(open.opportunities.length).toBeGreaterThan(0);
    expect(open.opportunities.map((each) => each.hours)).toStrictEqual(
      open.opportunities.map((each) => each.hours).toSorted((a, b) => b - a)
    );
  });

  it("offers no work that already runs or is being designed", () => {
    const view = at(hartog);
    const taken = new Set(
      view.value.works
        .filter((work) => work.live || work.expected > 0)
        .map((work) => work.evidence.id)
    );
    expect(
      briefOf(view).opportunities.some((each) => taken.has(each.id))
    ).toBeFalsy();
  });
});
