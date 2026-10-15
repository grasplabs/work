import { authErrors } from "@grasp-os/shared/errors";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { activeChat, setActiveChat } from "./chat/active-chat.ts";
import { CoreConnection, signOut } from "./core-connection.ts";
import type { SessionEnded } from "./core-connection.ts";
import { CoreTimeoutError } from "./core.ts";
import { tabLink } from "./screens/tab-link.ts";

// The tab's one connection to core (spec 11.2), shared by the shell and
// every App frame, with a stand-in for core: what each new connection
// says about who is signed in on it is all the tab learns. How it could
// go wrong, each tried below: frames opening connections of their own; a
// frame waiting for a reconnect giving up as the shell's calls do; a
// reconnect as someone else, or as nobody, handed to anyone, or leaving a
// frame running; a frame that joins after the end handed a stub; a
// connection that answers after the end handed out; one frame's stop
// keeping the others running; reconnects outside 1 to 30 s, or all at the
// same moment.

/**
 * Who a new connection says is signed in: a person (once `held` lets it
 * answer, if given), nobody, or core down.
 */
type Answer = { userId: string; held?: Promise<unknown> } | "nobody" | "down";

/** A stand-in connection to core, and what happened to it. */
interface Fake {
  readonly answer: Answer;
  disposed: boolean;
  /** Breaks it, as a dropped socket does. */
  break: () => void;
  readonly session: object;
}

/**
 * A tab on a stand-in core: `answers` says who each new connection finds
 * signed in, in turn, the last for every connection after.
 */
const tab = (answers: Answer[]) => {
  const opened: Fake[] = [];
  const ended: string[] = [];
  let back: (() => void) | undefined;
  const core = new CoreConnection({
    onSessionEnded: () => {
      ended.push("page reloads");
    },
    connect: () => {
      const answer = answers[Math.min(opened.length, answers.length - 1)];
      if (answer === undefined) {
        throw new Error("No answer scripted.");
      }
      let broken: (() => void) | undefined;
      const session = {
        whoami: async () =>
          await Promise.resolve(
            typeof answer === "object" ? { userId: answer.userId } : {}
          ),
      };
      const fake: Fake = {
        answer,
        disposed: false,
        break: () => {
          broken?.();
        },
        session,
      };
      opened.push(fake);
      const stub = {
        authenticate: async () => {
          await (typeof answer === "object" ? answer.held : undefined);
          if (answer === "down") {
            throw new Error("The socket closed.");
          }
          if (answer === "nobody") {
            throw authErrors.create("auth.unauthenticated");
          }
          return session;
        },
        ping: async () => await Promise.resolve("pong"),
        onRpcBroken: (onBroken: () => void) => {
          broken = onBroken;
        },
        [Symbol.dispose]: () => {
          fake.disposed = true;
        },
      };
      // SAFETY: a stand-in for the parts of core's API the connection uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return stub as never;
    },
    watchPage: (onBack) => {
      back = onBack;
    },
  });
  return {
    core,
    opened,
    ended,
    comeBack: () => {
      back?.();
    },
  };
};

/** A frame on `core`: what it was told of the session ending. */
const frameOn = (core: CoreConnection) => {
  const told: SessionEnded[] = [];
  const joined = tabLink(core, (why) => {
    told.push(why);
  });
  return { ...joined, told };
};

/** The code `promise` is refused with. */
const refusal = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return "answered";
  } catch (error) {
    return authErrors.codeOf(error) ?? error;
  }
};

const one = { userId: "one" };
const two = { userId: "two" };

describe("the tab's one connection to core", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves the shell and every App frame over one connection", async () => {
    const { core, opened } = tab([one]);
    const shell = await core.session();
    const first = frameOn(core);
    const second = frameOn(core);

    const seen = [await first.link.session(), await second.link.session()];
    expect(seen).toStrictEqual([shell, shell]);
    await expect(first.link.person()).resolves.toBe("one");

    // A frame that leaves takes nothing from the others.
    first.leave();
    await expect(second.link.session()).resolves.toBe(shell);
    expect(opened.map(({ disposed }) => disposed)).toStrictEqual([false]);
  });

  it("lets a frame wait out a reconnect as long as it takes, while the shell's call gives up in its seconds", async () => {
    const { core, opened } = tab([one, "down", "down", "down", "down", one]);
    const before = await core.session();
    const frame = frameOn(core);
    opened[0]?.break();

    const shell = refusal(core.session());
    const waiting = frame.link.session();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(shell).resolves.toBeInstanceOf(CoreTimeoutError);

    // Core comes back after several attempts, a minute on.
    await vi.advanceTimersByTimeAsync(60_000);
    const after = await waiting;
    expect(after).not.toBe(before);
    expect({ after, told: frame.told }).toStrictEqual({
      after: opened.at(-1)?.session,
      told: [],
    });
  });

  it("sends nothing a frame asked for once it left, when core is back", async () => {
    const { core, opened } = tab([one, "down", one]);
    await core.session();
    const frame = frameOn(core);
    opened[0]?.break();
    const sent: string[] = [];
    const opening = refusal(
      frame.link.retrying(async () => {
        sent.push("open");
        return await Promise.resolve("opened");
      })
    );

    frame.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect({
      refused: (await opening) instanceof Error,
      sent,
    }).toStrictEqual({ refused: true, sent: [] });
    // The connection stays, for the tab's other frames and its shell.
    await expect(core.session()).resolves.toBe(opened.at(-1)?.session);
  });

  it.each([
    { found: two, why: "principal-changed", code: "auth.principal_changed" },
    { found: "nobody", why: "signed-out", code: "auth.unauthenticated" },
  ] as const)(
    "stops every frame before the page reloads when a reconnect finds $why, and hands the connection to nobody",
    async ({ found, why, code }) => {
      const { core, opened, ended } = tab([one, found]);
      await core.session();
      const first = frameOn(core);
      const second = frameOn(core);
      setActiveChat("their-chat");
      // Into the same record as the page's reload, so the order is seen.
      const listening = core.onEnded(() => {
        ended.push("frame stopped");
      });
      opened[0]?.break();
      const waiting = refusal(first.link.session());
      await vi.advanceTimersByTimeAsync(1000);

      expect({
        told: [first.told, second.told],
        order: ended,
        disposed: opened[1]?.disposed,
        waiting: await waiting,
        chat: activeChat(),
      }).toStrictEqual({
        told: [[why], [why]],
        order: ["frame stopped", "page reloads"],
        disposed: true,
        waiting: code,
        chat: undefined,
      });

      // Nobody gets a stub after the end, a frame that joins late neither.
      const late = frameOn(core);
      expect({
        frame: await refusal(late.link.session()),
        shell: await refusal(core.api()),
        told: late.told,
      }).toStrictEqual({ frame: code, shell: code, told: [] });
      listening();
    }
  );

  it("ends for every frame once a frame is told by core the browser's session is someone else's", async () => {
    const { core, opened, ended } = tab([one]);
    await core.session();
    const first = frameOn(core);
    const second = frameOn(core);
    const gone = frameOn(core);
    gone.leave();

    first.end("principal-changed");

    expect({
      told: [first.told, second.told, gone.told],
      ended,
      disposed: opened[0]?.disposed,
      session: await refusal(second.link.session()),
    }).toStrictEqual({
      told: [["principal-changed"], ["principal-changed"], []],
      ended: ["page reloads"],
      disposed: true,
      session: "auth.principal_changed",
    });

    // Once only: ending again tells nobody twice.
    second.end("principal-changed");
    expect({ told: first.told, ended }).toStrictEqual({
      told: ["principal-changed"],
      ended: ["page reloads"],
    });
  });

  it("stops every frame when the person signs out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(new Response("{}")))
    );
    const { core, ended } = tab([one]);
    await core.session();
    const frame = frameOn(core);

    await signOut(core);

    expect(frame.told).toStrictEqual(["signed-out"]);
    expect(ended).toStrictEqual(["page reloads"]);
    await expect(refusal(frame.link.session())).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("tells every frame, and still reloads, when stopping one of them throws", async () => {
    const { core, ended } = tab([one]);
    await core.session();
    tabLink(core, () => {
      throw new Error("The frame was gone already.");
    });
    const after = frameOn(core);

    expect(() => {
      core.end("signed-out");
    }).toThrow(AggregateError);
    expect(after.told).toStrictEqual(["signed-out"]);
    expect(ended).toStrictEqual(["page reloads"]);
  });

  it("lets go of a connection that answers after the session ended", async () => {
    const held = Promise.withResolvers<boolean>();
    const { core, opened } = tab([one, { ...one, held: held.promise }]);
    await core.session();
    const frame = frameOn(core);
    opened[0]?.break();
    // The reconnect is under way when the page ends the session.
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toHaveLength(2);
    const waiting = refusal(frame.link.session());
    core.end("signed-out");
    held.resolve(true);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(waiting).resolves.toBe("auth.unauthenticated");
    expect(opened[1]?.disposed).toBeTruthy();
    expect(opened).toHaveLength(2);
  });

  it("waits up to a ceiling that doubles from 1 s to 30 s between reconnects, with full jitter", async () => {
    const { core, opened } = tab([one, "down"]);
    await core.session();
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    opened[0]?.break();
    const attempts: number[] = [];
    const start = Date.now();
    for (let second = 0; second <= 120; second += 1) {
      const before = opened.length;
      // oxlint-disable-next-line no-await-in-loop -- one second at a time
      await vi.advanceTimersByTimeAsync(1000);
      if (opened.length > before) {
        attempts.push((Date.now() - start) / 1000);
      }
    }
    expect(attempts.slice(0, 7)).toStrictEqual([1, 3, 7, 15, 31, 61, 91]);

    // Jittered: anywhere from no wait up to the ceiling, here half of it.
    random.mockReturnValue(0.5);
    await vi.advanceTimersByTimeAsync(30_000);
    const now = opened.length;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(opened).toHaveLength(now + 3);
  });

  it("tries at once when someone asks for core, instead of waiting out its pause", async () => {
    const { core, opened } = tab([one, "down", "down", one]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);
    opened[0]?.break();
    // Two failed attempts in: the next pause is 4 s.
    await vi.advanceTimersByTimeAsync(3000);
    expect(opened).toHaveLength(3);

    // Asked twice at once: one attempt, which both get.
    const asked = [core.session(), core.session()];
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toHaveLength(4);
    await expect(Promise.all(asked)).resolves.toStrictEqual([
      opened[3]?.session,
      opened[3]?.session,
    ]);
  });

  it("tries at once when the page comes back, once per pause however often it does", async () => {
    const { core, opened, comeBack } = tab([one, "down", "down", one]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);
    opened[0]?.break();
    await vi.advanceTimersByTimeAsync(1000);
    // The next pause is 2 s.
    expect(opened).toHaveLength(2);
    const frame = frameOn(core);
    const waiting = frame.link.session();

    // Back several times at once: one attempt, then the next pause (4 s).
    for (let times = 0; times < 5; times += 1) {
      comeBack();
    }
    await vi.advanceTimersByTimeAsync(3999);
    expect(opened).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe(opened[3]?.session);
  });

  it("asks again at a jittered moment when a frame's call fails in a way that may pass", async () => {
    const { core } = tab([one]);
    await core.session();
    const frame = frameOn(core);
    const random = vi.spyOn(Math, "random");
    const asked = async (draw: number): Promise<number[]> => {
      random.mockReturnValue(draw);
      const at: number[] = [];
      const start = Date.now();
      await refusal(
        frame.link.retrying(async () => {
          at.push(Date.now() - start);
          await Promise.resolve();
          if (at.length === 1) {
            throw new Error("The connection broke.");
          }
        })
      );
      return at;
    };

    const early = asked(0);
    await vi.advanceTimersByTimeAsync(1000);
    const late = asked(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect({ early: await early, late: await late }).toStrictEqual({
      early: [0, 500],
      late: [0, 1000],
    });
  });

  it("makes no more reconnect attempts than its pauses allow, however often App frames ask", async () => {
    const { core, opened } = tab([one, "down"]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const frames = [frameOn(core), frameOn(core), frameOn(core)];
    opened[0]?.break();
    const attempts: number[] = [];
    const start = Date.now();
    for (let tick = 0; tick < 400; tick += 1) {
      for (const frame of frames) {
        void refusal(frame.link.session());
        void refusal(
          frame.link.retrying(async () => await Promise.resolve("asked"))
        );
      }
      const before = opened.length;
      // oxlint-disable-next-line no-await-in-loop -- a tenth of a second at a time
      await vi.advanceTimersByTimeAsync(100);
      if (opened.length > before) {
        attempts.push(Math.round((Date.now() - start) / 100) / 10);
      }
    }
    expect(attempts).toStrictEqual([1, 3, 7, 15, 31]);
  });
});
