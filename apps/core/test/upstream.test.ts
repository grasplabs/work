import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { draftToldSchema } from "../src/draft-watch.ts";
import { draftWatch } from "../src/durable-objects.ts";
import { watchEnds } from "../src/socket-watchers.ts";
import { followObject } from "../src/upstream.ts";

// A page's watch of an object, as the Worker holds it (upstream.ts), on a
// real object that hibernates with its watchers (draft-watch.ts). Starts
// from the ways it can fail: a frame the page couldn't take for a moment,
// the object asleep or reset under it, a person's pages filling the
// object, and a watch let go of.

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
  }
) => {
  let after = 0;
  return await followObject({
    open: async () =>
      await draftWatch(env, subject).fetch(
        `https://draft-watch/?${new URLSearchParams({ person, after: String(after) }).toString()}`,
        { headers: { Upgrade: "websocket" } }
      ),
    deliver: async (frame) => {
      const told = draftToldSchema.parse(frame);
      await deliver(told);
      after = told.seq;
    },
    ended,
    refused: () => new Error("Refused"),
    logged: {},
  });
};

describe("a page's watch of an object", () => {
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
    });
    await draftWatch(env, subject).revised(5);

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([4, 5]);
    });
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
    });

    await evictDurableObject(object);
    await object.revised(2);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2]);
    });
    await evictDurableObject(object, { webSockets: "close" });
    await object.revised(3);
    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2, 3]);
    });
    await object.revised(4);

    await vi.waitFor(() => {
      expect(taken).toStrictEqual([1, 2, 3, 4]);
    });
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
    });
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
    });

    watch[Symbol.dispose]();
    await draftWatch(env, subject).revised(2);
    await scheduler.wait(100);

    expect(taken).toStrictEqual([1]);
  });
});
