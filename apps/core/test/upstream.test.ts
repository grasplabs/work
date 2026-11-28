import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { draftToldSchema } from "../src/draft-watch.ts";
import { draftWatch } from "../src/durable-objects.ts";
import { isolateRpcHeld } from "../src/rpc-target.ts";
import { watchEnds } from "../src/socket-watchers.ts";
import { followObject, reopenJitter } from "../src/upstream.ts";

// A page's watch of an object, as the Worker holds it (upstream.ts), on a
// real object that hibernates with its watchers (draft-watch.ts). Starts
// from the ways it can fail: a frame the page couldn't take for a moment,
// the object asleep or reset under it, a person's pages filling the
// object, and a watch let go of.

/** How long a test waits for what a socket carries, a slow machine too. */
const carried = { timeout: 10_000 };

/** Takes a telling and does nothing with it. */
const quiet = async (): Promise<void> => {
  await Promise.resolve();
};

/** A draft of its own for each test, so no test hears another's. */
const newSubject = () => ({ kind: "app" as const, id: crypto.randomUUID() });

/** Follows `subject`'s draft for `person`, handing each telling to `deliver`. */
const follow = async (
  subject: ReturnType<typeof newSubject>,
  person: string,
  deliver: (told: { seq: number; revision: number }) => Promise<void>,
  ended: (code: number) => void = () => {
    // Not expected.
  },
  maxQueued = 16 * 1024
) => {
  let after = 0;
  return await followObject({
    open: async () =>
      await draftWatch(env, subject).fetch(
        `https://draft-watch/?${new URLSearchParams({ person, after: String(after) }).toString()}`,
        { headers: { Upgrade: "websocket" } }
      ),
    parse: (frame) => draftToldSchema.parse(frame),
    deliver: async (told) => {
      await deliver(told);
      after = told.seq;
    },
    maxQueued,
    ended,
    logged: {},
  });
};

/** Sends `text` as a frame on every socket of `subject`'s draft object, as a fault would. */
const sendRaw = async (
  subject: ReturnType<typeof newSubject>,
  text: string
): Promise<void> => {
  await runInDurableObject(draftWatch(env, subject), (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      socket.send(text);
    }
  });
};

/** How many sockets `subject`'s draft object holds. */
const socketsOf = async (
  subject: ReturnType<typeof newSubject>
): Promise<number> =>
  await runInDurableObject(
    draftWatch(env, subject),
    (_instance, state) => state.getWebSockets().length
  );

/** Closes every socket of `subject`'s draft object with `code`. */
const closeAll = async (
  subject: ReturnType<typeof newSubject>,
  code: number
): Promise<void> => {
  await runInDurableObject(draftWatch(env, subject), (_instance, state) => {
    for (const socket of state.getWebSockets()) {
      socket.close(code, "By the test");
    }
  });
};

describe("a page's watch of an object", () => {
  // Every pause before a socket opens again, its jitter's draw fixed at
  // none: no test waits on a draw, nor on how long a pause runs.
  const { draw } = reopenJitter;
  beforeEach(() => {
    reopenJitter.draw = () => 0;
  });
  afterEach(() => {
    reopenJitter.draw = draw;
  });

  it("hands a frame the page couldn't take for a moment over again, once, and goes on live", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    let refuseNext = true;
    using watch = await follow(subject, "person", async ({ revision }) => {
      if (refuseNext) {
        refuseNext = false;
        throw new Error("The session couldn't be read just now.");
      }
      taken.push(revision);
      await Promise.resolve();
    });
    void watch;

    await draftWatch(env, subject).revised(4);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([4]);
    }, carried);
    await draftWatch(env, subject).revised(5);

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([4, 5]);
    }, carried);
  });

  it("hears the object after it slept, and after it reset, each telling once", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    using watch = await follow(subject, "person", async ({ revision }) => {
      taken.push(revision);
      await Promise.resolve();
    });
    void watch;
    const object = draftWatch(env, subject);
    await object.revised(1);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1]);
    }, carried);

    await evictDurableObject(object);
    await object.revised(2);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2]);
    }, carried);
    await evictDurableObject(object, { webSockets: "close" });
    await object.revised(3);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2, 3]);
    }, carried);
    await object.revised(4);

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2, 3, 4]);
    }, carried);
  });

  it("ends the oldest of a person's watches past the object's bound, and nobody else's", async () => {
    const subject = newSubject();
    const ended: string[] = [];
    const watches: Disposable[] = [];
    for (let page = 0; page <= 20; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      const watch = await follow(subject, "person", quiet, (code) => {
        ended.push(`${page}:${code}`);
      });
      watches.push(watch);
    }
    watches.push(
      await follow(subject, "someone else", quiet, (code) => {
        ended.push(`other:${code}`);
      })
    );

    await vi.waitFor(() => {
      expect(ended).toStrictEqual([`0:${watchEnds.displaced}`]);
    }, carried);
    for (const watch of watches) {
      watch[Symbol.dispose]();
    }
  });

  it("hands nothing more to a page that let go of its watch", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    const watch = await follow(subject, "person", async ({ revision }) => {
      taken.push(revision);
      await Promise.resolve();
    });
    await draftWatch(env, subject).revised(1);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1]);
    }, carried);

    watch[Symbol.dispose]();
    await draftWatch(env, subject).revised(2);
    await scheduler.wait(100);

    expect(taken).toStrictEqual([1]);
  });

  it("ends a watch that is sent a frame it doesn't carry, or one larger than it takes, telling why, and opens it no more", async () => {
    const endings: number[] = [];
    const bad = newSubject();
    using badWatch = await follow(bad, "person", quiet, (code) => {
      endings.push(code);
    });
    void badWatch;
    const large = newSubject();
    using largeWatch = await follow(
      large,
      "person",
      quiet,
      (code) => {
        endings.push(code);
      },
      1024
    );
    void largeWatch;

    await sendRaw(bad, "not json");
    await sendRaw(
      large,
      JSON.stringify({ seq: 1, revision: 1, pad: "x".repeat(2048) })
    );

    await vi.waitFor(() => {
      expect(endings.toSorted((a, b) => a - b)).toStrictEqual([
        watchEnds.invalid,
        watchEnds.tooLarge,
      ]);
    }, carried);
    await vi.waitFor(async () => {
      await expect(socketsOf(bad)).resolves.toBe(0);
      await expect(socketsOf(large)).resolves.toBe(0);
    }, carried);
  });

  it("catches a slow page up from what it took once frames for it outgrow the watch's bound, each telling reaching it, the last one too", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    const slow = Promise.withResolvers<true>();
    let first = true;
    using watch = await follow(
      subject,
      "person",
      async ({ revision }) => {
        if (first) {
          first = false;
          await slow.promise;
        }
        taken.push(revision);
      },
      undefined,
      256
    );
    void watch;
    const object = draftWatch(env, subject);
    await object.revised(1);
    // Many more than the bound holds while the page takes the first.
    for (let revision = 2; revision <= 40; revision += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await object.revised(revision);
    }
    slow.resolve(true);

    await vi.waitFor(() => {
      expect(taken.at(-1)).toBe(40);
    }, carried);
    // In order, never one twice.
    expect(taken).toStrictEqual(taken.toSorted((a, b) => a - b));
    expect(new Set(taken).size).toBe(taken.length);
  });

  it("ends a watch its object ends for good (gone), and opens it again after any other close", async () => {
    const subject = newSubject();
    const endings: number[] = [];
    const taken: number[] = [];
    using watch = await follow(
      subject,
      "person",
      async ({ revision }) => {
        taken.push(revision);
        await Promise.resolve();
      },
      (code) => {
        endings.push(code);
      }
    );
    void watch;

    await closeAll(subject, 1011);
    await draftWatch(env, subject).revised(1);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1]);
    }, carried);
    await closeAll(subject, watchEnds.gone);

    await vi.waitFor(() => {
      expect(endings).toStrictEqual([watchEnds.gone]);
    }, carried);
  });

  it("closes a socket whose state its object can't read, which the Worker opens again", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    using watch = await follow(subject, "person", async ({ revision }) => {
      taken.push(revision);
      await Promise.resolve();
    });
    void watch;
    // As another version's code would have left it.
    await runInDurableObject(draftWatch(env, subject), (_instance, state) => {
      for (const socket of state.getWebSockets()) {
        socket.serializeAttachment({ v: 0, shape: "older" });
      }
    });

    await draftWatch(env, subject).revised(1);

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1]);
    }, carried);
  });

  it("ends a watch whose object answers 404 as it opens it again, and opens it again after a 503", async () => {
    const subject = newSubject();
    const endings: number[] = [];
    const answers: number[] = [503];
    let opens = 0;
    using watch = await followObject({
      open: async () => {
        opens += 1;
        const answer = opens === 1 ? undefined : (answers.shift() ?? 404);
        return answer === undefined
          ? await draftWatch(env, subject).fetch(
              `https://draft-watch/?${new URLSearchParams({ person: "person", after: "0" }).toString()}`,
              { headers: { Upgrade: "websocket" } }
            )
          : new Response(null, { status: answer });
      },
      parse: (frame) => draftToldSchema.parse(frame),
      deliver: quiet,
      maxQueued: 16 * 1024,
      ended: (code) => {
        endings.push(code);
      },
      logged: {},
    });
    void watch;

    await closeAll(subject, 1011);

    await vi.waitFor(() => {
      expect({ endings, opens }).toStrictEqual({
        endings: [watchEnds.gone],
        opens: 3,
      });
    }, carried);
  });

  it("holds no frame past what the isolate's connections may hold together: the page catches up once there is room", async () => {
    const subject = newSubject();
    const taken: number[] = [];
    using watch = await follow(subject, "person", async ({ revision }) => {
      taken.push(revision);
      await Promise.resolve();
    });
    void watch;
    // Half of each pause, so the catching up waits while the isolate is
    // full rather than trying again and again within the test's look.
    reopenJitter.draw = () => 0.5;
    const { held } = isolateRpcHeld;
    // The isolate's connections hold all they may.
    isolateRpcHeld.held = isolateRpcHeld.limit;
    onTestFinished(() => {
      isolateRpcHeld.held = held;
    });

    await draftWatch(env, subject).revised(1);
    await scheduler.wait(200);
    const whileFull = [...taken];
    isolateRpcHeld.held = held;

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1]);
    }, carried);
    expect(whileFull).toStrictEqual([]);
  });
});
