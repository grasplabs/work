import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { adminSnapshot } from "./admin-steering.ts";
import { test } from "./csp.ts";
import {
  answered,
  back,
  changed,
  first,
  invited,
  personIn,
  readBack,
  speechSchema,
  streamed,
  turnOf,
  wavOf,
} from "./interview-turns.ts";
import { signInStaff } from "./people.ts";

// Someone's own interview, end to end (GRA-345, GRA-346, GRA-382): they
// open their link, choose their language and who they talk with, read what
// this is, answer by typing, stop for now and carry on, put a line of the
// read-back right, agree to it, and the interview is agreed in the store.
// Another goes through the screens before it in Dutch and chooses Claire,
// whose text and voice every turn then uses. A third talks: Stephen says
// his line a sentence at a time, starting before all of it is written, its
// words lighting up as he says them.
// The local stack reaches no model, so Stephen's turns are the browser's
// (e2e/interview-turns.ts). The stack has no voice either: what the page
// asks of `/api/speech` is noted and refused, so each line lights up
// without sound; where a test hears Stephen, it is answered with silence
// the length of the line. Its
// own Playwright project, after the onboarding's (playwright.config.ts):
// sending a link tells the team, and nothing undoes that.

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
  await expect.poll(async () => await personIn(person)).toBe("incomplete");
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

  // Core keeps it agreed to: both lines, as they were put right. Grasp's
  // admin sees its numbers, never its words (GRA-329).
  await expect
    .poll(async () => {
      const { interviews } = await adminSnapshot();
      const kept = interviews.find((interview) => interview.person === person);
      return { agreed: kept?.agreed, facts: kept?.facts };
    })
    .toStrictEqual({ agreed: true, facts: 2 });
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
  await expect
    .poll(async () => {
      const { interviews } = await adminSnapshot();
      return interviews.find((interview) => interview.person === person)
        ?.interviewer;
    })
    .toBe("claire");
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

  // While he talks, the box is a voice bar; once he asks, the bar listens to them.
  await expect(page.getByText("Stephen is talking")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Type instead" })
  ).toBeVisible();
  await expect(page.getByText(line)).toBeVisible();
  await expect(page.getByText("Listening", { exact: true })).toBeVisible({
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
