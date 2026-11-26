import {
  defaultFlow,
  onboardingBehind,
  setupSteps,
} from "@grasp-os/shared/onboarding-flow";
import { describe, expect, it } from "vite-plus/test";

import { heldWhileOnboarding } from "./landing.ts";

// Where someone signed in is held while their company's onboarding isn't
// behind it: its admins in the onboarding, everyone else waiting.

const admin = { role: "admin", staff: false } as const;
const member = { role: "user", staff: false } as const;

describe("someone signed in while the company onboards", () => {
  it.each([
    { who: "an admin", identity: admin, path: "/", to: "/setup" },
    {
      who: "an admin on a link",
      identity: admin,
      path: "/inbox",
      to: "/setup",
    },
    {
      who: "an admin on the onboarding's own settings",
      identity: admin,
      path: "/settings/onboarding",
      to: null,
    },
    { who: "a member", identity: member, path: "/", to: "/waiting" },
    {
      who: "a builder on a link",
      identity: { role: "builder", staff: false } as const,
      path: "/apps",
      to: "/waiting",
    },
  ])("holds $who: $to", ({ identity, path, to }) => {
    expect(heldWhileOnboarding({ path, identity, behind: false })).toBe(to);
  });

  it.each([admin, member])(
    "lets everyone go on once the onboarding is behind the company",
    (identity) => {
      expect(
        heldWhileOnboarding({ path: "/inbox", identity, behind: true })
      ).toBeNull();
    }
  );
});

/** The default flow's steps, with those in `off` switched off. */
const flowWithout = (off: readonly string[], on = true) => ({
  ...defaultFlow,
  on,
  steps: defaultFlow.steps.map((step) => ({
    ...step,
    on: !off.includes(step.id),
  })),
});

describe("an admin's onboarding being behind them", () => {
  it("is so at once where the company goes through no onboarding, or one with every step off", () => {
    expect([
      onboardingBehind({ flow: flowWithout([], false), done: [], open: false }),
      onboardingBehind({
        flow: flowWithout(defaultFlow.steps.map(({ id }) => id)),
        done: [],
        open: false,
      }),
    ]).toStrictEqual([true, true]);
  });

  it("waits for Grasp's go where its people are interviewed, for everyone but an admin who finished every screen", () => {
    const done = [...setupSteps];
    expect({
      member: onboardingBehind({ flow: defaultFlow, done, open: false }),
      go: onboardingBehind({ flow: defaultFlow, done: [], open: true }),
      adminDone: onboardingBehind({
        flow: defaultFlow,
        done,
        open: false,
        admin: true,
      }),
      adminHalfWay: onboardingBehind({
        flow: defaultFlow,
        done: ["welcome", "ai", "company"],
        open: false,
        admin: true,
      }),
    }).toStrictEqual({
      member: false,
      go: true,
      adminDone: true,
      adminHalfWay: false,
    });
  });

  it("is so once they finished every screen where nobody is interviewed, open or not", () => {
    const flow = flowWithout(["about", "pulse", "leads", "interviews"]);
    expect([
      onboardingBehind({
        flow,
        done: ["welcome", "ai", "company", "sources"],
        open: true,
      }),
      onboardingBehind({
        flow,
        done: ["welcome", "ai", "company", "sources", "documents"],
        open: false,
      }),
    ]).toStrictEqual([false, true]);
  });
});
