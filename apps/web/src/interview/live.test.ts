// @vitest-environment happy-dom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { joinAgent } from "./live.ts";
import type { LiveHandlers, LiveSegment, StartAgent } from "./live.ts";

// The live interview with the ElevenLabs agent (live.ts, `joinAgent`),
// with the SDK's start faked: their words as our own ear hears them stand
// over the box while they talk, the agent's words for their turn take
// their place, whatever our ear still hears of a turn taken up is dropped,
// and what our ear heard that the agent never took up goes again. The
// agent hanging up after his goodbye ends the interview; a drop does not.

type Options = Parameters<StartAgent>[0];

/** A conversation as the SDK would start it: what it was started with, and what it was told. */
const faked = () => {
  const started: { options: Options | null; updates: string[] } = {
    options: null,
    updates: [],
  };
  const start: StartAgent = async (options) => {
    started.options = options;
    return await Promise.resolve({
      sendContextualUpdate: (text: string) => {
        started.updates.push(text);
      },
      sendUserMessage: () => {
        // Nothing typed here.
      },
      setMicMuted: () => {
        // Never muted here.
      },
      setVolume: () => {
        // Never hushed here.
      },
      getInputVolume: () => 0.5,
      getOutputVolume: () => 0.25,
      endSession: async () => {
        await Promise.resolve();
      },
    });
  };
  return { started, start };
};

/** Joins a faked conversation: what the page was told, and the conversation's callbacks. */
const joined = async () => {
  const segments: LiveSegment[] = [];
  const ends: string[] = [];
  const on: LiveHandlers = {
    segment: (segment) => {
      segments.push(segment);
    },
    doing: () => {
      // Its poses aren't looked at here.
    },
    part: () => {
      // No parts here.
    },
    ended: () => {
      ends.push("ended");
    },
    finished: () => {
      ends.push("finished");
    },
    failed: () => {
      ends.push("failed");
    },
  };
  const { started, start } = faked();
  const live = await joinAgent(
    {
      conversationToken: "token",
      location: "eu-residency",
      context: "You are talking with Tim.",
      pass: "pass",
    },
    on,
    start
  );
  const { options } = started;
  if (live === null || options === null) {
    throw new Error("not joined");
  }
  return { live, options, started, segments, ends };
};

/** A line of the conversation, as the SDK tells one. */
const lineOf = (role: "agent" | "user", message: string) => ({
  role,
  message,
  source: role === "agent" ? ("ai" as const) : ("user" as const),
  event_id: 1,
});

/** What stands over the box for their turn `id`: the last segment told for it. */
const shown = (segments: LiveSegment[], id: string) =>
  segments.findLast((segment) => segment.id === id);

describe("the live interview with the ElevenLabs agent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends no overrides, and tells the agent who it talks with, once, as it starts", async () => {
    const { options, started } = await joined();
    expect(options.overrides).toBeUndefined();
    expect(options.stripAudioTags).toBeTruthy();
    expect(started.updates).toStrictEqual(["You are talking with Tim."]);
  });

  it("shows their words as our ear hears them, at once, before the agent has them", async () => {
    const { live, options, segments } = await joined();
    options.onMessage?.(lineOf("agent", "What do you do here?"));
    live.overheard(1, "I handle", false);
    expect(shown(segments, "you-0")).toStrictEqual({
      id: "you-0",
      from: "person",
      text: "I handle",
      final: false,
    });
    live.overheard(1, "I handle the invoices", false);
    live.overheard(2, "for Acme", false);
    expect(shown(segments, "you-0")?.text).toBe(
      "I handle the invoices for Acme"
    );
  });

  it("puts the agent's words for their turn in place of ours, and drops what our ear still hears of it", async () => {
    const { live, options, segments } = await joined();
    live.overheard(1, "I handle the invoice", false);
    options.onMessage?.(lineOf("user", "I handle the invoices."));
    expect(shown(segments, "you-0")).toStrictEqual({
      id: "you-0",
      from: "person",
      text: "I handle the invoices.",
      final: true,
    });
    // Late, from the turn already taken up: never shown as their next turn.
    live.overheard(1, "I handle the invoices", true);
    expect(shown(segments, "you-1")).toBeUndefined();
    // Their next turn shows as it is heard again.
    live.overheard(2, "Every Monday", false);
    expect(shown(segments, "you-1")?.text).toBe("Every Monday");
  });

  it("lets go of what our ear heard that the agent never took up as their turn", async () => {
    const { live, segments } = await joined();
    live.overheard(1, "Hm", true);
    expect(shown(segments, "you-0")?.text).toBe("Hm");
    await vi.advanceTimersByTimeAsync(6000);
    expect(shown(segments, "you-0")?.text).toBe("");
  });

  it("says how loud each is in the session", async () => {
    const { live } = await joined();
    expect(live.levels()).toStrictEqual({ his: 0.25, theirs: 0.5 });
  });

  it("ends the interview when he hangs up after he began, and only drops it otherwise", async () => {
    const first = await joined();
    first.options.onMessage?.(lineOf("agent", "Hi Tim."));
    first.options.onDisconnect?.({ reason: "agent" });
    expect(first.ends).toStrictEqual(["finished"]);
    const second = await joined();
    second.options.onMessage?.(lineOf("agent", "Hi Tim."));
    second.options.onDisconnect?.({ reason: "user" });
    expect(second.ends).toStrictEqual(["ended"]);
  });
});
