import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import type { Roster } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { routed, unique } from "./sign-in.ts";

// One turn of someone's interview (src/onboarding/interview.ts), over the
// endpoint, as the page asks for it. AI Gateway is the outside system: a
// fake behind the AI binding, answering for the deployment's quick model
// (his line) and its careful one (what he writes down). The ways it can
// fail, tried here:
//
// - The page saying who it is or what Stephen knows: the request takes no
//   such field, and the brief holds what the store knows.
// - A line out that breaks his rules, or a fact whose words weren't said.
// - A turn given up halfway going uncounted, or still running.
// - A link that isn't open, or a device that isn't the link's, getting a
//   turn.

const quick = "anthropic/claude-sonnet-4-5";
const careful = "anthropic/claude-opus-4-8";

/** The deployment's gateway: Stephen's two models, both let take sensitive data. */
const gatewayConfig = {
  gateway: "grasp-os-test",
  models: [quick, careful],
  roles: { quick, careful },
  sensitive: { models: [quick, careful], connections: [] },
};

const dayMs = 24 * 60 * 60 * 1000;

/** What a session answers, as far as these tests read it: the device's key. */
const sessionKey = z.object({ key: z.string().optional() });
/** A provider request, as far as these tests read it: its model. */
const requestModel = z.object({ model: z.unknown() });

/** A refusal's status and code. */
const codeOf = async (response: Response) => {
  const parsed = errorPayloadSchema.safeParse(await response.json());
  return [response.status, parsed.success ? parsed.data.code : null];
};
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A fresh onboarding running since yesterday, with one person in Ops (no
 * lead) whose link is out, opened on a device: their secret and key.
 */
const opened = async () => {
  const store = onboardingStore(env);
  const person = `oli-${unique()}`;
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: [
      {
        id: person,
        name: "Oli Olsen",
        team: "ops",
        email: "",
        title: "",
        away: false,
      },
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
  await store.releaseDue();
  const link = await store.linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  return { secret, key: key ?? "" };
};

type Turn = Omit<
  InterviewTurnRequest,
  "secret" | "key" | "interviewer" | "adding"
> &
  Partial<Pick<InterviewTurnRequest, "interviewer" | "adding">>;

const ask = async (
  link: { secret: string; key: string },
  turn: Turn
): Promise<Response> =>
  await routed(interviewTurnPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...link, ...turn }),
  });

/** Every event a turn's answer holds, once it is whole. */
const eventsOf = async (response: Response): Promise<TurnEvent[]> =>
  turnEvents(`${await response.text()}\n`).events;

const turnOf = (events: TurnEvent[]): StephenTurn | undefined =>
  events.flatMap((event) => ("turn" in event ? [event.turn] : []))[0];

/** What his line's model answers: six named lines. */
const line = (say: string, more = "no", part = "you"): GatewayReply => ({
  text: `TONE: none\nSAY: ${say}\nPART: ${part}\nWANTS: answer\nMORE: ${more}\nAGREED: no\n`,
  inputTokens: 1500,
  outputTokens: 40,
});

/** What the notes' model answers. */
const notes = (body: unknown): GatewayReply => ({
  text: JSON.stringify(body),
  inputTokens: 1600,
  outputTokens: 120,
});

/** The model a request went to, by its id in pi's catalog. */
const modelOf = ({ body }: GatewayRequest): unknown =>
  requestModel.safeParse(body).data?.model;

/** What `run` returns while the gateway answers with `replies`. */
const answering = async <T>(replies: GatewayReply[], run: () => Promise<T>) => {
  const before = env.MODEL_GATEWAY;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/** What the onboarding counted of interviews for `model`: calls and tokens read. */
const countedFor = async (model: string) => {
  const rows = await onboardingStore(env).usage();
  const of = rows.filter(
    (row) => row.purpose === "interviews" && row.model === model
  );
  return {
    calls: of.reduce((sum, { calls }) => sum + calls, 0),
    tokensIn: of.reduce((sum, { tokensIn }) => sum + tokensIn, 0),
  };
};

describe("an interview turn", { timeout: 60_000 }, () => {
  it("holds an interview over the endpoint: his line from the quick model, what he wrote down from the careful one, and who he talks with from the store", async () => {
    const link = await opened();
    const said = "I check the invoice in Exact and then I send it on.";
    const { requests, result } = await answering(
      [
        line(
          "First a few questions about you and AI, then your work. Do you already use AI in your work?"
        ),
        // Nothing was said yet: nothing to write down.
        notes({ facts: [], changes: [] }),
        line("Okay. Which system do you open first?", "no", "steps"),
        notes({
          facts: [
            {
              tag: "step",
              text: "You check the invoice in Exact.",
              record: "Check the invoice in Exact.",
              quote: "I check the invoice in Exact",
            },
          ],
          changes: [],
        }),
      ],
      async () => {
        const start = await eventsOf(
          await ask(link, {
            event: "start",
            locale: "en",
            lines: [],
            facts: [],
            phase: "open",
            minutes: 0,
          })
        );
        const answer = await eventsOf(
          await ask(link, {
            event: "answer",
            locale: "en",
            lines: [
              {
                from: "stephen",
                text: "Do you already use AI in your work?",
              },
              { from: "person", text: said, typed: true },
            ],
            facts: [],
            phase: "steps",
            minutes: 4,
          })
        );
        return { start, answer };
      }
    );
    const brief = JSON.stringify(requests[0]?.body);
    expect({
      started: turnOf(result.start)?.say,
      startedEarly: result.start.some((event) => "line" in event),
      answered: turnOf(result.answer),
      models: requests.map(modelOf),
      toldName: brief.includes("You talk with: Oli, Ops."),
      noLead: brief.includes('say \\"I was told\\" instead'),
    }).toStrictEqual({
      started:
        "First a few questions about you and AI, then your work. Do you already use AI in your work?",
      startedEarly: true,
      answered: {
        say: "Okay. Which system do you open first?",
        tone: null,
        phase: "steps",
        facts: [
          {
            tag: "step",
            text: "You check the invoice in Exact.",
            record: "Check the invoice in Exact.",
            quote: "I check the invoice in Exact",
          },
        ],
        changes: [],
        wants: "answer",
        more: false,
        approved: false,
      },
      models: [
        "claude-sonnet-4-5",
        "claude-opus-4-8",
        "claude-sonnet-4-5",
        "claude-opus-4-8",
      ],
      toldName: true,
      noLead: true,
    });
  });

  it("puts a line right that breaks his rules, and leaves out a fact whose words weren't said", async () => {
    const link = await opened();
    const { result } = await answering(
      [
        line(
          "Great answer! Who gets it after you, and why does it wait? Then we go on."
        ),
        notes({
          facts: [
            {
              tag: "number",
              text: "You handle 40 a week.",
              record: "About 40 a week.",
              quote: "forty a week",
            },
          ],
          changes: [{ id: "f9", text: "Unknown.", record: "Unknown." }],
        }),
      ],
      async () =>
        await eventsOf(
          await ask(link, {
            event: "answer",
            locale: "en",
            lines: [{ from: "person", text: "I send it on.", typed: true }],
            facts: [],
            phase: "steps",
            minutes: 5,
          })
        )
    );
    const turn = turnOf(result);
    expect({
      say: turn?.say,
      facts: turn?.facts,
      changes: turn?.changes,
    }).toStrictEqual({
      say: "Who gets it after you?",
      facts: [],
      changes: [],
    });
  });

  it("asks a line the quick model declines once more, of the careful one", async () => {
    const link = await opened();
    const { requests, result } = await answering(
      [
        { text: "", inputTokens: 1500, outputTokens: 1, refused: true },
        line("Which part of it takes longest?"),
        notes({ facts: [], changes: [] }),
      ],
      async () =>
        await eventsOf(
          await ask(link, {
            event: "answer",
            locale: "en",
            lines: [{ from: "person", text: "It is a lot.", typed: true }],
            facts: [],
            phase: "steps",
            minutes: 5,
          })
        )
    );
    expect({
      say: turnOf(result)?.say,
      models: requests.map(modelOf),
    }).toStrictEqual({
      say: "Which part of it takes longest?",
      models: ["claude-sonnet-4-5", "claude-opus-4-8", "claude-opus-4-8"],
    });
  });

  it("writes nothing down while he waits for the rest of what they say", async () => {
    const link = await opened();
    const { requests, result } = await answering(
      [line("", "yes", "steps")],
      async () =>
        await eventsOf(
          await ask(link, {
            event: "answer",
            locale: "en",
            lines: [{ from: "person", text: "And then I", typed: true }],
            facts: [],
            phase: "steps",
            minutes: 5,
          })
        )
    );
    expect({
      turn: turnOf(result),
      sent: requests.length,
    }).toMatchObject({ turn: { say: "", more: true, facts: [] }, sent: 1 });
  });

  it("cuts a turn given up halfway off at once, and counts what it took", async () => {
    const link = await opened();
    const before = await countedFor(quick);
    const reached = Promise.withResolvers<null>();
    const held = Promise.withResolvers<null>();
    const { requests } = await answering(
      [
        {
          ...line("Okay. And who checks it after you?"),
          pause: {
            at: 18,
            until: held.promise,
            reached: () => {
              reached.resolve(null);
            },
          },
        },
      ],
      async () => {
        const response = await ask(link, {
          event: "answer",
          locale: "en",
          lines: [{ from: "person", text: "I check it.", typed: true }],
          facts: [],
          phase: "steps",
          minutes: 5,
        });
        await reached.promise;
        // They talked on: the page gives the turn up.
        await response.body?.cancel();
        await vi.waitFor(
          async () => {
            const now = await countedFor(quick);
            if (now.calls === before.calls) {
              throw new Error("Not counted yet");
            }
          },
          { timeout: 10_000, interval: 100 }
        );
        return null;
      }
    );
    const after = await countedFor(quick);
    expect({
      cutOff: requests[0]?.signal.aborted,
      calls: after.calls - before.calls,
      read: after.tokensIn - before.tokensIn,
    }).toStrictEqual({ cutOff: true, calls: 1, read: 1500 });
  });

  it("gives no turn to a link that opens nothing, or to a device that isn't the link's", async () => {
    const link = await opened();
    const turn: Turn = {
      event: "start",
      locale: "en",
      lines: [],
      facts: [],
      phase: "open",
      minutes: 0,
    };
    const { requests, result } = await answering([], async () => ({
      unknown: await codeOf(
        await ask({ secret: "a".repeat(43), key: link.key }, turn)
      ),
      elsewhere: await codeOf(
        await ask({ secret: link.secret, key: "b".repeat(43) }, turn)
      ),
      // The page can't say who it is with.
      named: await codeOf(
        await routed(interviewTurnPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...link, ...turn, name: "Someone else" }),
        })
      ),
    }));
    expect({ ...result, sent: requests.length }).toStrictEqual({
      unknown: [404, "interview.link_invalid"],
      elsewhere: [403, "interview.elsewhere"],
      named: [400, "interview.invalid"],
      sent: 0,
    });
  });
});
