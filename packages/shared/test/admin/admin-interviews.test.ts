import { describe, expect, it } from "vite-plus/test";

import { funnelOf, talkedByDay } from "../../src/admin/admin-interviews.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { LISTEN_DAYS } from "../../src/admin/onboarding.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp] = SAMPLE_ORGS;
const at = (org: Org, more: Partial<OrgState> = {}) =>
  adminViewOf(org, { ...org.seed, ...more }, "2026-10-02");

describe("how far everyone has come with their link", () => {
  it("narrows step by step: asked, link out, opened, started, talked", () => {
    const funnel = funnelOf(at(noordkade));
    expect([funnel.asked, funnel.talked]).toStrictEqual([
      170,
      at(noordkade).counts.completed,
    ]);
    // Each step holds at most as many as the one before it.
    const steps = [
      funnel.asked,
      funnel.out,
      funnel.opened,
      funnel.started,
      funnel.talked,
    ];
    expect(steps).toStrictEqual(steps.toSorted((a, b) => b - a));
  });

  it("leaves out who is away and a team that does not take part", () => {
    const all = funnelOf(at(noordkade));
    const without = funnelOf(at(noordkade, { left: ["sales"] }));
    expect(without.asked).toBeLessThan(all.asked);
    expect(without.talked).toBe(all.talked);
  });

  it("is all nothing before the team is told", () => {
    expect(funnelOf(at(veldkamp))).toMatchObject({
      out: 0,
      opened: 0,
      started: 0,
      talked: 0,
      reminded: 0,
      toRemind: [],
    });
  });
});

describe("who talked, day by day", () => {
  it("adds up to everyone who talked, and says nothing of days that have not come", () => {
    const view = at(noordkade);
    const days = talkedByDay(view);
    expect(days).toHaveLength(LISTEN_DAYS + 1);
    expect(days[view.day]?.total).toBe(view.counts.completed);
    expect(
      days
        .slice(0, view.day + 1)
        .reduce((sum, each) => sum + (each.talked ?? 0), 0)
    ).toBe(view.counts.completed);
    expect(
      days
        .slice(view.day + 1)
        .every((each) => each.talked === null && each.total === null)
    ).toBeTruthy();
  });

  it("has no days before the team is told", () => {
    expect(
      talkedByDay(at(veldkamp)).every((each) => each.total === null)
    ).toBeTruthy();
  });
});
