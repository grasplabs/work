import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering, approveAgreed, holdAlarm } from "./interview-link.ts";
import { intake } from "./onboarding-team.ts";
import type { PartJudge } from "./onboarding-team.ts";
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

// What needs the company's admin at the end of the onboarding
// (src/onboarding/store.ts, `review` and `settle`, over `/rpc`): a step of
// a piece of work its people told two ways, when nobody could say why. The
// admin keeps both ways or says which holds. AI Gateway, which draws the
// work, is the outside system, faked behind the AI binding. The ways it
// can fail, tried here:
//
// - The admin told who said which way, or anyone's name.
// - A way fewer than five people told shown at all (GRA-1084): it would be
//   one person's way of doing it. Each way must rest on five or more the
//   brain's intake checked, in the drawing as it stands, the model's word
//   never enough.
// - Something settled that needs no settling, or by anyone but an admin
//   (Grasp's staff are admins, and read and settle as one).
// - A settlement made without a trace in the audit log.
// - Settling counting nothing towards what Grasp knows.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** The people of Ops besides Lea, its lead: ten who do its tickets. */
const doers = [
  "Max Mol",
  "Mia Moor",
  "Mo Mertens",
  "Noor Nijs",
  "Pim Peeters",
  "Rik Rooms",
  "Sam Smit",
  "Tess Tol",
  "Uma Uil",
  "Vic Vos",
] as const;

/** Ops, led by Lea, with ten who do its tickets, in an onboarding that started yesterday. */
const team = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    doers: doers.map((_, index) => `p${index}-${id}`),
  };
  const person = (personId: string, name: string, title: string) => ({
    id: personId,
    name,
    team: ids.team,
    email: "",
    title,
    away: false,
  });
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: [
      person(ids.lea, "Lea Lind", "Team lead"),
      ...ids.doers.map((personId, index) =>
        person(personId, doers[index] ?? "", "Agent")
      ),
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  return ids;
};

type Ids = Awaited<ReturnType<typeof team>>;

/** The device each person's link was opened on: a link opens for one device only. */
const devices = new Map<string, { secret: string; key: string | undefined }>();

/** Someone's link, opened on a device of their own the first time. */
const deviceOf = async (person: string) => {
  const known = devices.get(person);
  if (known !== undefined) {
    return known;
  }
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const opened = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await opened.json());
  const device = { secret, key };
  devices.set(person, device);
  return device;
};

/** Agrees to someone's interview, on their device, with `facts`, from `version`. */
const agree = async (
  person: string,
  tag: FactTag,
  facts: string[],
  version = 0
) => {
  const { secret, key } = await deviceOf(person);
  const agreed: InterviewFact[] = facts.map((record, index) => ({
    id: `f${index}`,
    tag,
    text: record,
    record,
    agreed: true,
  }));
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [{ from: "stephen", text: "What starts one?" }],
    facts: agreed,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: agreed.length,
    adding: false,
    addedAt: 0,
  };
  const saved = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", secret, key, version, progress }),
  });
  const { version: savedVersion }: InterviewSaved = await saved.json();
  await approveAgreed({ secret, key: key ?? "" }, agreed);
  return savedVersion;
};

const reply = (value: unknown): GatewayReply => ({
  text: JSON.stringify(value),
  inputTokens: 100,
  outputTokens: 10,
});

/** What the first five say they do, and the other five. */
const sheetWay = "I look the customer up in the client sheet.";
const salesforceWay = "I look the customer up in Salesforce.";

/** Tickets as drawn: the first five look the customer up one way, the other five another, as Max says, and nobody could say why. */
const ticketsReply = (ids: Ids): GatewayReply => {
  const [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9] = ids.doers;
  return reply({
    steps: [
      { text: "Open the ticket.", by: ids.doers },
      {
        text: "Look up the customer in the client sheet.",
        by: [p0, p1, p2, p3, p4],
        other: "Look up the customer in Salesforce, as Max does.",
        other_by: [p5, p6, p7, p8, p9],
        why: "conflict",
      },
    ],
  });
};

/**
 * Ops's map, tickets and the rota, drawn: tickets told two ways by five
 * people each, and nobody could say why; the rota, Lea's own, one way.
 * Then the team given to the brain, whose intake checks who told what as
 * `part` answers. Ten agree: `others` gives the other five their own
 * facts, when a test wants them different.
 */
const drawn = async (
  ids: Ids,
  part?: PartJudge,
  others: readonly string[] = [salesforceWay]
) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(ids.lea, "work", ["Ten of us handle new tickets."]);
  await answering(
    [
      reply({
        does: "Answers customers' questions",
        works: [
          {
            name: "handling new tickets",
            local: "nieuwe tickets afhandelen",
            one: "ticket",
            many: "tickets",
            doers: ids.doers,
            share: 0.8,
          },
          {
            name: "planning the rota",
            local: "het rooster plannen",
            one: "rota",
            many: "rotas",
            doers: [ids.lea],
            share: 0.2,
          },
        ],
      }),
    ],
    async () => await store.drawNext()
  );
  await store.releaseDue();
  for (const [index, person] of ids.doers.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    await agree(person, "step", index < 5 ? [sheetWay] : [...others]);
  }
  await answering(
    [
      reply({ steps: [{ text: "Plan next week's rota.", by: [ids.lea] }] }),
      ticketsReply(ids),
    ],
    async () => [await store.drawNext(), await store.drawNext()]
  );
  await intake(ids, [], part);
  const [tickets, rota] = await store.teamWorks(ids.team);
  return { tickets: tickets?.id ?? "", rota: rota?.id ?? "" };
};

/** Grasp's staff, signed in to the client's core. */
const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** What the store keeps of the difference checked in work `work`'s drawing. */
const checkedOf = async (work: string) =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec("SELECT way, other FROM checked_differences WHERE work = ?", work)
      .toArray()
  );

/** Someone's `action` on their own link (`withdraw`, `delete`). */
const onLinkOf = async (person: string, action: string) => {
  const { secret, key } = await deviceOf(person);
  await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, secret, key }),
  });
};

describe("what needs the admin", { timeout: 120_000 }, () => {
  beforeEach(holdAlarm);

  it("is a step told two ways that nobody could explain, by five or more each, never who told which or anyone's name, and keeps how the admin settled it", async () => {
    const ids = await team();
    const { tickets } = await drawn(ids);
    const { api } = await signedInApi(idp, "admin");
    const before = await api.onboarding.review();
    const events = await auditedDuring(async () => {
      await api.onboarding.settle(tickets, "first");
    });
    // Settled again, another way.
    const after = await api.onboarding.settle(tickets, "both");
    const told = JSON.stringify(before);
    expect({
      before,
      named: [ids.lea, ...ids.doers, ...doers].some((each) =>
        told.includes(each)
      ),
      events: events.map(({ action, actor, detail }) => ({
        action,
        actor: actor.type,
        detail,
      })),
      after: after.differences.map(({ holds }) => holds),
    }).toStrictEqual({
      before: {
        differences: [
          {
            work: tickets,
            name: "nieuwe tickets afhandelen",
            team: "Ops",
            way: "Look up the customer in the client sheet.",
            other: "Look up the customer in Salesforce, as someone does.",
            holds: null,
          },
        ],
        mapped: 2,
      },
      named: false,
      events: [
        {
          action: "onboarding.work.settled",
          actor: "person",
          detail: { holds: "first" },
        },
      ],
      after: ["both"],
    });
  });

  it("keeps a name out of a difference once the roster calls that person something else", async () => {
    const ids = await team();
    await drawn(ids);
    const store = onboardingStore(env);
    const { roster } = await store.view();
    // Only Max's name changes, to one that doesn't hold "Max" alone.
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).map((each) =>
          each.name === "Max Mol" ? { ...each, name: "Maximilian Mol" } : each
        ),
      },
      { type: "system" }
    );
    const { api } = await signedInApi(idp, "admin");
    const { differences } = await api.onboarding.review();
    expect(differences.map(({ other }) => other)).toStrictEqual([
      "Look up the customer in Salesforce, as someone does.",
    ]);
  });

  it("keeps no checked difference's words once someone it rests on withdraws, deletes their interview, or a document it had goes", async () => {
    // Withdrawing.
    const withdrawn = await team();
    const { tickets: first } = await drawn(withdrawn);
    const before = await checkedOf(first);
    await onLinkOf(withdrawn.doers[0] ?? "", "withdraw");
    const afterWithdrawal = await checkedOf(first);
    // Deleting the interview.
    const deleted = await team();
    const { tickets: second } = await drawn(deleted);
    await onLinkOf(deleted.doers[0] ?? "", "delete");
    const afterDeletion = await checkedOf(second);
    // A document shared before it was drawn (as its time says), purged.
    const documented = await team();
    const store = onboardingStore(env);
    const { tickets: third } = await drawn(documented);
    const document = `doc-${crypto.randomUUID()}`;
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO documents (id, name, at, by, reading) VALUES (?, 'Handbook', ?, 'admin', 'A handbook.')",
        document,
        new Date(Date.now() - 600_000).toISOString()
      );
    });
    const beforePurge = await checkedOf(third);
    await store.forgetDocuments([document], { type: "system" });
    expect({
      before: [before.length, beforePurge.length],
      afterWithdrawal,
      afterDeletion,
      afterPurge: await checkedOf(third),
    }).toStrictEqual({
      before: [1, 1],
      afterWithdrawal: [],
      afterDeletion: [],
      afterPurge: [],
    });
  });

  it("writes no checked difference's words for a drawing someone it rests on withdrew from while it was checked", async () => {
    const ids = await team();
    let withdrawing: Promise<void> | undefined;
    // While the intake checks who told what, the first of them withdraws.
    const { tickets } = await drawn(ids, () => {
      withdrawing ??= onLinkOf(ids.doers[0] ?? "", "withdraw");
      return true;
    });
    await withdrawing;
    await expect(checkedOf(tickets)).resolves.toStrictEqual([]);
  });

  it("shows no difference whose other way fewer than five are checked to tell, the drawing's word for five notwithstanding", async () => {
    const ids = await team();
    // One of the five says something else, as the check finds.
    const { tickets } = await drawn(
      ids,
      (part, facts) =>
        !part.includes("Salesforce") || facts.includes(salesforceWay),
      [salesforceWay]
    );
    const last = ids.doers.at(-1) ?? "";
    await agree(last, "step", ["I phone the customer first."], 1);
    await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    await intake(
      ids,
      [],
      (part, facts) =>
        !part.includes("Salesforce") || facts.includes(salesforceWay)
    );
    const { api } = await signedInApi(idp, "admin");
    const review = await api.onboarding.review();
    expect({
      review: review.differences,
      settle: await outcome(api.onboarding.settle(tickets, "both")),
    }).toStrictEqual({ review: [], settle: "onboarding.no_difference" });
  });

  it("shows a difference only while the drawing the brain checked stands: drawn again, it waits for the brain", async () => {
    const ids = await team();
    await drawn(ids);
    const { api } = await signedInApi(idp, "admin");
    const checked = await api.onboarding.review();
    // One of them agrees again, and tickets are drawn once more.
    const [first = ""] = ids.doers;
    await agree(first, "step", [sheetWay, "I close the ticket."], 1);
    await answering(
      [ticketsReply(ids)],
      async () => await onboardingStore(env).drawNext()
    );
    const redrawn = await api.onboarding.review();
    await intake(ids, []);
    const again = await api.onboarding.review();
    expect({
      checked: checked.differences.length,
      redrawn: redrawn.differences.length,
      again: again.differences.length,
    }).toStrictEqual({ checked: 1, redrawn: 0, again: 1 });
  });

  it("settles only a difference there is, and only for an admin, Grasp's staff among them", async () => {
    const ids = await team();
    const { tickets, rota } = await drawn(ids);
    const { api } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const staff = await asStaff();
    const staffReview = await staff.onboarding.review();
    expect({
      // The rota went one way: nothing to settle.
      rota: await outcome(api.onboarding.settle(rota, "both")),
      unknown: await outcome(api.onboarding.settle("nothing", "both")),
      user: await outcome(user.onboarding.settle(tickets, "both")),
      read: await outcome(user.onboarding.review()),
      staff: staffReview.differences.length,
    }).toStrictEqual({
      rota: "onboarding.no_difference",
      unknown: "onboarding.no_difference",
      user: "role.forbidden",
      read: "role.forbidden",
      staff: 1,
    });
  });

  it("counts towards what Grasp knows once it is settled", async () => {
    const ids = await team();
    const { tickets } = await drawn(ids);
    const { api } = await signedInApi(idp, "admin");
    const reviewOf = async () => {
      const { parts } = await api.onboardingGate.view();
      return parts.find(({ source }) => source === "review")?.known;
    };
    const before = await reviewOf();
    await api.onboarding.settle(tickets, "other");
    const after = await reviewOf();
    // Half for what is settled, and half for the work known: tickets,
    // which everyone who does it told, is known once one way holds; the
    // rota, Lea's own, waits for more than her overview.
    expect({ before, after }).toStrictEqual({ before: 0, after: 0.75 });
  });
});
