import { expect } from "@playwright/test";
import type { Locator, Page, Request } from "@playwright/test";

// Stephen's voice on the onboarding's pages (apps/web/src/voice) is
// ElevenLabs behind the model gateway, which the local stack doesn't
// reach: the page's speech requests are answered here as core answers
// them, with silence the length of the line, and kept, to see what he was
// asked to say.

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

export interface Asked {
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
export const answerSpeech = async (page: Page): Promise<Asked[]> => {
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

/**
 * How far the page's clock goes at a time while a test waits on reading:
 * a second, so whatever else the page times (a request's deadline, a
 * reconnect) never sees more than a second pass at once.
 */
const readingStepMs = 1000;

/** How long a test may wait, in real time, for what it reads to be read. */
const readingTimeoutMs = 60_000;

/**
 * Goes on the page's clock a second at a time until `ready` passes. A
 * line read silently, and the way on after it, wait the time it takes to
 * read the line on the page's clock (apps/web/src/voice/voice.ts's `hold`,
 * apps/web/src/onboarding/setup-parts.tsx's `explainedWait`): over a
 * minute of a walkthrough's steps in real time. With Playwright's clock
 * (`page.clock.install()` before the page loads) a test reads them at
 * once. Only that wait goes faster: what the test then checks is checked
 * as before. Sound the browser plays runs on its own clock, so a line
 * heard still takes its time.
 */
export const readUntil = async (
  page: Page,
  ready: () => Promise<void>
): Promise<void> => {
  await expect(async () => {
    await page.clock.fastForward(readingStepMs);
    await ready();
  }).toPass({ intervals: [0], timeout: readingTimeoutMs });
};

/**
 * `readUntil` the step's way on (`wayOn`) can be clicked: it fades in,
 * inert until then, once the step's line has been read.
 */
export const readOn = async (page: Page, wayOn: Locator): Promise<void> => {
  await readUntil(page, async () => {
    await wayOn.click({ trial: true, timeout: 100 });
  });
};
