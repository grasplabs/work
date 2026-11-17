import type { KickoffReading } from "@grasp-os/shared/kickoff";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { adminKickoff } from "./admin-kickoff.ts";
import { mockIdp } from "./idp.ts";
import { d1ColumnsWith, onboardingTablesWith } from "./kept-where.ts";
import { fakeProvider } from "./model-provider.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";
import { sayForAdmin, stillKept } from "./spoken.ts";

// The admin deletes the kickoff (GRA-1897): its transcript, its reading,
// the sponsor's answers, and everything drawn from it, for good. The ways
// it can fail, from the threat model on the issue:
//
// - A member deleting it, or the delete showing the admin its words.
// - Its words left in a read: the admin's onboarding, the Brain page
//   (`brain.read`'s vision, sector and teams), an interview turn's
//   context, or any table.
// - A staff save whose reading began before the delete bringing the
//   words back.
// - Its words in the audit log.
//
// Its source in the new Brain, and an erasure of it that fails, are
// brain-next-kickoff.test.ts'.

const idp = mockIdp();

/** Who works where: one team, so an interview turn has a context. */
const roster: RosterInput = {
  teams: [{ id: "finance", name: "Finance", lead: "ann" }],
  people: [
    { id: "ann", name: "Ann", team: "finance", title: "Head of finance" },
    { id: "ben", name: "Ben", team: "finance", title: "Accountant" },
  ],
};

/** A word only this kickoff says, lower case as the scans look for it. */
const markerOf = (): string => `zqkick${unique()}`;

/**
 * Staff bring in a kickoff whose transcript, reading, Stephen's words and
 * a team all hold `marker`, and answer one of its fields with it too.
 */
const bringIn = async (marker: string): Promise<void> => {
  const transcript = `Anna (CEO): We run ${marker} bakeries in Utrecht.
Anna (CEO): We want ${marker} bread in every town within two years.
Anna (CEO): Our ${marker} team of 6 bakes through the night.
Jakob (Grasp): What takes the most time?
Anna (CEO): Counting the flour by hand every morning, and the orders by phone.`;
  await fakeProvider({
    text: JSON.stringify({
      fields: [
        {
          field: "business",
          text: `${marker} bakeries in Utrecht.`,
          quote: `We run ${marker} bakeries in Utrecht`,
          ask: "",
        },
        {
          field: "goals",
          text: `${marker} bread in every town.`,
          quote: `We want ${marker} bread in every town`,
          ask: "",
        },
      ],
      teams: [{ name: marker, does: "Baking", people: 6 }],
      sponsor: "Anna",
      onboarding: [
        {
          locale: "en",
          business: `You run ${marker} bakeries.`,
          documents: ["recipes"],
          example: { role: "", question: "", answer: "", time: "" },
        },
      ],
    }),
    inputTokens: 900,
    outputTokens: 300,
  });
  const staff = adminKickoff();
  await staff.saveKickoff({ locale: "en", transcript: { text: transcript } });
  await staff.answerKickoff("pain", `Night shifts at ${marker} are long.`);
};

/** Every read the kickoff's words could reach, as text, for a marker to be looked for in. */
const reads = async (admin: Awaited<ReturnType<typeof signedInApi>>) => {
  const store = onboardingStore(env);
  return {
    kickoff: JSON.stringify(await store.kickoff()),
    setup: JSON.stringify(await admin.api.onboarding.view()),
    brain: JSON.stringify(await admin.api.brain.read()),
    turn: JSON.stringify(await store.contextOf("ben")),
    stephen: JSON.stringify(await store.stephen()),
  };
};

/** Which of `read`'s parts hold `marker`. */
const holding = (read: Record<string, string>, marker: string): string[] =>
  Object.entries(read).flatMap(([part, text]) =>
    text.toLowerCase().includes(marker) ? [part] : []
  );

/** Where `marker` is kept: core's database and the onboarding's tables. */
const keptWhere = async (marker: string) => ({
  core: await d1ColumnsWith(env.DB, marker),
  onboarding: await onboardingTablesWith(marker),
});

describe("deleting the kickoff", { timeout: 60_000 }, () => {
  it("takes it and everything drawn from it out of every read, with one audit event", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const marker = markerOf();
    await bringIn(marker);
    // Staff answer again.
    await adminKickoff().answerKickoff("pain", `Ovens at ${marker} run hot.`);

    // What /setup said of it, in the voice: the company as the kickoff read it.
    const spoken = `You run ${marker} bakeries.`;
    await sayForAdmin(admin.session, spoken);
    const voicedBefore = await stillKept(spoken);
    const before = await reads(admin);
    const keptBefore = await keptWhere(marker);
    const events = await auditedDuring(async () => {
      await admin.api.onboarding.deleteKickoff();
    });
    const after = await reads(admin);
    const voicedAfter = await stillKept(spoken);
    const kept = await onboardingStore(env).kickoff();
    const view = await admin.api.onboarding.view();

    expect({
      before: holding(before, marker),
      keptBefore,
      voiced: { before: voicedBefore, after: voicedAfter },
      after: holding(after, marker),
      keptAfter: await keptWhere(marker),
      transcript: kept.transcript,
      sponsor: view.sponsor,
      events: events.map(({ action, detail, actor }) => ({
        action,
        detail,
        admin: "userId" in actor && actor.userId === admin.userId,
      })),
      audited: JSON.stringify(events).toLowerCase().includes(marker),
    }).toStrictEqual({
      // The positive control: each read held the kickoff's words.
      before: ["kickoff", "setup", "brain", "turn", "stephen"],
      keptBefore: { core: [], onboarding: ["kickoff"] },
      voiced: { before: true, after: false },
      after: [],
      keptAfter: { core: [], onboarding: [] },
      transcript: null,
      sponsor: null,
      events: [
        { action: "onboarding.kickoff.deleted", detail: {}, admin: true },
      ],
      audited: false,
    });
  });

  it("refuses a member, and keeps the kickoff", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const marker = markerOf();
    await bringIn(marker);

    const refused = await outcome(member.api.onboarding.deleteKickoff());

    expect({
      refused,
      kept: holding(await reads(admin), marker).includes("kickoff"),
    }).toStrictEqual({ refused: "role.forbidden", kept: true });
  });

  it("refuses a staff save whose reading began before the delete", async () => {
    const admin = await signedInApi(idp, "admin");
    const marker = markerOf();
    await bringIn(marker);
    const store = onboardingStore(env);
    // Staff's reading begins: it takes the mark as it is now.
    const mark = await store.purgeMark();

    await admin.api.onboarding.deleteKickoff();
    const saved = await outcome(
      store.saveKickoff(
        {
          transcript: `Anna (CEO): ${marker} again.`,
          fileName: null,
          reading: { fields: {}, ask: {}, teams: [] } satisfies KickoffReading,
        },
        { type: "system" },
        mark
      )
    );

    expect({
      saved,
      kept: await keptWhere(marker),
    }).toStrictEqual({
      saved: "kickoff.purged",
      kept: { core: [], onboarding: [] },
    });
  });
});
