import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import { describe, expect, it } from "vite-plus/test";

import { stagesOf } from "../src/onboarding/staff-area.ts";
import type { StaffFacts } from "../src/onboarding/staff-area.ts";

// The stages of Grasp's onboarding area (src/onboarding/staff-area.ts),
// from what core holds: a lead who is away gets no link, so the leads'
// interviews can't wait on them.

const view: OnboardingView = {
  roster: {
    teams: [
      { id: "ops", name: "Ops", lead: "olga", does: "", off: false },
      { id: "sales", name: "Sales", lead: "sam", does: "", off: false },
    ],
    people: [
      { id: "olga", name: "Olga", team: "ops", away: false },
      { id: "sam", name: "Sam", team: "sales", away: true },
    ].map((one) => ({ ...one, email: "", title: "" })),
  },
  plan: null,
  progress: null,
  agreed: false,
  paused: false,
};

const gate: GateView = {
  open: false,
  closedSince: null,
  threshold: 80,
  known: 0,
  parts: [],
  ready: false,
  staff: null,
};

const facts: StaffFacts = {
  agreements: null,
  sent: new Set(["olga"]),
  sentAt: new Map([["olga", "2026-10-01"]]),
  interviews: new Map([
    [
      "olga",
      {
        person: "olga",
        kind: "lead",
        startedAt: "2026-10-01T09:00:00.000Z",
        completedAt: "2026-10-01T09:20:00.000Z",
      },
    ],
  ]),
};

describe("the onboarding area's stages", () => {
  it("count only the leads taking part as the leads to talk", () => {
    const leads = stagesOf(view, gate, facts).find(
      ({ stage }) => stage === "leads"
    );
    expect(leads?.todos).toStrictEqual([
      { kind: "leadsNamed", done: true },
      { kind: "leadsTalked", done: true, count: 1, of: 1 },
    ]);
  });
});
