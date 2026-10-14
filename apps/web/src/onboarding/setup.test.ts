import type { OnboardingProgress, Roster } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import {
  brainScene,
  closesOn,
  documentSources,
  dotsOf,
  keptAt,
  listeningOf,
  reachedOf,
  stepIndex,
  steps,
  teamNumbersOf,
  teamsOf,
} from "./setup.ts";
import type { Kept } from "./setup.ts";

// From the prototype's `lib/onboarding.test.ts`, on what core keeps.

const roster: Roster = {
  teams: [
    { id: "ops", name: "Ops", lead: null, does: "", off: false },
    { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
    { id: "board", name: "Board", lead: null, does: "", off: true },
  ],
  people: [
    {
      id: "lea",
      name: "Lea",
      email: "",
      team: "sales",
      title: "",
      away: false,
    },
    {
      id: "sam",
      name: "Sam",
      email: "",
      team: "sales",
      title: "",
      away: false,
    },
    { id: "ona", name: "Ona", email: "", team: "ops", title: "", away: false },
    { id: "bo", name: "Bo", email: "", team: "board", title: "", away: false },
  ],
};

const progress: OnboardingProgress = {
  teams: [
    {
      id: "sales",
      name: "Sales",
      people: 2,
      off: false,
      leadTalked: true,
      talked: null,
      asked: null,
    },
    {
      id: "ops",
      name: "Ops",
      people: 1,
      off: false,
      leadTalked: false,
      talked: null,
      asked: null,
    },
  ],
  talked: 0,
  asked: 0,
  leadsTalked: 1,
  leads: 1,
  asOf: "2026-10-06",
};

const plan = { start: "2026-10-06", days: 14 };

describe("the teams", () => {
  it("are those taking part, largest first", () => {
    expect(teamsOf(roster)).toStrictEqual([
      { id: "sales", name: "Sales", people: 2 },
      { id: "ops", name: "Ops", people: 1 },
    ]);
    expect(teamsOf(null)).toStrictEqual([]);
  });
});

describe("the interviews", () => {
  it("start on the plan's first day, and close on its last", () => {
    expect(listeningOf({ roster, plan, progress }, "2026-10-05").day).toBe(0);
    const first = listeningOf({ roster, plan, progress }, "2026-10-06");
    expect(first).toMatchObject({ day: 1, days: 14, leadsHeard: 1 });
    // The lead counts for their team; numbers per team come only from five people on.
    expect(first.heard).toStrictEqual([1, 0]);
    expect(listeningOf({ roster, plan, progress }, "2026-12-01")).toMatchObject(
      { day: 14, progress: 1 }
    );
    expect(closesOn(plan)).toBe("2026-10-19");
  });

  it("have not begun without a plan", () => {
    expect(
      listeningOf({ roster, plan: null, progress: null }, "2026-10-06")
    ).toStrictEqual({
      progress: 0,
      day: 0,
      days: 14,
      leadsHeard: 0,
      colleaguesHeard: 0,
      heard: [0, 0],
    });
  });
});

describe("the brain on each step", () => {
  const listening = listeningOf({ roster, plan, progress }, "2026-10-06");

  it("is the company brain with a nerve to each team once who is who is known", () => {
    expect(
      brainScene("company", { roster: null, listening, known: 20 }).shape
    ).toStrictEqual({ kind: "org", teams: [], leads: false, beyond: 0 });
    expect(
      brainScene("company", { roster, listening, known: 35 }).shape
    ).toStrictEqual({ kind: "org", teams: [2, 1], leads: false, beyond: 0 });
    expect(
      brainScene("leads", { roster, listening, known: 35 }).shape
    ).toMatchObject({ leads: true });
  });

  it("keeps who is who as a nerve beyond the places where documents live", () => {
    expect(
      brainScene("sources", { roster, listening, known: 35 }).shape
    ).toStrictEqual({
      kind: "hub",
      linked: documentSources.map(() => false),
      beyond: 1,
    });
  });

  it("has a figure for every step, as full as Grasp knows", () => {
    for (const step of steps) {
      const scene = brainScene(step, { roster, listening, known: 35 });
      expect(scene.shape.kind).toBeTruthy();
      expect(scene.fill).toBe(0.35);
      expect(scene.teams).toStrictEqual([0.5, 0]);
    }
  });
});

describe("the bar of what Grasp knows", () => {
  it("gives each source its share of the dots, filled as far as it is known", () => {
    const dots = dotsOf(
      [
        { weight: 20, known: 1 },
        { weight: 15, known: 0 },
        { weight: 65, known: 0.5 },
      ],
      20
    );
    expect(dots).toHaveLength(20);
    expect(dots.filter((dot) => dot.filled)).toHaveLength(4 + 0 + 7);
    expect(dots.findIndex((dot) => dot.next)).toBe(4);
    expect(dots.filter((dot) => dot.first)).toHaveLength(2);
  });
});

describe("how far the admin went", () => {
  it("is at least the interviews once they are planned", () => {
    expect(reachedOf(2, { plan: null })).toBe(2);
    expect(reachedOf(2, { plan: { ...plan, start: "2026-10-06" } })).toBe(
      stepIndex("listening")
    );
    expect(reachedOf(99, { plan: null })).toBe(steps.length - 1);
  });
});

describe("what this browser keeps of how far the admin went", () => {
  it("moves on with them, and stays at the furthest step when they go back", () => {
    let kept: Kept = { reached: 0, message: null };
    for (const step of [
      "company",
      "documents",
      "leads",
      "about",
      "company",
    ] as const) {
      kept = keptAt(kept, stepIndex(step));
    }
    expect(kept).toStrictEqual({ reached: stepIndex("leads"), message: null });
    const same = { reached: 4, message: "Hi" };
    expect(keptAt(same, 2)).toBe(same);
  });
});

describe("a team's numbers", () => {
  it("show how many talked of how many were asked, once enough were asked and enough talked", () => {
    expect(teamNumbersOf({ asked: 8, talked: 4 })).toStrictEqual({
      shown: "both",
      talked: 4,
      asked: 8,
    });
  });

  it("show only how many were asked while too few talked, and nothing while too few were asked", () => {
    expect(teamNumbersOf({ asked: 8, talked: null })).toStrictEqual({
      shown: "asked",
      asked: 8,
    });
    expect(teamNumbersOf({ asked: null, talked: null })).toStrictEqual({
      shown: "none",
    });
  });
});
