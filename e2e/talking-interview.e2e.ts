import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { interviewHearPath } from "@grasp-os/shared/interview-hear";
import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
} from "@grasp-os/shared/interview-turn";
import {
  transcriptionCommitSchema,
  transcriptionStartSchema,
} from "@grasp-os/shared/voice";
import { expect } from "@playwright/test";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { z } from "zod";

import { test } from "./csp.ts";
import { invited } from "./interview-turns.ts";
import { signInStaff } from "./people.ts";

// Stephen's ears, end to end (GRA-381): someone who chose to talk is heard
// through the browser's fake microphone, which plays a recorded voice over
// and over: a stretch of speech, then a pause long enough to end it. Their
// words show while they talk, all of a stretch's words are there a moment
// after it ends, and they are what Stephen is answered with. With the live
// line blocked, each stretch is written down from its recording instead.
// The stack has no transcription upstream: the live line's socket
// (`/api/transcription`) is answered in the browser as core relays the
// upstream, its frames checked against what core takes; and the
// recording's (`/api/interview/hear`) as core would, once checked it
// carries the link and a recording. Stephen's turns are the browser's, as
// in interview.e2e.ts. Its own file, as the fake microphone is the
// browser's and plays this file's voice.

/** The voice's sample rate, and how long it speaks and then pauses, in seconds. */
const rate = 16_000;
const speaksFor = 1.6;
const pausesFor = 3;

/** A WAV of 16-bit mono samples at `rate`, each from -1 to 1. */
const wavOf = (samples: number[]): Buffer => {
  const data = samples.length * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  for (const [at, sample] of samples.entries()) {
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + at * 2);
  }
  return wav;
};

/** A voice-like sound: a low tone rising and falling a few times a second, as syllables do. */
const voiceAt = (at: number): number => {
  const seconds = at / rate;
  const syllables = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 3 * seconds));
  return 0.45 * syllables * Math.sin(2 * Math.PI * 190 * seconds);
};

/** What the fake microphone hears, over and over: written before the browser starts. */
const voiceFile = path.join(os.tmpdir(), "grasp-e2e-talking.wav");
writeFileSync(
  voiceFile,
  wavOf(
    Array.from({ length: (speaksFor + pausesFor) * rate }, (_, at) =>
      at < speaksFor * rate ? voiceAt(at) : 0
    )
  )
);

test.use({
  launchOptions: {
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${voiceFile}`,
    ],
  },
});

const question =
  "Hi, I'm Stephen, an AI. What do you do first with an invoice?";
const thanks = "Thank you. And after that?";

/** A whole turn of Stephen's, as core streams it last. */
const turnOf = (say: string): string =>
  JSON.stringify({
    turn: {
      say,
      tone: null,
      phase: "you",
      facts: [],
      changes: [],
      wants: "answer",
      more: false,
      approved: false,
    } satisfies StephenTurn,
  });

/** Answers every turn: his question first, then his thanks; gives what each turn was told they said. */
const turns = async (page: Page): Promise<InterviewTurnRequest[]> => {
  const asked: InterviewTurnRequest[] = [];
  await page.route("**/api/interview/turn", async (route: Route) => {
    const turn = interviewTurnRequestSchema.parse(
      route.request().postDataJSON()
    );
    asked.push(turn);
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: turnOf(turn.event === "start" ? question : thanks),
    });
  });
  // No voice on the stack: each line lights up without sound.
  await page.route("**/api/speech", async (route: Route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "speech.unavailable",
        message: "The voice isn't set up for this deployment yet.",
      }),
    });
  });
  return asked;
};

/** What the live line's upstream hears in each stretch, as it gets more of it, and settles at its end. */
const partials = ["I check", "I check the invoice"];
const said = "I check the invoice in Exact.";
/** How long the fake upstream takes to settle a stretch, in ms: about what the real one takes. */
const settleMs = 200;
/** Bytes of a second of 16 kHz 16-bit audio. */
const secondBytes = rate * 2;

/** What the fake live line saw. */
interface Line {
  refused: string[];
  starts: number;
  /** Bytes of audio each stretch sent, in order. */
  stretches: number[];
}

/** A text frame's JSON, or nothing. */
const jsonOf = (message: string | Buffer): unknown => {
  if (typeof message !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
};

/**
 * The live line, as core relays the upstream: `ready` once the page
 * started it with its link, what is heard so far as audio comes in, and
 * the stretch's words a moment after the page commits it.
 */
const liveLine = async (page: Page): Promise<Line> => {
  const line: Line = { refused: [], starts: 0, stretches: [] };
  await page.routeWebSocket(
    "**/api/transcription",
    (socket: WebSocketRoute) => {
      let heard = 0;
      socket.onMessage((message) => {
        if (typeof message !== "string") {
          // Only audio core takes: 16-bit samples, at most 32 KiB a frame.
          if (message.length % 2 !== 0 || message.length > 32 * 1024) {
            line.refused.push(`frame of ${message.length}`);
          }
          heard += message.length;
          const shown =
            partials[
              Math.min(Math.floor(heard / (secondBytes / 2)), partials.length) -
                1
            ];
          if (shown !== undefined) {
            socket.send(JSON.stringify({ type: "partial", text: shown }));
          }
          return;
        }
        const frame = jsonOf(message);
        const start = transcriptionStartSchema.safeParse(frame);
        if (start.success) {
          line.starts += 1;
          if (start.data.link === undefined) {
            line.refused.push("start without a link");
          }
          socket.send(
            JSON.stringify({
              type: "ready",
              session: crypto.randomUUID(),
              maxSeconds: 900,
            })
          );
          return;
        }
        if (!transcriptionCommitSchema.safeParse(frame).success) {
          line.refused.push(message);
          return;
        }
        line.stretches.push(heard);
        heard = 0;
        setTimeout(() => {
          socket.send(JSON.stringify({ type: "final", text: said, words: [] }));
        }, settleMs);
      });
    }
  );
  return line;
};

/** When, on the page's clock, each commit went out on the live line and each of `words` first showed. */
const timesSchema = z.object({
  commits: z.array(z.number()),
  shown: z.array(z.number()),
});

/** Notes on the page's clock each commit it sends, and when the bubble first shows `words` after one. */
const watchTimes = async (page: Page, words: string): Promise<void> => {
  await page.addInitScript((text: string) => {
    const commits: number[] = [];
    const shown: number[] = [];
    Reflect.set(window, "earTimes", { commits, shown });
    // oxlint-disable-next-line typescript/unbound-method -- called on its own socket below
    const sendOriginal = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(this: WebSocket, data) {
      if (typeof data === "string" && data.includes('"commit"')) {
        commits.push(performance.now());
      }
      Reflect.apply(sendOriginal, this, [data]);
    };
    let showing = false;
    new MutationObserver(() => {
      const now = document.body.textContent?.includes(text);
      if (now && !showing) {
        shown.push(performance.now());
      }
      showing = now;
    }).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, words);
};

/** What the loop tells (`grasp:interview-loop`), as far as this test reads it. */
const loopSchema = z.array(
  z.union([
    z.object({
      happened: z.object({
        type: z.string(),
        at: z.number(),
        stretch: z.number().optional(),
      }),
    }),
    z.object({ did: z.object({ type: z.string() }) }),
  ])
);

/** Notes on `window.loopEvents` what the interview's loop tells. */
const watchLoop = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const told: unknown[] = [];
    // `loopEventName` in apps/web/src/interview/loop.ts.
    window.addEventListener("grasp:interview-loop", (event) => {
      if (event instanceof CustomEvent) {
        told.push(event.detail);
      }
    });
    Object.assign(window, { loopEvents: told });
  });
};

/** The ear kept at most this much of what it heard before a stretch began (ear.ts). */
const keptMs = 1000;

/**
 * The first stretch, in ms on the page's clock: how long it went on, and
 * how much the ear had heard before it began, since it last began to listen.
 */
const heardOf = (
  told: z.infer<typeof loopSchema>
): { span: number; before: number } => {
  const happened = told.flatMap((event) =>
    "happened" in event ? [event.happened] : []
  );
  const start = happened.find(
    ({ type, stretch }) => type === "stretch-start" && stretch === 1
  );
  const end = happened.find(
    ({ type, stretch }) => type === "stretch-end" && stretch === 1
  );
  const listened = happened.findLast(
    ({ type, at }) => type === "listen" && at <= (start?.at ?? 0)
  );
  if (start === undefined || end === undefined || listened === undefined) {
    return { span: Number.NaN, before: Number.NaN };
  }
  return {
    span: end.at - start.at,
    before: Math.min(start.at - listened.at, keptMs),
  };
};

/** Opens the link and starts the interview by talking, through the sound check. */
const startTalking = async (page: Page, link: string): Promise<void> => {
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await page
    .getByRole("button", { name: "Check sound and microphone" })
    .click();
  await page.getByRole("button", { name: "Yes, I can hear you" }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.click();
  await expect(page.getByText(question)).toBeVisible();
};

test("their words show while they talk, and all of them a moment after they stop", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `ada-${run}`;
  const link = await invited(staff, person, "Ada");
  const asked = await turns(page);
  const line = await liveLine(page);
  await watchTimes(page, said);
  await watchLoop(page);

  await startTalking(page, link);

  // While they talk, what is heard so far shows over the bar.
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(partials[0] ?? "")).toBeVisible({
    timeout: 15_000,
  });
  // Then all of it, and Stephen is answered with it, as said, not typed.
  await expect(page.getByText(thanks)).toBeVisible({ timeout: 15_000 });
  const answer = asked.find(({ event }) => event === "answer");
  const times = timesSchema.parse(
    await page.evaluate((): unknown => Reflect.get(window, "earTimes"))
  );
  const commit = times.commits[0] ?? Number.NaN;
  const shown = times.shown.find((at) => at >= commit) ?? Number.NaN;
  const heard = heardOf(
    loopSchema.parse(
      await page.evaluate((): unknown => Reflect.get(window, "loopEvents"))
    )
  );
  expect({
    refused: line.refused,
    started: line.starts >= 1,
    // A stretch goes out with what was heard before it began, up to a
    // second, so it is more than its own voice. Where the voice already
    // ran when he stopped and the ear began to listen, only that much was
    // heard of it: the microphone plays it over and over, whatever he does.
    stretch:
      (line.stretches[0] ?? 0) >=
      ((heard.span + heard.before) / 1000) * secondBytes * 0.8,
    answer: answer?.lines.at(-1),
    inTime: shown - commit <= 500,
  }).toStrictEqual({
    refused: [],
    started: true,
    stretch: true,
    answer: { from: "person", text: said },
    inTime: true,
  });
});

/** What a recording sent to be written down carried. */
const recordingSchema = z.object({
  secret: z.string().min(1),
  key: z.string().min(1),
  locale: z.literal("en"),
  audio: z.number().positive(),
});

test("with the live line blocked, what they said is written down from its recording", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `bo-${run}`;
  const link = await invited(staff, person, "Bo");
  const asked = await turns(page);
  // The live line is refused, every time it is tried.
  await page.routeWebSocket(
    "**/api/transcription",
    (socket: WebSocketRoute) => {
      void socket.close({ code: 1011, reason: "Blocked" });
    }
  );
  const recordings: unknown[] = [];
  await page.route(`**${interviewHearPath}`, async (route: Route) => {
    const request = route.request();
    const body = new Uint8Array(request.postDataBuffer() ?? []);
    const form = await new Response(body, {
      headers: { "content-type": request.headers()["content-type"] ?? "" },
    }).formData();
    const audio = form.get("audio");
    recordings.push({
      secret: form.get("secret"),
      key: form.get("key"),
      locale: form.get("locale"),
      audio: audio instanceof Blob ? audio.size : 0,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ heard: said }),
    });
  });

  await startTalking(page, link);

  await expect(page.getByText(thanks)).toBeVisible({ timeout: 30_000 });
  const answer = asked.find(({ event }) => event === "answer");
  expect({
    recording: recordingSchema.safeParse(recordings[0]).success,
    answer: answer?.lines.at(-1),
  }).toStrictEqual({
    recording: true,
    answer: { from: "person", text: said },
  });
});
