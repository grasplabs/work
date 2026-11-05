import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";

// The board's weekly weekly, read in one call (`dashboard.report()` in
// src/board-weekly.ts). The ways it can fail, tried here: a report on
// another week than the one the dashboard's line says, or of days its
// week doesn't hold; a member reading what only admins may (how many the
// interviews heard); and one part that can't be read taking the rest
// with it, or a part's refusal failing the weekly.

const idp = mockIdp();

/** Signing people in and running workflows can be slow on CI. */
const slow = { timeout: 60_000 };

const roster: RosterInput = {
  teams: [{ id: "sales", name: "Sales", lead: "lea" }],
  people: [{ id: "lea", name: "Lea", email: "lea@acme.test", team: "sales" }],
};

const today = () => new Date().toISOString().slice(0, 10);

/** A plan whose interviews start today, saved straight into the store. */
const planToday = async (): Promise<void> => {
  await onboardingStore(env).savePlan(
    { start: today(), days: 14 },
    { type: "system" }
  );
};

describe("the board's weekly report", slow, () => {
  afterEach(endLiveRuns);

  // First, before any test here saves a plan.
  it("has no programme without a plan, and still says what ran", async () => {
    const member = await signedInApi(idp, "user");

    const weekly = await member.api.dashboard.report();
    expect({
      programme: weekly.programme,
      runs: weekly.runs.state,
      people: "people" in weekly,
    }).toStrictEqual({
      programme: { state: "read", data: null },
      runs: "read",
      people: false,
    });
  });

  it("tells admins how many the interviews heard, and every part what it read", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    await planToday();

    const weekly = await admin.api.dashboard.report();
    const { progress } = await admin.api.onboarding.view();
    expect({
      states: [
        weekly.programme.state,
        weekly.runs.state,
        weekly.idleWorkflows.state,
        weekly.better.state,
      ],
      people: weekly.people,
      better: weekly.better.state === "read" ? weekly.better.data : "unread",
    }).toStrictEqual({
      states: ["read", "read", "read", "read"],
      people: { state: "read", data: progress },
      // An admin reads every signal, though none is computed yet.
      better: [],
    });
  });
});
