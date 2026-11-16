// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openEar } from "./ear.ts";
import type { EarEvent } from "./ear.ts";

// Stephen's ears, written down from a stretch's recording when the live
// line can't be had, against the browser's microphone, audio and recorder
// faked: what is outside Grasp. Once the ear is closed (the conversation
// stopped, or their session ended, GRA-1943), a stretch still being
// recorded is sent nowhere to be written down.

/** How loud the faked microphone is now: someone speaking, or a quiet room. */
const room = { speaking: false };

/** Recorders asked to stop, whose recording is handed over when the test says. */
const stopping: FakeRecorder[] = [];

class FakeRecorder extends EventTarget {
  state: "inactive" | "recording" = "inactive";
  readonly mimeType = "audio/webm";
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    stopping.push(this);
  }
  /** The recording is ready: its piece, then that it stopped. */
  handOver(): void {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data: new Blob(["a stretch said"]),
      })
    );
    this.dispatchEvent(new Event("stop"));
  }
}

/** The page's audio, faked: an analyser that hears the room, and no tap. */
const audioContext = {
  sampleRate: 48_000,
  destination: {},
  audioWorklet: {
    addModule: async (): Promise<never> => {
      await Promise.resolve();
      throw new Error("No tap here.");
    },
  },
  createAnalyser: () => ({
    fftSize: 1024,
    getByteTimeDomainData: (samples: Uint8Array): void => {
      for (let at = 0; at < samples.length; at += 1) {
        // A voice swings far around the middle; a quiet room doesn't.
        const swing = at % 2 === 0 ? 64 : -64;
        samples[at] = room.speaking ? 128 + swing : 128;
      }
    },
  }),
  createMediaStreamSource: () => ({
    connect: (): void => {
      // Nothing to connect to here.
    },
  }),
  resume: async (): Promise<void> => {
    await Promise.resolve();
  },
};

/** `new AudioContext()`, faked: it gives the faked context. */
const FakeAudioContext = function FakeAudioContext(): typeof audioContext {
  return audioContext;
};

const track = {
  enabled: true,
  stop: (): void => {
    // Let go of.
  },
  getSettings: () => ({ deviceId: "microphone" }),
};
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };

/** Every place a call was made to, as `fetch` was asked. */
const asked: string[] = [];

/** A faked browser around the ear, with no live line: written down from recordings. */
const browser = (): void => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
      "Date",
    ],
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  // No live line: the socket can't be opened.
  vi.stubGlobal(
    "WebSocket",
    vi.fn(() => {
      throw new Error("No live line here.");
    })
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      await Promise.resolve();
      asked.push(new URL(input, "https://grasp.test").pathname);
      return Response.json({ heard: "Words from the recording." });
    })
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => await Promise.resolve(stream) },
  });
};

/** Someone says a stretch and falls quiet: what the ear tells meanwhile. */
const saidOneStretch = async (): Promise<{
  ear: NonNullable<Awaited<ReturnType<typeof openEar>>>;
  told: EarEvent["type"][];
}> => {
  const ear = await openEar({ locale: "en", link: { secret: "s".repeat(43) } });
  if (ear === null) {
    throw new Error("The faked microphone wasn't given.");
  }
  const told: EarEvent["type"][] = [];
  ear.on((event) => {
    told.push(event.type);
  });
  room.speaking = true;
  await vi.advanceTimersByTimeAsync(1200);
  room.speaking = false;
  await vi.advanceTimersByTimeAsync(1500);
  return { ear, told };
};

/** The recordings asked to stop are handed over, and what follows them runs. */
const recordingsReady = async (): Promise<void> => {
  for (const recorder of stopping.splice(0)) {
    recorder.handOver();
  }
  await vi.advanceTimersByTimeAsync(10);
};

describe("an ear writing a stretch down from its recording", () => {
  afterEach(() => {
    room.speaking = false;
    stopping.length = 0;
    asked.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends a stretch said to be written down from its recording", async () => {
    browser();
    const { ear, told } = await saidOneStretch();
    await recordingsReady();
    ear.close();
    expect({ ended: told.includes("stretch-end"), asked }).toStrictEqual({
      ended: true,
      asked: ["/api/interview/hear"],
    });
  });

  it("sends nothing to be written down once closed while the stretch's recording was still on its way", async () => {
    browser();
    const { ear, told } = await saidOneStretch();
    ear.close();
    await recordingsReady();
    expect({ ended: told.includes("stretch-end"), asked }).toStrictEqual({
      ended: true,
      asked: [],
    });
  });
});
