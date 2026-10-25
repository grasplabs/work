import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { turnEvents } from "@grasp-os/shared/interview-turn";
import {
  labAnswerSchema,
  labContextSchema,
  labDrawingsSchema,
  labLinksSchema,
  labPath,
  labViaSchema,
} from "@grasp-os/shared/lab";
import type { LabWho } from "@grasp-os/shared/lab";
import type { Roster } from "@grasp-os/shared/onboarding";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import {
  answering,
  approveAgreed,
  careful,
  countedFor,
  gatewayConfig,
  modelOf,
  quick,
} from "./interview-link.ts";
import {
  auditedDuring,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The Stephen Lab's way into a local core (src/onboarding/lab.ts): its
// model calls through the gateway, and the practice people's links. AI
// Gateway is the outside system: a fake behind the AI binding. The ways it
// can fail, tried here:
//
// - A deployed core answering it: anyone could then spend a client's
//   models on the lab, or read the links it gives out.
// - Anyone but Grasp's staff using it, on a local stack too.
// - A call that goes around the gateway's allowlist, rules or audit log.
// - A turn or a drawing on the benches' fixed input (GRA-338) counted as
//   someone's interview, or kept as the company's drawing.

const idp = mockIdp();

/** Core's env as `vp run dev` runs it: no router in front. */
const localEnv = (): Env => ({ ...env, DEV_SKIP_ROUTER_SECRET: "true" });

/** The lab's request to a local core, as `session` signed in. */
const fromLab = async (
  body: unknown,
  { session, coreEnv = localEnv() }: { session?: string; coreEnv?: Env } = {}
): Promise<Response> =>
  await worker.fetch(
    new Request(`http://localhost:8787${labPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session === undefined ? {} : { cookie: session }),
      },
      body: JSON.stringify(body),
    }),
    coreEnv,
    createExecutionContext()
  );

const codeOf = async (response: Response) => [
  response.status,
  errorPayloadSchema.safeParse(await response.json()).data?.code ?? null,
];

/** What the lab's request answered, as JSON. */
const answerTo = async (
  body: unknown,
  options?: { session?: string }
): Promise<unknown> => {
  const response = await fromLab(body, options);
  return await response.json();
};

/** The status and code the lab's request was refused with. */
const refusedWith = async (
  body: unknown,
  options?: { session?: string }
): Promise<unknown[]> => await codeOf(await fromLab(body, options));

const staffSession = async () =>
  await signedIn(idp, "grasp-staff", staffPerson());

/** What the practice people answer, in the shape the lab asks for. */
const answerSchema = {
  type: "object",
  properties: { say: { type: "string" } },
  required: ["say"],
  additionalProperties: false,
};

const asked = {
  action: "ask",
  role: "careful",
  system: "You are Sanne, who books supplier invoices.",
  input: "Stephen: How does an invoice come in?",
  schema: answerSchema,
  maxTokens: 400,
};

const agreedFact = (
  id: string,
  tag: InterviewFact["tag"],
  record: string
): InterviewFact => ({ id, tag, text: record, record, agreed: true });

/** Opens someone's link on a device and saves their interview as agreed to, with `facts`, approved. */
const agree = async (person: string, facts: InterviewFact[]): Promise<void> => {
  const link = await onboardingStore(env).linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const opened = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = z.object({ key: z.string() }).parse(await opened.json());
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

/** What the careful model answers for the team's map: entering orders, Karin's. */
const mapOf = (karin: string): GatewayReply => ({
  text: JSON.stringify({
    does: "Enters the orders",
    works: [
      {
        name: "entering orders",
        local: "entering orders",
        one: "order",
        many: "orders",
        doers: [karin],
        share: 1,
      },
    ],
  }),
  inputTokens: 2000,
  outputTokens: 300,
});

/** What the careful model answers for entering orders, from Karin. */
const ordersDrawn = (karin: string): GatewayReply => ({
  text: JSON.stringify({
    starts: "",
    steps: [
      {
        text: "Type the order into the order system.",
        who: "Order clerk",
        tool: "",
        by: [karin],
        minutes: [],
        documented: false,
      },
    ],
    notes: [],
    numbers: [],
    open: [],
  }),
  inputTokens: 1000,
  outputTokens: 200,
});

describe("the Stephen Lab's way into a local core", { timeout: 60_000 }, () => {
  it("is not there on a deployed core, for staff either", async () => {
    const session = await staffSession();
    const response = await routed(labPath, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ action: "via" }),
    });
    await expect(codeOf(response)).resolves.toStrictEqual([
      404,
      "request.not_found",
    ]);
  });

  it("answers Grasp's staff only, on a local stack too", async () => {
    const member = await signedInWithRole(idp, "admin");
    const outcomes = await Promise.all([
      refusedWith({ action: "via" }),
      refusedWith({ action: "via" }, { session: member.session }),
    ]);
    expect(outcomes).toStrictEqual([
      [401, "auth.unauthenticated"],
      [403, "request.forbidden"],
    ]);
  });

  it("asks the role's model through the gateway, holds the answer to the lab's schema, and has it on record as the staff member's", async () => {
    const session = await staffSession();
    const { requests, result } = await answering(
      [
        // Not the shape asked for: the gateway asks once more.
        { text: '{"said": "by email"}', inputTokens: 300, outputTokens: 10 },
        { text: '{"say": "by email"}', inputTokens: 320, outputTokens: 10 },
      ],
      async () => {
        let response: Response | undefined;
        const audited = await auditedDuring(async () => {
          response = await fromLab(asked, { session });
        });
        return { response, audited };
      }
    );
    const answer = labAnswerSchema.parse(await result.response?.json());
    const calls = result.audited.filter(
      ({ action }) => action === "model.call"
    );
    expect({
      output: answer.output,
      model: answer.model,
      sentTo: requests.map(modelOf),
      calls: calls.map(({ actor, detail }) => ({
        actor: actor.type,
        purpose: detail.purpose,
      })),
    }).toStrictEqual({
      output: { say: "by email" },
      model: careful,
      sentTo: [
        careful.slice(careful.indexOf("/") + 1),
        careful.slice(careful.indexOf("/") + 1),
      ],
      calls: [
        { actor: "staff", purpose: "onboarding.lab" },
        { actor: "staff", purpose: "onboarding.lab" },
      ],
    });
  });

  it("refuses a call while the deployment's rules don't let the role's model take what the interviews carry", async () => {
    const session = await staffSession();
    const { requests, result } = await answering([], async () => {
      env.MODEL_GATEWAY = {
        ...gatewayConfig,
        roles: { careful },
        sensitive: { models: [quick], connections: [] },
      };
      return await refusedWith(asked, { session });
    });
    expect({ result, sent: requests.length }).toStrictEqual({
      result: [503, "model.unconfigured"],
      sent: 0,
    });
  });

  it("says how the models are reached: the gateway, and the model of each role", async () => {
    const session = await staffSession();
    const { result } = await answering([], async () =>
      labViaSchema.parse(await answerTo({ action: "via" }, { session }))
    );
    expect(result).toStrictEqual({
      gateway: gatewayConfig.gateway,
      quick: gatewayConfig.roles.quick,
      careful: gatewayConfig.roles.careful,
    });
  });

  it("gives the practice people's links, which open their interviews", async () => {
    const session = await staffSession();
    const store = onboardingStore(env);
    const person = `lab-${unique()}`;
    const roster: Roster = {
      teams: [{ id: "lab", name: "Finance", lead: null, does: "", off: false }],
      people: [
        {
          id: person,
          name: "Sanne de Vries",
          team: "lab",
          email: "",
          title: "Finance administrator",
          away: false,
        },
      ],
    };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(roster, by);
    await store.savePlan(
      { start: new Date().toISOString().slice(0, 10), days: 14 },
      by
    );
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    await store.releaseDue();
    const { links } = labLinksSchema.parse(
      await answerTo({ action: "links" }, { session })
    );
    const secret = links.find((each) => each.person === person)?.link;
    const opened = await routed(interviewApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "session",
        secret: secret?.split("#")[1] ?? "",
      }),
    });
    expect(
      z
        .object({ state: z.string(), name: z.string() })
        .parse(await opened.json())
    ).toStrictEqual({ state: "open", name: "Sanne" });
  });

  it("holds one of Stephen's turns on fixed input, with who it is with given, as a link's turn, and the onboarding counts none of it", async () => {
    const session = await staffSession();
    const who: LabWho = {
      company: "Noordzee Vis B.V.",
      name: "Karin",
      team: "Order desk",
      lead: "Wim",
      work: "entering orders",
      known: "",
    };
    const { requests, result } = await answering(
      [
        {
          text: "TONE: none\nSAY: Who releases it?\nPART: steps\nWANTS: answer\nMORE: no\nAGREED: no\n",
          inputTokens: 1500,
          outputTokens: 40,
        },
        {
          text: JSON.stringify({
            facts: [
              {
                tag: "step",
                text: "The order gets released.",
                record: "The order is released.",
                quote: "the order gets released",
              },
            ],
            changes: [],
          }),
          inputTokens: 1600,
          outputTokens: 120,
        },
      ],
      async () => {
        const before = await countedFor(quick);
        const response = await fromLab(
          {
            action: "turn",
            who,
            turn: {
              event: "answer",
              locale: "en",
              lines: [
                {
                  from: "stephen",
                  text: "What happens after you typed it in?",
                },
                {
                  from: "person",
                  text: "Then the order gets released.",
                  typed: true,
                },
              ],
              facts: [],
              phase: "steps",
              minutes: 5,
            },
          },
          { session }
        );
        const { events } = turnEvents(`${await response.text()}\n`);
        return { events, before, after: await countedFor(quick) };
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    const [turn] = result.events.flatMap((event) =>
      "turn" in event ? [event.turn] : []
    );
    expect({
      say: turn?.say,
      facts: turn?.facts.map(({ text }) => text),
      lineFirst: result.events.some((event) => "line" in event),
      models: requests.map(modelOf),
      told: [
        "The company: Noordzee Vis B.V.",
        "You talk with: Karin, Order desk.",
        "Their team lead, who pointed you to them: Wim.",
        "The work to learn about: entering orders.",
      ].map((line) => brief.includes(line)),
      counted: result.after.calls - result.before.calls,
    }).toStrictEqual({
      say: "Who releases it?",
      facts: ["The order gets released."],
      lineFirst: true,
      models: [
        quick.slice(quick.indexOf("/") + 1),
        careful.slice(careful.indexOf("/") + 1),
      ],
      told: [true, true, true, true],
      counted: 0,
    });
  });

  it("says who someone on the roster is, as their turns would know it, and nobody for someone not on it", async () => {
    const session = await staffSession();
    const store = onboardingStore(env);
    const id = unique();
    const by = { type: "system" } as const;
    await store.saveRoster(
      {
        teams: [
          {
            id: `desk-${id}`,
            name: "Order desk",
            lead: `wim-${id}`,
            does: "",
            off: false,
          },
        ],
        people: [
          {
            id: `wim-${id}`,
            name: "Wim Wouters",
            team: `desk-${id}`,
            email: "",
            title: "Team lead",
            away: false,
          },
          {
            id: `karin-${id}`,
            name: "Karin Kok",
            team: `desk-${id}`,
            email: "",
            title: "Order clerk",
            away: false,
          },
        ],
      },
      by
    );
    const [karin, nobody] = await Promise.all([
      answerTo({ action: "context", person: `karin-${id}` }, { session }),
      answerTo({ action: "context", person: `nobody-${id}` }, { session }),
    ]);
    const { who } = labContextSchema.parse(karin);
    expect({
      who: {
        name: who?.name,
        team: who?.team,
        lead: who?.lead,
        work: who?.work,
      },
      nobody: labContextSchema.parse(nobody),
    }).toStrictEqual({
      who: { name: "Karin", team: "Order desk", lead: "Wim", work: "" },
      nobody: { who: null },
    });
  });

  it("draws every piece of work again from what its people agreed to, and keeps nothing of it", async () => {
    const session = await staffSession();
    const store = onboardingStore(env);
    const id = unique();
    const ids = { team: `desk-${id}`, wim: `wim-${id}`, karin: `karin-${id}` };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(
      {
        teams: [
          {
            id: ids.team,
            name: "Order desk",
            lead: ids.wim,
            does: "",
            off: false,
          },
        ],
        people: [
          {
            id: ids.wim,
            name: "Wim Wouters",
            team: ids.team,
            email: "",
            title: "Team lead",
            away: false,
          },
          {
            id: ids.karin,
            name: "Karin Kok",
            team: ids.team,
            email: "",
            title: "Order clerk",
            away: false,
          },
        ],
      },
      by
    );
    await store.savePlan(
      {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        days: 14,
      },
      by
    );
    await store.setAgreements(
      { processing: true, assessment: true, council: "none" },
      by
    );
    await store.releaseDue();
    await agree(ids.wim, [
      agreedFact("l1", "work", "Karin enters the orders."),
    ]);
    await answering([mapOf(ids.karin)], async () => await store.drawNext());
    await store.releaseDue();
    await agree(ids.karin, [
      agreedFact("k1", "step", "Type the order into the order system."),
    ]);
    const { requests, result } = await answering(
      [ordersDrawn(ids.karin)],
      async () =>
        labDrawingsSchema.parse(await answerTo({ action: "draw" }, { session }))
    );
    const [work] = await store.teamWorks(ids.team);
    const due = await store.drawsDue();
    const drawn = z
      .object({
        from: z.array(z.string()),
        steps: z.array(z.object({ text: z.string() })),
      })
      .parse(result.drawings[0]?.drawn);
    expect({
      drawings: result.drawings.map(({ name }) => name),
      from: drawn.from,
      steps: drawn.steps.map(({ text }) => text),
      told: JSON.stringify(requests[0]?.body).includes(
        "- (step) Type the order into the order system."
      ),
      kept: work?.drawn ?? null,
      stillDue: due.includes(ids.karin),
    }).toStrictEqual({
      drawings: ["entering orders"],
      from: [ids.karin],
      steps: ["Type the order into the order system."],
      told: true,
      kept: null,
      stillDue: true,
    });
  });
});
