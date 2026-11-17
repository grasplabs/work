import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { interviewApiPath } from "@grasp-os/shared/interview-links";
import { interviewTurnRequestSchema } from "@grasp-os/shared/interview-turn";
import { expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { adminSnapshot } from "./admin-steering.ts";
import { test } from "./csp.ts";
import {
  adding,
  addressOf,
  answerTo,
  answered,
  back,
  changed,
  first,
  invited,
  personIn,
  readBack,
  signedInFor,
  speechSchema,
  streamed,
  turnOf,
  wavOf,
} from "./interview-turns.ts";
import { signInStaff } from "./people.ts";
import { origin } from "./stack.ts";

// Someone's own interview, end to end (GRA-345, GRA-346, GRA-382,
// GRA-1790): they open their link, sign in with the company's sign-in and
// are back on it, choose their language and who they talk with, read what
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

  // They sign in with the company's sign-in, told first that it records
  // it, and come back to their interview (GRA-1790).
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Sign in to open your interview" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "Signing in is recorded by your company's sign-in, as every sign-in is."
    )
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^Sign in with /u })
    .first()
    .click();
  await page.getByLabel("Email").fill(addressOf(person));
  await page.getByRole("button", { name: "Sign in" }).click();
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
  const words = lines.getByRole("button", { name: /^Change: /u });
  await expect(words).toHaveText([
    "You check the invoice in Exact.",
    "You send it to Sam.",
  ]);
  // How the work runs starts out shared with the team, each line its own to move.
  await expect(
    lines.getByRole("button", { name: "Shared with your team as how you work" })
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Change: You send it to Sam." })
    .click();
  const field = page.getByLabel("Change: You send it to Sam.");
  await field.fill("You send it to Kim.");
  await field.press("Enter");
  await expect(page.getByText(changed)).toBeVisible();
  await expect(words).toHaveText([
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

/**
 * Holds back core's answer to `page`'s next save, which core still takes:
 * `taken` once it has, and `release` lets the answer go (to a page gone
 * by then, which never hears it). As a save whose answer is lost when
 * the page closes, or is still on its way.
 */
const holdNextSave = async (page: Page) => {
  const taken = Promise.withResolvers<null>();
  const released = Promise.withResolvers<null>();
  let holding = true;
  await page.route(`**${interviewApiPath}`, async (route: Route) => {
    const body = route.request().postData() ?? "";
    if (!holding || !body.includes('"action":"save"')) {
      await route.fallback();
      return;
    }
    holding = false;
    const response = await route.fetch();
    taken.resolve(null);
    await released.promise;
    // The page that asked is gone: nobody takes the answer.
    await route.fulfill({ response }).catch(() => null);
  });
  return {
    taken: taken.promise,
    release: () => {
      released.resolve(null);
    },
  };
};

/**
 * Holds the next page's opening read (`session`) until `open`: the save
 * the page sends as it goes leaves at `pagehide`, out of the test's sight,
 * and the next page's read could reach core first.
 */
const holdOpening = async (page: Page): Promise<() => void> => {
  const opened = Promise.withResolvers<null>();
  await page.route(`**${interviewApiPath}`, async (route: Route) => {
    if ((route.request().postData() ?? "").includes('"action":"session"')) {
      await opened.promise;
    }
    await route.fallback();
  });
  return () => {
    opened.resolve(null);
  };
};

/** The interview core keeps on `link`, read as `page`'s person, as JSON. */
const keptOn = async (page: Page, link: string): Promise<string> => {
  const response = await page.request.post(`${origin}${interviewApiPath}`, {
    data: { action: "session", secret: link.split("#")[1] ?? "" },
    headers: { origin, "sec-fetch-site": "same-origin" },
  });
  return await response.text();
};

/**
 * Core's answer that it kept a save of `page`'s whose progress holds
 * `holds`. The page keeps each change a moment after it, or as it goes,
 * and "Saved" shows until a save takes long: a reload before core kept
 * the change races the page's last save against the next page's read.
 */
const keptWith = async (page: Page, holds: string): Promise<void> => {
  await page.waitForResponse(async (response) => {
    const request = response.request();
    if (
      new URL(response.url()).pathname !== interviewApiPath ||
      request.method() !== "POST" ||
      !(request.postData() ?? "").includes(holds)
    ) {
      return false;
    }
    const answer: unknown = await response.json();
    return z.object({ saved: z.literal(true) }).safeParse(answer).success;
  });
};

test("someone removes a line of theirs and takes out what was written from it, and neither is said to anyone again", async ({
  page,
}) => {
  const staff = await signInStaff();
  const run = crypto.randomUUID().slice(0, 8);
  const person = `ria-${run}`;
  const link = await invited(staff, person, "Ria");
  const asked = await answered(page);
  const written = `You check ${run} in Exact.`;
  // Their first answer is written down with their words in it; every
  // other turn as Stephen answers it.
  let answers = 0;
  await page.route("**/api/interview/turn", async (route: Route) => {
    const turn = interviewTurnRequestSchema.parse(
      route.request().postDataJSON()
    );
    const reply = answerTo(turn);
    answers += turn.event === "answer" ? 1 : 0;
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: streamed(
        turn.event === "answer" && answers === 1
          ? {
              ...reply,
              facts: reply.facts.map((fact, at) =>
                at === 0 ? { ...fact, text: written, record: written } : fact
              ),
            }
          : reply
      ),
    });
  });
  // What each turn tells core they said, to look for their words in.
  const told: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/interview/turn")) {
      told.push(request.postData() ?? "");
    }
  });

  await signedInFor(page, addressOf(person));
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Stephen", exact: true }).click();
  await page
    .getByRole("button", { name: "Type instead, without sound" })
    .click();
  await expect(page.getByText(first)).toBeVisible();
  const answer = page.getByLabel("Your answer");
  await answer.fill(`Only Ria knows ${run}, in Exact.`);
  // The save after their answer lands in core, but its answer is still on
  // its way when they remove their line and the page goes.
  const lastSave = await holdNextSave(page);
  await answer.press("Enter");
  await expect(page.getByText(readBack)).toBeVisible();
  await lastSave.taken;

  // Their own line, in the transcript only they read, removed once confirmed.
  await page.getByRole("button", { name: "Transcript" }).click();
  const transcript = page.getByRole("complementary", { name: "Transcript" });
  await transcript
    .getByRole("button", { name: `Remove your line: Only Ria knows ${run},` })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(transcript.getByText("Removed.")).toBeVisible();
  await expect(transcript.getByText(run)).toHaveCount(0);

  // Kept removed by core, though the page went before it heard of its last
  // save: after a reload, the transcript shows it removed.
  const open = await holdOpening(page);
  await page.reload();
  lastSave.release();
  // What the page sent as it went is kept: core's copy has the line removed.
  await expect
    .poll(async () => await keptOn(page, link))
    .toContain('"removed":true');
  open();
  await page.getByRole("button", { name: "Transcript" }).click();
  await expect(transcript.getByText("Removed.")).toBeVisible();
  await page.getByRole("button", { name: "Transcript" }).click();

  // What was written down from it is taken out of the read-back; the next
  // turn, asked as they put another line right, carries neither.
  const before = told.length;
  await page.getByRole("button", { name: `Take out: ${written}` }).click();
  await page
    .getByRole("button", { name: "Change: You send it to Sam." })
    .click();
  const field = page.getByLabel("Change: You send it to Sam.");
  await field.fill("You send it to Kim.");
  await field.press("Enter");
  await expect(page.getByText(changed)).toBeVisible();
  await page.getByRole("button", { name: "The rest is correct" }).click();
  await expect(
    page.getByRole("heading", { name: "Thank you, Ria." })
  ).toBeVisible();

  // Back from the same tab to add something: what they add is written down
  // and kept, and what was erased doesn't come back.
  await page.getByRole("button", { name: "Add something" }).click();
  // He asks what they'd like to add before they answer.
  await expect(page.getByText(adding)).toBeVisible();
  const more = page.getByLabel("Your answer");
  await more.fill("Then I book it in Exact.");
  const added = keptWith(page, "You check the invoice in Exact.");
  await more.press("Enter");
  await expect(page.getByText(readBack)).toBeVisible();
  await expect(page.getByText("You check the invoice in Exact.")).toBeVisible();
  await expect(page.getByText("Saved")).toBeVisible();
  await added;
  await page.reload();
  await expect(page.getByText("You check the invoice in Exact.")).toBeVisible();
  expect({
    asked: told.length > before,
    shown: await page.getByText(run).count(),
    told: told.slice(before).some((body) => body.includes(run)),
    refused: asked.refused,
  }).toStrictEqual({ asked: true, shown: 0, told: false, refused: [] });
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
  await signedInFor(page, addressOf(person));
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
  await signedInFor(page, addressOf(person));
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
