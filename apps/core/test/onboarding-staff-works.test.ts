import { STARTING_ORG_RULES } from "@grasp-os/shared/admin/onboarding-admin";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering, approveAgreed } from "./interview-link.ts";
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

// Every piece of work for Grasp's staff (GRA-377, staff-rpc.ts): as drawn
// from what its people agreed to, with the organization's own rules for
// when one is known, counted as known by hand, and drawn again. AI Gateway
// is the outside system, faked behind the AI binding. The ways it can
// fail, tried here:
//
// - Anyone but staff reading what people agreed to, or changing how far
//   the work is known: a member, the company's admin.
// - A read of what people said, by name, without a trace in the audit
//   log; or a trace that names them.
// - Each person's numbers merged into one on the way out.
// - Counting by hand hiding a difference nobody can explain.
// - Drawing again a piece of work nobody agreed to anything about.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;
const sessionKey = z.object({ key: z.string().optional() });

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

const fact = (id: string, record: string): InterviewFact => ({
  id,
  tag: "step",
  text: record,
  record,
  agreed: true,
});

/** Opens `person`'s link and saves their interview as agreed to, with `facts`. */
const agreeAs = async (
  person: string,
  facts: InterviewFact[]
): Promise<void> => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key = "" } = sessionKey.parse(await session.json());
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [{ from: "stephen", text: "What starts one?" }],
    facts,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: facts.length,
    adding: false,
    addedAt: 0,
  };
  await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", secret, key, version: 0, progress }),
  });
  await approveAgreed({ secret, key }, facts);
};

const reply = (value: object): GatewayReply => ({
  text: JSON.stringify(value),
  inputTokens: 1000,
  outputTokens: 200,
});

/**
 * Ops, led by Lea, with Max, Mia and Noor, who book invoices, and Noor,
 * who also files receipts and hasn't talked; its map drawn from what Lea
 * agreed to, and invoices drawn from what Max and Mia agreed to.
 */
const drawn = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    noor: `noor-${id}`,
  };
  const person = (key: "lea" | "max" | "mia" | "noor", name: string) => ({
    id: ids[key],
    name,
    team: ids.team,
    email: "",
    title: "",
    away: false,
  });
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: [
      person("lea", "Lea Lind"),
      person("max", "Max Mol"),
      person("mia", "Mia Moor"),
      person("noor", "Noor Nijs"),
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan(
    {
      start: new Date(Date.now() - dayMs).toISOString().slice(0, 10),
      days: 14,
    },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  await agreeAs(ids.lea, [fact("l1", "Max and Mia book the invoices.")]);
  const map = reply({
    does: "Books the invoices",
    works: [
      {
        name: "booking invoices",
        local: "facturen boeken",
        one: "invoice",
        many: "invoices",
        doers: [ids.max, ids.mia, ids.noor],
        share: 0.8,
      },
      {
        name: "filing receipts",
        local: "bonnetjes archiveren",
        one: "receipt",
        many: "receipts",
        doers: [ids.noor],
        share: 0.2,
      },
    ],
  });
  await answering([map], async () => await store.drawNext());
  await store.releaseDue();
  await agreeAs(ids.max, [fact("m1", "Max opens the invoice in Exact.")]);
  await agreeAs(ids.mia, [fact("i1", "Mia opens the invoice in Exact.")]);
  const invoices = reply({
    starts: "An invoice comes in by email.",
    starts_by: [ids.max, ids.mia],
    steps: [
      { text: "Open the invoice in Exact.", by: [ids.max, ids.mia] },
      { text: "Book it on the cost centre.", by: [ids.max, ids.mia] },
    ],
    notes: [],
    numbers: [
      { person: ids.max, quiet: 20, busy: 40, per: "week", minutes: [2, 4, 9] },
      { person: ids.mia, quiet: 60, busy: 90, per: "week", wrong: 1 },
    ],
    open: ["Who approves an invoice over 5,000 euros?"],
  });
  await answering([invoices], async () => await store.drawNext());
  const [booking, filing] = await store.teamWorks(ids.team);
  return { ids, booking: booking?.id ?? "", filing: filing?.id ?? "" };
};

/** How far the piece of work `id` is known, as core counts it now. */
const knownOf = async (team: string, id: string) => {
  const works = await onboardingStore(env).teamWorks(team);
  const known = works.find((work) => work.id === id)?.known;
  return { state: known?.state, byHand: known?.byHand };
};

describe("the work in Grasp's onboarding area", { timeout: 60_000 }, () => {
  it("is staff's alone: a member and the company's admin reach none of it", async () => {
    const { booking } = await drawn();
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.works()),
        outcome(api.onboardingStaff.setRules(null)),
        outcome(api.onboardingStaff.countAsKnown(booking, true)),
        outcome(api.onboardingStaff.drawWorkAgain(booking)),
      ])
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });

  it("shows staff each piece of work with its numbers as totals only, who told which parts, and its open questions, and every read is on record", async () => {
    const { ids, booking, filing } = await drawn();
    const staff = await asStaff();

    const reads: StaffWorks[] = [];
    const events = await auditedDuring(async () => {
      reads.push(await staff.onboardingStaff.works());
    });
    const works = reads[0]?.works ?? [];
    const work = works.find(({ id }) => id === booking);
    // Which parts each person told: yes or no, never their numbers.
    const parts = (person: string) => {
      const told = work?.drawn?.told[person];
      return [told?.volume, told?.takes, told?.wrong];
    };
    // Every value a person's entry carries, whatever its name: a number of
    // theirs would show here as a number outside `steps`, `waits`,
    // `differently` and `way.step`, which are positions in the drawing.
    const ownValues = Object.values(work?.drawn?.told ?? {}).flatMap(
      ({
        steps: _steps,
        waits: _waits,
        differently: _differently,
        way,
        ...rest
      }) =>
        Object.entries({ ...rest, way: way?.other ?? null }).filter(
          ([key, value]) =>
            !(key === "out" || typeof value === "boolean" || value === null)
        )
    );
    const text = JSON.stringify(events);
    expect({
      works: works
        .filter(({ team }) => team === ids.team)
        .map(({ id, item, doers, drawn: drawing }) => [
          id,
          item,
          doers,
          drawing === null,
        ]),
      max: parts(ids.max),
      mia: parts(ids.mia),
      ownValues,
      totals: work?.drawn?.totals,
      open: work?.drawn?.open,
      rules: reads[0]?.rules,
      audited: events.map(({ action, actor, target }) => [
        action,
        actor.type,
        target?.type,
      ]),
      named: [ids.max, ids.mia, "Max Mol"].some((name) => text.includes(name)),
    }).toStrictEqual({
      works: [
        [booking, ["invoice", "invoices"], [ids.max, ids.mia, ids.noor], false],
        [filing, ["receipt", "receipts"], [ids.noor], true],
      ],
      max: [true, true, false],
      mia: [true, false, true],
      ownValues: [],
      // The lowest and the highest anyone said, and how many it rests on:
      // a number one person alone gave shows with one person.
      totals: {
        volume: { quiet: [20, 60], busy: [40, 90], people: 2 },
        takes: { least: 2, most: 9, normal: [4, 4], people: 1 },
        wrong: { outOfTen: [1, 1], people: 1 },
      },
      open: ["Who approves an invoice over 5,000 euros?"],
      rules: STARTING_ORG_RULES,
      audited: [["onboarding.works.read", "staff", "organization"]],
      named: false,
    });
  });

  it("knows a piece of work under the organization's own rules, and counts one as known by hand", async () => {
    const { ids, booking } = await drawn();
    const staff = await asStaff();
    // Two of the three who do it talked: too few under the starting rules,
    // enough under rules that ask two and take any share of new facts.
    const starting = await knownOf(ids.team, booking);
    const events = await auditedDuring(async () => {
      await staff.onboardingStaff.setRules({
        ...STARTING_ORG_RULES,
        people: 2,
        minInterviews: 2,
        stopShare: 1,
      });
    });
    const byRules = await knownOf(ids.team, booking);
    await staff.onboardingStaff.setRules(null);
    const reset = await knownOf(ids.team, booking);
    await staff.onboardingStaff.countAsKnown(booking, true);
    const byHand = await knownOf(ids.team, booking);
    const { counted } = await staff.onboardingStaff.works();
    await staff.onboardingStaff.countAsKnown(booking, false);
    const left = await knownOf(ids.team, booking);
    expect({
      starting,
      byRules,
      reset,
      byHand,
      counted: counted.includes(booking),
      left,
      audited: events.map(({ action, detail }) => [action, detail.people]),
      invalid: await outcome(
        staff.onboardingStaff.setRules({ ...STARTING_ORG_RULES, people: 0 })
      ),
      unknown: await outcome(
        staff.onboardingStaff.countAsKnown("nothing", true)
      ),
    }).toStrictEqual({
      starting: { state: "mapping", byHand: false },
      byRules: { state: "complete", byHand: false },
      reset: { state: "mapping", byHand: false },
      byHand: { state: "complete", byHand: true },
      counted: true,
      left: { state: "mapping", byHand: false },
      audited: [["onboarding.rules.set", 2]],
      invalid: "onboarding.invalid",
      unknown: "onboarding.no_work",
    });
  });

  it("draws a piece of work again when staff ask, and not one nobody agreed to anything about", async () => {
    const { booking, filing } = await drawn();
    const store = onboardingStore(env);
    const staff = await asStaff();
    const before = await store.drawNext();
    await staff.onboardingStaff.drawWorkAgain(booking);
    const again = reply({
      steps: [{ text: "Open the invoice in Exact." }],
      open: [],
    });
    const { result } = await answering([again], async () => [
      await store.drawNext(),
      await store.drawNext(),
    ]);
    const { works } = await staff.onboardingStaff.works();
    expect({
      before,
      result,
      steps: works
        .find(({ id }) => id === booking)
        ?.drawn?.steps.map(({ text }) => text),
      nothing: await outcome(staff.onboardingStaff.drawWorkAgain(filing)),
      unknown: await outcome(staff.onboardingStaff.drawWorkAgain("nothing")),
    }).toStrictEqual({
      before: null,
      result: [`work:${booking}`, null],
      steps: ["Open the invoice in Exact."],
      nothing: "onboarding.nothing_to_draw",
      unknown: "onboarding.no_work",
    });
  });
});
