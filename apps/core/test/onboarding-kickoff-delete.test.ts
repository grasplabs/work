import type { KickoffReading } from "@grasp-os/shared/kickoff";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { adminKickoff } from "./admin-kickoff.ts";
import { allEvents } from "./audit-events.ts";
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
// - Its words left in a read: the admin's onboarding, the brain
//   (`brain.read`'s vision, sector and teams, retired records too), an
//   interview turn's context, or any table.
// - A staff save whose reading began before the delete bringing the
//   words back.
// - A failed step: the records' erasure refused part-way. The delete
//   says so, and a second one finishes it, with one event in all.
// - Its words in the audit log.

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

/** Has core's database refuse every delete of the brain's records until it is dropped. */
const holdRecordDeletes = async (): Promise<() => Promise<void>> => {
  const trigger = `hold_${unique()}`;
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE DELETE ON brain_records BEGIN SELECT RAISE(ABORT, 'held'); END`
  );
  return async () => {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  };
};

describe("deleting the kickoff", { timeout: 60_000 }, () => {
  it("takes it and everything drawn from it out of every read, with one audit event", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const marker = markerOf();
    await bringIn(marker);
    // Staff answer again, so a vision is retired with the marker in it.
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
      keptBefore: {
        core: ["brain_records.body"],
        onboarding: ["kickoff"],
      },
      voiced: { before: true, after: false },
      after: [],
      keptAfter: { core: [], onboarding: [] },
      transcript: null,
      sponsor: null,
      events: [
        {
          action: "onboarding.kickoff.deleted",
          // Its vision three times (read, answered, answered again), its
          // team and the team's size.
          detail: { kickoff: 1, records: 5 },
          admin: true,
        },
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

  it("finishes a delete whose erasure failed when asked again, with one event in all", async () => {
    const admin = await signedInApi(idp, "admin");
    const marker = markerOf();
    await bringIn(marker);

    const release = await holdRecordDeletes();
    const events = await auditedDuring(async () => {
      const first = await outcome(admin.api.onboarding.deleteKickoff());
      const left = await keptWhere(marker);
      await release();
      const second = await outcome(admin.api.onboarding.deleteKickoff());
      const third = await outcome(admin.api.onboarding.deleteKickoff());
      expect({ first, left, second, third }).toStrictEqual({
        // It says it isn't done: the kickoff is gone, its records owed.
        first: "onboarding.kickoff_unfinished",
        left: { core: ["brain_records.body"], onboarding: [] },
        second: "ok",
        // Nothing left: nothing changes, nothing is recorded.
        third: "ok",
      });
    });

    expect({
      kept: await keptWhere(marker),
      brain: holding(await reads(admin), marker),
      deleted: events
        .filter(({ action }) => action === "onboarding.kickoff.deleted")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      kept: { core: [], onboarding: [] },
      brain: [],
      deleted: [{ kickoff: 1, records: 4 }],
    });
  });

  it("has the alarm finish a delete whose erasure failed, saying meanwhile that it is erasing, with one event", async () => {
    const admin = await signedInApi(idp, "admin");
    const marker = markerOf();
    await bringIn(marker);

    const release = await holdRecordDeletes();
    const events = await auditedDuring(async () => {
      const first = await outcome(admin.api.onboarding.deleteKickoff());
      const meanwhile = await admin.api.onboarding.view();
      await release();
      // Nobody asks again: the store's alarm, armed by the failure, finishes it.
      const ran = await runDurableObjectAlarm(onboardingStore(env));
      expect({ first, meanwhile: meanwhile.kickoff, ran }).toStrictEqual({
        first: "onboarding.kickoff_unfinished",
        meanwhile: "erasing",
        ran: true,
      });
    });
    const view = await admin.api.onboarding.view();

    expect({
      kept: await keptWhere(marker),
      kickoff: view.kickoff,
      deleted: events
        .filter(({ action }) => action === "onboarding.kickoff.deleted")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      kept: { core: [], onboarding: [] },
      kickoff: null,
      deleted: [{ kickoff: 1, records: 4 }],
    });
  });

  it("erases a deleted kickoff's records before keeping a new one's", async () => {
    const admin = await signedInApi(idp, "admin");
    const old = markerOf();
    await bringIn(old);
    const release = await holdRecordDeletes();
    await outcome(admin.api.onboarding.deleteKickoff());
    await release();

    // Staff bring a new kickoff in before anything finished the erasure.
    const fresh = markerOf();
    await bringIn(fresh);

    const events = await allEvents();

    expect({
      old: await keptWhere(old),
      fresh: holding(await reads(admin), fresh).includes("brain"),
      logged: events.some((event) =>
        JSON.stringify(event).toLowerCase().includes(old)
      ),
    }).toStrictEqual({
      old: { core: [], onboarding: [] },
      fresh: true,
      logged: false,
    });
  });
});
