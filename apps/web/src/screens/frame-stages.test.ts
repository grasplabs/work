import { screenFrameMounted, screenFrameReady } from "@grasp-os/shared/screens";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  isMounted,
  isReady,
  stage,
  StageTimeoutError,
} from "./frame-stages.ts";
import type { FrameMessage } from "./frame-stages.ts";

// The page's side of a screen's start, attacked: every message here but
// the frame's own, for this very start, must count for nothing, and a
// stage nobody answers must end on time and leave nothing behind.

/** A window, as far as the page compares them. */
const frameWindow = { name: "the screen's frame" };
const otherWindow = { name: "another frame" };
const frame = (): unknown => frameWindow;

const expected = {
  load: "load-1",
  artifact: "a".repeat(64),
  generation: "generation-1",
};

const ready = (changes: Partial<FrameMessage> = {}): FrameMessage => ({
  source: frameWindow,
  origin: "null",
  data: { type: screenFrameReady, load: expected.load },
  ...changes,
});

const mounted = (changes: Partial<FrameMessage> = {}): FrameMessage => ({
  source: frameWindow,
  origin: "null",
  data: { type: screenFrameMounted, ...expected },
  ...changes,
});

/** A message as the page's window hears it. */
const heard = (message: FrameMessage): Event =>
  Object.assign(new Event("message"), message);

/** A window that says how many are listening to it. */
const listenedTo = () => {
  const target = new EventTarget();
  let listening = 0;
  return {
    listening: () => listening,
    dispatch: (message: FrameMessage) => target.dispatchEvent(heard(message)),
    messages: {
      addEventListener: (
        type: string,
        listener: EventListener,
        options?: AddEventListenerOptions
      ): void => {
        listening += 1;
        options?.signal?.addEventListener("abort", () => {
          listening -= 1;
        });
        target.addEventListener(type, listener, options);
      },
    },
  };
};

/** How a stage ended, once it has. */
const ending = async (waiting: Promise<void>): Promise<string> => {
  try {
    await waiting;
    return "reached";
  } catch (error) {
    return error instanceof StageTimeoutError
      ? `timed out waiting for ${error.stage}`
      : "stopped";
  }
};

describe("ready", () => {
  it("counts from the frame's own window, for this load", () => {
    expect(isReady(ready(), frame, expected.load)).toBeTruthy();
  });

  it("counts for nothing from anywhere else, or for another load", () => {
    const forged = {
      anotherFrame: ready({ source: otherWindow }),
      noSource: ready({ source: null }),
      // Where a frame that navigated away, or the page itself, speaks from.
      anOriginOfItsOwn: ready({ origin: "https://attacker.example" }),
      thePagesOrigin: ready({ origin: "https://grasp.example" }),
      anEarlierLoad: ready({
        data: { type: screenFrameReady, load: "load-0" },
      }),
      noLoad: ready({ data: { type: screenFrameReady } }),
      aLoadThatIsNoText: ready({
        data: { type: screenFrameReady, load: { toString: () => "load-1" } },
      }),
      mountedInstead: ready({ data: mounted().data }),
      moreThanReady: ready({
        data: { type: screenFrameReady, load: expected.load, trusted: true },
      }),
      notAnObject: ready({ data: `${screenFrameReady}:${expected.load}` }),
      nothing: ready({ data: null }),
    };
    expect(
      Object.entries(forged)
        .filter(([, message]) => isReady(message, frame, expected.load))
        .map(([name]) => name)
    ).toStrictEqual([]);
  });

  it("counts for nothing once the frame is off the page", () => {
    expect(
      [null, undefined].map((gone) =>
        isReady(ready({ source: null }), () => gone, expected.load)
      )
    ).toStrictEqual([false, false]);
  });
});

describe("mounted", () => {
  it("counts from the frame's own window, for this very start", () => {
    expect(isMounted(mounted(), frame, expected)).toBeTruthy();
  });

  it("counts for nothing forged, replayed or about other code", () => {
    const data = { type: screenFrameMounted, ...expected };
    const forged = {
      anotherFrame: mounted({ source: otherWindow }),
      anOriginOfItsOwn: mounted({ origin: "https://attacker.example" }),
      // Another screen's frame, or this one's last start, saying its own.
      anotherLoad: mounted({ data: { ...data, load: "load-0" } }),
      anotherStart: mounted({ data: { ...data, generation: "generation-0" } }),
      otherCode: mounted({ data: { ...data, artifact: "b".repeat(64) } }),
      noArtifact: mounted({
        data: {
          type: screenFrameMounted,
          load: expected.load,
          generation: expected.generation,
        },
      }),
      readyInstead: mounted({ data: ready().data }),
      aTrustFlag: mounted({ data: { ...data, approved: true } }),
      anArtifactThatIsNoText: mounted({
        data: { ...data, artifact: [expected.artifact] },
      }),
      nothing: mounted({ data: undefined }),
    };
    expect(
      Object.entries(forged)
        .filter(([, message]) => isMounted(message, frame, expected))
        .map(([name]) => name)
    ).toStrictEqual([]);
  });
});

describe("a stage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is reached by the frame's message, and listens no more after", async () => {
    const page = listenedTo();
    const waiting = stage(
      "ready",
      (message) => isReady(message, frame, expected.load),
      page.messages,
      new AbortController().signal
    );
    page.dispatch(ready({ source: otherWindow }));
    page.dispatch(ready());

    expect({
      ended: await ending(waiting),
      listening: page.listening(),
      timers: vi.getTimerCount(),
    }).toStrictEqual({ ended: "reached", listening: 0, timers: 0 });
  });

  it("times out after ten seconds of forged messages, and not a moment before", async () => {
    const page = listenedTo();
    const waiting = ending(
      stage(
        "mounted",
        (message) => isMounted(message, frame, expected),
        page.messages,
        new AbortController().signal
      )
    );
    page.dispatch(mounted({ source: otherWindow }));
    page.dispatch(mounted({ data: { ...expected, type: screenFrameReady } }));

    await vi.advanceTimersByTimeAsync(9999);
    const before = { listening: page.listening(), timers: vi.getTimerCount() };
    await vi.advanceTimersByTimeAsync(1);

    expect({
      before,
      ended: await waiting,
      listening: page.listening(),
      timers: vi.getTimerCount(),
    }).toStrictEqual({
      before: { listening: 1, timers: 1 },
      ended: "timed out waiting for mounted",
      listening: 0,
      timers: 0,
    });
  });

  it("stays timed out when the answer comes late", async () => {
    const page = listenedTo();
    const waiting = ending(
      stage(
        "ready",
        (message) => isReady(message, frame, expected.load),
        page.messages,
        new AbortController().signal
      )
    );
    await vi.advanceTimersByTimeAsync(10_000);
    page.dispatch(ready());

    await expect(waiting).resolves.toBe("timed out waiting for ready");
  });

  it("ends at once, with nothing left, when the screen is stopped", async () => {
    const page = listenedTo();
    const stopped = new AbortController();
    const waiting = ending(
      stage(
        "mounted",
        (message) => isMounted(message, frame, expected),
        page.messages,
        stopped.signal
      )
    );
    stopped.abort();

    expect({
      ended: await waiting,
      listening: page.listening(),
      timers: vi.getTimerCount(),
    }).toStrictEqual({ ended: "stopped", listening: 0, timers: 0 });
  });

  it("never starts for a screen stopped already", async () => {
    const page = listenedTo();
    const stopped = new AbortController();
    stopped.abort();
    const waiting = ending(
      stage("ready", () => true, page.messages, stopped.signal)
    );

    expect({
      ended: await waiting,
      listening: page.listening(),
      timers: vi.getTimerCount(),
    }).toStrictEqual({ ended: "stopped", listening: 0, timers: 0 });
  });
});
