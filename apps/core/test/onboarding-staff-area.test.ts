import { sha256Hex } from "@grasp-os/shared/encoding";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
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
  unique,
} from "./sign-in.ts";

// Grasp's onboarding area over `/rpc` (src/onboarding/staff-area.ts and
// staff-rpc.ts): a staff session sees where the onboarding stands, what
// needs Grasp, its notes and the log, and reads someone's interview. The
// ways it can fail, tried here:
//
// - Anyone but staff reading any of it: a member, the company's admin.
// - A transcript read without a trace, or one that names the person, or
//   carries their words, in the audit log, which the company's admin
//   reads (S2).
// - What needs Grasp missing what holds the onboarding up.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Marmalade lighthouse ledger";

/** Grasp's staff, on a connection of their own. */
const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

const progress = (text = sentinel): InterviewProgress => ({
  person: "completed",
  told: true,
  mode: "type",
  lines: [{ from: "person", text, typed: true }],
  facts: [],
  phase: "readback",
  wants: "end",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
});

/**
 * An onboarding running since yesterday, its agreements not all in: Ops,
 * without a lead, whose two people's links are out, and one of them has
 * talked.
 */
const running = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = { oli: `oli-${id}`, ona: `ona-${id}` };
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: [
      { id: ids.oli, name: "Oli Olsen", team: "ops" },
      { id: ids.ona, name: "Ona Ek", team: "ops" },
    ].map((one) => ({ ...one, email: "", title: "", away: false })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await store.savePlan(
    { start: yesterday.toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = (await store.linkOf(ids.oli)) ?? "";
  const mark = await sha256Hex(link.split("#")[1] ?? "");
  const key = await sha256Hex("oli's device");
  await store.openLink(mark, null, key);
  await store.saveInterview(mark, key, 0, progress());
  // The risk assessment taken back: the agreements aren't all in.
  await store.setAgreements(
    { processing: true, assessment: false, council: "none" },
    by
  );
  return { store, ids };
};

describe("Grasp's onboarding area", () => {
  it("shows staff where it stands and what needs them", async () => {
    await running();
    const staff = await asStaff();

    const { stages, needs } = await staff.onboardingStaff.overview();

    const stage = (name: string) => stages.find((each) => each.stage === name);
    expect({
      agreements: stage("agreements")?.status,
      people: stage("people")?.status,
      interviews: stage("interviews")?.todos,
      needs,
    }).toStrictEqual({
      agreements: "now",
      people: "done",
      interviews: [
        { kind: "plan", done: true },
        { kind: "linksOut", done: true, count: 2, of: 2 },
        { kind: "talked", done: false, count: 1, of: 2 },
      ],
      needs: [{ kind: "agreement", what: "assessment" }],
    });
  });

  it("is staff's alone: a member and the company's admin get nothing from it", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.overview()),
        outcome(api.onboardingStaff.log()),
        outcome(api.onboardingStaff.addNote("A note")),
        outcome(api.onboardingStaff.transcript("anyone")),
      ])
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });

  it("puts every transcript read in the audit log, by the interview's own id, without the person or their words", async () => {
    const { ids } = await running();
    const staff = await asStaff();

    const reads: string[] = [];
    const events = await auditedDuring(async () => {
      const read = await staff.onboardingStaff.transcript(ids.oli);
      reads.push(read.progress?.lines[0]?.text ?? "");
    });

    const text = JSON.stringify(events);
    expect({
      words: reads[0],
      actions: events.map(({ action, actor }) => [action, actor.type]),
      target: events.map(({ target }) => target?.type),
      names: text.includes(ids.oli) || text.includes("Oli Olsen"),
      words_in_log: text.includes(sentinel),
    }).toStrictEqual({
      words: sentinel,
      actions: [["onboarding.transcript.read", "staff"]],
      target: ["interview"],
      names: false,
      words_in_log: false,
    });
  });

  it("keeps staff's notes, and narrows the log by who, what, team and day, naming who did what", async () => {
    const { ids } = await running();
    const staff = await asStaff();
    const note = await staff.onboardingStaff.addNote("  Call Ops on Monday  ");
    const empty = await outcome(staff.onboardingStaff.addNote("   "));
    const { notes } = await staff.onboardingStaff.overview();
    // Oli loses their device: staff give them a new start.
    await staff.onboardingStaff.newStart(ids.oli);
    const { entries: interviews, teams } = await staff.onboardingStaff.log({
      what: "interview",
    });
    const { entries: byPeople } = await staff.onboardingStaff.log({
      actor: "person",
    });
    const { entries: byStaff } = await staff.onboardingStaff.log({
      actor: "staff",
      team: "ops",
    });
    const today = new Date().toISOString().slice(0, 10);
    const { entries: none } = await staff.onboardingStaff.log({
      day: "2001-01-01",
    });
    const { entries: noTeam } = await staff.onboardingStaff.log({
      team: "nobody",
    });
    expect({
      note: note.text,
      empty,
      newest: notes[0]?.text,
      interviews: interviews
        .filter(({ person }) => person?.id === ids.oli)
        .map(({ what }) => what)
        .toReversed(),
      onlyPeople: byPeople.every(({ actor }) => actor === "person"),
      staffInOps: byStaff
        .filter(({ person }) => person?.id === ids.oli)
        .map(({ what }) => what),
      teams,
      today: interviews.every(({ at }) => at.startsWith(today)),
      none,
      noTeam,
    }).toStrictEqual({
      note: "Call Ops on Monday",
      empty: "onboarding.invalid",
      newest: "Call Ops on Monday",
      interviews: [
        "interview.opened",
        "interview.started",
        "interview.completed",
        "interview.new_start",
      ],
      onlyPeople: true,
      staffInOps: ["interview.new_start"],
      teams: [{ id: "ops", name: "Ops" }],
      today: true,
      none: [],
      noTeam: [],
    });
  });
});
