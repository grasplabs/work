import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { expect } from "@playwright/test";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import { z } from "zod";

import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// An interview by voice, end to end (GRA-383): someone talks with Stephen
// through the browser's fake microphone, which plays a recording of a
// voice in stretches, over and over: a second of speaking, then three of
// quiet. Stephen answers when they are done, talking over him drops the
// answer on its way, and it runs to the read-back, where their yes agrees
// to it. Every answer is measured from their last word to his first sound,
// and the middle one is noted against the prototype's 2.3 seconds.
//
// The local stack reaches no model, no voice and no transcription, so
// those three are the browser's here, faked at their edges: the turns
// (`/api/interview/turn`) are checked against what core takes and answered
// as core would; each line asked to be said comes back as silence the
// length of its words; the live line (`/api/transcription`) answers each
// closed stretch with the next of the person's answers, as the relay does
// (GRA-932's protocol), and so does the recording's way
// (`/api/interview/hear`). Everything else is the page's own: the ear
// hearing the recording, turn-taking, and his voice playing.

/** A WAV of 16-bit mono samples at `rate`, each from -1 to 1. */
const wavOf = (rate: number, samples: number[]): Buffer => {
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

const rate = 16_000;
/** How long they speak, and are then quiet, in seconds: the recording's one round. */
const speakingSeconds = 1;
const quietSeconds = 3;

/**
 * A voice as the microphone hears it: a tone that wavers, its loudness
 * rising and falling with each syllable, four a second.
 */
const voiceAt = (at: number): number => {
  const seconds = at / rate;
  if (seconds >= speakingSeconds) {
    return 0;
  }
  const syllables = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * seconds);
  const pitch = 180 + 30 * Math.sin(2 * Math.PI * 3 * seconds);
  return 0.4 * syllables * Math.sin(2 * Math.PI * pitch * seconds);
};

/** The recording the fake microphone plays, round after round. Written before the browser starts. */
const voiceFile = path.join(os.tmpdir(), "grasp-e2e-spoken-interview.wav");
writeFileSync(
  voiceFile,
  wavOf(
    rate,
    Array.from({ length: (speakingSeconds + quietSeconds) * rate }, (_, at) =>
      voiceAt(at)
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

/** What the page asks to have said: the line. */
const speechSchema = z.object({ text: z.string() });

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

/** What the person says, in order: each closed stretch is written down as the next. */
const answers = [
  "I handle the invoices that come in.",
  "First I check the invoice in Exact.",
  "Then I send it to Sam for approval.",
  "That takes about ten minutes.",
  "Yes, that's correct.",
];

const first = "Hi Ines, I'm Stephen, an AI. What do you do most?";
const second = "What do you do first with an invoice?";
/** The answer under way when they talk on: never said. */
const dropped = "Who checks it after you?";
const third = "And how long does that take?";
const readBack = "Thank you. Let me read back what I wrote down.";
/** The answer that is held back long enough for them to talk on. */
const heldAnswer = 2;
const heldMs = 6000;

/** The prototype's middle wait from their last word to his first sound, in ms. */
const prototypeMs = 2300;

const turnOf = (more: Partial<StephenTurn>): StephenTurn => ({
  say: "",
  tone: null,
  phase: "you",
  facts: [],
  changes: [],
  wants: "answer",
  more: false,
  approved: false,
  ...more,
});

/** A turn as core streams it: his line, where it goes, then the whole turn. */
const streamed = (turn: StephenTurn): string => {
  const events: TurnEvent[] = [
    { line: { say: turn.say, tone: turn.tone } },
    { next: { phase: turn.phase, wants: turn.wants } },
    { turn },
  ];
  return events.map((event) => JSON.stringify(event)).join("\n");
};

/** What Stephen answers the `n`th answer of theirs, as the models would. */
const answerTo = (asked: InterviewTurnRequest, n: number): StephenTurn => {
  if (asked.event === "start") {
    return turnOf({ say: first });
  }
  if (n === 1) {
    return turnOf({ say: second, phase: "steps" });
  }
  if (n === heldAnswer) {
    return turnOf({ say: dropped, phase: "steps" });
  }
  if (n === 3) {
    return turnOf({ say: third, phase: "numbers" });
  }
  return turnOf({
    say: readBack,
    phase: "result",
    wants: "readback",
    facts: [
      {
        tag: "system",
        text: "You check the invoice in Exact.",
        record: "Check the invoice in Exact.",
        quote: "",
      },
      {
        tag: "handoff",
        text: "You send it to Sam for approval.",
        record: "Send it to Sam for approval.",
        quote: "",
      },
    ],
  });
};

/** Someone in a team of their own, with their interview link out; their link's path. */
const invited = async (staff: Person, person: string): Promise<string> => {
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [{ id: `team-${person}`, name: "Finance", lead: null }],
      people: [{ id: person, name: "Ines", team: `team-${person}` }],
    });
    await api.onboarding.savePlan({ start: today() });
    await api.onboardingStaff.setAgreements({
      processing: true,
      assessment: true,
      council: "none",
    });
  } finally {
    core[Symbol.dispose]();
  }
  return await interviewLinkOf(person);
};

/** What the page asked of the fakes. */
interface Asked {
  /** Turns core would refuse. */
  refused: unknown[];
  /** What they said, as each answer turn carried it. */
  answered: string[];
  /** Each line asked to be said. */
  said: string[];
  /** How long they waited for his voice, as each turn told core, for staff. */
  waited: number[];
}

const wordMs = 300;

/** A WAV of `seconds` of silence: 8 kHz. */
const silence = (seconds: number): Buffer =>
  wavOf(
    8000,
    Array.from({ length: Math.round(seconds * 8000) }, () => 0)
  );

/** What the person said next: the answer after those the turns carried so far. */
const nextAnswer = (asked: Asked): string =>
  answers[Math.min(asked.answered.length, answers.length - 1)] ?? "";

/** Stephen's turns, as core would answer them; the held one after a while. */
const fakeTurns = async (page: Page, asked: Asked): Promise<void> => {
  await page.route("**/api/interview/turn", async (route: Route) => {
    const turn = interviewTurnRequestSchema.safeParse(
      route.request().postDataJSON()
    );
    if (!turn.success) {
      asked.refused.push(turn.error.issues);
      await route.fulfill({ status: 400, body: "{}" });
      return;
    }
    if (turn.data.event !== "start") {
      asked.answered.push(turn.data.lines.at(-1)?.text ?? "");
    }
    if (turn.data.waited !== undefined) {
      asked.waited.push(turn.data.waited);
    }
    const n = asked.answered.length;
    if (n === heldAnswer) {
      await wait(heldMs);
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: streamed(answerTo(turn.data, n)),
      });
    } catch {
      // The page gave it up: they talked on.
    }
  });
};

/** His voice, as silence the length of each line's words. */
const fakeVoice = async (page: Page, asked: Asked): Promise<void> => {
  await page.route("**/api/speech", async (route: Route) => {
    const { text } = speechSchema.parse(route.request().postDataJSON());
    asked.said.push(text);
    const words = text.split(/\s+/u).map((word, at) => ({
      text: word,
      startMs: at * wordMs,
      endMs: (at + 1) * wordMs,
    }));
    await route.fulfill({
      json: {
        audio: silence((words.length * wordMs) / 1000).toString("base64"),
        mime: "audio/wav",
        words,
      },
    });
  });
};

/** The relay's answers on the live line: ready, then each closed stretch's words. */
const relay =
  (asked: Asked) =>
  (socket: WebSocketRoute): void => {
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        return;
      }
      const frame = z
        .object({ type: z.string() })
        .safeParse(JSON.parse(message));
      if (!frame.success) {
        return;
      }
      if (frame.data.type === "start") {
        socket.send(
          JSON.stringify({
            type: "ready",
            session: crypto.randomUUID(),
            maxSeconds: 900,
          })
        );
      } else if (frame.data.type === "commit") {
        socket.send(
          JSON.stringify({ type: "final", text: nextAnswer(asked), words: [] })
        );
      }
    });
  };

/** Each event the loop tells, kept from the page's first moment. */
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

/** What the loop told, as far as this test reads it. */
const toldSchema = z.array(
  z.union([
    z.object({
      measured: z.object({ by: z.string() }),
      waited: z.number().nullable(),
    }),
    z.object({
      did: z.object({
        type: z.string(),
        turn: z.number().optional(),
        text: z.string().optional(),
      }),
    }),
    z.object({ happened: z.object({ type: z.string() }) }),
  ])
);

/** The middle one of `values`, smallest first. */
const middleOf = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] ?? 0;
};

test("an interview by voice: he answers when they are done, drops his answer when they talk on, and reads back", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `ines-${run}`;
  const link = await invited(staff, person);
  const asked: Asked = { refused: [], answered: [], said: [], waited: [] };
  await fakeTurns(page, asked);
  await fakeVoice(page, asked);
  await page.routeWebSocket("**/api/transcription", relay(asked));
  await page.route("**/api/interview/hear", async (route: Route) => {
    await route.fulfill({ json: { heard: nextAnswer(asked) } });
  });
  await watchLoop(page);

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

  // Nobody types: it runs to the read-back by voice, and their yes agrees to it.
  await expect(page.getByText(readBack)).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByRole("heading", { name: "Thank you, Ines." })
  ).toBeVisible({ timeout: 90_000 });

  const told = toldSchema.parse(
    await page.evaluate((): unknown => Reflect.get(window, "loopEvents"))
  );
  const did = told.flatMap((event) => ("did" in event ? [event.did] : []));
  const dropTurns = new Set(
    did.flatMap(({ type, turn }) =>
      type === "drop" && turn !== undefined ? [turn] : []
    )
  );
  const askedAgain = did.filter(
    ({ type, turn }) =>
      type === "ask" && turn !== undefined && dropTurns.has(turn - 1)
  );
  const waits = told.flatMap((event) =>
    "measured" in event && event.waited !== null ? [event.waited] : []
  );
  const middle = middleOf(waits);
  testInfo.annotations.push({
    type: "first sound",
    description: `middle ${middle} ms over ${waits.length} answers (${waits.join(", ")} ms); the prototype's was ${prototypeMs} ms`,
  });

  expect({
    refused: asked.refused,
    // The answer under way when they talked on was dropped, never said, and asked again with all they said.
    dropped: dropTurns.size > 0,
    neverSaid: asked.said.filter((text) => text === dropped),
    talkedOn: askedAgain.some(
      ({ text = "" }) => answers.filter((one) => text.includes(one)).length > 1
    ),
    // He didn't listen to himself, nor during the read-back: what was answered is what they said.
    heard: asked.answered.filter(
      (text) => !answers.some((one) => text.includes(one))
    ),
    readBack: asked.said.includes("Is that correct?"),
    measured: waits.length >= 3,
    // Core is told each wait with the next turn, and keeps it for staff.
    kept: asked.waited.length >= 2,
    faster: middle < prototypeMs,
  }).toStrictEqual({
    refused: [],
    dropped: true,
    neverSaid: [],
    talkedOn: true,
    heard: [],
    readBack: true,
    measured: true,
    kept: true,
    faster: true,
  });
});
