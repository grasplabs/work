import type { ScreenBridge } from "@grasp-os/sdk/screen-runtime";
import { portTransport } from "@grasp-os/shared/screen-port";
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
  const close = openBridge(port1, core.target);
  const page: RpcStub<ScreenBridge> = new RpcSession<ScreenBridge>(
    portTransport(port2)
  ).getRemoteMain();
  return { ...core, close, page, port: port2 };
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

/** A value nested `depth` arrays deep. */
const nested = (depth: number): unknown => {
  let value: unknown = "bottom";
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

const noop = (): void => {
  // Nothing to update.
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

    expect({ fits, tooLong, after, reached: frame.calls.length }).toStrictEqual(
      { fits: "answered", tooLong: "refused", after: "refused", reached: 1 }
    );
  });

  it("ends the session over a value nested deeper than 32", async () => {
    const frame = framed();
    const shallow = await outcome(frame.page.call("notes", [nested(20)]));
    const deep = await outcome(frame.page.call("notes", [nested(40)]));
    frame.close();

    expect({ shallow, deep, reached: frame.calls.length }).toStrictEqual({
      shallow: "answered",
      deep: "refused",
      reached: 1,
    });
  });

  it("ends the session over anything on the port that isn't its text", async () => {
    const frame = framed();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no target origin
    frame.port.postMessage({ type: "grasp:screen-mounted", trusted: true });
    const after = await outcome(frame.page.call("notes", []));
    frame.close();

    expect({ after, reached: frame.calls }).toStrictEqual({
      after: "refused",
      reached: [],
    });
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
    expect({ before, after, reached: frame.calls }).toStrictEqual({
      before: [false, false],
      after: "refused",
      reached: [],
    });
  });
});
