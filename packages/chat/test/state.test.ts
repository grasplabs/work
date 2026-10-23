import { Message } from "chat";
import type { QueueEntry } from "chat";
// Chat SDK's state on Durable Objects (src/state.ts), through the objects'
// real boundary, as the SDK uses it: a thread's lock held by one handler at
// a time and only by its token, keys kept for their lifetime and set only
// once, lists trimmed to their newest, a thread's queue in order, followed
// threads remembered, and what expired cleared from storage.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { durableObjectState } from "../src/state.ts";

const state = durableObjectState(env.CHAT_STATE);

/** A thread or key no other test uses. */
const fresh = (kind: string) => `${kind}-${crypto.randomUUID()}`;

/** Waits `ms`, for what expires after it. */
const pause = async (ms: number) => {
  await scheduler.wait(ms);
};

/** A message queued in `thread` while a handler ran, as the SDK queues one. */
const queued = (thread: string, text: string): QueueEntry => ({
  enqueuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  message: new Message({
    id: text,
    threadId: thread,
    text,
    formatted: { type: "root", children: [] },
    raw: {},
    author: {
      userId: "U1",
      userName: "someone",
      fullName: "Someone",
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  }),
});

/**
 * What an object still stores once its alarm has run (it may have already):
 * its keys and its tables.
 */
const storedIn = async (name: string) => {
  const object = env.CHAT_STATE.getByName(name);
  await runDurableObjectAlarm(object);
  return await runInDurableObject(object, async (_instance, ctx) => {
    const keys = await ctx.storage.list();
    const tables = ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ESCAPE '\\'"
      )
      .one().n;
    return keys.size + tables;
  });
};

describe("Chat SDK's state on Durable Objects", () => {
  it("gives a thread's lock to one holder at a time, and lets only its token extend or release it", async () => {
    const thread = fresh("thread");
    const first = await state.acquireLock(thread, 60_000);
    const second = await state.acquireLock(thread, 60_000);
    const forged = { threadId: thread, token: "forged", expiresAt: 0 };
    const extendedByForger = await state.extendLock(forged, 60_000);
    await state.releaseLock(forged);
    const stillHeld = await state.acquireLock(thread, 60_000);
    const extended =
      first === null ? false : await state.extendLock(first, 60_000);
    if (first !== null) {
      await state.releaseLock(first);
    }
    const afterRelease = await state.acquireLock(thread, 60_000);

    expect({
      first: first?.threadId,
      second,
      extendedByForger,
      stillHeld,
      extended,
      afterRelease: afterRelease?.threadId,
      newToken: afterRelease?.token !== first?.token,
    }).toStrictEqual({
      first: thread,
      second: null,
      extendedByForger: false,
      stillHeld: null,
      extended: true,
      afterRelease: thread,
      newToken: true,
    });
  });

  it("frees a lock once it expires, and never brings an expired one back", async () => {
    const thread = fresh("thread");
    const lapsed = await state.acquireLock(thread, 20);
    await pause(40);
    const extended =
      lapsed === null ? true : await state.extendLock(lapsed, 60_000);
    const next = await state.acquireLock(thread, 60_000);

    expect({ extended, taken: next?.threadId }).toStrictEqual({
      extended: false,
      taken: thread,
    });
  });

  it("lets a forced release take a lock from its holder, whose own release then does nothing", async () => {
    const thread = fresh("thread");
    const stuck = await state.acquireLock(thread, 60_000);
    await state.forceReleaseLock(thread);
    const taken = await state.acquireLock(thread, 60_000);
    if (stuck !== null) {
      await state.releaseLock(stuck);
    }

    expect({
      taken: taken?.threadId,
      stillTaken: await state.acquireLock(thread, 60_000),
    }).toStrictEqual({ taken: thread, stillTaken: null });
  });

  it("keeps a key's value for its lifetime, sets it only once, and forgets it when asked", async () => {
    const key = fresh("key");
    const lasting = fresh("key");
    await state.set(key, { seen: 1 }, 30);
    const once = await state.setIfNotExists(key, { seen: 2 });
    const kept = await state.get(key);
    await state.set(lasting, ["for", "good"]);
    await pause(50);
    const expired = await state.get(key);
    const again = await state.setIfNotExists(key, { seen: 3 }, 60_000);
    const replaced = await state.get(key);
    await state.delete(key);

    expect({
      once,
      kept,
      expired,
      again,
      replaced,
      deleted: await state.get(key),
      lasting: await state.get(lasting),
    }).toStrictEqual({
      once: false,
      kept: { seen: 1 },
      expired: null,
      again: true,
      replaced: { seen: 3 },
      deleted: null,
      lasting: ["for", "good"],
    });
  });

  it("keeps a list's newest entries in order, for the lifetime its last append gave it", async () => {
    const key = fresh("list");
    const options = { maxLength: 3, ttlMs: 60_000 };
    await state.appendToList(key, { value: 1 }, options);
    await state.appendToList(key, { value: 2 }, options);
    await state.appendToList(key, { value: 3 }, options);
    await state.appendToList(key, { value: 4 }, options);
    const newest = await state.getList(key);
    const short = fresh("list");
    await state.appendToList(short, "soon gone", { ttlMs: 20 });
    await pause(40);

    expect({
      newest,
      expired: await state.getList(short),
      none: await state.getList(fresh("list")),
    }).toStrictEqual({
      newest: [{ value: 2 }, { value: 3 }, { value: 4 }],
      expired: [],
      none: [],
    });
  });

  it("queues a thread's messages in order, keeping the newest when it is full", async () => {
    const thread = fresh("thread");
    const depths = [
      await state.enqueue(thread, queued(thread, "one"), 2),
      await state.enqueue(thread, queued(thread, "two"), 2),
      await state.enqueue(thread, queued(thread, "three"), 2),
    ];
    const depth = await state.queueDepth(thread);
    const first = await state.dequeue(thread);
    const second = await state.dequeue(thread);

    expect({
      depths,
      depth,
      // Back as the JSON the SDK revives its message from.
      order: [first?.message.text, second?.message.text],
      empty: await state.dequeue(thread),
      after: await state.queueDepth(thread),
    }).toStrictEqual({
      depths: [1, 2, 2],
      depth: 2,
      order: ["two", "three"],
      empty: null,
      after: 0,
    });
  });

  it("remembers which threads are followed", async () => {
    const followed = fresh("thread");
    const left = fresh("thread");
    await state.subscribe(followed);
    await state.subscribe(left);
    await state.unsubscribe(left);

    expect({
      followed: await state.isSubscribed(followed),
      left: await state.isSubscribed(left),
      never: await state.isSubscribed(fresh("thread")),
    }).toStrictEqual({ followed: true, left: false, never: false });
  });

  it("clears an object from storage once what it held is removed or its queued messages expire", async () => {
    const key = fresh("key");
    await state.set(key, "for good");
    await state.delete(key);
    const followed = fresh("thread");
    await state.subscribe(followed);
    await state.unsubscribe(followed);
    const abandoned = fresh("thread");
    await state.enqueue(
      abandoned,
      { ...queued(abandoned, "never taken"), expiresAt: Date.now() + 20 },
      5
    );
    await pause(40);

    expect({
      deleted: await storedIn(`key:${key}`),
      unsubscribed: await storedIn(`thread:${followed}`),
      abandoned: await storedIn(`thread:${abandoned}`),
    }).toStrictEqual({ deleted: 0, unsubscribed: 0, abandoned: 0 });
  });

  it("clears an object from storage once all it held expired", async () => {
    const key = fresh("key");
    await state.set(key, "brief", 20);
    await pause(40);

    expect({
      stored: await storedIn(`key:${key}`),
      read: await state.get(key),
    }).toStrictEqual({ stored: 0, read: null });
  });
});
