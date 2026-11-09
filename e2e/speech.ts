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
 * a second.
 */
const readingStepMs = 1000;

/** How long a look at the page waits, in real time, between steps. */
const lookMs = 100;

/**
 * How long a frame the page sent to core without one back counts as a
 * call core is still answering: past it, the page is taken as waiting on
 * nothing, so a frame that is never answered holds no step for good.
 */
const unansweredMs = 2000;

/** What a page is waiting on from core: its requests, and its socket's last frames. */
interface Traffic {
  requests: Set<Request>;
  sentAt: number;
  receivedAt: number;
}

const trafficOf = new WeakMap<Page, Traffic>();

/**
 * Installs Playwright's clock on `page`, before it loads, and watches what
 * it waits on from core, for `readUntil`.
 */
export const installReadingClock = async (page: Page): Promise<void> => {
  const traffic: Traffic = { requests: new Set(), sentAt: 0, receivedAt: 0 };
  trafficOf.set(page, traffic);
  page.on("request", (request) => {
    const from = request.redirectedFrom();
    if (from !== null) {
      traffic.requests.delete(from);
    }
    traffic.requests.add(request);
  });
  const done = (request: Request) => {
    traffic.requests.delete(request);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("websocket", (socket) => {
    socket.on("framesent", () => {
      traffic.sentAt = Date.now();
    });
    socket.on("framereceived", () => {
      traffic.receivedAt = Date.now();
    });
  });
  await page.clock.install();
};

/** Whether the page is waiting on core: a request, or a call on its socket. */
const waitingOnCore = (traffic: Traffic | undefined): boolean =>
  traffic !== undefined &&
  (traffic.requests.size > 0 ||
    (traffic.sentAt > traffic.receivedAt &&
      Date.now() - traffic.sentAt < unansweredMs));

/**
 * How long a step's way on may take to come on the page's clock: its
 * line's reading time, or with the voice on and never heard that and
 * 3.5 s more (apps/web/src/onboarding/setup-parts.tsx's `explainedWait`),
 * for the longest line with room to spare.
 */
const wayOnMs = 30_000;

/**
 * Goes on the page's clock a second at a time until `ready` passes, for at
 * most `withinMs` of it, then fails as `ready` last did. A line read
 * silently, and the way on after it, wait the time it takes to read the
 * line on the page's clock (apps/web/src/voice/voice.ts's `hold`,
 * apps/web/src/onboarding/setup-parts.tsx's `explainedWait`): over a
 * minute of a walkthrough's steps in real time. With Playwright's clock
 * (`installReadingClock` before the page loads) a test reads them at
 * once. Only that wait goes faster, still bounded as a real wait was:
 * what the test then checks is checked as before. The clock steps only
 * while the page waits on nothing from core: the page gives core's
 * answers 5 s on that clock (apps/web/src/core.ts's `timeoutMs`), and a
 * step taken while one was on its way failed a slow runner's answers as
 * out of reach (November 2026). Sound the browser plays runs on its own
 * clock, so a line heard still takes its time.
 */
export const readUntil = async (
  page: Page,
  ready: () => Promise<void>,
  withinMs: number
): Promise<void> => {
  const traffic = trafficOf.get(page);
  const started = Date.now();
  let forwarded = 0;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one look per step of the clock
      await ready();
      return;
    } catch (error) {
      // The page's clock went on as far as it was stepped, and as long as
      // the looks took.
      if (forwarded + Date.now() - started >= withinMs) {
        throw error;
      }
    }
    if (waitingOnCore(traffic)) {
      // oxlint-disable-next-line no-await-in-loop -- its answer comes in real time
      await page.waitForTimeout(lookMs);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- one step of the clock at a time
      await page.clock.fastForward(readingStepMs);
      forwarded += readingStepMs;
    }
  }
};

/**
 * `readUntil` the step's way on (`wayOn`) can be clicked: it fades in,
 * inert until then, once the step's line has been read.
 */
export const readOn = async (page: Page, wayOn: Locator): Promise<void> => {
  await readUntil(
    page,
    async () => {
      await wayOn.click({ trial: true, timeout: lookMs });
    },
    wayOnMs
  );
};
