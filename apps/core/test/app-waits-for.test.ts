import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { waitsOn } from "../src/app-waits-for.ts";
import type { Hold } from "../src/app-waits-for.ts";

// The walk a call about to wait makes back through other Apps' queues
// (app-waits-for.ts), over queues the test lays out: pure logic, so
// tested on its own. How it can fail: a cycle missed, a hold left behind
// by a call that ended taken on trust (here or in another App), an App
// that can't answer stopping the walk, a walk with no end, and a wide
// round crowding out the chain that closes the cycle.

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
  { limit = 32, selfHolder = "self", failing = new Set<string>() } = {}
): Promise<{ found: boolean; asked: string[] }> => {
  const asked: string[] = [];
  const found = await waitsOn({
    self,
    holding,
    holds: (call) => call === selfHolder,
    ask: async ({ app: asking, call }) => {
      asked.push(asking);
      if (failing.has(asking)) {
        throw new Error("No answer");
      }
      const queue = queues[asking];
      return await Promise.resolve(queue?.holder === call ? queue.waiting : []);
    },
    limit,
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
    const long = await walk([held("0")], line, { limit: 40 });
    expect({
      short: { found: short.found, asked: short.asked.length },
      long: { found: long.found, asked: long.asked.length },
    }).toStrictEqual({
      short: { found: false, asked: 32 },
      long: { found: true, asked: 40 },
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
    expect({ found, askedG: asked.includes(app("g")) }).toStrictEqual({
      found: true,
      askedG: true,
    });
  });
});
