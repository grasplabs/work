import { interviewTurnPath, turnEvents } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { interviewerText } from "../src/onboarding/interviewer-text.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import {
  answering,
  codeOf,
  countedFor,
  modelOf,
  onLink,
  opened,
  openedFor,
  participate,
  quick,
} from "./interview-link.ts";
import type { ProviderReply } from "./model-provider.ts";
import { routed } from "./sign-in.ts";

// One turn of someone's interview (src/onboarding/interview.ts), over the
// endpoint, as the page asks for it. The model provider is the outside
// system: a fake behind connect, answering for the organization's model:
// his line (the quick role) and what he writes down (the careful one). The
// ways it can fail, tried here:
//
// - The page saying who it is or what Stephen knows: the request takes no
//   such field, and the brief holds what the store knows.
// - A line out that breaks his rules, or a fact whose words weren't said.
// - A turn given up halfway going uncounted, or still running.
// - A link that isn't open, or a device that isn't the link's, getting a
//   turn.

type Turn = Omit<
  InterviewTurnRequest,
  "secret" | "key" | "interviewer" | "adding"
> &
  Partial<Pick<InterviewTurnRequest, "interviewer" | "adding">>;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
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
const line = (say: string, more = "no", part = "you"): ProviderReply => ({
  text: `TONE: none\nSAY: ${say}\nPART: ${part}\nWANTS: answer\nMORE: ${more}\nAGREED: no\n`,
  inputTokens: 1500,
  outputTokens: 40,
});

/** What the notes' model answers. */
const notes = (body: unknown): ProviderReply => ({
  text: JSON.stringify(body),
  inputTokens: 1600,
  outputTokens: 120,
});

describe("an interview turn", { timeout: 60_000 }, () => {
  it("holds an interview over the endpoint: his line and what he wrote down from the organization's model, and who he talks with from the store", async () => {
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
      // Both roles resolve to the organization's default.
      models: [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5",
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

  it("asks a line the model declines once more", async () => {
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
      models: ["claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"],
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
    // What it read is counted as far as the provider's count reached core
    // before the cut: through connect, the cut may come first.
    expect({
      cutOff: requests[0]?.signal.aborted,
      sent: requests.length,
      counted: after.calls > before.calls,
    }).toStrictEqual({ cutOff: true, sent: 1, counted: true });
  });

  it("keeps the text a turn ran on, and how long they waited for the voice, for Grasp's staff", async () => {
    const link = await opened();
    await answering(
      [
        line("Okay. And who checks it after you?"),
        notes({ facts: [], changes: [] }),
      ],
      async () =>
        await eventsOf(
          await ask(link, {
            event: "answer",
            interviewer: "claire",
            locale: "de",
            lines: [{ from: "person", text: "Ich prüfe sie." }],
            facts: [],
            phase: "steps",
            minutes: 5,
            waited: 1340,
          })
        )
    );
    const { mark } = await interviewerText("claire", "own", "de");
    const { texts, waits } = await onboardingStore(env).interviewerFacts();
    const today = isoDay(Date.now());
    expect({
      text: texts
        .filter((text) => text.mark === mark)
        .map(({ interviewer, locale }) => ({ interviewer, locale })),
      waits: waits.filter(({ day }) => day === today),
    }).toStrictEqual({
      text: [{ interviewer: "claire", locale: "de" }],
      waits: [{ day: today, upTo: 1400, answers: 1 }],
    });
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

  it("gives no turn to someone who didn't agree to take part, or withdrew (GRA-329, T1, T5)", async () => {
    const { link } = await openedFor({ participating: false });
    const turn: Turn = {
      event: "start",
      locale: "en",
      lines: [],
      facts: [],
      phase: "open",
      minutes: 0,
    };
    const { requests, result } = await answering([], async () => {
      const unagreed = await codeOf(await ask(link, turn));
      await participate(link);
      await onLink({ action: "withdraw", ...link });
      return { unagreed, withdrawn: await codeOf(await ask(link, turn)) };
    });
    expect({ ...result, sent: requests.length }).toStrictEqual({
      unagreed: [403, "interview.not_participating"],
      withdrawn: [410, "interview.withdrawn"],
      sent: 0,
    });
  });
});
