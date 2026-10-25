import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { interviewTurnPath } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { labMarks } from "../src/onboarding/lab-marks.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { answering, openedFor } from "./interview-link.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The interviews by name in Grasp's onboarding area (staff-rpc.ts): where
// everyone stands, someone's own link, the one reminder, a team asked in,
// an interview deleted on its person's request, and who held a transcript
// on which text. The ways it can fail, tried here:
//
// - Anyone but staff reaching any of it: a member, the company's admin.
// - A read that names people, or holds a link, without a trace in the
//   audit log; or a trace that names the person, or holds the link or
//   their words (the company's admin reads the audit log).
// - The one reminder going twice, or to someone who already talked.
// - A deleted interview coming back from a copy left open.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Quince barometer satchel";

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

const progress = (): InterviewProgress => ({
  person: "completed",
  told: true,
  mode: "type",
  lines: [{ from: "person", text: sentinel, typed: true }],
  facts: [],
  phase: "readback",
  wants: "end",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
  rating: 4,
  interviewer: "claire",
});

/** What a link's session answers, as far as these tests read it. */
const sessionOf = z.object({ key: z.string().optional() });

/** Opens a link's path on a device, as the interview page does: its key. */
const openOn = async (path: string): Promise<string> => {
  const secret = path.split("#")[1] ?? "";
  const answer = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  return sessionOf.parse(await answer.json()).key ?? "";
};

/**
 * An onboarding running since yesterday: Ops (no lead), whose two
 * people's links are out, Oli having talked; and Labs, which doesn't take
 * part, led by Lia.
 */
const running = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = { oli: `oli-${id}`, ona: `ona-${id}`, lia: `lia-${id}` };
  const roster: Roster = {
    teams: [
      { id: "ops", name: "Ops", lead: null, does: "", off: false },
      { id: "labs", name: "Labs", lead: ids.lia, does: "", off: true },
    ],
    people: [
      { id: ids.oli, name: "Oli Olsen", team: "ops" },
      { id: ids.ona, name: "Ona Ek", team: "ops" },
      { id: ids.lia, name: "Lia Berg", team: "labs" },
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
  const path = (await store.linkOf(ids.oli)) ?? "";
  const key = await openOn(path);
  const secret = path.split("#")[1] ?? "";
  const saved = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "save",
      secret,
      key,
      version: 0,
      progress: progress(),
    }),
  });
  if (!saved.ok) {
    throw new Error(`Oli's interview wasn't kept (${saved.status})`);
  }
  return { store, ids, oli: { secret, key } };
};

describe("the interviews in Grasp's onboarding area", () => {
  it("are staff's alone: a member and the company's admin reach none of it", async () => {
    const { ids } = await running();
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.interviews()),
        outcome(api.onboardingStaff.link(ids.oli)),
        outcome(api.onboardingStaff.remind([ids.ona])),
        outcome(api.onboardingStaff.askIn("labs")),
        outcome(api.onboardingStaff.deleteInterview(ids.oli)),
        outcome(api.onboardingStaff.interview(ids.oli)),
      ])
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });

  it("show staff where everyone stands by name, without a word anyone said, and every read is on record", async () => {
    const { ids } = await running();
    const staff = await asStaff();

    const reads: AdminSnapshot[] = [];
    const events = await auditedDuring(
      async () => {
        reads.push(await staff.onboardingStaff.interviews());
      },
      { staffAccesses: true }
    );
    const links = reads[0]?.links ?? [];
    const stateOf = (person: string) =>
      links.find((link) => link.person === person)?.state;
    const oli = reads[0]?.interviews.find(({ person }) => person === ids.oli);
    expect({
      states: [stateOf(ids.oli), stateOf(ids.ona), stateOf(ids.lia)],
      oli: [oli?.rating, oli?.interviewer, oli?.agreed],
      words: JSON.stringify(reads).includes(sentinel),
      audited: events.map(({ action, actor, target }) => [
        action,
        actor.type,
        target?.type,
      ]),
    }).toStrictEqual({
      states: ["completed", "invited", "waiting"],
      oli: [4, "claire", true],
      words: false,
      // On record as a staff look (staff-audit.ts), naming no one.
      audited: [["staff.accessed", "staff", undefined]],
    });
  });

  it("give staff someone's own link to send by hand, on record by its random id alone", async () => {
    const { ids } = await running();
    const staff = await asStaff();

    const paths: string[] = [];
    const events = await auditedDuring(
      async () => {
        paths.push(await staff.onboardingStaff.link(ids.ona));
      },
      { staffAccesses: true }
    );
    const path = paths[0] ?? "";
    const secret = path.split("#")[1] ?? "";
    // The link staff were given opens Ona's interview, and nobody else's.
    const key = await openOn(path);
    const text = JSON.stringify(events);
    expect({
      path: path.startsWith("/interview#"),
      opens: key.length > 0,
      audited: events.map(({ action, target }) => [action, target?.type]),
      secretInLog: text.includes(secret),
      named: text.includes(ids.ona) || text.includes("Ona Ek"),
      nobody: await outcome(staff.onboardingStaff.link("nobody")),
    }).toStrictEqual({
      path: true,
      opens: true,
      // On record as a staff look before anything was read, by the kind of
      // what was asked alone (staff-audit.ts).
      audited: [["staff.accessed", undefined]],
      secretInLog: false,
      named: false,
      nobody: "onboarding.not_found",
    });
  });

  it("note the one reminder once, only for whom the link is out and who hasn't talked", async () => {
    const { ids } = await running();
    const staff = await asStaff();

    const events = await auditedDuring(async () => {
      await staff.onboardingStaff.remind([ids.oli, ids.ona, ids.lia]);
    });
    const again = await staff.onboardingStaff.remind([ids.ona]);
    const { links } = await staff.onboardingStaff.interviews();
    const reminded = links
      .filter(({ remindedAt }) => remindedAt !== null)
      .map(({ person }) => person)
      .filter((person) => Object.values(ids).includes(person));
    const { entries } = await staff.onboardingStaff.log({
      what: "interview.reminded",
    });
    const text = JSON.stringify(events);
    expect({
      reminded,
      again,
      logged: entries
        .filter(({ person }) => person?.id === ids.ona)
        .map(({ actor }) => actor),
      audited: events.map(({ action, detail }) => [action, detail]),
      named: text.includes(ids.ona),
    }).toStrictEqual({
      reminded: [ids.ona],
      again: 0,
      logged: ["staff"],
      audited: [["onboarding.reminded", { count: 1 }]],
      named: false,
    });
  });

  it("ask a team in that didn't take part: its lead's link goes out", async () => {
    const { ids } = await running();
    const staff = await asStaff();

    const view = await staff.onboardingStaff.askIn("labs");
    const { links } = await staff.onboardingStaff.interviews();
    expect({
      off: view.roster?.teams.find(({ id }) => id === "labs")?.off,
      lia: links.find(({ person }) => person === ids.lia)?.state,
      unknown: await outcome(staff.onboardingStaff.askIn("nowhere")),
    }).toStrictEqual({
      off: false,
      lia: "invited",
      unknown: "onboarding.no_team",
    });
  });

  it("delete someone's interview on their request: gone for staff, and a copy left open can't save it back", async () => {
    const { ids, oli } = await running();
    const staff = await asStaff();

    const events = await auditedDuring(async () => {
      await staff.onboardingStaff.deleteInterview(ids.oli);
    });
    const read = await staff.onboardingStaff.interview(ids.oli);
    const resaved = await routed(interviewApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        secret: oli.secret,
        key: oli.key,
        version: 1,
        progress: progress(),
      }),
    });
    const { links } = await staff.onboardingStaff.interviews();
    expect({
      state: read.state,
      resaved: resaved.status,
      deleted:
        (links.find(({ person }) => person === ids.oli)?.deletedAt ?? null) !==
        null,
      audited: events.map(({ action }) => action),
      named: JSON.stringify(events).includes(ids.oli),
      nobody: await outcome(staff.onboardingStaff.deleteInterview(ids.lia)),
    }).toStrictEqual({
      state: null,
      resaved: 410,
      deleted: true,
      audited: ["onboarding.interview.deleted"],
      named: false,
      nobody: "onboarding.no_link",
    });
  });

  it("show who held an interview, and the text it was held with, by its mark", async () => {
    const { link, person } = await openedFor();
    const staff = await asStaff();
    const before = await staff.onboardingStaff.interview(person);
    await answering(
      [
        {
          text: "TONE: none\nSAY: Shall we start?\nPART: open\nWANTS: answer\nMORE: no\nAGREED: no\n",
          inputTokens: 10,
          outputTokens: 10,
        },
        {
          text: '{"facts":[],"changes":[]}',
          inputTokens: 10,
          outputTokens: 10,
        },
      ],
      async () => {
        const turn = await routed(interviewTurnPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...link,
            event: "start",
            locale: "nl",
            interviewer: "claire",
            lines: [],
            facts: [],
            phase: "open",
            minutes: 0,
          }),
        });
        await turn.text();
      }
    );
    const after = await staff.onboardingStaff.interview(person);
    expect({ before: before.texts, after: after.texts }).toStrictEqual({
      before: [],
      after: [labMarks.claire.own.nl],
    });
  });
});
