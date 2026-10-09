import type { KickoffReading } from "@grasp-os/shared/kickoff";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import type { StephenSetup } from "@grasp-os/shared/onboarding-staff";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// What only Grasp's staff set in the onboarding (GRA-320): how Stephen is
// set up for this deployment, which every interview turn's context holds
// with what the kickoff brought; and the agreements, each with its day,
// whose last one in sends the links that wait. The ways it can fail,
// tried here:
//
// - Stephen asking about what staff told him to leave alone, because the
//   kickoff's older word on it is still in his context.
// - Anyone but staff reading or changing his setup or the agreements.
// - A setup that isn't one: no language, one he doesn't speak, a line
//   past its length.
// - The words staff gave him in the audit log, which the company reads.
// - Links waiting on the store's next alarm, up to an hour, once the
//   agreements are in.

const idp = mockIdp();

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** What the kickoff brought: what to leave alone, the languages, a team. */
const reading: KickoffReading = {
  fields: {
    limits: {
      text: "De salarisadministratie blijft buiten beeld.",
      quote: "Aan de salarisadministratie mag niemand komen",
    },
    languages: {
      text: "Nederlands, en Engels voor IT.",
      quote: "Nederlands, en Engels voor IT",
    },
    pain: {
      text: "Klantgegevens overtypen tussen het CRM en de bankportalen.",
      quote: "Het overtypen van klantgegevens",
    },
  },
  ask: {},
  teams: [{ name: "Hypotheekadvies", does: "Advies" }],
};

const kickoffIn = async (): Promise<void> => {
  await onboardingStore(env).saveKickoff(
    { transcript: "Het gesprek.", fileName: null, reading },
    { type: "system" }
  );
};

/** Staff's own setup: only Dutch, the board's plans left alone, two words. */
const staffs: StephenSetup = {
  languages: ["nl"],
  limits: ["De plannen van de directie"],
  terms: ["Hypotheekadvies", "Zebulon CRM"],
};

describe("how Stephen is set up", () => {
  it("is what the kickoff suggests until staff set it, and every turn's context holds it with what the kickoff brought", async () => {
    await kickoffIn();
    const staff = await asStaff();
    const suggested = await staff.onboardingStaff.stephen();
    const before = await onboardingStore(env).interviewBrief();
    expect({
      setup: suggested.setup,
      changed: suggested.changed,
      kickoff: suggested.kickoff,
      leavesAlone: before.includes(
        "- De salarisadministratie blijft buiten beeld."
      ),
      languages: before.includes(
        "## The languages you interview in\nEnglish, Dutch, German, French, Spanish"
      ),
      kickoffLanguages: before.includes("Nederlands, en Engels voor IT."),
      pain: before.includes("Klantgegevens overtypen"),
    }).toStrictEqual({
      setup: {
        languages: ["en", "nl", "de", "fr", "es"],
        limits: ["De salarisadministratie blijft buiten beeld."],
        terms: ["Hypotheekadvies"],
      },
      changed: false,
      kickoff: {
        languages: "Nederlands, en Engels voor IT.",
        systems: null,
      },
      leavesAlone: true,
      languages: true,
      kickoffLanguages: true,
      pain: true,
    });
  });

  it("holds staff's setup from the next turn on, in place of the kickoff's word on languages and what to leave alone, and goes back to it", async () => {
    await kickoffIn();
    const staff = await asStaff();
    const saved = await staff.onboardingStaff.saveStephen(staffs);
    const brief = await onboardingStore(env).interviewBrief();
    const reset = await staff.onboardingStaff.saveStephen(null);
    const after = await onboardingStore(env).interviewBrief();
    expect({
      setup: saved.setup,
      changed: saved.changed,
      languages: brief.includes("## The languages you interview in\nDutch\n"),
      leavesAlone: brief.includes("- De plannen van de directie"),
      words: brief.includes("Hypotheekadvies, Zebulon CRM"),
      // The kickoff's own word on them would contradict staff's.
      kickoffLimits: brief.includes("salarisadministratie"),
      kickoffLanguages: brief.includes("Engels voor IT"),
      // The rest of what it brought stays.
      pain: brief.includes("Klantgegevens overtypen"),
      reset: { changed: reset.changed, setup: reset.setup.languages.length },
      backToKickoff: after.includes("salarisadministratie"),
    }).toStrictEqual({
      setup: staffs,
      changed: true,
      languages: true,
      leavesAlone: true,
      words: true,
      kickoffLimits: false,
      kickoffLanguages: false,
      pain: true,
      reset: { changed: false, setup: 5 },
      backToKickoff: true,
    });
  });

  it("holds before any kickoff is in", async () => {
    const staff = await asStaff();
    await staff.onboardingStaff.saveStephen(staffs);
    const brief = await onboardingStore(env).interviewBrief();
    expect(brief).toContain("Zebulon CRM");
  });

  it("is on record as staff's, without the words they gave him", async () => {
    const staff = await asStaff();
    const events = await auditedDuring(async () => {
      await staff.onboardingStaff.saveStephen(staffs);
      await staff.onboardingStaff.saveStephen(null);
    });
    expect({
      actions: events.map(({ action, actor }) => [action, actor.type]),
      detail: events[0]?.detail,
      words: JSON.stringify(events).includes("Zebulon"),
    }).toStrictEqual({
      actions: [
        ["onboarding.stephen.set", "staff"],
        ["onboarding.stephen.reset", "staff"],
      ],
      detail: { languages: "nl", limits: 1, terms: 2 },
      words: false,
    });
  });

  it("refuses what isn't a setup", async () => {
    const staff = await asStaff();
    const tries: unknown[] = [
      { ...staffs, languages: [] },
      { ...staffs, languages: ["pt"] },
      { ...staffs, languages: ["nl", "nl"] },
      { ...staffs, terms: ["x".repeat(41)] },
      { ...staffs, limits: [" "] },
      { ...staffs, extra: true },
    ];
    const refused = await Promise.all(
      tries.map(
        async (setup) =>
          await outcome(
            // SAFETY: what a client could send, whatever its types say.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            staff.onboardingStaff.saveStephen(setup as StephenSetup)
          )
      )
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.invalid"]));
  });
});

/** One team, led by Lea, and Sam in it; and Ona in a team without a lead. */
const roster: RosterInput = {
  teams: [
    { id: "sales", name: "Sales", lead: "lea" },
    { id: "ops", name: "Ops", lead: null },
  ],
  people: [
    { id: "lea", name: "Lea", team: "sales" },
    { id: "sam", name: "Sam", team: "sales" },
    { id: "ona", name: "Ona", team: "ops" },
  ],
};

describe("the agreements, as staff put them in place", () => {
  it("keep each one's day, and once the last is in the links that wait go out at once; the team is told then", async () => {
    const { api } = await signedInApi(idp, "admin");
    const staff = await asStaff();
    await api.onboarding.saveRoster(roster);
    await api.onboarding.savePlan({
      start: new Date().toISOString().slice(0, 10),
    });
    await staff.onboardingStaff.setAgreements({
      processing: true,
      processingOn: "2026-10-01",
      assessment: true,
      assessmentOn: "2026-10-02",
      council: "waiting",
    });
    const waiting = await staff.onboardingStaff.agreements();
    const view = await staff.onboardingStaff.setAgreements({
      processing: true,
      processingOn: "2026-10-01",
      assessment: true,
      assessmentOn: "2026-10-02",
      council: "none",
      councilOn: "2026-10-03",
    });
    const out = await staff.onboardingStaff.agreements();
    expect({ waiting, agreed: view.agreed, out }).toStrictEqual({
      waiting: {
        agreements: {
          processing: true,
          processingOn: "2026-10-01",
          assessment: true,
          assessmentOn: "2026-10-02",
          council: "waiting",
        },
        agreed: false,
        told: false,
        out: 0,
        waiting: 3,
      },
      agreed: true,
      out: {
        agreements: {
          processing: true,
          processingOn: "2026-10-01",
          assessment: true,
          assessmentOn: "2026-10-02",
          council: "none",
          councilOn: "2026-10-03",
        },
        agreed: true,
        told: true,
        // The lead's and Ona's; Sam's waits for Lea.
        out: 2,
        waiting: 1,
      },
    });
  });

  it("refuse a day that isn't one", async () => {
    const staff = await asStaff();
    await expect(
      outcome(
        staff.onboardingStaff.setAgreements({
          processing: true,
          processingOn: "1 October",
          assessment: false,
          council: "waiting",
        })
      )
    ).resolves.toBe("onboarding.invalid");
  });
});

describe("what only staff set", () => {
  it("is staff's alone: a member and the company's admin get nothing from it", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.stephen()),
        outcome(api.onboardingStaff.saveStephen(staffs)),
        outcome(api.onboardingStaff.saveStephen(null)),
        outcome(api.onboardingStaff.agreements()),
      ])
    );
    const kept = await onboardingStore(env).stephen();
    expect({ refused: new Set(refused), changed: kept.changed }).toStrictEqual({
      refused: new Set(["onboarding.staff_only"]),
      changed: false,
    });
  });
});
