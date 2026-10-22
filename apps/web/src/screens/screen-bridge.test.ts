import { bridgeTransport } from "@grasp-os/sdk/screen-runtime";
import type { ScreenBridge } from "@grasp-os/sdk/screen-runtime";
import { functionRequestMaxBytes } from "@grasp-os/shared/operation-limits";
import { screenLimits } from "@grasp-os/shared/screen-limits";
import { portTransport } from "@grasp-os/shared/screen-port";
import type { ScreenNavigation } from "@grasp-os/shared/screens";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { RpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { frameBridge, FrameRpcTarget, openBridge } from "./screen-bridge.ts";
import type { FrameTarget } from "./screen-bridge.ts";

// The page's bridge, from the frame's end of a real `MessagePort`: a
// screen that sends more, bigger and deeper than it may, and a page that
// stops it. Core is stood in for; what core itself refuses is tested
// there (core's screen-bridge.test.ts).

/** Core's hold on a screen's subscription, which says when it's let go. */
class Subscription extends RpcTarget {
  released = false;
  /** Let go of by everything that held it: the page's end too. */
  disposed = false;
  /** Whether the page let go of it itself (`release`), not only its session. */
  releasedByPage = false;

  async release(): Promise<void> {
    this.released = true;
    this.releasedByPage = true;
    await Promise.resolve();
  }

  [Symbol.dispose](): void {
    this.released = true;
    this.disposed = true;
  }
}

/** What core answers a function call unless a test says otherwise. */
const nullAnswer = { result: { ok: true, value: null } };

/** What reached core, and what it handed out: `answer` to a function call. */
const coreStandIn = (answer: unknown = nullAnswer) => {
  const functionCalls: string[] = [];
  const runStarts: { workflow: string; input: unknown }[] = [];
  const reports: string[] = [];
  const draftRequests: string[] = [];
  const navigations: ScreenNavigation[] = [];
  const guards: boolean[] = [];
  const subscriptions: Subscription[] = [];
  // The live queries' callbacks core keeps.
  const kept: Disposable[] = [];
  // What the frame said it got the answers of.
  const received: string[] = [];
  const streams: { subscription: Subscription; end: () => void }[] = [];
  /** Holds each stream's opening until it resolves, when a test sets it. */
  const opening: { gate: Promise<unknown> | undefined } = { gate: undefined };
  const target: FrameTarget = {
    callFunction: async (request) => {
      functionCalls.push(request);
      return await Promise.resolve(answer);
    },
    submissionReceived: async (request) => {
      received.push(request);
      await Promise.resolve();
    },
    streamFunction: async (_what, request, _onFrame, onEnded) => {
      functionCalls.push(request);
      const subscription = new Subscription();
      streams.push({ subscription, end: onEnded });
      await opening.gate;
      return subscription;
    },
    cancelStream: async (request) => {
      functionCalls.push(request);
      return await Promise.resolve({ cancelled: true });
    },
    report: async (problem) => {
      reports.push(problem.message);
      await Promise.resolve();
    },
    startRun: async (workflow, input) => {
      runStarts.push({ workflow, input });
      return await Promise.resolve("started");
    },
    runs: async () => await Promise.resolve([]),
    run: async () => await Promise.resolve("a run"),
    decide: async () => await Promise.resolve("decided"),
    control: async () => await Promise.resolve("controlled"),
    summary: async () => await Promise.resolve("summarised"),
    watchRuns: async () => {
      const subscription = new Subscription();
      subscriptions.push(subscription);
      return await Promise.resolve(subscription);
    },
    drafts: async () => {
      draftRequests.push("drafts");
      return await Promise.resolve({});
    },
    saveDraft: (_key, text) => {
      draftRequests.push(text === null ? "drop" : "save");
    },
    clearDrafts: () => {
      draftRequests.push("clear");
    },
    input: () => ({ id: "n1" }),
    navigate: async (navigation) => {
      navigations.push(navigation);
      await Promise.resolve();
    },
    leaveGuard: (guarded) => {
      guards.push(guarded);
    },
    watchQuery: async (_request, onSnapshot) => {
      // Kept, as core keeps a live query's callback until it lets go.
      if (onSnapshot instanceof RpcStub) {
        kept.push(onSnapshot.dup());
      }
      const subscription = new Subscription();
      subscriptions.push(subscription);
      return await Promise.resolve(subscription);
    },
  };
  // What a v1 server call would reach, were the bridge to pass one on: a
  // target's `call`, which no target has any more.
  const serverCalls: unknown[] = [];
  Object.assign(target, {
    call: async (...args: unknown[]) => {
      serverCalls.push(args);
      return await Promise.resolve("answered");
    },
  });
  return {
    serverCalls,
    draftRequests,
    functionCalls,
    received,
    runStarts,
    guards,
    navigations,
    opening,
    reports,
    streams,
    subscriptions,
    target,
  };
};

/** A frame on its port, talking to the page's bridge as the runtime does. */
const framed = (answer?: unknown) => {
  const core = coreStandIn(answer);
  const { port1, port2 } = new MessageChannel();
  const broken = { times: 0 };
  const close = openBridge(port1, core.target, () => {
    broken.times += 1;
  });
  const page: RpcStub<ScreenBridge> = new RpcSession<ScreenBridge>(
    portTransport(port2)
  ).getRemoteMain();
  return { ...core, broken, close, page, port: port2 };
};

/** `nested(depth)` as Cap'n Web writes it: each array as `[[...]]`. */
const wireNested = (depth: number): unknown => {
  let value: unknown = "bottom";
  for (let level = 1; level < depth; level += 1) {
    value = [[value]];
  }
  return value;
};

/** Whether `value` is an object with a `code`, as an error's own properties travel. */
const isCoded = (value: unknown): value is { code: unknown } =>
  typeof value === "object" && value !== null && "code" in value;

/**
 * A frame that speaks Cap'n Web's messages by hand on its port, as a
 * screen's code can: `push` sends an expression and gives the ID it gets
 * (1, 2, ... in order), `pull` what one settled as: its answer, or the
 * code of its error (written `["error", name, message, stack?, own]`).
 */
const rawFramed = () => {
  const core = coreStandIn();
  const { port1, port2 } = new MessageChannel();
  const broken = { times: 0 };
  const close = openBridge(port1, core.target, () => {
    broken.times += 1;
  });
  const waiting = new Map<number, (outcome: unknown) => void>();
  port2.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message: unknown =
      typeof event.data === "string" ? JSON.parse(event.data) : undefined;
    if (!Array.isArray(message)) {
      return;
    }
    const kind: unknown = message[0];
    const id: unknown = message[1];
    const value: unknown = message[2];
    if (typeof id !== "number") {
      return;
    }
    if (kind === "resolve") {
      waiting.get(id)?.({ answered: value });
    } else if (kind === "reject") {
      const own = Array.isArray(value) ? value.find(isCoded) : undefined;
      waiting.get(id)?.(own?.code ?? value);
    }
  });
  port2.start();
  let pushed = 0;
  const push = (expression: unknown): number => {
    port2.postMessage(JSON.stringify(["push", expression]));
    pushed += 1;
    return pushed;
  };
  const pull = async (id: number): Promise<unknown> => {
    const settled = Promise.withResolvers<unknown>();
    waiting.set(id, settled.resolve);
    port2.postMessage(JSON.stringify(["pull", id]));
    return await settled.promise;
  };
  return { ...core, broken, close, push, pull };
};

/** A start of a run of `notes` with one string, as Cap'n Web writes it. */
const notesCall = (text: string): unknown => [
  "pipeline",
  0,
  ["startRun"],
  ["notes", text],
];

/**
 * `notesCall` padded so the message that pushes it (`["push", ...]` as
 * `rawFramed` sends it) is exactly `length` code units.
 */
const paddedCall = (length: number): unknown => {
  const bare = JSON.stringify(["push", notesCall("")]).length;
  return notesCall("x".repeat(length - bare));
};

/** How a call of the frame's ended: its answer, or why not. */
const outcome = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    return await call;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : "refused";
  }
};

/**
 * A request of the frame's that core answers: a function call, as the
 * screen client makes one. `answered` once core's answer reached the
 * frame, else what refused it.
 */
const poke = async (
  frame: { page: { callFunction: (request: string) => Promise<unknown> } },
  request = "{}"
): Promise<unknown> => {
  const answer = await outcome(frame.page.callFunction(request));
  return JSON.stringify(answer) === JSON.stringify(nullAnswer)
    ? "answered"
    : answer;
};

/** `value`, however a screen that isn't type-checked would pass it. */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; the bridge must refuse it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A value `depth` levels deep: arrays around a leaf, which is a level too. */
const nested = (depth: number): unknown => {
  let value: unknown = "bottom";
  for (let level = 1; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

const noop = (): void => {
  // Nothing to update.
};

/** Follows a workflow's runs once more, as a screen may over and over. */
const follow = async (page: RpcStub<ScreenBridge>): Promise<string> => {
  await page.watchRuns("invoices", noop);
  return "followed";
};

/** A frame callback that takes each frame in. */
const ignoreFrame = async (): Promise<void> => {
  await Promise.resolve();
};

describe("the page's bridge to a screen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the frame only an object that holds each call to the frame's bounds", () => {
    // What `openBridge` serves, and what every call of a frame's lands on
    // first. Its answers are its target's: `watchRuns` passes on core's
    // stub of the subscription, whose calls go back to core over the
    // page's own connection, to a target core bounds (RunSubscription, a
    // CoreRpcTarget: core's rpc-targets.test.ts).
    expect(frameBridge(coreStandIn().target, [])).toBeInstanceOf(
      FrameRpcTarget
    );
  });

  it("passes a function call's request on as the text the frame sent, and nothing else", async () => {
    const frame = framed();
    const request = JSON.stringify({ reference: {}, input: { title: "é" } });
    const results = {
      text: await outcome(frame.page.callFunction(request)),
      object: await outcome(frame.page.callFunction(unchecked({ request }))),
      tooLong: await outcome(
        frame.page.callFunction("x".repeat(functionRequestMaxBytes + 1))
      ),
    };
    expect(results).toStrictEqual({
      text: { result: { ok: true, value: null } },
      object: "screen.invalid",
      tooLong: "screen.invalid",
    });
    expect(frame.functionCalls).toStrictEqual([request]);
    frame.close();
  });

  it("hands the frame its route input, and passes a navigation on only as one of its App's screens with its input", async () => {
    const frame = framed();
    const go = async (request: unknown) =>
      await outcome(frame.page.navigate(unchecked(request)));
    const input = await frame.page.input();
    const results = {
      push: await go(JSON.stringify({ screen: "note", input: { id: "n1" } })),
      replace: await go(
        JSON.stringify({ screen: "notes", input: {}, replace: true })
      ),
      // No URL, path, App or person: only a screen's route name.
      url: await go(JSON.stringify({ screen: "https://evil.test", input: {} })),
      path: await go(JSON.stringify({ screen: "/notes/n1" })),
      withApp: await go(JSON.stringify({ screen: "note", app: "other" })),
      notText: await go({ screen: "note" }),
      notJson: await go("{"),
      notReplace: await go(JSON.stringify({ screen: "note", replace: "yes" })),
      tooLong: await go(
        JSON.stringify({
          screen: "note",
          input: { id: "x".repeat(screenLimits.navigationInputBytes + 256) },
        })
      ),
    };
    frame.close();

    expect({ input, results, reached: frame.navigations }).toStrictEqual({
      input: { id: "n1" },
      results: {
        push: undefined,
        replace: undefined,
        url: "screen.invalid",
        path: "screen.invalid",
        withApp: "screen.invalid",
        notText: "screen.invalid",
        notJson: "screen.invalid",
        notReplace: "screen.invalid",
        tooLong: "screen.invalid",
      },
      reached: [
        { screen: "note", input: { id: "n1" } },
        { screen: "notes", input: {}, replace: true },
      ],
    });
  });

  it("passes on whether the screen holds unsaved edits, and nothing but that", async () => {
    const frame = framed();
    await frame.page.leaveGuard(true);
    await frame.page.leaveGuard(unchecked("yes"));
    await frame.page.leaveGuard(false);
    await frame.page.input();
    frame.close();
    expect(frame.guards).toStrictEqual([true, false]);
  });

  it("gathers leave guards past their budget and passes on the newest, so the page ends with what the screen said last", async () => {
    vi.useFakeTimers();
    try {
      const frame = framed();
      const { burst } = screenLimits.leaveGuards;
      for (let at = 0; at < burst + 5; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each goes in order, as a screen sends them
        await frame.page.leaveGuard(at % 2 === 0);
      }
      // The newest of those held back: what the screen said last.
      await frame.page.leaveGuard(false);
      const withinBudget = frame.guards.length;
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = [...frame.guards];
      frame.close();
      expect({
        withinBudget,
        passedLater: settled.length - withinBudget,
        last: settled.at(-1),
      }).toStrictEqual({ withinBudget: burst, passedLater: 1, last: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on that the frame got a call's answer, as the text it sent, and nothing else", async () => {
    const frame = framed();
    const request = JSON.stringify({ reference: {}, idempotencyKey: "k" });
    const results = {
      text: await outcome(frame.page.submissionReceived(request)),
      object: await outcome(
        frame.page.submissionReceived(unchecked({ request }))
      ),
      tooLong: await outcome(
        frame.page.submissionReceived("x".repeat(functionRequestMaxBytes + 1))
      ),
    };
    expect({ results, received: frame.received }).toStrictEqual({
      results: {
        text: undefined,
        object: "screen.invalid",
        tooLong: "screen.invalid",
      },
      received: [request],
    });
    frame.close();
  });

  it("lets a burst of requests through, refuses the rest, and fills again with time", async () => {
    const frame = framed();
    const flood = await Promise.all(
      Array.from({ length: 200 }, async (_value, index) =>
        // Malformed ones count too.
        index % 2 === 0
          ? await poke(frame)
          : await outcome(frame.page.runs(unchecked(index)))
      )
    );
    const reachedInFlood = frame.functionCalls.length;
    // 120 a minute: two more after a second.
    vi.setSystemTime(1_001_000);
    const later = await Promise.all(
      [0, 0, 0].map(async () => await poke(frame))
    );
    frame.close();

    expect({
      answered: flood.filter((result) => result === "answered").length,
      invalid: flood.filter((result) => result === "screen.invalid").length,
      refused: flood.filter((result) => result === "screen.rate_limited")
        .length,
      reachedInFlood,
      later,
    }).toStrictEqual({
      answered: 10,
      invalid: 10,
      refused: 180,
      reachedInFlood: 10,
      later: ["answered", "answered", "screen.rate_limited"],
    });
  });

  it("hands over drafts to a burst of twenty, and passes on every change and clear", async () => {
    const frame = framed();
    const handedOver = await Promise.all(
      Array.from({ length: 30 }, async () => await frame.page.drafts())
    );
    for (let count = 0; count < 30; count += 1) {
      void frame.page.saveDraft("draft", "text");
    }
    void frame.page.saveDraft("draft", null);
    void frame.page.clearDrafts();
    // In order on the one port: once this is answered, so are the rest.
    await poke(frame);
    frame.close();

    const count = (kind: string) =>
      frame.draftRequests.filter((request) => request === kind).length;
    expect({
      handedOver: handedOver.length,
      drafts: count("drafts"),
      kept: count("save"),
      dropped: count("drop"),
      cleared: count("clear"),
    }).toStrictEqual({
      handedOver: 30,
      drafts: 20,
      kept: 30,
      dropped: 1,
      cleared: 1,
    });
  });

  it("passes on twenty reports of a flood, valid or not, and no more", async () => {
    const frame = framed();
    for (let count = 0; count < 5; count += 1) {
      void frame.page.report(
        unchecked({ kind: "alert", message: "not a kind" })
      );
    }
    for (let count = 0; count < 1000; count += 1) {
      void frame.page.report({ kind: "error", message: `Problem ${count}` });
    }
    // In order on the one port: once this is answered, so are the reports.
    await poke(frame);
    frame.close();

    expect(frame.reports).toStrictEqual(
      Array.from({ length: 15 }, (_value, index) => `Problem ${index}`)
    );
  });

  it("takes a message exactly as long as a message may be, and ends the session over one code unit more", async () => {
    const atLimit = rawFramed();
    const exact = atLimit.pull(
      atLimit.push(paddedCall(screenLimits.rpc.maxMessageSize))
    );
    await expect(exact).resolves.toStrictEqual({ answered: "started" });
    atLimit.close();

    const pastLimit = rawFramed();
    pastLimit.push(paddedCall(screenLimits.rpc.maxMessageSize + 1));
    await vi.waitFor(() => {
      expect(pastLimit.broken.times).toBe(1);
    });
    pastLimit.close();
    expect({
      exactReached: atLimit.runStarts.length,
      pastReached: pastLimit.runStarts.length,
    }).toStrictEqual({ exactReached: 1, pastReached: 0 });
  });

  it("hands the frame an answer as large as a public operation's output", async () => {
    const value = "x".repeat(screenLimits.answerBytes - 2);
    const frame = framed({ result: { ok: true, value } });
    const answered = await outcome(frame.page.callFunction("{}"));
    frame.close();
    expect({
      bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
      whole:
        JSON.stringify(answered) ===
        JSON.stringify({ result: { ok: true, value } }),
      broken: frame.broken.times,
    }).toStrictEqual({
      bytes: screenLimits.answerBytes,
      whole: true,
      broken: 0,
    });
  });

  it("counts a message's length in code units, not signs", async () => {
    const frame = framed();
    const fits = await outcome(frame.page.callFunction("x".repeat(200_000)));
    // Half as many signs, each two code units: counted as units, not signs.
    const tooLong = await outcome(
      frame.page.callFunction("😀".repeat(140_000))
    );
    const after = await poke(frame);
    frame.close();

    expect({
      fits,
      tooLong,
      after,
      reached: frame.functionCalls.length,
      // The page is told, once, so it can say the screen stopped.
      broken: frame.broken.times,
    }).toStrictEqual({
      // Past what a function call takes, but a message the port takes.
      fits: "screen.invalid",
      tooLong: "refused",
      after: "refused",
      reached: 0,
      broken: 1,
    });
  });

  it("passes on a value as deep as values may be, and ends the session over one level more", async () => {
    const frame = framed();
    const deepest = await outcome(
      frame.page.startRun("notes", nested(valueDepth + 1))
    );
    const tooDeep = await outcome(
      frame.page.startRun("notes", nested(valueDepth + 2))
    );
    frame.close();

    expect({
      deepest,
      tooDeep,
      reached: frame.runStarts,
      broken: frame.broken.times,
    }).toStrictEqual({
      deepest: "started",
      tooDeep: "refused",
      // Whole, every level of it: an argument passed straight may be one
      // level deeper than values nest (`rpcArgumentDepth`).
      reached: [{ workflow: "notes", input: nested(valueDepth + 1) }],
      broken: 1,
    });
  });

  it("refuses a value built from many messages deeper than values may be, before it reaches core, and passes one as deep", async () => {
    const frame = rawFramed();
    // A value `base` levels deep, then `levels` more pushes, each an array
    // around the push before: no message is deeper than `base`.
    const built = (base: number, levels: number): number => {
      let pushed = frame.push(wireNested(base));
      for (let level = 0; level < levels; level += 1) {
        pushed = frame.push([[["pipeline", pushed]]]);
      }
      return pushed;
    };
    const called = async (pushed: number): Promise<unknown> =>
      await frame.pull(
        frame.push([
          "pipeline",
          0,
          ["startRun"],
          ["notes", ["pipeline", pushed]],
        ])
      );

    const deepest = await called(built(valueDepth - 8, 9));
    const oneMore = await called(built(valueDepth - 8, 10));
    // Thousands of levels: refused as such, not by running out of stack.
    const farDeeper = await called(built(30, 100));
    // Passed as a run's input, straight.
    const asInput = await frame.pull(
      frame.push([
        "pipeline",
        0,
        ["startRun"],
        ["invoices", ["pipeline", built(30, 100)]],
      ])
    );
    const after = await called(built(1, 0));
    frame.close();

    expect({
      deepest,
      oneMore,
      farDeeper,
      asInput,
      after,
      reached: frame.runStarts,
      broken: frame.broken.times,
    }).toStrictEqual({
      deepest: { answered: "started" },
      oneMore: "request.too_deep",
      farDeeper: "request.too_deep",
      asInput: "request.too_deep",
      after: { answered: "started" },
      reached: [
        { workflow: "notes", input: nested(valueDepth + 1) },
        { workflow: "notes", input: "bottom" },
      ],
      // The session goes on.
      broken: 0,
    });
  });

  it("serves a frame no call of its App's server, and passes it on nowhere", async () => {
    const frame = rawFramed();
    const called = await frame.pull(
      frame.push(["pipeline", 0, ["call"], ["notes", [["a"]]]])
    );
    // The session goes on.
    const after = await frame.pull(
      frame.push(["pipeline", 0, ["callFunction"], ["{}"]])
    );
    frame.close();

    expect({
      called:
        typeof called === "object" && called !== null && "answered" in called,
      after,
      reached: {
        server: frame.serverCalls,
        runs: frame.runStarts,
        functions: frame.functionCalls,
      },
    }).toStrictEqual({
      called: false,
      after: { answered: nullAnswer },
      reached: { server: [], runs: [], functions: ["{}"] },
    });
  });

  it("refuses a value a key every object has carries in, a prototype and an error's own among them", async () => {
    const frame = rawFramed();
    let deep = frame.push(wireNested(30));
    for (let level = 0; level < 100; level += 1) {
      deep = frame.push([[["pipeline", deep]]]);
    }
    const shallow = frame.push({ approved: true });
    const called = async (key: string, pushed: number): Promise<unknown> =>
      await frame.pull(
        frame.push([
          "pipeline",
          0,
          ["startRun"],
          ["notes", { [key]: ["pipeline", pushed] }],
        ])
      );

    const outcomes = {
      protoDeep: await called("__proto__", deep),
      protoShallow: await called("__proto__", shallow),
      constructorDeep: await called("constructor", deep),
      toJSONDeep: await called("toJSON", deep),
      // Cap'n Web gives it `errors` as a property `Object.keys` skips.
      aggregateDeep: await frame.pull(
        frame.push([
          "pipeline",
          0,
          ["startRun"],
          [
            "notes",
            [
              "error",
              "AggregateError",
              "m",
              null,
              { errors: ["pipeline", deep] },
            ],
          ],
        ])
      ),
    };
    frame.close();

    expect({ outcomes, reached: frame.runStarts }).toStrictEqual({
      outcomes: {
        protoDeep: "request.unsupported_value",
        protoShallow: "request.unsupported_value",
        constructorDeep: "request.too_deep",
        toJSONDeep: "request.too_deep",
        aggregateDeep: "request.too_deep",
      },
      reached: [],
    });
  });

  it("refuses a value held so many times over it is more than a message may hold", async () => {
    const frame = rawFramed();
    // Each push holds the one before twice: 2^10 copies of 1,000 signs, far
    // past the bridge's message size. Cap'n Web copies every reference before
    // the check runs (GRA-424), so more copies only make the test slow.
    let pushed = frame.push("x".repeat(1000));
    for (let level = 0; level < 10; level += 1) {
      pushed = frame.push([
        [
          ["pipeline", pushed],
          ["pipeline", pushed],
        ],
      ]);
    }
    const held = await frame.pull(
      frame.push(["pipeline", 0, ["startRun"], ["notes", ["pipeline", pushed]]])
    );
    frame.close();

    expect({ held, reached: frame.runStarts }).toStrictEqual({
      held: "request.too_large",
      reached: [],
    });
  });

  it("ends the session over anything on the port that isn't its text", async () => {
    const frame = framed();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no target origin
    frame.port.postMessage({ type: "grasp:screen-mounted", trusted: true });
    const after = await poke(frame);
    frame.close();

    expect({
      after,
      reached: frame.runStarts,
      broken: frame.broken.times,
    }).toStrictEqual({ after: "refused", reached: [], broken: 1 });
  });

  it("counts following a workflow's runs as a request, however often a screen does", async () => {
    const frame = framed();
    const followed: unknown[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      followed.push(await outcome(follow(frame.page)));
    }
    frame.close();

    expect({
      followed: followed.filter((result) => result === "followed").length,
      refused: followed.filter((result) => result === "screen.rate_limited")
        .length,
      reachedCore: frame.subscriptions.length,
    }).toStrictEqual({ followed: 20, refused: 5, reachedCore: 20 });
  });

  it("lets go of a live query's subscription, through the page to core, once the screen's client releases it", async () => {
    const frame = framed();
    const transport = bridgeTransport(() => frame.page);
    const followed = await transport.watch("{}", noop, noop);
    followed.release();

    await vi.waitFor(() => {
      expect(frame.subscriptions).toMatchObject([
        { released: true, disposed: true },
      ]);
    });
  });

  it("lets go of every stream the frame follows once closed", async () => {
    const frame = framed();
    const request = JSON.stringify({ reference: {}, input: {} });
    await frame.page.streamFunction("stream", request, ignoreFrame);
    await frame.page.streamFunction("stream", request, ignoreFrame);
    await frame.page.streamFunction("stream", request, ignoreFrame);
    frame.close();
    await vi.waitFor(() => {
      expect(
        frame.streams.map(({ subscription }) => subscription.releasedByPage)
      ).toStrictEqual([true, true, true]);
    });
  });

  it("lets go of a stream still opening when the frame closes, as soon as it opens", async () => {
    const frame = framed();
    const gate = Promise.withResolvers<null>();
    frame.opening.gate = gate.promise;
    const request = JSON.stringify({ reference: {}, input: {} });
    const pending = outcome(
      frame.page.streamFunction("stream", request, ignoreFrame)
    );
    await vi.waitFor(() => {
      expect(frame.streams).toHaveLength(1);
    });
    frame.close();
    gate.resolve(null);
    await pending;
    await vi.waitFor(() => {
      expect(frame.streams[0]?.subscription.releasedByPage).toBeTruthy();
    });
  });

  it("lets go of a stream the frame followed as soon as it ends, not only once closed", async () => {
    const frame = framed();
    const request = JSON.stringify({ reference: {}, input: {} });
    await frame.page.streamFunction("stream", request, ignoreFrame);
    await frame.page.streamFunction("stream", request, ignoreFrame);
    const [first, second] = frame.streams;
    first?.end();
    const whileOpen = frame.streams.map(
      ({ subscription }) => subscription.released
    );
    frame.close();
    await vi.waitFor(() => {
      expect(second?.subscription.released).toBeTruthy();
    });
    // The one that ended was let go of then; the other only at the close.
    expect(whileOpen).toStrictEqual([true, false]);
  });

  it("lets go of what the frame followed, and answers nothing more, once closed", async () => {
    const frame = framed();
    await frame.page.watchRuns("invoices", noop);
    await frame.page.watchRuns("payouts", noop);
    const before = frame.subscriptions.map(({ released }) => released);
    frame.close();
    // Twice does nothing more.
    frame.close();
    const after = await poke(frame);

    await vi.waitFor(() => {
      expect(frame.subscriptions.map(({ released }) => released)).toStrictEqual(
        [true, true]
      );
    });
    expect({
      before,
      after,
      reached: frame.runStarts,
      // Closed by the page itself: nothing broke.
      broken: frame.broken.times,
    }).toStrictEqual({
      before: [false, false],
      after: "refused",
      reached: [],
      broken: 0,
    });
  });

  it("ends the session over references that would copy without end, and a fresh screen still works", async () => {
    const frame = rawFramed();
    // Push "x", then each message an array of two references to the one
    // before: a copy that doubles each step, as GRA-424's probe does.
    frame.push("x");
    for (let level = 1; level <= 16; level += 1) {
      frame.push([
        [
          ["pipeline", level],
          ["pipeline", level],
        ],
      ]);
    }
    await vi.waitFor(() => {
      expect(frame.broken.times).toBe(1);
    });
    frame.close();

    // The tab lives: a fresh bridge still answers a call.
    const fresh = framed();
    const answered = await poke(fresh);
    fresh.close();
    expect(answered).toBe("answered");
  });

  it("ends the session when what the frame never releases holds too much, and a fresh screen still works", async () => {
    const frame = rawFramed();
    // Forty values of four thousand small numbers each, never released:
    // little text (well within what the port holds unread), but a lot of
    // heap once parsed and kept, which the session's bytes don't allow.
    const dense = [Array.from({ length: 4000 }, (_value, index) => index % 10)];
    for (let count = 0; count < 40; count += 1) {
      frame.push(dense);
    }
    await vi.waitFor(() => {
      expect(frame.broken.times).toBe(1);
    });
    frame.close();

    const fresh = framed();
    const answered = await poke(fresh);
    fresh.close();
    expect(answered).toBe("answered");
  });

  it("passes a call with the largest request a screen may send, again and again", async () => {
    const frame = framed();
    // As long as a function call's request may be, each answered and let go.
    const largest = "x".repeat(functionRequestMaxBytes);
    // One after another: each answered, and let go, before the next.
    const answers: unknown[] = [];
    for (let count = 0; count < 5; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in turn on purpose: each call must be answered before the next is sent
      answers.push(await poke(frame, largest));
    }
    frame.close();
    expect({ answers, broken: frame.broken.times }).toStrictEqual({
      answers: ["answered", "answered", "answered", "answered", "answered"],
      broken: 0,
    });
  });
});
