import type { Locator, Page, Request, WebSocket } from "@playwright/test";
import { z } from "zod";

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
 * What a page is waiting on from core: its requests, and the calls on each
 * of its sockets core hasn't answered yet, by their ids, with when each
 * was made.
 */
interface Traffic {
  /** Its requests in flight, with when each started. */
  requests: Map<Request, number>;
  sockets: Map<WebSocket, Socket>;
}

/**
 * A socket of the page's to core: when it began opening, whether core has
 * said anything on it yet, and the calls core owes an answer, by id, with
 * when each was made.
 */
interface Socket {
  openedAt: number;
  answered: boolean;
  calls: Map<number, number>;
  /** The id the page's next `push`, `stream` or `pipe` takes. */
  nextId: number;
}

/**
 * How long the page gives core's answer to a call, on its clock
 * (apps/web/src/core.ts's `timeoutMs`). A call unanswered for longer in
 * real time is past its deadline already, as the page's clock went on in
 * real time all along, or is one that never had one, such as a live
 * subscription that stays open: a step can't fail it.
 */
const answerDeadlineMs = 5000;

const trafficOf = new WeakMap<Page, Traffic>();

/**
 * A capnweb message (capnweb 0.12's RpcSession, one JSON array a frame).
 * Each `push`, `stream` and `pipe` the page sends takes the next import
 * id, from 1, as capnweb numbers them. The page awaits a call's answer
 * through a `["pull", id]`, and a `stream` it sends waits for its own; a
 * `["resolve", id, …]` or `["reject", id, …]` from core gives it. Every
 * other message expects no answer: a `release`, which follows each
 * answer, and core's answers to calls core made of the page (negative
 * ids), which the page doesn't await through a pull.
 */
const messageSchema = z.tuple([z.string()]).rest(z.unknown());

/** The message in `payload`: its kind, and its id if it names one. */
const messageOf = (
  payload: string | Buffer
): { kind: string; id: number | undefined } | undefined => {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(String(payload)));
    if (!parsed.success) {
      return undefined;
    }
    const [kind, id] = parsed.data;
    return { kind, id: typeof id === "number" ? id : undefined };
  } catch {
    return undefined;
  }
};

/** The messages of the page's that take the next import id. */
const takesAnId = new Set(["push", "stream", "pipe"]);

/** Follows the calls the page makes on `socket`, until it closes. */
const followCalls = (traffic: Traffic, socket: WebSocket): void => {
  const followed: Socket = {
    openedAt: Date.now(),
    answered: false,
    calls: new Map(),
    nextId: 1,
  };
  traffic.sockets.set(socket, followed);
  socket.on("framesent", ({ payload }) => {
    const message = messageOf(payload);
    if (message === undefined) {
      return;
    }
    if (takesAnId.has(message.kind)) {
      const id = followed.nextId;
      followed.nextId += 1;
      if (message.kind === "stream") {
        followed.calls.set(id, Date.now());
      }
    } else if (message.kind === "pull" && message.id !== undefined) {
      followed.calls.set(message.id, Date.now());
    }
  });
  socket.on("framereceived", ({ payload }) => {
    followed.answered = true;
    const message = messageOf(payload);
    if (
      (message?.kind === "resolve" || message?.kind === "reject") &&
      message.id !== undefined
    ) {
      followed.calls.delete(message.id);
    }
  });
  socket.on("close", () => {
    traffic.sockets.delete(socket);
  });
};

/**
 * Installs Playwright's clock on `page`, before it loads, and watches what
 * it waits on from core, for `readUntil`.
 */
export const installReadingClock = async (page: Page): Promise<void> => {
  const traffic: Traffic = { requests: new Map(), sockets: new Map() };
  trafficOf.set(page, traffic);
  page.on("request", (request) => {
    const from = request.redirectedFrom();
    if (from !== null) {
      traffic.requests.delete(from);
    }
    traffic.requests.set(request, Date.now());
  });
  const done = (request: Request) => {
    traffic.requests.delete(request);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("websocket", (socket) => {
    followCalls(traffic, socket);
  });
  await page.clock.install();
};

/**
 * Whether the page is waiting on core: a request, a socket opening or a
 * call on one, each within its deadline from when it began.
 */
const waitingOnCore = (traffic: Traffic | undefined): boolean => {
  if (traffic === undefined) {
    return false;
  }
  const now = Date.now();
  const pending = (since: number): boolean => now - since < answerDeadlineMs;
  return (
    [...traffic.requests.values()].some(pending) ||
    [...traffic.sockets.values()].some(
      ({ openedAt, answered, calls }) =>
        // Opening: the page queues its calls until it is open, and core
        // opens it only once it found the session, while the calls'
        // deadlines already run. Playwright shows the handshake as no
        // request, and the queued calls as no frame.
        (!answered && pending(openedAt)) || [...calls.values()].some(pending)
    )
  );
};

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
