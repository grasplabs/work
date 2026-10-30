import type { Page, Request } from "@playwright/test";

// Stephen's voice on the onboarding's pages (apps/web/src/voice) is
// Grasp's own speech feature behind the model gateway (OpenAI by
// default, through connect with Grasp's key), which the local stack doesn't
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
