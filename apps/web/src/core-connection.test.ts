// @vitest-environment happy-dom
import { authErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { activeChat, setActiveChat } from "./chat/active-chat.ts";
import { slotOf } from "./chat/chat-subject.ts";
import {
  CoreConnection,
  frameReadMs,
  heartbeatMs,
  heldPingMs,
  shellStatus,
  signOut,
} from "./core-connection.ts";
import type { HostCheck, SessionEnded } from "./core-connection.ts";
import { CoreTimeoutError } from "./core.ts";
import { tabLink } from "./pages/tab-link.ts";
import { keepChatLink, pendingChatLink } from "./settings/chat-link.ts";

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
type Answer =
  | {
      userId: string;
      name?: string;
      held?: Promise<unknown>;
      /** Their session ended: core refuses to say who they are. */
      gone?: boolean;
    }
  | "nobody"
  | "down";

/** A stand-in connection to core, and what happened to it. */
interface Fake {
  readonly answer: Answer;
  disposed: boolean;
  /** Breaks it, as a dropped socket does. */
  break: () => void;
  /** Stops it answering anything, without saying so, as a socket the network died under. */
  silence: () => void;
  /** Answers every ping it held back since, as a socket that recovers. */
  speak: () => void;
  readonly session: object;
}

/**
 * A tab on a stand-in core: `answers` says who each new connection finds
 * signed in, in turn, the last for every connection after.
 */
const tab = (answers: Answer[]) => {
  /**
   * Whether the tab is in front, what a fresh request to core finds, and
   * how long core takes to say it.
   */
  const page: { visible: boolean; host: HostCheck; hostTakesMs: number } = {
    visible: true,
    host: "answers",
    hostTakesMs: 0,
  };
  const opened: Fake[] = [];
  const ended: string[] = [];
  /** What the tab asked core, by name, on any connection. */
  const asked: string[] = [];
  let back: (() => void) | undefined;
  let offline: (() => void) | undefined;
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
      let silent = false;
      const held: (() => void)[] = [];
      const session = {
        whoami: async () => {
          asked.push("whoami");
          if (typeof answer !== "object") {
            return await Promise.resolve({});
          }
          // As it is when asked: a test may rename the person meanwhile.
          const { userId, name, gone } = answer;
          if (gone === true) {
            throw authErrors.create("auth.unauthenticated");
          }
          return await Promise.resolve(
            name === undefined ? { userId } : { userId, name }
          );
        },
      };
      const fake: Fake = {
        answer,
        disposed: false,
        break: () => {
          broken?.();
        },
        silence: () => {
          silent = true;
        },
        speak: () => {
          silent = false;
          for (const pong of held.splice(0)) {
            pong();
          }
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
        ping: async () => {
          asked.push("ping");
          if (silent) {
            const later = Promise.withResolvers<string>();
            held.push(() => {
              later.resolve("pong");
            });
            return await later.promise;
          }
          return await Promise.resolve("pong");
        },
        signInOptions: async () => {
          asked.push("signInOptions");
          return await Promise.resolve([]);
        },
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
    watchPage: (onBack, onOffline) => {
      back = onBack;
      offline = onOffline;
    },
    clock: { now: () => Date.now(), visible: () => page.visible },
    checkHost: async () => {
      const said = Promise.withResolvers<HostCheck>();
      setTimeout(() => {
        said.resolve(page.host);
      }, page.hostTakesMs);
      return await said.promise;
    },
  });
  return {
    core,
    page,
    opened,
    ended,
    asked,
    comeBack: () => {
      back?.();
    },
    goOffline: () => {
      offline?.();
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
    // Each pause its whole ceiling. The shell's call cuts the first (1 s)
    // short; the four after it (2, 4, 8 and 16 s) keep core out for 30 s,
    // longer than the shell waits. Drawn at random, they could add up to
    // less than its five seconds.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { core, opened } = tab([one, "down", "down", "down", "down", one]);
    const before = await core.session();
    const frame = frameOn(core);
    opened[0]?.break();

    const shell = refusal(core.session());
    const waiting = frame.link.session();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(shell).resolves.toBeInstanceOf(CoreTimeoutError);

    // Core comes back after several attempts, half a minute on.
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
      setActiveChat("their-app-chat", slotOf({ kind: "app", id: "invoices" }));
      keepChatLink("their-chat-link-secret");
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
        chats: [
          activeChat(),
          activeChat(slotOf({ kind: "app", id: "invoices" })),
        ],
        chatLink: pendingChatLink(),
      }).toStrictEqual({
        told: [[why], [why]],
        order: ["frame stopped", "page reloads"],
        disposed: true,
        waiting: code,
        chats: [undefined, undefined],
        chatLink: undefined,
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

  it("stops every frame when the person signs out, and forgets the chat link they opened in the tab and what they typed and didn't send, so whoever signs in next isn't offered either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(new Response("{}")))
    );
    const { core, ended } = tab([one]);
    await core.session();
    const frame = frameOn(core);
    keepChatLink("their-chat-link-secret");
    const draft = "grasp.chat.draft.one.chat-1";
    localStorage.setItem(draft, JSON.stringify({ text: "Who owes us?" }));
    const kept = pendingChatLink();

    await signOut(core);

    expect({
      kept,
      after: pendingChatLink(),
      draft: localStorage.getItem(draft),
    }).toStrictEqual({
      kept: "their-chat-link-secret",
      after: undefined,
      draft: null,
    });
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

  it("says whether core can be reached as it finds out: checking, reachable, unreachable while it tries again, reachable once back", async () => {
    const { core, opened } = tab([one, "down", one]);
    const seen: string[] = [core.reach];
    core.watchReach(() => {
      seen.push(core.reach);
    });
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);
    opened[0]?.break();
    // The first try after the drop fails; the one after its pause answers.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await core.session();

    expect(seen).toStrictEqual([
      "checking",
      "reachable",
      "unreachable",
      "checking",
      "unreachable",
      "checking",
      "reachable",
    ]);
  });

  it("finds a connection that died without saying so within seconds while something depends on it, and asks nothing once nothing does", async () => {
    const { core, opened, asked } = tab([one, one]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pings = () => asked.filter((name) => name === "ping").length;
    const letGo = core.keepAlive();
    // Asked at once, then every 2.5 s, while it answers.
    await vi.advanceTimersByTimeAsync(5000);
    const answering = { pings: pings(), reach: core.reach };

    // The network dies under it: nothing answers, nothing closes.
    opened[0]?.silence();
    await vi.advanceTimersByTimeAsync(heartbeatMs + 5000 + 250);
    const noticed = opened[0]?.disposed;
    await vi.advanceTimersByTimeAsync(1);
    // Connected again, and still kept alive on the new connection.
    const again = { opened: opened.length, reach: core.reach };

    letGo();
    const before = pings();
    await vi.advanceTimersByTimeAsync(60_000);

    expect({
      answering,
      noticed,
      again,
      afterLettingGo: pings() - before,
    }).toStrictEqual({
      answering: { pings: 3, reach: "reachable" },
      noticed: true,
      again: { opened: 2, reach: "reachable" },
      afterLettingGo: 0,
    });
  });

  it("lets no frozen or hidden tab, nor core too busy to answer, look like a dead socket, and lets go of one that is", async () => {
    const { core, page, opened } = tab([one, one]);
    await core.session();
    const letGo = core.keepAlive();
    await vi.advanceTimersByTimeAsync(0);
    opened[0]?.silence();
    // The page stands still for a minute (a frozen tab, a stalled
    // machine): no time passes for it, however long the clock jumps.
    for (let stall = 0; stall < 10; stall += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      // oxlint-disable-next-line no-await-in-loop -- one stall after another
      await vi.advanceTimersByTimeAsync(250);
    }
    const frozen = opened[0]?.disposed;
    // In the back: nothing counts.
    page.visible = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const hidden = opened[0]?.disposed;
    // In front, its ping unanswered, but core doesn't answer a fresh
    // request either: busy, not dead.
    page.visible = true;
    page.host = "busy";
    await vi.advanceTimersByTimeAsync(20_000);
    const busy = opened[0]?.disposed;
    // Core answers a fresh request while the socket says nothing: dead.
    page.host = "answers";
    await vi.advanceTimersByTimeAsync(heartbeatMs + 5000 + 250);
    letGo();

    expect({ frozen, hidden, busy, dead: opened[0]?.disposed }).toStrictEqual({
      frozen: false,
      hidden: false,
      busy: false,
      dead: true,
    });
  });

  it("keeps a socket whose ping answers late, while core is asked over HTTP", async () => {
    const { core, page, opened } = tab([one, one]);
    await core.session();
    const letGo = core.keepAlive();
    await vi.advanceTimersByTimeAsync(0);
    opened[0]?.silence();
    page.hostTakesMs = 3000;
    // The next ping (at 2.5 s) waits out its 5 s; core is asked, and takes
    // 3 s; the socket recovers meanwhile.
    await vi.advanceTimersByTimeAsync(heartbeatMs + 5000 + 250 + 1000);
    opened[0]?.speak();
    await vi.advanceTimersByTimeAsync(3000);
    const kept = opened[0]?.disposed;
    letGo();

    expect({ kept, opened: opened.length }).toStrictEqual({
      kept: false,
      opened: 1,
    });
  });

  it("lets no ping that waits behind a large message let a working connection go, yet lets go of one that died under it", async () => {
    const { core, opened } = tab([one, one]);
    await core.session();
    const letGo = core.keepAlive();
    await vi.advanceTimersByTimeAsync(0);
    // A file goes out: the socket answers nothing until it has.
    const uploading = core.holdHeartbeat();
    opened[0]?.silence();
    await vi.advanceTimersByTimeAsync(60_000);
    const slowUpload = opened[0]?.disposed;
    // It never answers: the socket died under the upload.
    await vi.advanceTimersByTimeAsync(heldPingMs);
    const died = opened[0]?.disposed;
    uploading();
    letGo();

    expect({ slowUpload, died }).toStrictEqual({
      slowUpload: false,
      died: true,
    });
  });

  it("lets go of the connection at once when the browser goes offline, and connects again as it comes back online", async () => {
    const { core, opened, goOffline, comeBack } = tab([one, "down", one]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);

    goOffline();
    // The first try after it fails, as nothing connects offline.
    await vi.advanceTimersByTimeAsync(1000);
    const offline = { disposed: opened[0]?.disposed, reach: core.reach };
    // Online again: it tries at once, not after its next pause.
    comeBack();
    await vi.advanceTimersByTimeAsync(0);

    expect({ offline, opened: opened.length, reach: core.reach }).toStrictEqual(
      {
        offline: { disposed: true, reach: "unreachable" },
        opened: 3,
        reach: "reachable",
      }
    );
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

  it("lets no call given up on already cut a reconnect pause short", async () => {
    const { core, opened } = tab([one, "down", one]);
    await core.session();
    vi.spyOn(Math, "random").mockReturnValue(1);
    opened[0]?.break();
    await vi.advanceTimersByTimeAsync(1000);
    // The next pause is 2 s.
    const given = AbortSignal.abort(new Error("Gave up."));
    const refused = [
      await refusal(core.session(given)),
      await refusal(core.api(given)),
    ];
    await vi.advanceTimersByTimeAsync(1999);
    expect({ refused: refused.length, attempts: opened.length }).toStrictEqual({
      refused: 2,
      attempts: 2,
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

// Who the shell knows is signed in, on every way to a page: asked of core
// once, not on every click. How it could go wrong, each tried below: a
// round trip before every page's own reads; a changed name, role or team
// never shown; nobody signed in remembered, so signing in never counts.
describe("who the shell knows is signed in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks core once, then knows it on every page after without asking", async () => {
    const { core, asked } = tab([one]);
    const first = await shellStatus(core);
    asked.length = 0;

    const later = [
      await shellStatus(core),
      await shellStatus(core),
      await shellStatus(core),
    ];

    expect({ asked, later }).toStrictEqual({
      asked: [],
      later: [first, first, first],
    });
    expect(first.identity?.userId).toBe("one");
  });

  it("shows what it knows at once once it's half a minute old, and asks again behind the page for the page after", async () => {
    const person = { userId: "one", name: "One" };
    const { core, asked } = tab([person]);
    await shellStatus(core);
    person.name = "Uno";
    await vi.advanceTimersByTimeAsync(frameReadMs);
    asked.length = 0;

    const shown = await shellStatus(core);
    const meanwhile = await shellStatus(core);
    await vi.advanceTimersByTimeAsync(0);
    const after = await shellStatus(core);

    expect({
      names: [shown, meanwhile, after].map(({ identity }) => identity?.name),
      asked: asked.toSorted(),
    }).toStrictEqual({
      names: ["One", "One", "Uno"],
      // Asked once, however many pages were opened meanwhile.
      asked: ["ping", "signInOptions", "whoami"],
    });
  });

  it("asks core on every page while nobody is signed in", async () => {
    const { core, asked } = tab(["nobody"]);

    const statuses = [await shellStatus(core), await shellStatus(core)];

    expect({
      signedIn: statuses.map(({ connected, identity }) => ({
        connected,
        identity,
      })),
      pings: asked.filter((name) => name === "ping"),
    }).toStrictEqual({
      signedIn: [
        { connected: true, identity: undefined },
        { connected: true, identity: undefined },
      ],
      pings: ["ping", "ping"],
    });
  });

  it("asks again at once when core refuses a call for the person's role, and the page after shows what core says now", async () => {
    const person = { userId: "one", name: "Admin" };
    const { core } = tab([person]);
    await shellStatus(core);
    person.name = "Member";

    const refused = await refusal(
      core.withSession(async () => {
        throw await Promise.resolve(roleErrors.create("role.forbidden"));
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    const { identity } = await shellStatus(core);

    expect({
      refused: roleErrors.codeOf(refused),
      name: identity?.name,
    }).toStrictEqual({ refused: "role.forbidden", name: "Member" });
  });

  it("sends the page after to sign in once core, asked again behind the page, says nobody is, and asks core itself from then on", async () => {
    const person: { userId: string; gone?: boolean } = { userId: "one" };
    const { core, asked } = tab([person]);
    await shellStatus(core);
    person.gone = true;
    await vi.advanceTimersByTimeAsync(frameReadMs);

    const shown = await shellStatus(core);
    await vi.advanceTimersByTimeAsync(0);
    asked.length = 0;
    const after = await shellStatus(core);
    const again = await shellStatus(core);

    expect({
      shown: shown.identity?.userId,
      after: after.identity,
      again: again.identity,
      pings: asked.filter((name) => name === "ping"),
    }).toStrictEqual({
      shown: "one",
      after: undefined,
      again: undefined,
      // Nobody is never kept: each page asks.
      pings: ["ping", "ping"],
    });
  });

  it("serves what it knows while core is out of reach mid-session, so each page shows its own reads failing", async () => {
    const { core, opened } = tab([one, "down"]);
    const before = await shellStatus(core);
    opened[0]?.break();

    const meanwhile = await shellStatus(core);
    await vi.advanceTimersByTimeAsync(frameReadMs);
    const old = await shellStatus(core);
    // The ask behind the page gives up; what core said last stands.
    await vi.advanceTimersByTimeAsync(20_000);
    const afterAsk = await shellStatus(core);

    expect([meanwhile, old, afterAsk]).toStrictEqual([before, before, before]);
    expect(before).toMatchObject({ connected: true, identity: one });
  });
});
