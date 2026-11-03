import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { adminCommands } from "./admin-command.ts";
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
// - A week, or a next report, counted from anything but the programme's
//   first Monday and core's own today.

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

/** `YYYY-MM-DD` of the day `days` days before `day`. */
const dayBefore = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

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
    expect(programme).toMatchObject({
      start: mondayBefore(today()),
      weeks: 8,
      stage: "open",
      today: today(),
      week: 1,
      inProgramme: true,
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

  it("counts today's week and the next report from the programme's first Monday", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: member } = await signedInApi(idp, "user");
    await admin.onboarding.saveRoster(roster);
    // Nine weeks before this week's Monday: past the programme's eight.
    const monday = mondayBefore(today());
    const start = dayBefore(monday, 9 * 7);
    await planFrom(start);
    const daysIn = (Date.parse(today()) - Date.parse(monday)) / 86_400_000;
    const read = await member.onboarding.programme();
    expect({
      start: read?.start,
      today: read?.today,
      week: read?.week,
      inProgramme: read?.inProgramme,
      nextReport: read?.nextReport,
      reportWindow: read?.reportWindow,
    }).toStrictEqual({
      start,
      today: today(),
      week: 10,
      inProgramme: false,
      // On a Monday, the report on the week that just closed is ready.
      nextReport:
        daysIn === 0
          ? { inDays: 0, week: 9, through: 7 }
          : { inDays: 7 - daysIn, week: 10, through: daysIn },
      reportWindow:
        daysIn === 0
          ? { to: dayBefore(monday, 1), days: 7 }
          : { to: today(), days: daysIn + 1 },
    });
  });

  it("says where the onboarding stands while the company is not in yet", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboarding.saveRoster(roster);
    await planFrom(today());
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    const staff = core.authenticate();
    await adminCommands().close();
    const closed = await staff.onboarding.programme();
    await adminCommands().open();
    expect(closed?.stage).toBe("interviews");
  });
});
