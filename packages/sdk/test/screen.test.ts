/* oxlint-disable max-classes-per-file -- the fake page, and the subscriptions it answers as core does */
import { portTransport } from "@grasp-os/shared/screen-port";
import { RpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  bridge,
  bridgeTransport,
  connectBridge,
} from "../src/screen-runtime.ts";
import { followRun, followRuns } from "../src/screen.ts";

// The screen's workflow hooks and stream transport from the side of the
// page: the screen's runtime connects to a fake page over a real
// `MessagePort`, as in the frame, and the page plays core.

type Callback = (value: unknown) => Promise<void>;

/** Serves `page` on `port` as the page does: each message as text. */
const servePage = (port: MessagePort, page: RpcTarget): Disposable =>
  new RpcSession(portTransport(port), page).getRemoteMain();

/** A callback the screen passed, as the page receives it. */
const isCallback = (value: unknown): value is RpcStub<Callback> =>
  value instanceof RpcStub;

/** A run subscription the page answers, as core's is: released once. */
interface FakeFollower {
  workflow: string;
  callback: RpcStub<Callback>;
  released: boolean;
}

/** Most run subscriptions core lets one open screen hold. */
const maxRunSubscriptions = 20;

/** Core's answer to `watchRuns`, which the screen releases. */
class FakeHold extends RpcTarget {
  readonly #follower: FakeFollower;

  constructor(follower: FakeFollower) {
    super();
    this.#follower = follower;
  }

  release(): void {
    this.#follower.released = true;
  }
}

/** Core's answer to `streamFunction`, released and then let go of. */
class FakeStream extends RpcTarget {
  released = false;
  disposed = false;

  release(): void {
    this.released = true;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

/** The page's side of the bridge. */
class FakePage extends RpcTarget {
  readonly streams: FakeStream[] = [];

  streamFunction(): FakeStream {
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream;
  }

  /** The input the screen was opened with: none here. */
  readonly opened: null = null;

  input(): null {
    return this.opened;
  }

  // Each read of runs waits on a promise of its own, which a test resolves
  // or rejects in any order.
  readonly reads: PromiseWithResolvers<unknown>[] = [];
  readonly followers: FakeFollower[] = [];

  async runs(): Promise<unknown> {
    const read = Promise.withResolvers<unknown>();
    this.reads.push(read);
    return await read.promise;
  }

  // Runs by ID, as core keeps them, whatever the list holds; each read
  // of one is counted.
  readonly known = new Map<string, unknown>();
  readonly runReads: string[] = [];

  run(id: string): unknown {
    this.runReads.push(id);
    if (!this.known.has(id)) {
      throw Object.assign(new Error("There's no such workflow run."), {
        code: "workflow.run_not_found",
      });
    }
    return this.known.get(id);
  }

  /** Core's limit too: at most 20 subscriptions not released. */
  watchRuns(workflow: string, onChange: unknown): FakeHold {
    if (!isCallback(onChange)) {
      throw new Error("Not a callback");
    }
    const held = this.followers.filter(({ released }) => !released);
    if (held.length >= maxRunSubscriptions) {
      throw new Error("screen.too_many_subscriptions");
    }
    const follower = { workflow, callback: onChange.dup(), released: false };
    this.followers.push(follower);
    return new FakeHold(follower);
  }
}

/** The code a refusal carries, as core sends it. */
const codeOf = (refusal: unknown): unknown =>
  typeof refusal === "object" && refusal !== null && "code" in refusal
    ? refusal.code
    : undefined;

/**
 * Waits until everything the screen sent before now has reached the page,
 * and the page's messages before now have reached the screen: a round trip
 * over the same port, which keeps messages in order.
 */
const roundTrip = async (): Promise<void> => {
  await bridge().input();
};

describe("a screen's stream transport", () => {
  let page: FakePage;
  let sessions: Disposable[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port1, port2 } = new MessageChannel();
    page = new FakePage();
    sessions = [servePage(port2, page), connectBridge(port1)];
  });

  afterEach(() => {
    for (const session of sessions) {
      session[Symbol.dispose]();
    }
    vi.useRealTimers();
  });

  it("lets go of a stream's subscription once it is released, so the page holds none", async () => {
    const { port1, port2 } = new MessageChannel();
    const streaming = new FakePage();
    const served = servePage(port2, streaming);
    const connected = connectBridge(port1);
    try {
      const transport = bridgeTransport(() => connected);
      const stream = await transport.stream?.("stream", "{}", () => {
        // No frames here.
      });
      await stream?.release();
      await vi.waitFor(() => {
        expect(
          streaming.streams.map(({ released, disposed }) => ({
            released,
            disposed,
          }))
        ).toStrictEqual([{ released: true, disposed: true }]);
      });
    } finally {
      connected[Symbol.dispose]();
      served[Symbol.dispose]();
    }
  });
});

/**
 * A workflow of the test's own: the frame keeps one subscription per
 * workflow for as long as it lives, across tests too.
 */
const workflow = (): string => `workflow-${crypto.randomUUID()}`;

/** A screen that shows nothing. */
const noop = (): void => {
  // Nothing to show.
};

describe(followRuns, () => {
  let page: FakePage;
  let sessions: Disposable[] = [];

  beforeEach(() => {
    const { port1, port2 } = new MessageChannel();
    page = new FakePage();
    sessions = [servePage(port2, page), connectBridge(port1)];
  });

  afterEach(() => {
    for (const session of sessions) {
      session[Symbol.dispose]();
    }
    vi.useRealTimers();
  });

  /** Until what the screen sent has reached the page and been answered. */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one round trip after another
      await roundTrip();
    }
  };

  /** The page's `index`th read, which the screen has made by now. */
  const readAt = (index: number): PromiseWithResolvers<unknown> => {
    const read = page.reads[index];
    if (!read) {
      throw new Error(`No read ${index} of ${page.reads.length}`);
    }
    return read;
  };

  /** Tells the screen a run of `name` changed, as core does. */
  const push = async (name: string): Promise<void> => {
    const follower = page.followers.findLast((each) => each.workflow === name);
    if (!follower) {
      throw new Error(`Not following ${name}`);
    }
    await follower.callback({ run: "run-1" });
  };

  it("reads the runs at once, once it follows, and on each change, and never shows an older read over a newer one", async () => {
    const name = workflow();
    const shown: unknown[] = [];
    const stop = followRuns(name, (runs) => {
      shown.push(runs);
    });
    await settle();
    // One read at once, one once core follows for it.
    const [first, second] = [readAt(0), readAt(1)];
    second.resolve(["newer"]);
    await settle();
    first.resolve(["older"]);
    await settle();
    await push(name);
    await settle();
    readAt(2).resolve(["pushed"]);
    await settle();
    stop();

    expect(shown).toStrictEqual([["newer"], ["pushed"]]);
  });

  it("shows no runs and the refusal once core refuses the build as revoked, and reads no more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const name = workflow();
    const shown: unknown[] = [];
    const refused: unknown[] = [];
    const stop = followRuns(
      name,
      (runs) => {
        shown.push(runs);
      },
      (refusal) => {
        refused.push(codeOf(refusal));
      }
    );
    await settle();
    readAt(0).resolve(["run-1"]);
    await settle();
    const revoked = Object.assign(new Error("Revoked."), {
      code: "screen.revoked",
    });
    readAt(1).reject(revoked);
    await settle();
    const reads = page.reads.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    // Told a run changed after: it reads no more.
    await push(name);
    await settle();
    stop();
    expect({
      shown,
      refused,
      readsAfter: page.reads.length - reads,
    }).toStrictEqual({
      shown: [["run-1"], []],
      refused: ["screen.revoked"],
      readsAfter: 0,
    });
  });

  it("tries a failed read again, backing off, until one shows, the first read too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const name = workflow();
    const shown: unknown[] = [];
    const stop = followRuns(name, (runs) => {
      shown.push(runs);
    });
    await settle();
    readAt(0).reject(new Error("Core can't be reached"));
    readAt(1).reject(new Error("Core can't be reached"));
    await settle();
    const beforeRetry = page.reads.length;
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    readAt(2).reject(new Error("Still not"));
    await settle();
    // Twice as long before the next try.
    await vi.advanceTimersByTimeAsync(1999);
    await settle();
    const beforeSecondRetry = page.reads.length;
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    readAt(3).resolve(["recovered"]);
    await settle();
    // A failure after that keeps what it showed until a try succeeds.
    await push(name);
    await settle();
    readAt(4).reject(new Error("Gone again"));
    await settle();
    const afterFailure = [...shown];
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    readAt(5).resolve(["again"]);
    await settle();
    stop();

    expect({
      beforeRetry,
      beforeSecondRetry,
      afterFailure,
      shown,
    }).toStrictEqual({
      beforeRetry: 2,
      beforeSecondRetry: 3,
      afterFailure: [["recovered"]],
      shown: [["recovered"], ["again"]],
    });
  });

  it("shows nothing more once stopped, releases its subscription, and rejects what core still sends", async () => {
    const name = workflow();
    const shown: unknown[] = [];
    const stop = followRuns(name, (runs) => {
      shown.push(runs);
    });
    await settle();
    stop();
    readAt(0).resolve(["late"]);
    readAt(1).reject(new Error("Not tried again"));
    await settle();
    const pushed = await push(name).then(
      () => "delivered",
      () => "rejected"
    );
    await settle();

    expect({
      shown,
      reads: page.reads.length,
      released: page.followers.map(({ released }) => released),
      pushed,
    }).toStrictEqual({
      shown: [],
      reads: 2,
      released: [true],
      pushed: "rejected",
    });
  });

  it("shares one subscription among a workflow's followers, and releases it once the last stops", async () => {
    const name = workflow();
    const stopFirst = followRuns(name, noop);
    const stopSecond = followRuns(name, noop);
    await settle();
    const whileBoth = page.followers.map(({ released }) => released);
    stopFirst();
    await settle();
    const afterFirst = page.followers.map(({ released }) => released);
    stopSecond();
    await settle();

    expect({
      whileBoth,
      afterFirst,
      afterBoth: page.followers.map(({ released }) => released),
    }).toStrictEqual({
      whileBoth: [false],
      afterFirst: [false],
      afterBoth: [true],
    });
  });

  it("still follows live after screens followed and stopped 21 workflows in turn", async () => {
    for (let time = 0; time < maxRunSubscriptions; time += 1) {
      followRuns(workflow(), noop)();
      // oxlint-disable-next-line no-await-in-loop -- one screen after another
      await settle();
    }
    const name = workflow();
    const shown: unknown[] = [];
    const stop = followRuns(name, (runs) => {
      shown.push(runs);
    });
    await settle();
    for (const read of page.reads) {
      read.resolve(["before"]);
    }
    await settle();
    await push(name);
    await settle();
    page.reads.at(-1)?.resolve(["pushed"]);
    await settle();
    stop();
    await settle();

    expect({
      held: page.followers.filter(({ released }) => !released).length,
      shown: shown.at(-1),
    }).toStrictEqual({ held: 0, shown: ["pushed"] });
  });
});

describe(followRun, () => {
  let page: FakePage;
  let sessions: Disposable[] = [];

  beforeEach(() => {
    const { port1, port2 } = new MessageChannel();
    page = new FakePage();
    sessions = [servePage(port2, page), connectBridge(port1)];
  });

  afterEach(() => {
    for (const session of sessions) {
      session[Symbol.dispose]();
    }
  });

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one round trip after another
      await roundTrip();
    }
  };

  it("reads a run by its ID, however old, again when its workflow's runs change, and null for one core has none of", async () => {
    const name = workflow();
    // Not among the newest 100 the list shows: never listed at all here.
    page.known.set("run-old", { id: "run-old", status: "running" });
    const shown: unknown[] = [];
    const missing: unknown[] = [];
    const stop = followRun(name, "run-old", (run) => {
      shown.push(run);
    });
    const stopMissing = followRun(name, "run-gone", (run) => {
      missing.push(run);
    });
    await settle();
    page.known.set("run-old", { id: "run-old", status: "completed" });
    const follower = page.followers.findLast((each) => each.workflow === name);
    await follower?.callback({ run: "run-old" });
    await settle();
    stop();
    stopMissing();
    await settle();

    expect({
      last: shown.at(-1),
      missing: [...new Set(missing)],
      listed: page.reads.length,
    }).toStrictEqual({
      last: { id: "run-old", status: "completed" },
      missing: [null],
      listed: 0,
    });
  });
});
