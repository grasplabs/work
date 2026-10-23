import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import type {
  InterviewTurnRequest,
  StephenTurn,
  TurnEvent,
} from "@grasp-os/shared/interview-turn";
import { expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { test } from "./csp.ts";
import { interviewLinkOf } from "./interview-link.ts";
import { apiOf, signInStaff } from "./people.ts";
import type { Person } from "./people.ts";

// Someone's own interview, end to end (GRA-345, GRA-346, GRA-382): they
// open their link, choose their language and who they talk with, read what
// this is, answer by typing, stop for now and carry on, put a line of the
// read-back right, agree to it, and the interview is agreed in the store.
// Another goes through the screens before it in Dutch and chooses Claire,
// whose text and voice every turn then uses. A third talks: Stephen says
// his line a sentence at a time, starting before all of it is written, its
// words lighting up as he says them.
// The local stack reaches no model, so Stephen's turns are the browser's:
// what the page asks of `/api/interview/turn` is checked against what core
// takes, and answered as core would, a line of JSON at a time. Everything
// else, opening the link and keeping what was said, is core's own. The
// stack has no voice either: what the page asks of `/api/speech` is
// noted and refused, so each line lights up without sound; where a test
// hears Stephen, it is answered with silence the length of the line. Its
// own Playwright project, after the onboarding's (playwright.config.ts):
// sending a link tells the team, and nothing undoes that.

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

/**
 * What the browser's fake microphone hears, over and over: half a second
 * of a voice-like tone, then a pause, so it is heard clearly above the
 * room, as someone speaking is. Written before the browser starts.
 */
const voiceFile = path.join(os.tmpdir(), "grasp-e2e-voice.wav");
writeFileSync(
  voiceFile,
  wavOf(
    16_000,
    Array.from({ length: 16_000 }, (_, at) =>
      at < 8000 ? 0.4 * Math.sin((2 * Math.PI * 220 * at) / 16_000) : 0
    )
  )
);

// Sound plays without a press first, and the microphone is allowed without asking.
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

/** What the page asks to have said: the line, and in whose voice (`@grasp-os/shared/voice`). */
const speechSchema = z.object({ text: z.string(), speaker: z.string() });

/** Today, as core's plan reads it (UTC). */
const today = (): string => new Date().toISOString().slice(0, 10);

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

/** The first sentence of a line, sent ahead while the rest is written, as core does (`earlyOpening`): never a question. */
const openingOf = (say: string): string | undefined =>
  /^(?<first>.*?[.!…])\s+\S/u.exec(say)?.groups?.first;

/** A turn as core streams it: the first sentence of his line, his line, where it goes, then the whole turn. */
const streamed = (turn: StephenTurn): string => {
  const opening = openingOf(turn.say);
  const events: TurnEvent[] = [
    ...(opening === undefined
      ? []
      : [{ opening: { say: opening, tone: turn.tone } }]),
    { line: { say: turn.say, tone: turn.tone } },
    { next: { phase: turn.phase, wants: turn.wants } },
    { turn },
  ];
  return events.map((event) => JSON.stringify(event)).join("\n");
};

const first = "Hi, I'm Stephen, an AI. What do you do most?";
const back = "Welcome back. What do you do first with an invoice?";
const readBack = "Thank you. Let me read back what I wrote down.";
const changed = "I put that right. Is that correct?";

/** What Stephen answers each thing that happens, as the models would. */
const answerTo = (asked: InterviewTurnRequest): StephenTurn => {
  const said = asked.lines.at(-1)?.text ?? "";
  switch (asked.event) {
    case "start": {
      return turnOf({ say: first });
    }
    case "resume": {
      return turnOf({ say: back, phase: "steps" });
    }
    case "readback": {
      return turnOf({
        say: changed,
        phase: "readback",
        wants: "readback",
        changes: [
          {
            id: "f2",
            text: "You send it to Kim in finance.",
            record: "Send it to Kim in finance.",
          },
        ],
      });
    }
    case "add":
    case "answer":
    case "file":
    case "nudge": {
      return turnOf({
        say: readBack,
        phase: "result",
        wants: "readback",
        facts: [
          {
            tag: "system",
            text: "You check the invoice in Exact.",
            record: "Check the invoice in Exact.",
            quote: said.includes("in Exact") ? "in Exact" : "",
          },
          {
            tag: "handoff",
            text: "You send it to Sam.",
            record: "Send it to Sam.",
            quote: "",
          },
        ],
      });
    }
    default: {
      return asked.event satisfies never;
    }
  }
};

/** Where `person` stands, as core keeps their interview. */
const personIn = async (
  staff: Person,
  person: string
): Promise<string | undefined> => {
  const { core, api } = apiOf(staff);
  try {
    const { progress } = await api.onboardingStaff.transcript(person);
    return progress?.person;
  } finally {
    core[Symbol.dispose]();
  }
};

/** Someone in a team of their own, with their interview link out; their link's path. */
const invited = async (
  staff: Person,
  person: string,
  name: string
): Promise<string> => {
  const { core, api } = apiOf(staff);
  try {
    await api.onboarding.saveRoster({
      teams: [{ id: `team-${person}`, name: "Finance", lead: null }],
      people: [{ id: person, name, team: `team-${person}` }],
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

/** What the page asked of core's turns and voice, as the stack answers them. */
interface Asked {
  /** Turns core would refuse. */
  refused: unknown[];
  /** Each turn's event, and who was asked to hold it. */
  turns: { event: string; interviewer: string }[];
  /** Each line asked to be said, and in whose voice. */
  said: { text: string; speaker: unknown }[];
}

/** Answers every turn as core would, and refuses every line to be said, as a stack without a voice does. */
const answered = async (page: Page): Promise<Asked> => {
  const asked: Asked = { refused: [], turns: [], said: [] };
  await page.route("**/api/interview/turn", async (route: Route) => {
    const turn = interviewTurnRequestSchema.safeParse(
      route.request().postDataJSON()
    );
    if (!turn.success) {
      asked.refused.push(turn.error.issues);
      await route.fulfill({ status: 400, body: "{}" });
      return;
    }
    asked.turns.push({
      event: turn.data.event,
      interviewer: turn.data.interviewer,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: streamed(answerTo(turn.data)),
    });
  });
  await page.route("**/api/speech", async (route: Route) => {
    const line = speechSchema.safeParse(route.request().postDataJSON());
    asked.said.push(
      line.success
        ? { text: line.data.text, speaker: line.data.speaker }
        : { text: "", speaker: null }
    );
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

test("someone has their interview by typing, carries on after stopping, and agrees to the read-back", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `noor-${run}`;
  const link = await invited(staff, person, "Noor");
  // Every turn the page asks for must be one core takes.
  const asked = await answered(page);

  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Hi Noor, I’m Stephen. I’m an AI, and I work for Grasp.",
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Type instead, without sound" })
    .click();
  await expect(page.getByText(first)).toBeVisible();

  // They stop, and the link carries on where it was, after a reload too.
  await page.getByRole("button", { name: "Stop for now" }).click();
  await expect(page.getByText("Your place is kept.")).toBeVisible();
  await expect
    .poll(async () => await personIn(staff, person))
    .toBe("incomplete");
  await page.reload();
  await expect(page.getByText(back)).toBeVisible();

  const answer = page.getByLabel("Your answer");
  await answer.fill("I check it in Exact, then I send it to Sam.");
  await answer.press("Enter");

  // The read-back, a part at a time: a line put right where it is.
  await expect(page.getByText(readBack)).toBeVisible();
  const lines = page.getByRole("list").filter({ hasText: "Exact" });
  await expect(lines.getByRole("listitem")).toHaveText([
    "You check the invoice in Exact.",
    "You send it to Sam.",
  ]);
  await page
    .getByRole("button", { name: "Change: You send it to Sam." })
    .click();
  const field = page.getByLabel("Change: You send it to Sam.");
  await field.fill("You send it to Kim.");
  await field.press("Enter");
  await expect(page.getByText(changed)).toBeVisible();
  await expect(lines.getByRole("listitem")).toHaveText([
    "You check the invoice in Exact.",
    "You send it to Kim in finance.",
  ]);
  await page.getByRole("button", { name: "Yes, that’s correct" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you, Noor." })
  ).toBeVisible();

  // Core keeps it agreed: what is left in, as it was put right.
  const reader = apiOf(staff);
  try {
    await expect
      .poll(async () => {
        const { progress } =
          await reader.api.onboardingStaff.transcript(person);
        return {
          person: progress?.person,
          facts: progress?.facts.map(({ text, agreed }) => ({ text, agreed })),
        };
      })
      .toStrictEqual({
        person: "completed",
        facts: [
          { text: "You check the invoice in Exact.", agreed: true },
          { text: "You send it to Kim in finance.", agreed: true },
        ],
      });
  } finally {
    reader.core[Symbol.dispose]();
  }
  expect({
    refused: asked.refused,
    events: asked.turns.map(({ event }) => event),
  }).toStrictEqual({
    refused: [],
    events: ["start", "resume", "answer", "readback"],
  });
});

test("someone goes through the screens before the interview in Dutch, chooses Claire, and talks with her", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `lotte-${run}`;
  const link = await invited(staff, person, "Lotte");
  const asked = await answered(page);

  // The device's language is marked; another is one press away, and the question is asked in it.
  await page.goto(link);
  await expect(
    page.getByRole("button", { name: "English", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Nederlands", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "In welke taal wil je dit interview doen?",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Doorgaan" }).click();

  // Stephen and Claire each say who they are, in their own voice; neither is chosen beforehand.
  await expect(
    page.getByText("Kies door wie je geïnterviewd wilt worden.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Claire", exact: true }).click();

  // What this is, with her; then the sound check, said in her voice.
  await expect(
    page.getByRole("heading", {
      name: "Hoi Lotte, ik ben Claire. Ik ben een AI en ik werk voor Grasp.",
    })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Geluid en microfoon testen" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Hoi Lotte, ik ben Claire, een AI. Kun je me horen?",
    })
  ).toBeVisible();
  await expect
    .poll(
      () =>
        asked.said.find(({ text }) => text.endsWith("Kun je me horen?"))
          ?.speaker
    )
    .toBe("claire");
  await page
    .getByRole("button", { name: "Liever typen, zonder geluid" })
    .click();

  // The first turn is hers, and core keeps who was chosen.
  await expect(page.getByText(first)).toBeVisible();
  await expect(
    page.getByText(/^Claire (?<doing>stelt een vraag|luistert|denkt na)\.$/u)
  ).toBeAttached();
  const reader = apiOf(staff);
  try {
    await expect
      .poll(async () => {
        const { progress } =
          await reader.api.onboardingStaff.transcript(person);
        return progress?.interviewer;
      })
      .toBe("claire");
  } finally {
    reader.core[Symbol.dispose]();
  }
  expect({
    refused: asked.refused,
    turns: asked.turns,
    claire: asked.said.find(({ text }) => text === "En ik ben Claire.")
      ?.speaker,
  }).toStrictEqual({
    refused: [],
    turns: [{ event: "start", interviewer: "claire" }],
    claire: "claire",
  });
});

/** A WAV of `seconds` of silence: 8 kHz. */
const silence = (seconds: number): Buffer =>
  wavOf(
    8000,
    Array.from({ length: Math.round(seconds * 8000) }, () => 0)
  );

/** How long each word takes, said here. */
const wordMs = 300;

/** Answers every line asked to be said as core does, with silence the length of its words; what was asked, in order. */
const heard = async (page: Page): Promise<string[]> => {
  const asked: string[] = [];
  await page.route("**/api/speech", async (route: Route) => {
    const line = speechSchema.parse(route.request().postDataJSON());
    asked.push(line.text);
    const words = line.text.split(/\s+/u).map((text, at) => ({
      text,
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
  return asked;
};

/** Each word that lit up on the page, and when, in ms on the page's clock. */
const litSchema = z.array(z.object({ word: z.string(), at: z.number() }));

/** Notes, frame by frame, each word on the stage as it lights up, from the page's first moment. */
const watchWords = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const lit: { word: string; at: number }[] = [];
    const seen = new WeakSet<Element>();
    const look = (): void => {
      for (const word of document.querySelectorAll(
        'main [data-said="saying"], main [data-said="said"]'
      )) {
        if (!seen.has(word)) {
          seen.add(word);
          lit.push({ word: word.textContent.trim(), at: performance.now() });
        }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    Object.assign(window, { litWords: lit });
  });
};

const sentences = [
  "Hi Kai, good to meet you.",
  "I will ask about one piece of your work.",
  "What do you do most?",
];

test("Stephen says his line a sentence at a time, without a gap, its words lighting up as he says them", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `kai-${run}`;
  const link = await invited(staff, person, "Kai");
  await answered(page);
  // His first line has three sentences; core sends the first while the rest is written.
  const line = sentences.join(" ");
  await page.route("**/api/interview/turn", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: streamed(turnOf({ say: line, tone: "warm, relaxed" })),
    });
  });
  const asked = await heard(page);
  await watchWords(page);

  // They hear him, he hears them, and they start talking.
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
  // From here: the sound check's own line may still be ending as Start shows.
  const startedAt = await page.evaluate(() => performance.now());

  // While he talks, the box is a voice bar; once he asks, it is the box to answer in.
  await expect(page.getByText("Stephen is talking")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Type instead" })
  ).toBeVisible();
  await expect(page.getByText(line)).toBeVisible();
  await expect(page.getByLabel("Your answer")).toBeVisible({
    timeout: 30_000,
  });

  // Each sentence was asked for on its own, the first first; each word lit up as it was said, one after another, with no gap between the sentences.
  const words = line.split(" ");
  const lit = litSchema
    .parse(await page.evaluate((): unknown => Reflect.get(window, "litWords")))
    .filter(({ at }) => at > startedAt);
  const firstAt = lit[0]?.at ?? 0;
  expect({
    asked: asked.filter((text) => sentences.includes(text)),
    words: lit.map(({ word }) => word),
    beats: lit.map(({ at }) => Math.round((at - firstAt) / wordMs)),
  }).toStrictEqual({
    asked: sentences,
    words,
    beats: words.map((_, at) => at),
  });
});
