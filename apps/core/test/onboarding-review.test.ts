import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering } from "./interview-link.ts";
import {
  auditedDuring,
  outcome,
  routed,
  signedInApi,
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
// - Something settled that needs no settling, or by anyone but an admin.
// - A settlement made without a trace in the audit log.
// - Settling counting nothing towards what Grasp knows.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** Ops, led by Lea, with Max, Mia and Mo, in an onboarding that started yesterday. */
const team = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    mo: `mo-${id}`,
  };
  const person = (key: "lea" | "max" | "mia" | "mo", name: string) => ({
    id: ids[key],
    name,
    team: ids.team,
    email: "",
    title: key === "lea" ? "Team lead" : "Agent",
    away: false,
  });
  const roster: Roster = {
    teams: [{ id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false }],
    people: [
      person("lea", "Lea Lind"),
      person("max", "Max Mol"),
      person("mia", "Mia Moor"),
      person("mo", "Mo Mertens"),
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

/** Agrees to someone's interview, on a device of their own, with `facts`. */
const agree = async (person: string, tag: FactTag, facts: string[]) => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const opened = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await opened.json());
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
    body: JSON.stringify({
      action: "save",
      secret,
      key,
      version: 0,
      progress,
    }),
  });
  const { version }: InterviewSaved = await saved.json();
  return version;
};

const reply = (value: unknown): GatewayReply => ({
  text: JSON.stringify(value),
  inputTokens: 100,
  outputTokens: 10,
});

/**
 * Ops's map, tickets and the rota, drawn: tickets told two ways by Max,
 * Mia and Mo, and nobody could say why; the rota, Lea's own, one way.
 */
const drawn = async (ids: Ids) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  await agree(ids.lea, "work", ["Max, Mia and Mo handle new tickets."]);
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
            doers: [ids.max, ids.mia, ids.mo],
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
  for (const person of [ids.max, ids.mia, ids.mo]) {
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    await agree(person, "step", ["I look the customer up."]);
  }
  await answering(
    [
      reply({
        steps: [{ text: "Plan next week's rota.", by: [ids.lea] }],
      }),
      reply({
        steps: [
          { text: "Open the ticket.", by: [ids.max, ids.mia, ids.mo] },
          {
            text: "Look up the customer in the client sheet.",
            by: [ids.max, ids.mia],
            other: "Look up the customer in Salesforce.",
            other_by: [ids.mo],
            why: "conflict",
          },
        ],
      }),
    ],
    async () => [await store.drawNext(), await store.drawNext()]
  );
  const [tickets, rota] = await store.teamWorks(ids.team);
  return { tickets: tickets?.id ?? "", rota: rota?.id ?? "" };
};

describe("what needs the admin", { timeout: 60_000 }, () => {
  it("is a step told two ways that nobody could explain, never who told which, and keeps how the admin settled it", async () => {
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
      named: [ids.lea, ids.max, ids.mia, ids.mo, "Max", "Mo"].some((each) =>
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
            other: "Look up the customer in Salesforce.",
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

  it("settles only a difference there is, and only for an admin", async () => {
    const ids = await team();
    const { tickets, rota } = await drawn(ids);
    const { api } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    expect({
      // The rota went one way: nothing to settle.
      rota: await outcome(api.onboarding.settle(rota, "both")),
      unknown: await outcome(api.onboarding.settle("nothing", "both")),
      user: await outcome(user.onboarding.settle(tickets, "both")),
      read: await outcome(user.onboarding.review()),
    }).toStrictEqual({
      rota: "onboarding.no_difference",
      unknown: "onboarding.no_difference",
      user: "role.forbidden",
      read: "role.forbidden",
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
