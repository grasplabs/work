import type { ScreenBridge } from "@grasp-os/sdk/screen-runtime";
import { portTransport } from "@grasp-os/shared/screen-port";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { RpcSession, RpcTarget } from "capnweb";
import type { RpcStub } from "capnweb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { openBridge } from "./screen-bridge.ts";
import type { FrameTarget } from "./screen-bridge.ts";

// The page's bridge, from the frame's end of a real `MessagePort`: a
// screen that sends more, bigger and deeper than it may, and a page that
// stops it. Core is stood in for; what core itself refuses is tested
// there (core's screen-bridge.test.ts).

/** Core's hold on a screen's subscription, which says when it's let go. */
class Subscription extends RpcTarget {
  released = false;

  release(): void {
    this.released = true;
  }

  [Symbol.dispose](): void {
    this.released = true;
  }
}

/** What reached core, and what it handed out. */
const coreStandIn = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const reports: string[] = [];
  const subscriptions: Subscription[] = [];
  const target: FrameTarget = {
    call: async (method, args) => {
      calls.push({ method, args });
      return await Promise.resolve("answered");
    },
    report: async (problem) => {
      reports.push(problem.message);
      await Promise.resolve();
    },
    startRun: async () => await Promise.resolve("started"),
    runs: async () => await Promise.resolve([]),
    run: async () => await Promise.resolve("a run"),
    decide: async () => await Promise.resolve("decided"),
    watchRuns: async () => {
      const subscription = new Subscription();
      subscriptions.push(subscription);
      return await Promise.resolve(subscription);
    },
  };
  return { calls, reports, subscriptions, target };
};

/** A frame on its port, talking to the page's bridge as the runtime does. */
const framed = () => {
  const core = coreStandIn();
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

describe("the page's bridge to a screen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a call on to the screen's own target, named by a string", async () => {
    const frame = framed();
    const results = {
      call: await outcome(frame.page.call("notes", ["a"])),
      nameObject: await outcome(
        frame.page.call(unchecked({ toString: () => "notes" }), [])
      ),
      noArguments: await outcome(frame.page.call("notes", unchecked("a"))),
    };
    frame.close();

    expect({ results, reached: frame.calls }).toStrictEqual({
      results: {
        call: "answered",
        nameObject: "screen.invalid",
        noArguments: "screen.invalid",
      },
      reached: [{ method: "notes", args: ["a"] }],
    });
  });

  it("lets a burst of requests through, refuses the rest, and fills again with time", async () => {
    const frame = framed();
    const flood = await Promise.all(
      Array.from({ length: 200 }, async (_value, index) =>
        // Malformed ones count too.
        index % 2 === 0
          ? await outcome(frame.page.call("notes", []))
          : await outcome(frame.page.runs(unchecked(index)))
      )
    );
    const reachedInFlood = frame.calls.length;
    // 120 a minute: two more after a second.
    vi.setSystemTime(1_001_000);
    const later = await Promise.all(
      [0, 0, 0].map(async () => await outcome(frame.page.call("notes", [])))
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
    await frame.page.call("notes", []);
    frame.close();

    expect(frame.reports).toStrictEqual(
      Array.from({ length: 15 }, (_value, index) => `Problem ${index}`)
    );
  });

  it("ends the session over a message longer than 262,144 code units", async () => {
    const frame = framed();
    const fits = await outcome(frame.page.call("notes", ["x".repeat(200_000)]));
    // Half as many signs, each two code units: counted as units, not signs.
    const tooLong = await outcome(
      frame.page.call("notes", ["😀".repeat(140_000)])
    );
    const after = await outcome(frame.page.call("notes", []));
    frame.close();

    expect({
      fits,
      tooLong,
      after,
      reached: frame.calls.length,
      // The page is told, once, so it can say the screen stopped.
      broken: frame.broken.times,
    }).toStrictEqual({
      fits: "answered",
      tooLong: "refused",
      after: "refused",
      reached: 1,
      broken: 1,
    });
  });

  it("passes on a value as deep as values may be, and ends the session over one level more", async () => {
    const frame = framed();
    const deepest = await outcome(
      frame.page.call("notes", [nested(valueDepth)])
    );
    const tooDeep = await outcome(
      frame.page.call("notes", [nested(valueDepth + 1)])
    );
    frame.close();

    expect({
      deepest,
      tooDeep,
      reached: frame.calls,
      broken: frame.broken.times,
    }).toStrictEqual({
      deepest: "answered",
      tooDeep: "refused",
      // Whole, every level of it.
      reached: [{ method: "notes", args: [nested(valueDepth)] }],
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
          ["call"],
          ["notes", [[["pipeline", pushed]]]],
        ])
      );

    const deepest = await called(built(valueDepth - 8, 8));
    const oneMore = await called(built(valueDepth - 8, 9));
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
      reached: frame.calls,
      broken: frame.broken.times,
    }).toStrictEqual({
      deepest: { answered: "answered" },
      oneMore: "request.too_deep",
      farDeeper: "request.too_deep",
      asInput: "request.too_deep",
      after: { answered: "answered" },
      reached: [
        { method: "notes", args: [nested(valueDepth)] },
        { method: "notes", args: ["bottom"] },
      ],
      // The session goes on.
      broken: 0,
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
          ["call"],
          ["notes", [[{ [key]: ["pipeline", pushed] }]]],
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
          ["call"],
          [
            "notes",
            [
              [
                [
                  "error",
                  "AggregateError",
                  "m",
                  null,
                  { errors: ["pipeline", deep] },
                ],
              ],
            ],
          ],
        ])
      ),
    };
    frame.close();

    expect({ outcomes, reached: frame.calls }).toStrictEqual({
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
      frame.push(["pipeline", 0, ["call"], ["notes", [[["pipeline", pushed]]]]])
    );
    frame.close();

    expect({ held, reached: frame.calls }).toStrictEqual({
      held: "request.too_large",
      reached: [],
    });
  });

  it("ends the session over anything on the port that isn't its text", async () => {
    const frame = framed();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no target origin
    frame.port.postMessage({ type: "grasp:screen-mounted", trusted: true });
    const after = await outcome(frame.page.call("notes", []));
    frame.close();

    expect({
      after,
      reached: frame.calls,
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

  it("lets go of what the frame followed, and answers nothing more, once closed", async () => {
    const frame = framed();
    await frame.page.watchRuns("invoices", noop);
    await frame.page.watchRuns("payouts", noop);
    const before = frame.subscriptions.map(({ released }) => released);
    frame.close();
    // Twice does nothing more.
    frame.close();
    const after = await outcome(frame.page.call("notes", []));

    await vi.waitFor(() => {
      expect(frame.subscriptions.map(({ released }) => released)).toStrictEqual(
        [true, true]
      );
    });
    expect({
      before,
      after,
      reached: frame.calls,
      // Closed by the page itself: nothing broke.
      broken: frame.broken.times,
    }).toStrictEqual({
      before: [false, false],
      after: "refused",
      reached: [],
      broken: 0,
    });
  });
});
