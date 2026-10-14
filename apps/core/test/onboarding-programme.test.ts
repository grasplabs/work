import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { openRpc, signedIn, signedInApi, staffPerson } from "./sign-in.ts";

// The programme with Grasp, as the dashboard reads it
// (`onboarding.programme()` in src/onboarding/rpc.ts): for everyone signed
// in, so nothing in it but the Monday it began and where the onboarding
// stands. The ways it can fail, tried here:
//
// - A week line without a plan, or a programme that starts on any day but
//   the Monday of the week the interviews start.
// - A member reading more of the onboarding than the dates and the stage.

const idp = mockIdp();

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Peregrine Wolstenholme";

const roster: RosterInput = {
  teams: [{ id: "sales", name: "Sales", lead: "lea" }],
  people: [
    { id: "lea", name: sentinel, email: "lea@acme.test", team: "sales" },
  ],
};

const today = () => new Date().toISOString().slice(0, 10);

/** The Monday (UTC) of the week `day` falls in, counted by hand. */
const mondayBefore = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  while (date.getUTCDay() !== 1) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
};

/** Saves a plan straight into the deployment's store, past days too. */
const planFrom = async (start: string): Promise<void> => {
  const by = { type: "system" } as const;
  await onboardingStore(env).savePlan({ start, days: 14 }, by);
};

describe("the programme", () => {
  it("is none without a plan, for any role", async () => {
    const { api: member } = await signedInApi(idp, "user");
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboarding.saveRoster(roster);
    await expect(member.onboarding.programme()).resolves.toBeNull();
    await expect(admin.onboarding.programme()).resolves.toBeNull();
  });

  it("starts on the Monday of the week the interviews start, and tells every member only that and the stage", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: member } = await signedInApi(idp, "user");
    await admin.onboarding.saveRoster(roster);
    await admin.onboarding.savePlan({ start: today(), days: 14 });
    const programme = await member.onboarding.programme();
    // Never closed here, so open: the company is in.
    expect(programme).toStrictEqual({
      start: mondayBefore(today()),
      weeks: 8,
      stage: "open",
    });
    expect(JSON.stringify(programme)).not.toContain(sentinel);
  });

  it("counts a Wednesday's and a Sunday's interviews from the Monday before, and a Monday's from that day", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboarding.saveRoster(roster);
    const starts: Record<string, string> = {};
    for (const start of ["2026-09-09", "2026-09-13", "2026-09-14"]) {
      // oxlint-disable-next-line no-await-in-loop -- one plan at a time
      await planFrom(start);
      // oxlint-disable-next-line no-await-in-loop -- read after each plan
      const programme = await admin.onboarding.programme();
      starts[start] = programme?.start ?? "none";
    }
    expect(starts).toStrictEqual({
      "2026-09-09": "2026-09-07",
      "2026-09-13": "2026-09-07",
      "2026-09-14": "2026-09-14",
    });
  });

  it("says where the onboarding stands while the company is not in yet", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboarding.saveRoster(roster);
    await planFrom(today());
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    const staff = core.authenticate();
    await staff.onboardingGate.close();
    const closed = await staff.onboarding.programme();
    await staff.onboardingGate.open();
    expect(closed?.stage).toBe("interviews");
  });
});
