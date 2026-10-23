import { sha256Hex } from "@grasp-os/shared/encoding";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type { Interviewer, Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// How Stephen and Claire are doing, and the AI the onboarding used, over
// `/rpc` (src/onboarding/interviewer-numbers.ts and staff-rpc.ts), from
// interviews kept the way people's pages keep them. The ways it can fail,
// tried here:
//
// - Anyone but staff reading it: a member, the company's admin.
// - Who said what reaching it: what was said, or anyone's name or id.
// - Someone talking now counted as stopped, or Claire's interviews as
//   Stephen's.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Quince harbour abacus";

const minuteMs = 60_000;

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

const fact = (id: string, out = false): InterviewFact => ({
  id,
  tag: "step",
  text: `${sentinel} ${id}`,
  record: `${sentinel} ${id}`,
  ...(out ? { out: true as const } : {}),
});

interface Said {
  interviewer: Interviewer;
  mode: "talk" | "type";
  phase: InterviewProgress["phase"];
  facts?: InterviewFact[];
  rating?: number;
}

const progressOf = (
  said: Said,
  person: InterviewProgress["person"]
): InterviewProgress => ({
  person,
  told: true,
  mode: said.mode,
  lines: [
    {
      from: "person",
      text: sentinel,
      ...(said.mode === "type" ? { typed: true as const } : {}),
    },
  ],
  facts: said.facts ?? [],
  phase: said.phase,
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
  interviewer: said.interviewer,
  ...(said.rating === undefined ? {} : { rating: said.rating }),
});

/**
 * An onboarding running since yesterday: Lea leads Sales, and Ops has no
 * lead, so every link is out at once. Each interview is kept as the
 * person's page keeps it: started at `from` minutes ago, saved last at
 * `to`, and finished there when it is.
 */
const interviewed = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    lea: `lea-${id}`,
    oli: `oli-${id}`,
    ona: `ona-${id}`,
    ida: `ida-${id}`,
    uma: `uma-${id}`,
  };
  const roster: Roster = {
    teams: [
      { id: "sales", name: "Sales", lead: ids.lea, does: "", off: false },
      { id: "ops", name: "Ops", lead: null, does: "", off: false },
    ],
    people: [
      { id: ids.lea, name: "Lea Lind", team: "sales" },
      { id: ids.oli, name: "Oli Olsen", team: "ops" },
      { id: ids.ona, name: "Ona Ek", team: "ops" },
      { id: ids.ida, name: "Ida Inge", team: "ops" },
      { id: ids.uma, name: "Uma Ude", team: "ops" },
    ].map((one) => ({ ...one, email: "", title: "", away: false })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  const yesterday = new Date(Date.now() - 24 * 60 * minuteMs);
  await store.savePlan(
    { start: yesterday.toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const now = Date.now();
  const ago = (minutes: number) =>
    new Date(now - minutes * minuteMs).toISOString();
  const marks: Record<string, string> = {};
  const talk = async (
    person: string,
    said: Said,
    from: number,
    to: number,
    finished: boolean
  ) => {
    const link = (await store.linkOf(person)) ?? "";
    const mark = await sha256Hex(link.split("#")[1] ?? "");
    marks[person] = mark;
    const key = await sha256Hex(`${person}'s device`);
    await store.openLink(mark, null, key, ago(from));
    await store.saveInterview(
      mark,
      key,
      0,
      progressOf(said, "progress"),
      ago(from)
    );
    await store.saveInterview(
      mark,
      key,
      1,
      progressOf(said, finished ? "completed" : "incomplete"),
      ago(to)
    );
  };
  await talk(
    ids.lea,
    { interviewer: "stephen", mode: "talk", phase: "readback", rating: 5 },
    40,
    20,
    true
  );
  await talk(
    ids.oli,
    {
      interviewer: "stephen",
      mode: "talk",
      phase: "readback",
      facts: [fact("f1"), fact("f2"), fact("f3"), fact("f4", true)],
      rating: 4,
    },
    180,
    170,
    true
  );
  await talk(
    ids.ona,
    {
      interviewer: "claire",
      mode: "type",
      phase: "readback",
      facts: [fact("f1"), fact("f2")],
      rating: 2,
    },
    120,
    108,
    true
  );
  // Stopped at the steps an hour and a half ago; Uma talks now.
  await talk(
    ids.ida,
    { interviewer: "stephen", mode: "talk", phase: "steps" },
    120,
    110,
    false
  );
  await talk(
    ids.uma,
    { interviewer: "claire", mode: "talk", phase: "story" },
    20,
    2,
    false
  );
  return { store, ids, marks };
};

/** A text's mark, as the turn keeps it: 64 hex. */
const textMark = (letter: string) => letter.repeat(64);

describe("how Stephen and Claire are doing", () => {
  it("counts each apart: ratings, who finished, where people stop, how long and what was left in", async () => {
    const { store, ids, marks } = await interviewed();
    const ran = async (
      person: string,
      mark: string,
      interviewer: Interviewer
    ) => {
      await store.turnRan(marks[person] ?? "", {
        mark,
        interviewer,
        locale: "nl",
      });
    };
    await ran(ids.oli, textMark("a"), "stephen");
    await ran(ids.ida, textMark("a"), "stephen");
    await ran(ids.ona, textMark("b"), "claire");
    const staff = await asStaff();

    const { interviewers } = await staff.onboardingStaff.interviewers();

    const [stephen, claire] = interviewers;
    expect({
      stephen: {
        started: stephen?.started,
        finished: stephen?.finished,
        stopped: stephen?.stopped,
        steps: stephen?.stops.steps,
        rating: stephen?.rating,
        lead: Math.round(stephen?.minutes.lead ?? 0),
        own: Math.round(stephen?.minutes.own ?? 0),
        lengths: stephen?.lengths.map(({ count }) => count),
        leftIn: stephen?.leftIn,
        byVoice: stephen?.byVoice,
        texts: stephen?.texts.map(({ mark, kind, locale, started }) => [
          mark,
          kind,
          locale,
          started,
        ]),
      },
      claire: {
        started: claire?.started,
        finished: claire?.finished,
        stopped: claire?.stopped,
        rating: claire?.rating.average,
        byVoice: claire?.byVoice,
        texts: claire?.texts.map(({ mark, finished }) => [mark, finished]),
      },
    }).toStrictEqual({
      stephen: {
        started: 3,
        finished: 2,
        stopped: 1,
        steps: 1,
        rating: { count: 2, average: 4.5, by: [0, 0, 0, 1, 1] },
        lead: 20,
        own: 10,
        lengths: [1, 0, 1, 0, 0],
        leftIn: 0.75,
        byVoice: 1,
        texts: [
          [textMark("a"), "own", "nl", 2],
          [null, "lead", null, 1],
        ],
      },
      claire: {
        started: 2,
        finished: 1,
        // Uma talks now: she stopped nowhere yet.
        stopped: 0,
        rating: 2,
        byVoice: 0,
        texts: [
          [textMark("b"), 1],
          [null, 0],
        ],
      },
    });
  });

  it("says nothing anyone said, and names nobody", async () => {
    const { ids } = await interviewed();
    const staff = await asStaff();

    const text = JSON.stringify(await staff.onboardingStaff.interviewers());

    expect(
      [sentinel, ...Object.values(ids), "Lea Lind", "Oli Olsen"].filter(
        (each) => text.includes(each)
      )
    ).toStrictEqual([]);
  });

  it("tells the wait for his voice by day: the middle answer's, and the one nine in ten were faster than", async () => {
    const { store } = await interviewed();
    const day = "2026-03-02";
    await Promise.all(
      [900, 1150, 1800, 4000].map(async (waited) => {
        await store.turnRan(
          "no link's",
          { mark: textMark("c"), interviewer: "stephen", locale: "en" },
          waited,
          `${day}T10:00:00.000Z`
        );
      })
    );
    const staff = await asStaff();

    const { answers } = await staff.onboardingStaff.interviewers();

    expect(answers.find((each) => each.day === day)).toStrictEqual({
      day,
      answers: 4,
      middle: 1200,
      slow: 4000,
    });
  });

  it("gives the AI used by day, purpose and model, as the store counted it", async () => {
    const store = onboardingStore(env);
    const day = "2026-03-03";
    const at = `${day}T09:00:00.000Z`;
    await store.meter(
      {
        purpose: "interviews",
        model: "anthropic/claude-sonnet-4-5",
        tokensIn: 1000,
        tokensCached: 400,
        tokensOut: 50,
      },
      at
    );
    await store.meter(
      {
        purpose: "interviews",
        model: "anthropic/claude-sonnet-4-5",
        tokensIn: 500,
        tokensOut: 20,
      },
      at
    );
    await store.meter(
      { purpose: "reading", model: "voice", seconds: 12.5 },
      at
    );
    const staff = await asStaff();

    const rows = await staff.onboardingStaff.aiUse();

    expect(rows.filter((row) => row.day === day)).toStrictEqual([
      {
        day,
        purpose: "interviews",
        model: "anthropic/claude-sonnet-4-5",
        calls: 2,
        tokensIn: 1500,
        tokensCached: 400,
        tokensOut: 70,
        seconds: 0,
      },
      {
        day,
        purpose: "reading",
        model: "voice",
        calls: 1,
        tokensIn: 0,
        tokensCached: 0,
        tokensOut: 0,
        seconds: 12.5,
      },
    ]);
  });

  it("is staff's alone: a member and the company's admin get nothing from it", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");

    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.interviewers()),
        outcome(api.onboardingStaff.aiUse()),
      ])
    );

    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });
});
