import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { CallQueue } from "../src/app-call-queue.ts";
import { waitsOn } from "../src/app-waits-for.ts";
import type { Hold } from "../src/app-waits-for.ts";

// The walk a call about to wait makes back through other Apps' queues
// (app-waits-for.ts), over queues the test lays out: pure logic, so
// tested on its own. How it can fail: a cycle missed, a hold left behind
// by a call that ended taken on trust (here or in another App), a busy
// App's ended turns using up the limit, a cycle that broke while the walk
// went on still refused, an App that can't answer stopping the walk, a
// walk with no end or that goes on once its call no longer waits, and a
// wide round crowding out the chain that closes the cycle.

const app = (name: string): AppId => appIdSchema.parse(`app-${name}`);

/** `name`'s App, held by the call `name`. */
const held = (name: string): Hold => ({ app: app(name), call: name });

const self = app("self");

/**
 * Who waits for each App, while the call named holds it: an App asked
 * with another call answers nothing, as `App.waitingHolds` does.
 */
type Queues = Record<string, { holder: string; waiting: Hold[][] }>;

/** `waitsOn` for `self` held by `selfHolder`, over `queues`. */
const walk = async (
  holding: Hold[],
  queues: Queues,
  {
    limit = 32,
    selfHolder = "self",
    selfHolds = (call: string): boolean => call === selfHolder,
    failing = new Set<string>(),
    signal = new AbortController().signal,
    onAsk = (_asking: string, _turns: readonly string[]): void => {
      // Nothing changes as the walk asks, unless a test says so.
    },
  } = {}
): Promise<{ found: boolean; asked: string[] }> => {
  const asked: string[] = [];
  const found = await waitsOn({
    self,
    holding,
    holds: selfHolds,
    ask: async (asking, turns) => {
      asked.push(asking);
      onAsk(asking, turns);
      if (failing.has(asking)) {
        throw new Error("No answer");
      }
      const queue = queues[asking];
      return await Promise.resolve(
        queue !== undefined && turns.includes(queue.holder)
          ? { holder: queue.holder, waiting: queue.waiting }
          : undefined
      );
    },
    limit,
    signal,
  });
  return { found, asked };
};

/** Whether `walk` found this App waiting on the call's chain. */
const foundBy = async (...args: Parameters<typeof walk>): Promise<boolean> => {
  const { found } = await walk(...args);
  return found;
};

describe("the walk back through Apps' queues", () => {
  it("finds this App waiting on the call's chain, directly or through others", async () => {
    expect({
      direct: await foundBy([held("a")], {
        [app("a")]: { holder: "a", waiting: [[held("self")]] },
      }),
      throughTwo: await foundBy([held("a")], {
        [app("a")]: { holder: "a", waiting: [[held("b")]] },
        [app("b")]: { holder: "b", waiting: [[held("x"), held("self")]] },
      }),
      none: await foundBy([held("a")], {
        [app("a")]: { holder: "a", waiting: [[held("b")]] },
        [app("b")]: { holder: "b", waiting: [] },
      }),
    }).toStrictEqual({ direct: true, throughTwo: true, none: false });
  });

  it("takes no hold on trust: one whose call no longer holds its App counts for nothing", async () => {
    expect({
      // This App held by another call than the one waiting there.
      selfMovedOn: await foundBy(
        [held("a")],
        { [app("a")]: { holder: "a", waiting: [[held("self")]] } },
        { selfHolder: "later" }
      ),
      // B held by another call than the one that waited for A.
      otherMovedOn: await foundBy([held("a")], {
        [app("a")]: { holder: "a", waiting: [[held("b")]] },
        [app("b")]: { holder: "later", waiting: [[held("self")]] },
      }),
      // The call's own hold, gone by the time it is asked.
      ownMovedOn: await foundBy([held("a")], {
        [app("a")]: { holder: "later", waiting: [[held("self")]] },
      }),
    }).toStrictEqual({
      selfMovedOn: false,
      otherMovedOn: false,
      ownMovedOn: false,
    });
  });

  it("passes over an App that can't answer, and goes on with the others", async () => {
    const queues: Queues = {
      [app("a")]: { holder: "a", waiting: [[held("self")]] },
      [app("b")]: { holder: "b", waiting: [[held("self")]] },
    };
    expect({
      oneAnswers: await foundBy([held("a"), held("b")], queues, {
        failing: new Set([app("a")]),
      }),
      noneAnswers: await foundBy([held("a"), held("b")], queues, {
        failing: new Set([app("a"), app("b")]),
      }),
    }).toStrictEqual({ oneAnswers: true, noneAnswers: false });
  });

  it("asks no more Apps than its limit, and finds a cycle among that many", async () => {
    // A line of 40 Apps, each waiting for the one before, this App last.
    const line: Queues = {};
    for (let at = 0; at < 40; at += 1) {
      line[app(`${at}`)] = {
        holder: `${at}`,
        waiting: [[at === 39 ? held("self") : held(`${at + 1}`)]],
      };
    }
    const short = await walk([held("0")], line, { limit: 32 });
    expect({
      short: { found: short.found, asked: short.asked.length },
      long: await foundBy([held("0")], line, { limit: 40 }),
    }).toStrictEqual({
      short: { found: false, asked: 32 },
      long: true,
    });
  });

  it("asks each hold once, however many chains wait on it, so a cycle elsewhere ends", async () => {
    const { found, asked } = await walk([held("a")], {
      [app("a")]: { holder: "a", waiting: [[held("b")], [held("b")]] },
      [app("b")]: { holder: "b", waiting: [[held("a")]] },
    });
    expect({ found, asked }).toStrictEqual({
      found: false,
      asked: [app("a"), app("b")],
    });
  });

  it("goes on first, in a round wider than it may ask, along chains already on the walk", async () => {
    // A's queue holds more fresh chains than the walk may still ask, and
    // last one through B, already asked, whose chain goes on to G: G
    // waits on this App.
    const queues: Queues = {
      [app("a")]: {
        holder: "a",
        waiting: [
          [held("f1")],
          [held("f2")],
          [held("f3")],
          [held("b"), held("g")],
        ],
      },
      [app("b")]: { holder: "b", waiting: [] },
      [app("g")]: { holder: "g", waiting: [[held("self")]] },
    };
    const { found, asked } = await walk([held("a"), held("b")], queues, {
      limit: 4,
    });
    expect({
      found,
      askedG: asked.includes(app("g")),
      // Two Apps were left to ask in that round: G and F1.
      askedF2: asked.includes(app("f2")),
    }).toStrictEqual({ found: true, askedG: true, askedF2: false });
  });

  it("asks a busy App about all its turns at once, so the ones that ended don't use up the limit", async () => {
    // 31 calls wait for B holding turns of A that have ended, and one
    // holding the turn of A that holds it now, which waits on this App.
    const ended = Array.from({ length: 31 }, (_, at) => [
      { app: app("a"), call: `ended-${at}` },
    ]);
    // How often the walk asked A before it found the cycle and asked
    // about it again (about A's current turn alone).
    let askedAWalking = 0;
    const found = await foundBy(
      [held("b")],
      {
        [app("b")]: { holder: "b", waiting: [...ended, [held("a")]] },
        [app("a")]: { holder: "a", waiting: [[held("self")]] },
      },
      {
        limit: 2,
        onAsk: (asking, turns) => {
          askedAWalking += asking === app("a") && turns.length > 1 ? 1 : 0;
        },
      }
    );
    expect({ found, askedAWalking }).toStrictEqual({
      found: true,
      askedAWalking: 1,
    });
  });

  it("refuses nothing once a cycle it found broke while it went on", async () => {
    const queues: Queues = {
      [app("a")]: { holder: "a", waiting: [[held("b")]] },
      [app("b")]: { holder: "b", waiting: [[held("self")]] },
    };
    // B's call stops waiting for A once A answered, before B is asked.
    const found = await foundBy([held("a")], queues, {
      onAsk: (asking) => {
        if (asking === app("b")) {
          queues[app("a")] = { holder: "a", waiting: [] };
        }
      },
    });
    // This App's turn ends once the walk found it, before the cycle is
    // asked about again.
    let selfAsked = false;
    const selfMovedOn = await foundBy(
      [held("a")],
      {
        [app("a")]: { holder: "a", waiting: [[held("b")]] },
        [app("b")]: { holder: "b", waiting: [[held("self")]] },
      },
      {
        selfHolds: (call) => {
          const holdsNow = call === "self" && !selfAsked;
          selfAsked = true;
          return holdsNow;
        },
      }
    );
    expect({ found, selfMovedOn }).toStrictEqual({
      found: false,
      selfMovedOn: false,
    });
  });

  it("asks nothing more once the call no longer waits", async () => {
    const left = new AbortController();
    const { found, asked } = await walk(
      [held("a")],
      {
        [app("a")]: { holder: "a", waiting: [[held("b")]] },
        [app("b")]: { holder: "b", waiting: [[held("self")]] },
      },
      {
        signal: left.signal,
        onAsk: () => {
          left.abort();
        },
      }
    );
    expect({ found, asked }).toStrictEqual({ found: false, asked: [app("a")] });
  });

  it("asks about each cycle found again at most once, and none once the call no longer waits", async () => {
    // Ten calls waiting for A each close the same cycle, which breaks as
    // the walk asks about it again.
    const queues: Queues = {
      [app("a")]: {
        holder: "a",
        waiting: Array.from({ length: 10 }, () => [held("self")]),
      },
    };
    let askedA = 0;
    const once = await walk([held("a")], queues, {
      onAsk: (asking) => {
        askedA += asking === app("a") ? 1 : 0;
        if (askedA === 2) {
          queues[app("a")] = { holder: "a", waiting: [] };
        }
      },
    });
    // Three cycles found in one round; as the first is asked about again,
    // it has broken and the call stops waiting.
    const left = new AbortController();
    const three: Queues = {
      [app("a")]: { holder: "a", waiting: [[held("self")]] },
      [app("b")]: { holder: "b", waiting: [[held("self")]] },
      [app("c")]: { holder: "c", waiting: [[held("self")]] },
    };
    let askedAgain = 0;
    const stopped = await walk([held("a"), held("b"), held("c")], three, {
      signal: left.signal,
      onAsk: (asking) => {
        askedAgain += asking === app("a") ? 1 : 0;
        if (askedAgain === 2) {
          three[app("a")] = { holder: "a", waiting: [] };
          left.abort();
        }
      },
    });
    expect({ once, stopped }).toStrictEqual({
      once: { found: false, asked: [app("a"), app("a")] },
      stopped: {
        found: false,
        asked: [app("a"), app("b"), app("c"), app("a")],
      },
    });
  });
});

describe("a call's check as it waits its turn", () => {
  it("is told once its call no longer waits: let in, or given up", async () => {
    const queue = new CallQueue<string>(4);
    const release = await queue.turn(
      new AbortController().signal,
      () => new Error("busy"),
      "first"
    );
    const signals: AbortSignal[] = [];
    // Finds nothing, so each call waits on.
    const found: Error[] = [];
    const check = async (left: AbortSignal): Promise<Error | undefined> => {
      signals.push(left);
      await Promise.resolve();
      return found[0];
    };
    const letIn = queue.turn(
      new AbortController().signal,
      () => new Error("busy"),
      "second",
      {
        tag: "second",
        check,
      }
    );
    const deadline = new AbortController();
    const givenUp = queue.turn(
      deadline.signal,
      () => new Error("busy"),
      "third",
      {
        tag: "third",
        check,
      }
    );
    const before = signals.map(({ aborted }) => aborted);
    deadline.abort();
    const gaveUp = await givenUp.then(
      () => "let in",
      () => "gave up"
    );
    release();
    const releaseSecond = await letIn;
    releaseSecond();
    expect({
      before,
      gaveUp,
      after: signals.map(({ aborted }) => aborted),
      holder: queue.holder(),
    }).toStrictEqual({
      before: [false, false],
      gaveUp: "gave up",
      after: [true, true],
      holder: undefined,
    });
  });
});
