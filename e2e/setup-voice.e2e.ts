import { expect } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// Stephen says each step of the admin's onboarding (apps/web/src/voice):
// with the sound on, each step's line is asked of the voice, the next
// step's ahead of time, and a step's way on comes once it is said; with
// the sound off, nothing is asked and the way on comes once there was time
// to read it. The voice itself is ElevenLabs behind the model gateway,
// which the local stack doesn't reach, so the page's speech requests are
// answered here, with silence the length of the line.

// Sound plays without a press first, as once the admin has clicked their way in.
test.use({
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

/** A WAV of `seconds` of silence: 8 kHz, 16-bit, mono. */
const silence = (seconds: number): Buffer => {
  const rate = 8000;
  const data = Math.round(seconds * rate) * 2;
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
  return wav;
};

/** How long each word takes, said here. */
const wordMs = 60;

interface Asked {
  text: string;
  language: string;
  tone?: string;
  speaker?: string;
}

const askedIn = (request: Request): Asked => {
  const body: unknown = request.postDataJSON();
  if (
    typeof body !== "object" ||
    body === null ||
    !("text" in body) ||
    typeof body.text !== "string" ||
    !("language" in body) ||
    typeof body.language !== "string"
  ) {
    throw new Error("Not a line to say");
  }
  const asked: Asked = { text: body.text, language: body.language };
  if ("tone" in body && typeof body.tone === "string") {
    asked.tone = body.tone;
  }
  if ("speaker" in body && typeof body.speaker === "string") {
    asked.speaker = body.speaker;
  }
  return asked;
};

/** Answers the page's speech requests as core does, and keeps what was asked. */
const answerSpeech = async (page: Page): Promise<Asked[]> => {
  const asked: Asked[] = [];
  await page.route("**/api/speech", async (route) => {
    const line = askedIn(route.request());
    asked.push(line);
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

const sourcesLine =
  "Where does the work get written down? Procedures, handbooks, how-tos. Connect where they live, and I’ll only read what you share with me.";

test("the admin goes through empty steps and back, with the sound on and off", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupVoice");
  const page = await pageOf(admin);
  const asked = await answerSpeech(page);

  // Sound on: the welcome is said warmly, in the page's language.
  await page.goto("/setup?step=welcome");
  await expect(
    page.getByRole("heading", { level: 1, name: /, I’m Stephen$/u })
  ).toBeFocused();
  await expect
    .poll(() =>
      asked.find((line) =>
        line.text.endsWith(
          "Stephen. Before we start, which language do you prefer?"
        )
      )
    )
    .toMatchObject({ language: "en", tone: "warm" });

  // On who's who, the next step's line is fetched ahead.
  await page.goto("/setup?step=company");
  await expect(
    page.getByRole("heading", { name: "Who’s who at your company?" })
  ).toBeVisible();
  await expect
    .poll(() => asked.some((line) => line.text === sourcesLine))
    .toBe(true);

  // Said, the way on comes: past where the documents live, and back.
  await page.goto("/setup?step=sources");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Where does the work get written down?" })
  ).toBeVisible();

  // Pause holds him, and play goes on.
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  // Sound off: kept in this browser, nothing more is asked of the voice,
  // and the way on comes once there was time to read the step.
  await page.getByRole("button", { name: "Turn sound off" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Turn sound on" })
  ).toHaveAttribute("aria-pressed", "false");
  const before = asked.length;
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    page.getByRole("heading", { name: "Which tools do people actually use?" })
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("heading", {
      name: "Do you have anything that explains how you work?",
    })
  ).toBeVisible();
  expect(asked.length).toBe(before);
});

/** "How this works" in Dutch: its second line, a long one, and how it ends. */
const story = {
  second:
    "Ons eerste gesprek gaf me het grote plaatje. Nu heb ik de details nodig.",
  third:
    "Jij laat me zien wie wie is, waar de documenten staan en welke tools mensen gebruiken.",
  summary: /^Eerst je mensen, documenten en tools\./u,
};

test("the story plays through in Dutch, with the sound on and off, and goes on to who's who", async ({
  pageOf,
}) => {
  const { admin } = peopleIn("setupStory");
  const page = await pageOf(admin);
  const asked = await answerSpeech(page);

  // The welcome, in Dutch from the moment it is picked.
  await page.goto("/setup?step=welcome");
  await page.getByRole("button", { name: "Nederlands" }).click();
  await page.getByRole("button", { name: "Laten we beginnen" }).click();

  // Sound on: Stephen tells it, and in the sample interview Mark, Lisa and
  // Tim answer in voices of their own, all in Dutch.
  await expect(page.getByText(story.summary)).toBeVisible({ timeout: 90_000 });
  const told = asked.filter((line) => line.language === "nl");
  expect({
    voices: new Set(told.map((line) => line.speaker ?? "stephen")),
    second: told.some((line) => line.text === story.second),
  }).toStrictEqual({
    voices: new Set(["stephen", "mark", "lisa", "tim"]),
    second: true,
  });
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(
    page.getByRole("heading", { name: "Wie is wie in je bedrijf?" })
  ).toBeVisible();

  // Sound off: told at the pace of speech, nothing asked of the voice.
  // Paused, it holds on the line it is at; played, it goes on to the end.
  await page.getByRole("button", { name: "Geluid uitzetten" }).click();
  const before = asked.length;
  await page.goto("/setup?step=about");
  const second = page.getByText(story.second);
  await expect(second).toBeVisible();
  await page.getByRole("button", { name: "Pauzeren" }).click();
  await page.waitForTimeout(6000);
  await expect(second).toBeVisible();
  await expect(page.getByText(story.third)).toBeHidden();
  await page.getByRole("button", { name: "Afspelen" }).click();
  await expect(page.getByText(story.third)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(story.summary)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Doorgaan" }).click();
  await expect(
    page.getByRole("heading", { name: "Wie is wie in je bedrijf?" })
  ).toBeVisible();
  expect(asked.length).toBe(before);
});
