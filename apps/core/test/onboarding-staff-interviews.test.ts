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
import { adminCommands, adminSnapshot } from "./admin-command.ts";
import { answering, openedFor } from "./interview-link.ts";
import { auditedDuring, outcome, routed, unique } from "./sign-in.ts";

// The interviews by name as Grasp's admin reads and steers them (the
// admin snapshot and admin commands): where everyone stands, the one
// reminder, a team asked in, and who held a transcript on which text.
// The ways it can fail, tried here:
//
// - A read that names people without a trace in the audit log; or a trace
//   that names the person, or holds their words (the company's admin
//   reads the audit log).
// - The one reminder going twice, or to someone who already talked.

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Quince barometer satchel";

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

describe("the interviews, as Grasp's admin sees and steers them", () => {
  it("show staff where everyone stands by name, without a word anyone said, and every read is on record", async () => {
    const { ids } = await running();

    const reads: AdminSnapshot[] = [];
    const events = await auditedDuring(async () => {
      reads.push(await adminSnapshot());
    });
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
      // On record as the admin's read, naming no one.
      audited: [["admin.snapshot.read", "staff", "organization"]],
    });
  });

  it("note the one reminder once, only for whom the link is out and who hasn't talked", async () => {
    const { ids } = await running();

    const events = await auditedDuring(async () => {
      await adminCommands().remind([ids.oli, ids.ona, ids.lia]);
    });
    const again = await auditedDuring(async () => {
      await adminCommands().remind([ids.ona]);
    });
    const { links } = await adminSnapshot();
    const reminded = links
      .filter(({ remindedAt }) => remindedAt !== null)
      .map(({ person }) => person)
      .filter((person) => Object.values(ids).includes(person));
    const { entries } = await onboardingStore(env).staffLog({
      what: "interview.reminded",
    });
    const text = JSON.stringify(events);
    expect({
      reminded,
      again: again.length,
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

    await adminCommands().askIn("labs");
    const { roster, links } = await adminSnapshot();
    expect({
      off: roster?.teams.find(({ id }) => id === "labs")?.off,
      lia: links.find(({ person }) => person === ids.lia)?.state,
      unknown: await outcome(adminCommands().askIn("nowhere")),
    }).toStrictEqual({
      off: false,
      lia: "invited",
      unknown: "onboarding.no_team",
    });
  });

  it("show who held an interview, and the text it was held with, by its mark", async () => {
    const { link, person } = await openedFor();
    const store = onboardingStore(env);
    const before = await store.interviewOf(person);
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
    const after = await store.interviewOf(person);
    expect({ before: before?.texts, after: after?.texts }).toStrictEqual({
      before: [],
      after: [labMarks.claire.own.nl],
    });
  });
});
