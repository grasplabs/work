import { defaultFlow, setupSteps } from "@grasp-os/shared/onboarding-flow";
import { describe, expect, it } from "vite-plus/test";

import { landingAfterSignIn, onboardingBehind } from "./landing.ts";

// Where someone lands right after signing in: a company's admin whose
// organization is still onboarding goes into the onboarding; everyone
// else where they were going.

const admin = { role: "admin", staff: false } as const;

/** Where they land, and whether it was asked if the organization finished onboarding. */
const land = async (
  path: string,
  identity: Parameters<typeof landingAfterSignIn>[0]["identity"],
  open: boolean
) => {
  let asked = false;
  const to = await landingAfterSignIn({
    path,
    identity,
    open: async () => {
      asked = true;
      return await Promise.resolve(open);
    },
  });
  return { to, asked };
};

describe("landing right after signing in", () => {
  it("takes the company's admin into the onboarding while their organization hasn't finished it", async () => {
    await expect(land("/", admin, false)).resolves.toStrictEqual({
      to: "/setup",
      asked: true,
    });
  });

  it("takes them home once it has", async () => {
    await expect(land("/", admin, true)).resolves.toMatchObject({ to: null });
  });

  it("keeps a link they followed to sign in", async () => {
    await expect(land("/inbox", admin, false)).resolves.toMatchObject({
      to: null,
    });
  });

  it.each([
    { who: "a member", identity: { role: "user", staff: false } as const },
    { who: "Grasp's staff", identity: { role: "admin", staff: true } as const },
  ])("leaves $who where they were going", async ({ identity }) => {
    await expect(land("/", identity, false)).resolves.toStrictEqual({
      to: null,
      asked: false,
    });
  });
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

  it("waits for Grasp's go where its people are interviewed, whatever the admin finished", () => {
    const done = [...setupSteps];
    expect([
      onboardingBehind({ flow: defaultFlow, done, open: false }),
      onboardingBehind({ flow: defaultFlow, done: [], open: true }),
    ]).toStrictEqual([false, true]);
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
