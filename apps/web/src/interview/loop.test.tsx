// @vitest-environment happy-dom
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { i18n } from "@lingui/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { holdInterview, progressNow, releaseInterview } from "./kept.ts";
import {
  agreeToPart,
  changeLine,
  goOn,
  sendTyped,
  setLoopWords,
  startLoop,
  stopLoop,
  useLoop,
} from "./loop.ts";
import type { LoopState } from "./loop.ts";
import type { LoopWords } from "./words.ts";

// The interview as it runs (loop.ts), against core faked as `fetch`
// answers it. No conversation with the agent is joined here: what is
// tried is what the page does around one. When core opens none, the page
// says why, as core said it, offers to try again only where that can
// help, and asks for nothing else in its place. In the read-back, what
// they put right goes to core's notes as an answer with the lines read
// back; a line changed on screen names that line and its new words; and
// one core couldn't write down is said, kept, and written down before
// they can agree.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const words: LoopWords = {
  locale: "en",
  question: "Is that correct?",
  yes: "Yes, that’s correct.",
  summary: "Summary",
  summaryIntro: "I’ve put together a summary.",
  summaryAsk: "Does that capture it well?",
  addedAsk: "Does this new part look right?",
  added: "This is what is new.",
  opening: () => "Hi.",
  welcomeBack: "Welcome back.",
  backNote: "Back.",
  farewell: () => "Thanks so much.",
  agrees: /^(?:yes|correct)[\s.!]*$/iu,
  changed: (was, now) => `Change “${was}” to “${now}”.`,
  unheard: "I could not hear that.",
  notStarted: "The interview could not start. Try again.",
  dropped: "The conversation with Stephen was cut off.",
  notNoted: "What you said could not be written down yet.",
  voiceSpent: "You have talked as long as you can today.",
};

/** Someone who types, about to start. */
const starting: InterviewProgress = {
  person: "progress",
  told: true,
  mode: "type",
  lines: [],
  facts: [],
  phase: "open",
  wants: "answer",
  startedAt: 1,
  confirmed: 0,
  adding: false,
  addedAt: 0,
};

/** Someone who types, at the read-back of two lines. */
const reading: InterviewProgress = {
  ...starting,
  lines: [
    { from: "stephen", text: "What do you do with an invoice?" },
    { from: "person", text: "I check it, then it waits two days." },
  ],
  facts: [
    {
      id: "f1",
      tag: "step",
      text: "You check the invoice.",
      record: "Check the invoice.",
    },
    {
      id: "f2",
      tag: "wait",
      text: "It waits two days.",
      record: "The invoice waits 2 days.",
    },
  ],
  phase: "readback",
  wants: "readback",
};

/** What the page asked of the live conversation's endpoint, as far as it is read here. */
const voiceAsked = z.looseObject({ action: z.string() });
type VoiceAsked = z.output<typeof voiceAsked>;

let root: Root | undefined;

/** What the page would show of the conversation: what he does, and what stands in the bar at the top. */
const Probe = () => {
  const loop = useLoop();
  return (
    <output data-doing={loop.doing}>{JSON.stringify(loop.trouble)}</output>
  );
};

const troubleSchema = z
  .object({ message: z.string(), again: z.boolean() })
  .nullable();

/** What the probe shows now. */
const seen = (): Pick<LoopState, "doing" | "trouble"> => {
  const shown = document.querySelector("output");
  return {
    doing: z
      .enum(["idle", "speaking", "listening", "thinking"])
      .parse(shown?.dataset.doing),
    trouble: troubleSchema.parse(JSON.parse(shown?.textContent ?? "null")),
  };
};

/** Does `what`, then moves the page's clock on `ms`: React's updates and whatever waits on a promise are flushed. */
const doing = async (what: () => void, ms = 0): Promise<void> => {
  await act(async () => {
    what();
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/**
 * The interview running from `progress`, on a core whose live
 * conversation endpoint answers each request as `voice` says: every
 * request it got, and every other address asked.
 */
const running = async (
  progress: InterviewProgress,
  voice: (asked: VoiceAsked) => Response
) => {
  const asked: VoiceAsked[] = [];
  const others: string[] = [];
  let version = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input,
        "https://acme.test"
      );
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}"
      );
      if (url.pathname === "/api/interview/voice") {
        const request = voiceAsked.parse(body);
        asked.push(request);
        return await Promise.resolve(voice(request));
      }
      if (url.pathname === "/api/interview") {
        const { action } = voiceAsked.parse(body);
        version += 1;
        return Response.json(
          action === "approve"
            ? { approved: true, receipt: "receipt", at: "2026-11-26T10:00:00Z" }
            : { saved: true, version }
        );
      }
      others.push(url.pathname);
      return new Response(null, { status: 404 });
    })
  );
  holdInterview({ secret: "s".repeat(43), kind: "own", version: 1, progress });
  const mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => {
    root?.render(<Probe />);
    await Promise.resolve();
  });
  await doing(() => {
    setLoopWords(words);
    startLoop();
  });
  return { asked, others };
};

/** Why core opened no conversation, as its voice endpoint says it. */
const refusal = (error: string, status: number): Response =>
  Response.json({ error, status }, { status });

/** What core's notes wrote down from a correction. */
const noted = (changes: unknown[]): Response =>
  Response.json({
    noted: 1,
    turn: { facts: [], changes, phase: "readback" },
  });

describe("the interview as it runs", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // What the conversation is joined over: this page only gets as far as asking core.
    vi.stubGlobal("RTCPeerConnection", vi.fn());
  });

  afterEach(async () => {
    await act(async () => {
      stopLoop({ keep: false });
      root?.unmount();
      await Promise.resolve();
    });
    root = undefined;
    releaseInterview();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("says why core opened no conversation, as core said it, and offers no way to try again when the day's budget is spent", async () => {
    const spent =
      "That is as long as the interview can run today. Come back tomorrow to go on.";
    const { asked, others } = await running(starting, () =>
      refusal(spent, 429)
    );
    expect({
      asked: asked.map(({ action, event }) => ({ action, event })),
      trouble: seen().trouble,
      doing: seen().doing,
      // Nothing else is asked in its place.
      others,
    }).toStrictEqual({
      asked: [{ action: "open", event: "start" }],
      trouble: { message: spent, again: false },
      doing: "idle",
      others: [],
    });
  });

  it("offers to try again when the conversation could not start, and opens it again when they do", async () => {
    const { asked } = await running(starting, () =>
      refusal("The interview could not start. Try again.", 503)
    );
    const first = seen().trouble;
    await doing(goOn);
    expect({
      first,
      asked: asked.map(({ action, event }) => ({ action, event })),
      still: seen().trouble?.again,
    }).toStrictEqual({
      first: {
        message: "The interview could not start. Try again.",
        again: true,
      },
      asked: [
        { action: "open", event: "start" },
        { action: "open", event: "start" },
      ],
      still: true,
    });
  });

  it("sends what they type in the read-back to core's notes as an answer to the lines read back, and keeps what comes back", async () => {
    const { asked } = await running(reading, () =>
      noted([
        {
          id: "f2",
          text: "It waits three days.",
          record: "The invoice waits 3 days.",
        },
      ])
    );
    await doing(() => {
      sendTyped("No, it waits three days.");
    });
    const now = progressNow();
    expect({
      asked,
      line: now.lines.at(-1),
      fact: now.facts.find(({ id }) => id === "f2"),
      trouble: seen().trouble,
      doing: seen().doing,
    }).toMatchObject({
      asked: [
        {
          action: "answer",
          phase: "readback",
          noted: 0,
          reading: ["f1", "f2"],
          before: [
            { from: "stephen", text: "What do you do with an invoice?" },
            { from: "person", text: "I check it, then it waits two days." },
          ],
          said: [
            { from: "person", text: "No, it waits three days.", typed: true },
          ],
        },
      ],
      line: { from: "person", text: "No, it waits three days.", typed: true },
      fact: {
        text: "It waits three days.",
        record: "The invoice waits 3 days.",
      },
      trouble: null,
      // Their turn again: he says nothing more about it.
      doing: "listening",
    });
    // No conversation is open in the read-back: nothing is opened, and no pass is sent.
    expect(asked[0]).not.toHaveProperty("pass");
  });

  it("agrees to a part on a plain yes without asking core anything", async () => {
    const { asked } = await running(reading, () => noted([]));
    await doing(() => {
      sendTyped("Yes.");
    }, 2000);
    expect({ asked, person: progressNow().person }).toStrictEqual({
      asked: [],
      person: "completed",
    });
  });

  it("tells core which line they changed on screen and its new words, says so when that can't be written down, and has them agree only once it is", async () => {
    let works = false;
    const { asked } = await running(reading, () =>
      works
        ? noted([
            {
              id: "f1",
              text: "You check the invoice in Exact.",
              record: "Check the invoice in Exact.",
            },
          ])
        : refusal("Stephen could not be reached. Try again.", 502)
    );
    await doing(() => {
      changeLine(
        "f1",
        "You check the invoice.",
        "You check the invoice in Exact."
      );
    });
    const failed = {
      edit: asked[0]?.edit,
      said: asked[0]?.said,
      // Their words stand at once, whatever becomes of the request.
      text: progressNow().facts.find(({ id }) => id === "f1")?.text,
      trouble: seen().trouble,
    };
    // They agree while it is still owed: it is asked for again, and nothing is agreed to.
    await doing(agreeToPart, 2000);
    const owed = { person: progressNow().person, asked: asked.length };
    works = true;
    await doing(goOn, 2000);
    expect({
      failed,
      owed,
      written: progressNow().facts.find(({ id }) => id === "f1")?.record,
      person: progressNow().person,
      trouble: seen().trouble,
    }).toStrictEqual({
      failed: {
        edit: { id: "f1", text: "You check the invoice in Exact." },
        said: [
          {
            from: "person",
            text: "Change “You check the invoice” to “You check the invoice in Exact”.",
            typed: true,
          },
        ],
        text: "You check the invoice in Exact.",
        trouble: { message: words.notNoted, again: true },
      },
      owed: { person: "progress", asked: 2 },
      written: "Check the invoice in Exact.",
      person: "completed",
      trouble: null,
    });
  });
});
