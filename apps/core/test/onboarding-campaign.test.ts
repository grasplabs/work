import { addDays } from "@grasp-os/shared/admin/org-record";
import type { Roster } from "@grasp-os/shared/onboarding";
import { campaignSchema } from "@grasp-os/shared/onboarding-campaign";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { codeOf, holdAlarm, onLink, openedFor } from "./interview-link.ts";
import { captureMail } from "./mail-capture.ts";
import { onboardingLog } from "./onboarding-log.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The campaign the company's admin watches while the interviews run, and
// the two things they do from it, over `/rpc`; and "not now" on someone's
// own link. What must not happen, tried here:
//
// - The page telling more of a team than the admin's own view does: a
//   team under five its numbers, or one where fewer than three talked how
//   many did.
// - A nudge mailing someone who finished, a team twice a day, or using up
//   the one reminder Grasp sends by itself.
// - Anyone but an admin nudging, or correcting an address.
// - A corrected address changing anyone else's, or standing in the audit
//   log.
// - A reminder someone asked for going twice, or to someone who finished;
//   or their company's audit log saying they asked.

const idp = mockIdp();

const by = { type: "system" } as const;

/** Eight in the morning (UTC) on `day`. */
const morning = (day: string): string => `${day}T08:00:00.000Z`;

/** How many days ago the interviews began, of the 14 they run. */
const began = 10;

const reminderOpening = "Reminder — ";

/**
 * A company ten days into its interviews. Ops (no lead, five people) was
 * asked on the first day and nobody started; Oda's link mail failed. Sales
 * is led by Lea, who talked on the second day, with Cleo leading it too;
 * its six others were asked on the seventh day: two finished on the
 * eighth, one on the ninth, one started and stopped, two did nothing.
 * Finance is two people. Ids are the test's own: the store counts
 * everyone it ever asked.
 */
const seeded = async () => {
  const id = unique();
  const start = addDays(new Date().toISOString().slice(0, 10), -began);
  const day = (index: number): string => morning(addDays(start, index));
  const ids = {
    ops: `ops-${id}`,
    sales: `sales-${id}`,
    finance: `fin-${id}`,
  };
  const one = (key: string, team: string) => ({
    id: `${key}-${id}`,
    name: key,
    email: `${key}-${id}@acme.test`,
    team,
    title: "",
    away: false,
  });
  const roster: Roster = {
    teams: [
      { id: ids.ops, name: "Ops", lead: null, does: "", off: false },
      {
        id: ids.sales,
        name: "Sales",
        lead: `lea-${id}`,
        coLeads: [`cleo-${id}`],
        does: "",
        off: false,
      },
      { id: ids.finance, name: "Finance", lead: null, does: "", off: false },
    ],
    people: [
      ...["oda", "o2", "o3", "o4", "o5"].map((key) => one(key, ids.ops)),
      ...["lea", "cleo", "s1", "s2", "s3", "s4", "s5", "s6"].map((key) =>
        one(key, ids.sales)
      ),
      ...["f1", "f2"].map((key) => one(key, ids.finance)),
    ],
  };
  const store = onboardingStore(env);
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start, days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  // The first mail of all, Oda's, fails for good.
  const mail = await captureMail(store, "E_RECIPIENT_SUPPRESSED");
  await store.releaseDue(day(0));
  await store.deliverMail();
  await store.noteInterview({
    person: `lea-${id}`,
    kind: "lead",
    startedAt: day(1),
    completedAt: day(1),
  });
  // Nobody drew Sales' map: its links go once the wait for its lead is over.
  await store.releaseDue(day(6));
  await store.deliverMail();
  const talked = async (key: string, on: number, finished = true) => {
    await store.noteInterview({
      person: `${key}-${id}`,
      kind: "own",
      startedAt: day(on),
      completedAt: finished ? day(on) : null,
    });
  };
  await talked("s1", 7);
  await talked("s2", 7);
  await talked("s3", 8);
  await talked("s4", 8, false);
  return { id, ids, start, day, roster, store, mail };
};

/** Whom the reminders among `mails` went to. */
const remindedOf = (mails: EmailMessageBuilder[]) =>
  mails
    .filter(({ subject }) => subject.startsWith(reminderOpening))
    .map(({ to }) => to);

describe("the campaign the admin watches", () => {
  // Each test releases and delivers by hand, on the day it means.
  beforeEach(holdAlarm);

  it("tells each team in numbers as the admin may see them, the talks day by day, which team is quiet and whose mail failed", async () => {
    const { id, ids, start } = await seeded();
    const { api } = await signedInApi(idp, "admin");
    const campaign = campaignSchema.parse(await api.onboarding.campaign());
    const gate = await api.onboardingGate.view();
    const sales = campaign.teams.find((team) => team.id === ids.sales);
    expect({
      days: [campaign.start, campaign.days, campaign.closes],
      teams: campaign.teams.map(({ byDay: _byDay, ...team }) => team),
      // The day of the plan, from 0, with how many of Sales finished on it.
      salesByDay: sales?.byDay?.flatMap((count, index) =>
        count === 0 ? [] : [[index, count]]
      ),
      hidden: campaign.teams
        .filter((team) => team.id !== ids.sales)
        .map((team) => team.byDay),
      asks: campaign.asks,
      totals: [
        campaign.asked,
        campaign.talked,
        campaign.leads,
        campaign.leadsTalked,
      ],
      go: [campaign.known, campaign.threshold, campaign.ready],
    }).toStrictEqual({
      days: [start, 14, addDays(start, 13)],
      teams: [
        {
          id: ids.ops,
          name: "Ops",
          led: false,
          leadTalked: false,
          asked: 5,
          talked: null,
          inProgress: null,
          notStarted: null,
          quiet: true,
        },
        {
          id: ids.sales,
          name: "Sales",
          led: true,
          leadTalked: true,
          asked: 6,
          talked: 3,
          inProgress: 1,
          notStarted: 2,
          quiet: false,
        },
        // Two people: none of its numbers are the admin's.
        {
          id: ids.finance,
          name: "Finance",
          led: false,
          leadTalked: false,
          asked: null,
          talked: null,
          inProgress: null,
          notStarted: null,
          quiet: false,
        },
      ],
      salesByDay: [
        [7, 2],
        [8, 1],
      ],
      hidden: [null, null],
      asks: [
        {
          kind: "quiet",
          team: ids.ops,
          name: "Ops",
          waiting: 5,
          nudged: false,
        },
        {
          kind: "mail",
          person: `oda-${id}`,
          name: "oda",
          team: "Ops",
          email: `oda-${id}@acme.test`,
        },
      ],
      totals: [11, 3, 1, 1],
      go: [gate.known, gate.threshold, gate.ready],
    });
  });

  it("nudges exactly who hasn't finished, once a day, audited with how many, and leaves Grasp's own reminder owed", async () => {
    const { id, ids, start, store, mail } = await seeded();
    const { api, userId } = await signedInApi(idp, "admin");
    const before = mail.sent.length;
    let nudged: unknown = null;
    const audited = await auditedDuring(async () => {
      nudged = await api.onboarding.nudge(ids.sales);
      await store.deliverMail();
    });
    const again = await outcome(api.onboarding.nudge(ids.sales));
    const after = await api.onboarding.campaign();
    const events = audited.filter(
      ({ action }) => action === "onboarding.team.nudged"
    );
    // The last day of the interviews: every link went out long enough ago.
    const owed = await store.remindDue(morning(addDays(start, 13)));
    expect({
      nudged,
      mailed: remindedOf(mail.sent.slice(before)),
      events: events.map(({ actor, detail }) => ({
        by: actor.type === "person" ? actor.userId : actor.type,
        detail,
      })),
      again,
      // Finance's numbers aren't the admin's, so neither is how many a nudge would mail.
      small: await outcome(api.onboarding.nudge(ids.finance)),
      unknown: await outcome(api.onboarding.nudge(`nobody-${id}`)),
      stillOwed: ["s4", "s5", "s6"].every((key) =>
        owed.includes(`${key}-${id}`)
      ),
      asks: after?.asks.filter(({ kind }) => kind === "quiet"),
    }).toStrictEqual({
      nudged: { mailed: 4 },
      // Cleo leads Sales too and hasn't talked; Lea and three others have.
      mailed: ["cleo", "s4", "s5", "s6"].map((key) => `${key}-${id}@acme.test`),
      events: [{ by: userId, detail: { team: ids.sales, count: 4 } }],
      again: "onboarding.nudged_today",
      small: "onboarding.team_too_small",
      unknown: "onboarding.no_team",
      stillOwed: true,
      asks: [
        {
          kind: "quiet",
          team: ids.ops,
          name: "Ops",
          waiting: 5,
          nudged: false,
        },
      ],
    });
  });

  it("says a quiet team got today's nudge", async () => {
    const { ids } = await seeded();
    const { api } = await signedInApi(idp, "admin");
    await api.onboarding.nudge(ids.ops);
    const campaign = await api.onboarding.campaign();
    expect(campaign?.asks.filter(({ kind }) => kind === "quiet")).toStrictEqual(
      [{ kind: "quiet", team: ids.ops, name: "Ops", waiting: 5, nudged: true }]
    );
  });

  it("corrects one person's address and sends their link again, audited with whose and never the address", async () => {
    const { id, store, mail } = await seeded();
    const { api, userId } = await signedInApi(idp, "admin");
    const right = `right-${id}@acme.test`;
    const viewBefore = await api.onboarding.view();
    const was = viewBefore.roster?.people ?? [];
    const before = mail.sent.length;
    const audited = await auditedDuring(async () => {
      await api.onboarding.correctAddress(`oda-${id}`, right);
      await store.deliverMail();
    });
    const viewAfter = await api.onboarding.view();
    const now = viewAfter.roster?.people ?? [];
    const links = await api.onboarding.links();
    const events = audited.filter(
      ({ action }) => action === "onboarding.address.corrected"
    );
    expect({
      changed: now.filter(
        (person, index) => person.email !== was[index]?.email
      ),
      sent: mail.sent.slice(before).map(({ to, subject }) => ({
        to,
        reminder: subject.startsWith(reminderOpening),
      })),
      failed: links
        .filter(({ mailFailed }) => mailFailed)
        .map(({ person }) => person),
      events: events.map(({ actor, detail }) => ({
        by: actor.type === "person" ? actor.userId : actor.type,
        detail,
      })),
      address: JSON.stringify(audited).includes(right),
      // Only someone whose mail failed: everyone else's address changes with the list.
      notFailed: await outcome(
        api.onboarding.correctAddress(`o2-${id}`, `other-${id}@acme.test`)
      ),
      notListed: await outcome(
        api.onboarding.correctAddress(`nobody-${id}`, right)
      ),
      notAnAddress: await outcome(
        api.onboarding.correctAddress(`oda-${id}`, "not an address")
      ),
    }).toStrictEqual({
      changed: [{ ...was[0], email: right }],
      sent: [{ to: right, reminder: false }],
      failed: [],
      events: [{ by: userId, detail: { person: `oda-${id}` } }],
      address: false,
      notFailed: "onboarding.no_failed_mail",
      notListed: "onboarding.not_found",
      notAnAddress: "onboarding.invalid",
    });
  });

  it("is the admins' alone", async () => {
    const { id, ids } = await seeded();
    const { api } = await signedInApi(idp, "user");
    await expect(
      Promise.all([
        outcome(api.onboarding.campaign()),
        outcome(api.onboarding.nudge(ids.ops)),
        outcome(
          api.onboarding.correctAddress(`oda-${id}`, `right-${id}@acme.test`)
        ),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "role.forbidden",
    ]);
  });

  it("counts a second lead's interview as their team's lead having talked", async () => {
    const { id, day, store } = await seeded();
    const { api } = await signedInApi(idp, "admin");
    // A team with two leads, and only the second of them talks.
    const view = await api.onboarding.view();
    const roster = view.roster ?? { teams: [], people: [] };
    await store.saveRoster(
      {
        teams: [
          ...roster.teams,
          {
            id: `new-${id}`,
            name: "Support",
            lead: `first-${id}`,
            coLeads: [`second-${id}`],
            does: "",
            off: false,
          },
        ],
        people: [
          ...roster.people,
          ...["first", "second"].map((key) => ({
            id: `${key}-${id}`,
            name: key,
            email: `${key}-${id}@acme.test`,
            team: `new-${id}`,
            title: "",
            away: false,
          })),
        ],
      },
      by
    );
    // A team new once the team is told starts now, its leads first.
    await store.releaseDue();
    const before = await api.onboarding.view();
    await store.noteInterview({
      person: `second-${id}`,
      kind: "lead",
      startedAt: day(9),
      completedAt: day(9),
    });
    const { progress } = await api.onboarding.view();
    expect({
      leadsBefore: before.progress?.leadsTalked,
      leads: progress?.leadsTalked,
      team: progress?.teams.find((team) => team.id === `new-${id}`)?.leadTalked,
    }).toStrictEqual({ leadsBefore: 1, leads: 2, team: true });
  });
});

describe("a reminder someone asks for on their own link", () => {
  beforeEach(holdAlarm);

  it("goes once at the moment they picked, beside Grasp's own, is in the onboarding's log alone, and is refused once they talked", async () => {
    const { link, person } = await openedFor({ participating: false });
    const store = onboardingStore(env);
    const mail = await captureMail(store);
    await store.deliverMail();
    const before = mail.sent.length;
    const at = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
    let answer: unknown = null;
    const audited = await auditedDuring(async () => {
      const asked = await onLink({ action: "later", ...link, at });
      answer = await asked.json();
    });
    const past = await onLink({
      action: "later",
      ...link,
      at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const early = await store.remindAsked(new Date().toISOString());
    const went = await store.remindAsked(at);
    const twice = await store.remindAsked(at);
    await store.deliverMail(Date.parse(at));
    const { plan } = await store.view();
    // The last day of the interviews: their link went out long enough ago.
    const own = await store.remindDue(
      morning(addDays(plan?.start ?? "", (plan?.days ?? 0) - 1))
    );
    await store.noteInterview({
      person,
      kind: "own",
      startedAt: at,
      completedAt: at,
    });
    const after = await onLink({ action: "later", ...link, at });
    expect({
      answer,
      early,
      went,
      twice,
      reminders: remindedOf(mail.sent.slice(before)).length,
      own,
      log: await onboardingLog("interview.remind_asked"),
      audited: JSON.stringify(audited).includes(person),
      past: await codeOf(past),
      after: await codeOf(after),
    }).toStrictEqual({
      answer: { at },
      early: [],
      went: [person],
      twice: [],
      reminders: 1,
      own: [person],
      log: [
        {
          what: "interview.remind_asked",
          by: "interviewee",
          about: person,
          named: null,
        },
      ],
      audited: false,
      past: [400, "interview.invalid"],
      after: [409, "interview.finished"],
    });
  });
});
