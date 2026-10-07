import type { AuditEvent } from "@grasp-os/shared/audit";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { onboardingPeopleMax } from "@grasp-os/shared/onboarding";
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

// The onboarding's store (src/onboarding/store.ts), over `/rpc`: the
// company's admin gives it who works where and the plan, and reads back
// numbers per team; Grasp's staff pause the interviews and say the
// agreements are in. From the threat model (GRA-307), the ways it can
// fail, tried here:
//
// - Someone else changing it: anyone but an admin, or anyone but staff
//   pausing it or saying the agreements are in (S1).
// - What comes in that isn't a roster or a plan, or a roster past its
//   limits (C6), or a plan that starts in the past.
// - A link out while the interviews are paused (L8), or before the
//   agreements are in (L5), or before its team's moment.
// - The admin's numbers or the audit log carrying who someone is or what
//   they said (W1, W2, W7).
// - Someone taken off the list keeping their link (L7).

const idp = mockIdp();

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Zebulon Quillfeather";

const person = (id: string, team: string, name = `Person ${id}`) => ({
  id,
  name,
  email: `${id}@acme.test`,
  team,
});

/** Sales, led by Lea, with five people; Ops, without a lead, with two. */
const roster: RosterInput = {
  teams: [
    { id: "sales", name: "Sales", lead: "lea" },
    { id: "ops", name: "Ops", lead: null },
  ],
  people: [
    person("lea", "sales", sentinel),
    person("sam", "sales"),
    person("sid", "sales"),
    person("sue", "sales"),
    person("sy", "sales"),
    person("oli", "ops"),
    person("ona", "ops"),
  ],
};

const today = () => new Date().toISOString().slice(0, 10);
const plan = () => ({ start: today(), days: 14 });

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** Every value in the events, as text: what the audit log keeps. */
const textOf = (events: AuditEvent[]): string => JSON.stringify(events);

describe("the admin's onboarding", () => {
  it("keeps the roster and the plan and gives them back", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.saveRoster(roster);
    await api.onboarding.savePlan(plan());
    const view = await api.onboarding.view();
    expect(view.roster?.teams.map(({ id }) => id)).toStrictEqual([
      "sales",
      "ops",
    ]);
    expect(view.roster?.people).toHaveLength(7);
    expect(view.roster?.people[1]).toStrictEqual({
      id: "sam",
      name: "Person sam",
      email: "sam@acme.test",
      team: "sales",
      title: "",
      away: false,
    });
    expect(view.plan).toStrictEqual({ start: today(), days: 14 });
  });

  it("is the admins' alone", async () => {
    const { api } = await signedInApi(idp, "user");
    await expect(outcome(api.onboarding.view())).resolves.toBe(
      "role.forbidden"
    );
    await expect(outcome(api.onboarding.saveRoster(roster))).resolves.toBe(
      "role.forbidden"
    );
  });

  it("refuses what isn't a roster: someone in no team, a lead from another team, too many people", async () => {
    const { api } = await signedInApi(idp, "admin");
    const nowhere = {
      ...roster,
      people: [...roster.people, person("x", "nowhere")],
    };
    const foreignLead: RosterInput = {
      ...roster,
      teams: [
        { id: "sales", name: "Sales", lead: "lea" },
        { id: "ops", name: "Ops", lead: "sam" },
      ],
    };
    const crowd = {
      teams: roster.teams,
      people: Array.from({ length: onboardingPeopleMax + 1 }, (_, index) =>
        person(`p${index}`, "ops")
      ),
    };
    const empty: RosterInput = { teams: [], people: [] };
    for (const wrong of [nowhere, foreignLead, crowd, empty]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(outcome(api.onboarding.saveRoster(wrong))).resolves.toBe(
        "onboarding.invalid"
      );
    }
  });

  it("refuses a plan that starts in the past, or runs longer than six weeks", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.saveRoster(roster);
    await expect(
      outcome(api.onboarding.savePlan({ start: "2020-01-06", days: 14 }))
    ).resolves.toBe("onboarding.past");
    await expect(
      outcome(api.onboarding.savePlan({ start: today(), days: 99 }))
    ).resolves.toBe("onboarding.invalid");
  });

  it("shows numbers for a team of five or more, never for a smaller one, and never a name", async () => {
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.saveRoster(roster);
    const store = onboardingStore(env);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    for (const id of ["sam", "oli"]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await store.noteInterview({
        person: id,
        kind: "own",
        startedAt: yesterday,
        completedAt: yesterday,
      });
    }
    const { progress } = await api.onboarding.view();
    expect(progress?.teams).toStrictEqual([
      expect.objectContaining({ id: "sales", talked: 1, asked: 4 }),
      expect.objectContaining({ id: "ops", talked: null, asked: null }),
    ]);
    expect(JSON.stringify(progress)).not.toContain(sentinel);
  });
});

describe("Grasp's staff in the onboarding", () => {
  it("are the only ones who pause it or say the agreements are in", async () => {
    const { api } = await signedInApi(idp, "admin");
    await expect(outcome(api.onboardingStaff.pause())).resolves.toBe(
      "onboarding.staff_only"
    );
    await expect(
      outcome(
        api.onboardingStaff.setAgreements({
          processing: true,
          assessment: true,
          council: "none",
        })
      )
    ).resolves.toBe("onboarding.staff_only");
  });

  it("let no link out before the agreements are in, nor while the interviews are paused", async () => {
    const { api } = await signedInApi(idp, "admin");
    const staff = await asStaff();
    const store = onboardingStore(env);
    await api.onboarding.saveRoster(roster);
    await api.onboarding.savePlan(plan());
    await expect(store.releaseDue()).resolves.toStrictEqual([]);

    await staff.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "waiting",
    });
    await expect(store.releaseDue()).resolves.toStrictEqual([]);

    await staff.onboardingStaff.pause();
    await staff.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "agreed",
    });
    await expect(api.onboarding.view()).resolves.toMatchObject({
      agreed: true,
      paused: true,
    });
    await expect(store.releaseDue()).resolves.toStrictEqual([]);

    await staff.onboardingStaff.resume();
    // The lead's, and a team without a lead; Sales waits for its lead.
    await expect(store.releaseDue()).resolves.toStrictEqual([
      "lea",
      "oli",
      "ona",
    ]);
  });

  it("put every change in the audit log, as who made it, with no name in it", async () => {
    const { api, userId } = await signedInApi(idp, "admin");
    const staff = await asStaff();
    const events = await auditedDuring(async () => {
      await api.onboarding.saveRoster(roster);
      await api.onboarding.savePlan(plan());
      await staff.onboardingStaff.pause();
      await staff.onboardingStaff.resume();
    });
    // The admin's and staff's changes; links the alarm sends are Grasp's own.
    const ours = events.filter(
      ({ target, actor }) =>
        target?.type === "onboarding" && actor.type !== "system"
    );
    expect(ours.map(({ action }) => action)).toStrictEqual([
      "onboarding.roster.saved",
      "onboarding.plan.saved",
      "onboarding.paused",
      "onboarding.resumed",
    ]);
    expect(ours[0]).toMatchObject({
      actor: { type: "person", userId },
      detail: { teams: 2, people: 7 },
    });
    expect(ours[2]?.actor.type).toBe("staff");
    expect(textOf(ours)).not.toContain(sentinel);
  });
});

describe("someone taken off the list", () => {
  it("keeps no link and nothing of where their interview stood", async () => {
    const { api } = await signedInApi(idp, "admin");
    const staff = await asStaff();
    const store = onboardingStore(env);
    await api.onboarding.saveRoster(roster);
    await api.onboarding.savePlan(plan());
    await staff.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
    await store.releaseDue();
    await store.noteInterview({
      person: "oli",
      kind: "own",
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    await api.onboarding.saveRoster({
      ...roster,
      people: roster.people.filter(({ id }) => id !== "oli"),
    });
    const sent = await store.sentLinks();
    expect(sent.map(({ person: id }) => id)).not.toContain("oli");
    expect(sent.map(({ person: id }) => id)).toContain("ona");
  });
});
