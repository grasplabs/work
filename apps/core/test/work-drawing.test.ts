import { sha256Hex } from "@grasp-os/shared/encoding";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { Roster, SettleChoice } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { drawnOf, knownOf } from "../src/onboarding/work-drawing.ts";
import type { RawDrawing } from "../src/onboarding/work-drawing.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import {
  answering,
  approveAgreed,
  careful,
  modelOf,
  participate,
} from "./interview-link.ts";
import { routed, unique } from "./sign-in.ts";

// Each piece of work drawn from what its people agreed to
// (src/onboarding/work-drawing.ts and the store's drawing): once someone
// who does a piece of work agrees to their interview, the careful model
// draws it again from everyone's agreed facts, and what nobody could say
// becomes what Stephen asks next. AI Gateway is the outside system, faked
// behind the AI binding. The ways it can fail, tried here:
//
// - People's numbers averaged into one, or made up where nobody gave any.
// - What the lead said about the whole team told as if it were the work.
// - What earlier interviews left open never reaching the next interview.
// - A drawing that keeps failing being tried for good, or never again.

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sessionKey = z.object({ key: z.string().optional() });

/** A team led by Lea, with Max, Mia, Mo and Noor, in a fresh onboarding that started yesterday. */
const team = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    team: `ops-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    mo: `mo-${id}`,
    noor: `noor-${id}`,
  };
  const person = (
    key: "lea" | "max" | "mia" | "mo" | "noor",
    name: string,
    title: string
  ) => ({
    id: ids[key],
    name,
    team: ids.team,
    email: "",
    title,
    away: false,
  });
  const roster: Roster = {
    teams: [
      { id: ids.team, name: "Ops", lead: ids.lea, does: "", off: false },
      { id: `fin-${id}`, name: "Finance", lead: null, does: "", off: true },
    ],
    people: [
      person("lea", "Lea Lind", "Team lead"),
      person("max", "Max Mol", "Agent"),
      person("mia", "Mia Moor", "Agent"),
      person("mo", "Mo Mertens", "Agent"),
      person("noor", "Noor Nijs", "Agent"),
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
  // The store is shared across tests, so this roster took the last test's
  // people out, and that set the alarm to draw soon. Taken away, what is
  // due is drawn only when the test asks.
  await runInDurableObject(store, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  return ids;
};

/** Someone's link opened on a device: their secret and key. */
const openLink = async (person: string) => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  return { secret, key: key ?? "" };
};

const fact = (id: string, tag: FactTag, record: string): InterviewFact => ({
  id,
  tag,
  text: record,
  record,
  agreed: true,
});

/** Saves someone's interview as agreed to, with `facts`; returns the new version. */
const agree = async (
  link: { secret: string; key: string },
  version: number,
  facts: InterviewFact[],
  file?: string
): Promise<number> => {
  const progress: InterviewProgress = {
    person: "completed",
    told: true,
    mode: "type",
    lines: [
      { from: "stephen", text: "What starts one?" },
      ...(file === undefined
        ? []
        : [{ from: "person" as const, text: "This one.", file }]),
    ],
    facts,
    phase: "readback",
    wants: "end",
    startedAt: Date.now(),
    confirmed: facts.length,
    adding: false,
    addedAt: 0,
  };
  const response = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save", ...link, version, progress }),
  });
  const saved: InterviewSaved = await response.json();
  await approveAgreed(link, facts);
  return saved.version;
};

type Ids = Awaited<ReturnType<typeof team>>;

/** What the careful model answers for the map: tickets, by Max, Mia and Mo, and the rota, Lea's own. */
const mapReply = (ids: Ids): GatewayReply => ({
  text: JSON.stringify({
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
  inputTokens: 2000,
  outputTokens: 300,
});

/** What the careful model answers for tickets, from Max, Mia and Mo. */
const ticketsReply = (ids: Ids): GatewayReply => ({
  text: JSON.stringify({
    starts: "A customer email arrives as a ticket in Zendesk.",
    starts_by: [ids.max, ids.mia],
    steps: [
      {
        text: "Open the ticket.",
        who: "Agent",
        tool: "Zendesk",
        by: [ids.max, ids.mia, ids.mo],
        other: "",
        other_by: [],
        why: "",
        because: "",
        minutes: [],
        documented: false,
      },
      {
        text: "Look up the customer in the client sheet.",
        who: "Agent",
        tool: "Excel",
        by: [ids.max, ids.mia],
        other: "Look up the customer in Salesforce.",
        other_by: [ids.mo],
        why: "conflict",
        because: "",
        minutes: [-1, 2, -1],
        documented: false,
      },
    ],
    notes: [
      {
        kind: "differently",
        text: "the customer number is missing",
        detail: "Email the customer for it.",
        out_of_ten: -1,
        after: 1,
        by: [ids.max],
      },
    ],
    numbers: [
      {
        person: ids.max,
        quiet: 30,
        busy: 50,
        of: "me",
        per: "week",
        minutes: [3, 10, 45],
        wrong: 2,
      },
      {
        person: ids.mia,
        quiet: -1,
        busy: 45,
        of: "unknown",
        per: "week",
        minutes: [-1, 12, -1],
        wrong: -1,
      },
    ],
    open: [
      "Why do some look the customer up in Salesforce?",
      "How many tickets come in a busy week for the whole team?",
    ],
  }),
  inputTokens: 4000,
  outputTokens: 900,
});

/** The lead's map drawn, and everyone's links out: tickets and the rota, by id. */
const mapped = async (ids: Ids) => {
  const store = onboardingStore(env);
  await store.releaseDue();
  const lea = await openLink(ids.lea);
  await agree(lea, 0, [
    fact("l1", "work", "Max, Mia and Mo handle new tickets."),
    fact("l2", "work", "Lea plans the rota every Friday."),
  ]);
  await answering([mapReply(ids)], async () => await store.drawNext());
  await store.releaseDue();
  const [tickets, rota] = await store.teamWorks(ids.team);
  return { lea, tickets: tickets?.id ?? "", rota: rota?.id ?? "" };
};

/** The text of every message a request sent, in one string. */
const sentOf = (body: unknown): string => JSON.stringify(body);

const refused: GatewayReply = {
  status: 400,
  errorType: "invalid_request_error",
};

describe("a piece of work, drawn", { timeout: 60_000 }, () => {
  it("is drawn from three agreed interviews, keeps each person's numbers apart, and gives the next interview what is still open", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const { tickets } = await mapped(ids);
    await agree(
      await openLink(ids.max),
      0,
      [
        fact("m1", "step", "Max opens the ticket and looks the customer up."),
        fact("m2", "number", "Max does 30 to 50 a week."),
      ],
      "ticket-4411.pdf"
    );
    await agree(await openLink(ids.mia), 0, [
      fact("i1", "number", "Mia does about 45 in a busy week."),
    ]);
    await agree(await openLink(ids.mo), 0, [
      fact("o1", "step", "Mo looks the customer up in Salesforce."),
    ]);
    const noor = await openLink(ids.noor);
    await participate(noor);
    const contextOf = async () => {
      const context = await store.turnContext(
        await sha256Hex(noor.secret),
        await sha256Hex(noor.key)
      );
      return context.ok ? context.value.known : "";
    };
    const before = await contextOf();
    // The rota, Lea's own, is drawn from her alone; tickets after.
    const rotaReply: GatewayReply = {
      text: JSON.stringify({ steps: [], open: [] }),
      inputTokens: 100,
      outputTokens: 10,
    };
    const { requests, result: drew } = await answering(
      [rotaReply, ticketsReply(ids)],
      async () => [await store.drawNext(), await store.drawNext()]
    );
    const drawnWorks = await store.teamWorks(ids.team);
    const work = drawnWorks.find(({ id }) => id === tickets);
    const sent = sentOf(requests[1]?.body);
    const due = await store.drawsDue();
    const usage = await store.usage();
    const after = await contextOf();
    expect({
      drew: drew[1],
      models: requests.map(modelOf),
      sent: {
        // Each teller by a neutral label, never their id or title (GRA-1084).
        max:
          sent.includes("## P1") &&
          !sent.includes(ids.max) &&
          !sent.includes("(Agent)"),
        // A file named in the conversation was never read back or
        // approved: it doesn't leave the store (GRA-329).
        example: sent.includes("ticket-4411.pdf"),
        mia: sent.includes("- (number) Mia does about 45 in a busy week."),
        mo: sent.includes("- (step) Mo looks the customer up in Salesforce."),
        // The lead's overview is context, never one of the tellers.
        leadAsContext: sent.includes(
          "for context only:\\n- Max, Mia and Mo handle new tickets."
        ),
        leadAsTeller: sent.includes(`## ${ids.lea}`),
        // A team that's off is still a team the work can go to.
        teams: sent.includes("The company's other teams: Finance."),
      },
      from: work?.drawn?.from,
      numbers: Object.fromEntries(
        Object.entries(work?.drawn?.told ?? {}).map(([person, told]) => [
          person,
          {
            volume: told.volume,
            of: told.volumeOf ?? null,
            takes: told.takes,
            wrong: told.wrong,
          },
        ])
      ),
      differs: work?.drawn?.differs,
      outOfTen: work?.drawn?.differently.map(({ outOfTen }) => outOfTen),
      known: { approved: work?.known.approved, state: work?.known.state },
      before: before.includes("left open"),
      after: after.includes(
        "What earlier interviews left open, to ask when it comes up: Why do some look the customer up in Salesforce? How many tickets come in a busy week for the whole team?"
      ),
      due: [ids.max, ids.mia, ids.mo].filter((id) => due.includes(id)),
      counted: usage.some(
        ({ purpose, model }) => purpose === "drawing" && model === careful
      ),
    }).toMatchObject({
      drew: `work:${tickets}`,
      models: ["claude-opus-4-8", "claude-opus-4-8"],
      sent: {
        max: true,
        example: false,
        mia: true,
        mo: true,
        leadAsContext: true,
        leadAsTeller: false,
        teams: true,
      },
      from: [ids.max, ids.mia, ids.mo],
      numbers: {
        [ids.max]: { volume: [30, 50], of: "me", takes: [3, 10, 45], wrong: 2 },
        // A busy week alone is both ends; a normal time alone is the normal one.
        [ids.mia]: {
          volume: [45, 45],
          of: "unknown",
          takes: [12, 12, 12],
          wrong: null,
        },
        // Mo gave no numbers: none are made up.
        [ids.mo]: { volume: null, of: null, takes: null, wrong: null },
      },
      differs: {
        step: 1,
        other: "Look up the customer in Salesforce.",
        why: "conflict",
        because: "",
      },
      outOfTen: [null],
      // Noor does it too and hasn't talked: three of four.
      known: { approved: 3, state: "mapping" },
      before: false,
      after: true,
      due: [],
      counted: true,
    });
  });

  it("is the lead's own work drawn from the lead alone, while work others do waits for them", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const { rota } = await mapped(ids);
    const reply: GatewayReply = {
      text: JSON.stringify({
        steps: [{ text: "Plan next week's rota.", by: [ids.lea] }],
        open: [],
      }),
      inputTokens: 100,
      outputTokens: 10,
    };
    const { requests, result } = await answering([reply], async () => [
      await store.drawNext(),
      await store.drawNext(),
    ]);
    const sent = sentOf(requests[0]?.body);
    const works = await store.teamWorks(ids.team);
    expect({
      result,
      teller:
        sent.includes("## P1, asked about the work of the whole team") &&
        !sent.includes(ids.lea) &&
        !sent.includes("(Team lead)"),
      context: sent.includes("for context only"),
      drawn: works.map(
        ({ drawn }) => drawn?.steps.map(({ text }) => text) ?? null
      ),
    }).toStrictEqual({
      result: [`work:${rota}`, null],
      teller: true,
      context: false,
      drawn: [null, ["Plan next week's rota."]],
    });
  });

  it("is tried again after a minute, five and thirty, then given up and logged, and drawn again once someone agrees to more", async () => {
    const store = onboardingStore(env);
    const ids = await team();
    const { tickets } = await mapped(ids);
    // The rota, Lea's own, is drawn first and out of the way.
    await answering(
      [{ text: "{}", inputTokens: 1, outputTokens: 1 }],
      async () => await store.drawNext()
    );
    const max = await openLink(ids.max);
    const facts = [fact("m1", "step", "Max opens the ticket.")];
    const version = await agree(max, 0, facts);
    const now = Date.now();
    const minute = 60_000;
    const { requests, result } = await answering(
      [refused, refused, refused, refused],
      async () => [
        await store.drawNext(now),
        // Not yet: it waits a minute.
        await store.drawNext(now + minute / 2),
        await store.drawNext(now + minute + 1),
        await store.drawNext(now + 7 * minute),
        await store.drawNext(now + 38 * minute),
        // Given up: nothing is due.
        await store.drawNext(now + 120 * minute),
      ]
    );
    const dueNow = await store.drawsDue();
    const dueAfter = dueNow.includes(ids.max);
    await agree(max, version, [
      ...facts,
      fact("m2", "number", "Max does 40 a week."),
    ]);
    const { result: again } = await answering(
      [ticketsReply(ids)],
      async () => await store.drawNext()
    );
    const { entries } = await store.staffLog({ what: "work" });
    expect({
      result,
      calls: requests.length,
      dueAfter,
      again,
      log: entries
        .filter(({ person }) => person?.id === ids.max)
        .map(({ what }) => what),
    }).toStrictEqual({
      result: [
        `work:${tickets}`,
        null,
        `work:${tickets}`,
        `work:${tickets}`,
        `work:${tickets}`,
        null,
      ],
      calls: 4,
      dueAfter: false,
      again: `work:${tickets}`,
      log: [
        "work.drawn",
        "work.gave_up",
        "work.failed",
        "work.failed",
        "work.failed",
      ],
    });
  });
});

/** Three people who handle tickets, as the store briefs the drawing. */
const tellers = {
  tellers: [
    { person: "lisa", title: "Agent", facts: [], example: "ticket-4411.pdf" },
    { person: "tim", title: "Agent", facts: [], example: null },
    { person: "bram", title: "Agent", facts: [], example: null },
  ],
};

/** A step everyone told, by default. */
const step = (
  text: string,
  more: Partial<NonNullable<RawDrawing["steps"]>[number]> = {}
) => ({
  text,
  by: ["lisa", "tim", "bram"],
  ...more,
});

describe("the work as drawn", () => {
  it("keeps the times of a step in their places, and counts in hours once a normal one takes two", () => {
    const drawn = drawnOf(
      {
        steps: [
          step("Open the ticket.", { minutes: [] }),
          step("Look it up.", { minutes: [-1, 2, -1] }),
          step("Answer.", { minutes: [3, 8, 30], documented: true }),
        ],
        numbers: [
          {
            person: "lisa",
            quiet: 3,
            busy: 5,
            per: "week",
            minutes: [150, 240, 480],
          },
          { person: "nobody-asked", quiet: 1, busy: 2, minutes: [] },
        ],
      },
      tellers,
      "2026-10-22T00:00:00.000Z"
    );
    expect({
      minutes: drawn.steps.map(({ minutes }) => minutes),
      documented: drawn.steps.map(({ documented }) => documented),
      unit: drawn.unit,
      takes: drawn.told.lisa?.takes,
      told: Object.keys(drawn.told),
    }).toStrictEqual({
      minutes: [null, [2, 2, 2], [3, 8, 30]],
      documented: [false, false, true],
      unit: "hours",
      takes: [2.5, 4, 8],
      told: ["lisa", "tim", "bram"],
    });
  });

  it("keeps each person's own minutes of a step and share of a case, apart from any text", () => {
    const drawn = drawnOf(
      {
        steps: [
          step("Look it up.", {
            minutes: [2, 4, 9],
            minutes_by: [
              { person: "lisa", minutes: [2, 4, 9] },
              { person: "nobody-asked", minutes: [1, 1, 1] },
            ],
          }),
        ],
        notes: [
          {
            kind: "differently",
            text: "the client number is missing",
            detail: "Ask Finance.",
            out_of_ten: 2,
            out_of_ten_by: [{ person: "tim", out_of_ten: 2 }],
            by: ["tim"],
          },
        ],
      },
      tellers,
      "2026-10-22T00:00:00.000Z"
    );

    expect({
      lisa: drawn.told.lisa?.stepMinutes,
      tim: drawn.told.tim?.caseShares,
      bram: [drawn.told.bram?.stepMinutes, drawn.told.bram?.caseShares],
      // The case's text holds no number of anyone's.
      when: drawn.differently.map(({ when }) => when),
    }).toStrictEqual({
      lisa: [{ step: 0, minutes: [2, 4, 9] }],
      tim: [{ case: 0, outOfTen: 2 }],
      bram: [[], []],
      when: ["the client number is missing"],
    });
  });

  it("holds when the model leaves everything out", () => {
    const bare = drawnOf({}, tellers, "2026-10-22T00:00:00.000Z");
    expect({
      steps: bare.steps,
      differs: bare.differs,
      open: bare.open,
      lisa: bare.told.lisa,
    }).toMatchObject({
      steps: [],
      differs: null,
      open: [],
      lisa: {
        volume: null,
        takes: null,
        wrong: null,
        steps: [],
        example: "ticket-4411.pdf",
      },
    });
  });

  it.each([
    {
      why: "",
      told: ["lisa", "tim", "bram"],
      holds: null,
      counted: false,
      state: "complete",
    },
    {
      why: "place",
      told: ["lisa", "tim", "bram"],
      holds: null,
      counted: false,
      state: "variants",
    },
    // Told two ways and nobody can say why: it waits until somebody can.
    {
      why: "conflict",
      told: ["lisa", "tim", "bram"],
      holds: null,
      counted: false,
      state: "blocked",
    },
    // Or until the admin settles it: both ways kept, or one that holds.
    {
      why: "conflict",
      told: ["lisa", "tim", "bram"],
      holds: "both",
      counted: false,
      state: "variants",
    },
    {
      why: "conflict",
      told: ["lisa", "tim", "bram"],
      holds: "other",
      counted: false,
      state: "complete",
    },
    {
      why: "",
      told: ["lisa", "tim"],
      holds: null,
      counted: false,
      state: "mapping",
    },
    // Counted as known by hand by Grasp: that holds, unless nobody can say why.
    {
      why: "",
      told: ["lisa", "tim"],
      holds: null,
      counted: true,
      state: "complete",
    },
    {
      why: "conflict",
      told: ["lisa", "tim", "bram"],
      holds: null,
      counted: true,
      state: "blocked",
    },
  ] satisfies {
    why: string;
    told: string[];
    holds: SettleChoice | null;
    counted: boolean;
    state: string;
  }[])(
    "is known as $state when $told.length of three told it, a step told two ways for '$why', settled as $holds, counted by hand $counted",
    ({ why, told, holds, counted, state }) => {
      const drawn = drawnOf(
        {
          steps: [
            step("Open the ticket."),
            step("Look it up.", {
              by: ["lisa", "tim"],
              ...(why === ""
                ? {}
                : {
                    other: "Look it up in Salesforce.",
                    other_by: ["bram"],
                    why,
                  }),
            }),
          ],
        },
        {
          tellers: tellers.tellers.filter(({ person }) =>
            told.includes(person)
          ),
        },
        "2026-10-22T00:00:00.000Z"
      );
      const known = knownOf(drawn, {
        id: "tickets",
        team: "ops",
        told,
        doers: ["lisa", "tim", "bram"],
        lead: null,
        holds,
        counted,
      });
      expect(known.state).toBe(state);
    }
  );
});
