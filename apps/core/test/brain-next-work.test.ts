import {
  defineWork,
  enqueueWork,
  WorkError,
  workAtOnce,
  workAttemptsMax,
  workCallsMax,
  workModelRate,
  workPerConnection,
  workParkedMs,
  workParksMax,
  workRequestMaxLength,
} from "@grasp-os/brain-next/work";
import type {
  NewWork,
  WorkContext,
  WorkDefinition,
  WorkPriority,
} from "@grasp-os/brain-next/work";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  addSource,
  brainWorkOverview,
  readSourceVersionAs,
  workBrain,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { aiProvidersControlUrl } from "./ai-providers-fake.ts";
import type { PlannedReply } from "./ai-providers-fake.ts";
import { platformAnthropicKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { streamText } from "./provider-streams.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The new Brain's work queue (GRA-1724), driven as core's clock drives it
// (`workBrain`, a tick at the clock's time), its model calls through core's
// gateway to a faked provider. The work is of kinds only this file
// defines, whose handler the tests control: what it does for an item is
// looked up by the item's key, and nothing for a key without one. One
// kind takes the queue's usual time per attempt, the other a short one.

/** The Brain's one store, as the tests reach into it to add items. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** What the handler does for an item, by its key. */
const behaviours = new Map<string, (context: WorkContext) => Promise<void>>();

/** What the handler saw: runs started and ended, by key, and the most at once. */
interface Seen {
  started: string[];
  finished: string[];
  running: string[];
  mostAtOnce: number;
  /** The most runs of one key at once. */
  mostOfOneKey: number;
}
const seen: Seen = {
  started: [],
  finished: [],
  running: [],
  mostAtOnce: 0,
  mostOfOneKey: 0,
};

const ofKey = (key: string): number =>
  seen.running.filter((running) => running === key).length;

const handle = async (key: string, context: WorkContext): Promise<void> => {
  seen.started.push(key);
  seen.running.push(key);
  seen.mostAtOnce = Math.max(seen.mostAtOnce, seen.running.length);
  seen.mostOfOneKey = Math.max(seen.mostOfOneKey, ofKey(key));
  try {
    await behaviours.get(key)?.(context);
    seen.finished.push(key);
  } finally {
    seen.running.splice(seen.running.indexOf(key), 1);
  }
};

const payload = z.strictObject({ key: z.string() });
type Payload = z.infer<typeof payload>;

const kindOf = (name: string): string =>
  `test.${name}_${crypto.randomUUID().replaceAll("-", "")}`;

/** Work with the queue's usual time per attempt. */
const testWork = defineWork({
  kind: kindOf("queue"),
  payload,
  run: async ({ key }, context) => {
    await handle(key, context);
  },
});

/** Work with time for a burst of model calls, and not much more. */
const mediumWork = defineWork({
  kind: kindOf("medium"),
  payload,
  timeLimitMs: 1000,
  run: async ({ key }, context) => {
    await handle(key, context);
  },
});

/** Work with a short time per attempt. */
const quickTimeMs = 300;
const quickWork = defineWork({
  kind: kindOf("quick"),
  payload,
  timeLimitMs: quickTimeMs,
  run: async ({ key }, context) => {
    await handle(key, context);
  },
});

const reset = (): void => {
  // A run in a store the test killed never ends: none is left running.
  seen.running.length = 0;
  seen.started.length = 0;
  seen.finished.length = 0;
  seen.mostAtOnce = 0;
  seen.mostOfOneKey = 0;
};

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };
const later = (ms: number): Date => {
  clock.at = Math.max(clock.at, Date.now()) + ms;
  return new Date(clock.at);
};

/** One tick of core's clock, `ms` after the last. */
const tick = async (ms = 1000): Promise<void> => {
  await workBrain(env, later(ms));
};

/** Whether `promise` failed. */
const failed = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
};

type Item = Omit<NewWork<Payload>, "payload">;

const enqueue = async (
  item: Item,
  work: WorkDefinition<Payload> = testWork
): Promise<void> => {
  await runInDurableObject(store(), (_store, state) => {
    enqueueWork(state.storage, work, { ...item, payload: { key: item.key } });
  });
};

const enqueueAll = async (
  keys: readonly string[],
  item: Omit<Item, "key">,
  work: WorkDefinition<Payload> = testWork
): Promise<void> => {
  await runInDurableObject(store(), (_store, state) => {
    for (const key of keys) {
      enqueueWork(state.storage, work, { ...item, key, payload: { key } });
    }
  });
};

const keyOf = (name: string): string => `${name}-${crypto.randomUUID()}`;
const keysOf = (name: string, count: number): string[] =>
  Array.from({ length: count }, () => keyOf(name));

const runsOf = (key: string): number =>
  seen.started.filter((started) => started === key).length;

/** The queue as staff see it: waiting of this file's kinds, and parked of `keys`. */
const queue = async (keys: readonly string[] = []) => {
  const overview = await brainWorkOverview(env);
  const kinds = new Set([testWork.kind, quickWork.kind, mediumWork.kind]);
  return {
    waiting: overview.waiting
      .filter(({ kind }) => kinds.has(kind))
      .reduce((sum, { count }) => sum + count, 0),
    running: overview.running,
    parked: overview.parked.filter(({ key }) => keys.includes(key)),
    paused: overview.paused,
    overdue: overview.overdue.filter(({ key }) => keys.includes(key)),
  };
};

/** Kills the store, as a crash or a restart would. */
const killStore = async (): Promise<void> => {
  await failed(
    runInDurableObject(store(), (_store, state) => {
      state.abort("Killed by the test");
    })
  );
};

const pause = async (ms: number): Promise<void> => {
  await scheduler.wait(ms);
};

/** A handler's work that takes a moment. */
const brief = async (): Promise<void> => {
  await pause(20);
};

/**
 * A flag one request sets and another waits for: a handler runs in the
 * store's request, and workerd lets no request wait on another's promise.
 */
const flag = () => {
  const state = { set: false };
  return {
    set: () => {
      state.set = true;
    },
    wait: async (): Promise<void> => {
      while (!state.set) {
        // oxlint-disable-next-line no-await-in-loop -- until it is set
        await pause(5);
      }
    },
  };
};

/** Waits until `done` holds. */
const until = async (done: () => boolean): Promise<void> => {
  while (!done()) {
    // oxlint-disable-next-line no-await-in-loop -- until it holds
    await pause(5);
  }
};

const answer: ProviderReply = {
  text: "An answer.",
  inputTokens: 10,
  outputTokens: 5,
};

/** Whether the file of `hash` is in doubt now: a delete of it may still land. */
const inDoubtNow = async (hash: string): Promise<boolean> =>
  await runInDurableObject(
    store(),
    (_store, state) =>
      (state.storage.sql
        .exec<{ until: number | null }>(
          "SELECT in_doubt_until AS until FROM files WHERE hash = ?",
          hash
        )
        .toArray()
        .at(0)?.until ?? 0) > Date.now()
  );

/** Whether the store still notes the file of `hash`. */
const noted = async (hash: string): Promise<boolean> =>
  await runInDurableObject(
    store(),
    (_store, state) =>
      state.storage.sql
        .exec("SELECT hash FROM files WHERE hash = ?", hash)
        .toArray().length > 0
  );

/** The SHA-256 of `text` in UTF-8, in hex: its file's key in the bucket. */
const fileHashOf = async (text: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

/**
 * What an add that crashed between its file and its version leaves: the
 * file of `text` in the bucket, and its row noted long ago with no version
 * holding it, so the next sweep takes it.
 */
const crashedAdd = async (text: string): Promise<string> => {
  const hash = await fileHashOf(text);
  await env.BRAIN_OBJECTS.put(`sources/${hash}`, text);
  await runInDurableObject(store(), (_store, state) => {
    state.storage.sql.exec(
      "INSERT INTO files (hash, refs, written_at) VALUES (?, 0, 0)",
      hash
    );
  });
  return hash;
};

/**
 * The store's bucket with its deletes held until `released`, as an R2 that
 * hangs, then carried out late but for the keys in `never`, whose delete
 * never lands; deletes asked and writes counted. Answers the controls and
 * how to give the store its own bucket back (harmless twice).
 */
const holdingDeletes = async (never: readonly string[] = []) => {
  const held = { released: false, landed: 0, writes: 0, asked: 0 };
  const real = env.BRAIN_OBJECTS;
  const restore = await runInDurableObject(store(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = {
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        held.writes += 1;
        return await real.put(...args);
      },
      get: async (...args: Parameters<R2Bucket["get"]>) =>
        await real.get(...args),
      delete: async (keys: string | string[]) => {
        held.asked += 1;
        while (!held.released) {
          // oxlint-disable-next-line no-await-in-loop -- until released
          await pause(20);
        }
        await real.delete([keys].flat().filter((key) => !never.includes(key)));
        held.landed += 1;
      },
    };
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: bucket });
    return () => {
      Reflect.set(instance, "env", objectEnv);
    };
  });
  return { held, restore };
};

/** Adds `text` as a new upload `userId` may read: its source and version. */
const addOf = async (text: string, userId: string) =>
  await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text,
    readers: { kind: "owner", personId: userId },
  });

/** What `promise` was refused with, or "" when it wasn't. */
const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Runs `run` with `Date` alone `ms` ahead, as the sources tests move it. */
const withDateAhead = async <T>(ms: number, run: () => Promise<T>) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** The host's side of a model call broken, as when its tick is gone. */
const brokenHost = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("The host is gone");
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Plans how the providers answer the requests that carry `key`, in order. */
const plan = async (key: string, replies: PlannedReply[]): Promise<void> => {
  const internet = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(internet)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await internet.fetch(aiProvidersControlUrl, {
    method: "POST",
    body: JSON.stringify({ key, replies }),
  });
  await response.body?.cancel();
};

/** An answer on Grasp's Anthropic key. */
const graspAnswer: PlannedReply = {
  sse: streamText("anthropic-messages", {
    text: "An answer.",
    inputTokens: 10,
    outputTokens: 5,
  }),
};

const idp = mockIdp();

/** Runs `run` with the organization's calls on Grasp's own key. */
const onGraspKey = async (run: () => Promise<void>): Promise<void> => {
  const { api } = await signedInApi(idp, "admin");
  await api.aiProviders.setSource("grasp");
  try {
    await run();
  } finally {
    await api.aiProviders.setSource("own");
  }
};

/** Connect, as when it can't be reached: its provider routes fail. */
const unreachableConnect = new Proxy(env.CONNECT, {
  get: (target, key): unknown => {
    if (key !== "aiProviderRoutes") {
      const value: unknown = Reflect.get(target, key);
      return value;
    }
    return async () => {
      await Promise.resolve();
      throw new Error("connect unreachable");
    };
  },
});

/** A handler's work that asks the model once. */
const asksOnce = async ({ ask }: WorkContext): Promise<void> => {
  await ask({ system: "Say something.", input: "Something." });
};

describe("the Brain's work queue", { timeout: 60_000 }, () => {
  // Each test's items are its own: what is left of them (waiting, parked,
  // to come back a day later) and the queue's pause go with the test.
  afterEach(async () => {
    behaviours.clear();
    await runInDurableObject(store(), (_store, state) => {
      state.storage.sql.exec(
        "DELETE FROM work_items WHERE running = 0 AND kind IN (?, ?, ?)",
        testWork.kind,
        quickWork.kind,
        mediumWork.kind
      );
      state.storage.sql.exec(
        "UPDATE work_model_bucket SET paused_until = 0, paused_since = NULL, pause_reason = NULL"
      );
    });
  });

  it("runs items in priority order, never more than the set number at once", async () => {
    reset();
    const priorities: WorkPriority[] = [
      "archive",
      "recent",
      "conversation",
      "upload",
      "asked",
    ];
    // Added last class first, twice over.
    const added = [...priorities, ...priorities].map((priority) => ({
      key: keyOf(priority),
      priority,
    }));
    for (const item of added) {
      behaviours.set(item.key, brief);
      // oxlint-disable-next-line no-await-in-loop -- added in this order
      await enqueue(item);
    }
    await tick();
    const firstFirst = priorities
      .toReversed()
      .flatMap((priority) => added.filter((item) => item.priority === priority))
      .map((item) => item.key);
    expect(seen.started).toStrictEqual(firstFirst);
    expect(seen.mostAtOnce).toBe(workAtOnce);
    await expect(queue()).resolves.toMatchObject({ waiting: 0, running: 0 });
  });

  it("runs at most the set number of one connection's items at once, and holds up nothing else", async () => {
    reset();
    const connection = `connection-${crypto.randomUUID()}`;
    const ofConnection = keysOf("connected", 6);
    const others = keysOf("other", 2);
    const connected = { running: new Set<string>(), most: 0 };
    for (const key of ofConnection) {
      behaviours.set(key, async () => {
        connected.running.add(key);
        connected.most = Math.max(connected.most, connected.running.size);
        await brief();
        connected.running.delete(key);
      });
    }
    for (const key of others) {
      behaviours.set(key, brief);
    }
    await enqueueAll(ofConnection, { priority: "recent", connection });
    await enqueueAll(others, { priority: "archive" });
    await tick();
    expect(connected.most).toBe(workPerConnection);
    // The first to start: as many of the connection's as it may, then the others.
    expect(
      seen.started.slice(0, workPerConnection + others.length).toSorted()
    ).toStrictEqual(
      [...ofConnection.slice(0, workPerConnection), ...others].toSorted()
    );
    expect(seen.finished.toSorted()).toStrictEqual(
      [...ofConnection, ...others].toSorted()
    );
  });

  it("runs each item once when a tick is delivered twice", async () => {
    reset();
    const items = keysOf("twice", 7);
    for (const key of items) {
      behaviours.set(key, brief);
    }
    await enqueueAll(items, { priority: "upload" });
    const at = later(1000);
    await Promise.all([workBrain(env, at), workBrain(env, at)]);
    expect(seen.started.toSorted()).toStrictEqual(items.toSorted());
    expect(seen.mostAtOnce).toBe(workAtOnce);
  });

  it("runs an item the store was killed in the middle of again, and the others once", async () => {
    reset();
    const killedIn = keyOf("killed");
    const others = keysOf("done", 2);
    const gate = flag();
    const reached = flag();
    behaviours.set(killedIn, async () => {
      reached.set();
      await gate.wait();
    });
    await enqueue({ key: killedIn, priority: "asked" });
    await enqueueAll(others, { priority: "recent" });
    const first = failed(workBrain(env, later(1000)));
    await reached.wait();
    await until(() => seen.finished.length >= others.length);
    await killStore();
    await expect(first).resolves.toBeTruthy();
    gate.set();
    await tick();
    expect([killedIn, ...others].map(runsOf)).toStrictEqual([2, 1, 1]);
    expect(seen.finished.toSorted()).toStrictEqual(
      [killedIn, ...others].toSorted()
    );
    await expect(queue()).resolves.toMatchObject({ waiting: 0, running: 0 });
  });

  it("picks up where it was once the clock comes back after the store restarted", async () => {
    reset();
    const [first, second] = [keyOf("first"), keyOf("second")];
    await enqueue({ key: second, priority: "archive" });
    await enqueue({ key: first, priority: "asked" });
    // No tick for hours, and the store restarted meanwhile.
    await killStore();
    await tick(3 * 60 * 60_000);
    expect(seen.started).toStrictEqual([first, second]);
    await expect(queue()).resolves.toMatchObject({ waiting: 0, running: 0 });
  });

  it("parks an item that keeps failing with the queue's own code, never the handler's words, and runs the rest", async () => {
    reset();
    const failing = keyOf("failing");
    const unreadable = keyOf("unreadable");
    const behind = keyOf("behind");
    const secret = `secret-${crypto.randomUUID()}`;
    behaviours.set(failing, async () => {
      await brief();
      throw new Error(`Could not parse ${secret}`);
    });
    behaviours.set(unreadable, async () => {
      await brief();
      throw new WorkError("unreadable");
    });
    await enqueue({ key: failing, priority: "asked" });
    await enqueue({ key: unreadable, priority: "asked" });
    await enqueue({ key: behind, priority: "archive" });
    for (
      let tickNumber = 0;
      tickNumber < workAttemptsMax + 2;
      tickNumber += 1
    ) {
      // Past each backoff.
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    expect([failing, unreadable, behind].map(runsOf)).toStrictEqual([
      workAttemptsMax,
      workAttemptsMax,
      1,
    ]);
    const overview = await brainWorkOverview(env);
    expect(JSON.stringify(overview)).not.toContain(secret);
    const { waiting, parked } = await queue([failing, unreadable]);
    expect({
      waiting,
      parked: parked
        .map(({ key, attempts, error, message }) => ({
          key,
          attempts,
          error,
          message,
        }))
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    }).toStrictEqual({
      waiting: 0,
      parked: [
        {
          key: failing,
          attempts: workAttemptsMax,
          error: "failed",
          message: "Its work failed.",
        },
        {
          key: unreadable,
          attempts: workAttemptsMax,
          error: "unreadable",
          message: "What it works on can't be read.",
        },
      ].toSorted((a, b) => a.key.localeCompare(b.key)),
    });
  });

  it("parks an item that crashes its object, and keeps its neighbours", async () => {
    reset();
    const crashing = keyOf("crashing");
    const neighbour = keyOf("neighbour");
    const firstTick = flag();
    behaviours.set(crashing, async () => {
      await killStore();
      // The object is gone: nothing after this runs.
      await pause(60_000);
    });
    behaviours.set(neighbour, async () => {
      // Under way when the first crash comes.
      await firstTick.wait();
    });
    await enqueue({ key: neighbour, priority: "conversation" });
    await enqueue({ key: crashing, priority: "asked" });
    let ticks = 0;
    while (!seen.finished.includes(neighbour) && ticks < workAttemptsMax + 4) {
      ticks += 1;
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await failed(tick());
      firstTick.set();
    }
    // Its first stop is given back; each one after, while it ran alone, is its own.
    expect(runsOf(crashing)).toBe(workAttemptsMax + 1);
    expect(seen.finished).toStrictEqual([neighbour]);
    const { waiting, parked } = await queue([crashing, neighbour]);
    expect({ waiting, parked }).toMatchObject({
      waiting: 0,
      parked: [
        { key: crashing, attempts: workAttemptsMax, error: "interrupted" },
      ],
    });
  });

  it("parks an item that keeps running out of time, its handler stopped by its signal", async () => {
    reset();
    const slow = keyOf("slow");
    behaviours.set(slow, async ({ signal }) => {
      await scheduler.wait(60_000, { signal });
    });
    await enqueue({ key: slow, priority: "asked" }, quickWork);
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked } = await queue([slow]);
    expect({ runs: runsOf(slow), parked }).toMatchObject({
      runs: workAttemptsMax,
      parked: [{ key: slow, attempts: workAttemptsMax, error: "timed_out" }],
    });
  });

  it("refuses a key or a connection that isn't well-formed, keeping nothing", async () => {
    reset();
    const loneHalf = "\uD800";
    await expect(
      enqueue({ key: `key-${loneHalf}`, priority: "asked" })
    ).rejects.toThrow("unpaired surrogate");
    await expect(
      enqueue({
        key: keyOf("fine"),
        priority: "asked",
        connection: `c-${loneHalf}`,
      })
    ).rejects.toThrow("unpaired surrogate");
    const { waiting } = await queue();
    expect(waiting).toBe(0);
  });

  it("replaces an item still waiting with a newer one of its key", async () => {
    reset();
    const document = keyOf("document");
    // What the handler finds of the document: its version when it runs.
    const current = { version: "first" };
    const versions: string[] = [];
    behaviours.set(document, async () => {
      versions.push(current.version);
      await brief();
    });
    await enqueue({ key: document, priority: "archive" });
    current.version = "second";
    await enqueue({ key: document, priority: "recent" });
    const { waiting } = await queue();
    expect(waiting).toBe(1);
    await tick();
    expect(versions).toStrictEqual(["second"]);
  });

  it("never runs a newer item of a key beside the one under way, whatever else ends", async () => {
    reset();
    const document = keyOf("document");
    const other = keyOf("other");
    const gate = flag();
    const otherGate = flag();
    const reached = flag();
    behaviours.set(document, async () => {
      if (runsOf(document) === 1) {
        reached.set();
        await gate.wait();
      }
    });
    behaviours.set(other, async () => {
      await otherGate.wait();
    });
    await enqueue({ key: document, priority: "upload" });
    await enqueue({ key: other, priority: "upload" });
    const ticked = tick();
    await reached.wait();
    await enqueue({ key: document, priority: "upload" });
    // Another item ends, and the tick claims again while the first runs.
    otherGate.set();
    await until(() => seen.finished.includes(other));
    await pause(50);
    gate.set();
    await ticked;
    const { waiting } = await queue();
    expect({
      runs: runsOf(document),
      mostOfOneKey: seen.mostOfOneKey,
      waiting,
    }).toStrictEqual({ runs: 2, mostOfOneKey: 1, waiting: 0 });
  });

  it("keeps the result of the newer item when an older one ran out of time and ended late", async () => {
    reset();
    const document = keyOf("document");
    const other = keyOf("other");
    const result = { value: "none", version: 1 };
    const reached = flag();
    behaviours.set(document, async () => {
      const { version } = result;
      if (version === 1) {
        reached.set();
        // Ignores its signal, and ends after its time, within its grace.
        await pause(quickTimeMs * 1.5);
      }
      result.value = `version ${version}`;
    });
    behaviours.set(other, brief);
    await enqueue({ key: document, priority: "upload" }, quickWork);
    const ticked = tick();
    await reached.wait();
    result.version = 2;
    await enqueue({ key: document, priority: "upload" }, quickWork);
    await enqueue({ key: other, priority: "upload" }, quickWork);
    // The tick stays open until the late one ended, and runs the newer one
    // after it.
    await ticked;
    expect({
      result: result.value,
      runs: runsOf(document),
      mostOfOneKey: seen.mostOfOneKey,
    }).toStrictEqual({ result: "version 2", runs: 2, mostOfOneKey: 1 });
  });

  it("lets a handler that ignores its signal run on alone, past a restart, and keeps the rest of the queue going", async () => {
    reset();
    const stuck = keyOf("stuck");
    const others = keysOf("going", 2);
    const reached = flag();
    const runs = { ended: 0 };
    behaviours.set(stuck, async () => {
      reached.set();
      // Ignores its signal, well past its time and its grace.
      await pause(quickTimeMs * 4);
      runs.ended += 1;
    });
    await enqueue({ key: stuck, priority: "asked" }, quickWork);
    const first = failed(tick());
    await reached.wait();
    await killStore();
    await expect(first).resolves.toBeTruthy();
    // After the restart it runs alone; settled once its time and grace are
    // over, it no longer holds up the rest.
    await enqueueAll(others, { priority: "archive" });
    await tick();
    // Still running on its own: staff see its key held.
    const { overdue } = await queue([stuck]);
    expect({
      finished: seen.finished.toSorted(),
      overdue,
    }).toStrictEqual({
      finished: others.toSorted(),
      overdue: [{ kind: quickWork.kind, key: stuck }],
    });
    // Every run ended but the one in the killed store, which never does.
    const allEnded = () => runs.ended === runsOf(stuck) - 1;
    // The run the restart stopped was given back.
    while (runsOf(stuck) < workAttemptsMax + 1) {
      // Its last run ended: only then may its key run again.
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await until(allEnded);
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked } = await queue([stuck]);
    expect({ runs: runsOf(stuck), parked }).toMatchObject({
      runs: workAttemptsMax + 1,
      parked: [{ key: stuck, attempts: workAttemptsMax, error: "timed_out" }],
    });
    await until(allEnded);
  });

  it("parks an item whose call the provider refuses, while every other item completes and the queue never waits", async () => {
    reset();
    later(60 * 60_000);
    const refusedInput = `refuse-${crypto.randomUUID()}`;
    await answeringProvider((requests) =>
      JSON.stringify(requests.at(-1)?.body).includes(refusedInput)
        ? { status: 400, errorType: "invalid_request_error" }
        : answer
    );
    const refused = keyOf("refused");
    const others = keysOf("answered", 3);
    behaviours.set(refused, async ({ ask }) => {
      await ask({ system: "Say something.", input: refusedInput });
    });
    for (const key of others) {
      behaviours.set(key, asksOnce);
    }
    await enqueue({ key: refused, priority: "asked" });
    await enqueueAll(others, { priority: "recent" });
    const pausedSeen: unknown[] = [];
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
      // oxlint-disable-next-line no-await-in-loop -- after each tick
      const { paused } = await brainWorkOverview(env);
      pausedSeen.push(paused);
    }
    const { parked } = await queue([refused, ...others]);
    expect({
      pausedSeen,
      finished: seen.finished.toSorted(),
      parked: parked.map(({ key, attempts, error }) => ({
        key,
        attempts,
        error,
      })),
    }).toStrictEqual({
      pausedSeen: Array.from({ length: workAttemptsMax }, () => null),
      finished: others.toSorted(),
      parked: [
        { key: refused, attempts: workAttemptsMax, error: "model_refused" },
      ],
    });
  });

  it("puts an item back, spending no attempt, when the host's model can't be reached", async () => {
    reset();
    later(60 * 60_000);
    const item = keyOf("unreached");
    behaviours.set(item, asksOnce);
    await enqueue({ key: item, priority: "asked" });
    for (let tickNumber = 0; tickNumber <= workAttemptsMax; tickNumber += 1) {
      // Past each wait, which doubles up to 30 minutes.
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await store().work(brokenHost, later(40 * 60_000));
    }
    const meanwhile = await queue([item]);
    await answeringProvider(() => answer);
    await tick(40 * 60_000);
    const { parked } = await queue([item]);
    expect({
      reason: meanwhile.paused?.reason,
      parkedMeanwhile: meanwhile.parked,
      runs: runsOf(item),
      finished: seen.finished,
      parked,
    }).toStrictEqual({
      reason: "unavailable",
      parkedMeanwhile: [],
      runs: workAttemptsMax + 2,
      finished: [item],
      parked: [],
    });
  });

  it("asks the model through core's gateway, waiting its turn within the queue's one rate", async () => {
    reset();
    const sentAt: number[] = [];
    const provider = await answeringProvider(() => {
      sentAt.push(Date.now());
      return answer;
    });
    // Long enough for a full bucket.
    later(60 * 60_000);
    const calls = workModelRate.burst + 2;
    const asking = keyOf("asking");
    const answers: string[] = [];
    behaviours.set(asking, async ({ ask }) => {
      for (let call = 0; call < calls; call += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call after another
        answers.push(await ask({ system: "Say something.", input: asking }));
      }
    });
    await enqueue({ key: asking, priority: "upload" });
    await tick();
    const tokenMs = 60_000 / workModelRate.perMinute;
    expect({
      sent: provider.requests.length,
      answers: answers.length,
      // The calls past the burst waited for their tokens.
      paced:
        (sentAt.at(-1) ?? 0) - (sentAt[0] ?? 0) >=
        (calls - workModelRate.burst) * tokenMs - 100,
      finished: seen.finished,
    }).toStrictEqual({
      sent: calls,
      answers: calls,
      paced: true,
      finished: [asking],
    });
  });

  it("pauses the whole queue when the provider limits calls, at least a minute", async () => {
    reset();
    later(60 * 60_000);
    const limit = { told: false };
    const provider = await answeringProvider(() => {
      if (!limit.told) {
        limit.told = true;
        return {
          status: 429,
          errorType: "rate_limit_error",
          headers: { "retry-after": "40" },
        };
      }
      return answer;
    });
    const [limited, next] = keysOf("limited", 2);
    if (limited === undefined || next === undefined) {
      throw new Error("Expected two keys");
    }
    behaviours.set(limited, asksOnce);
    behaviours.set(next, asksOnce);
    await enqueue({ key: limited, priority: "asked" }, quickWork);
    await tick();
    expect(provider.requests).toHaveLength(1);
    await enqueue({ key: next, priority: "asked" }, quickWork);
    await tick(10_000);
    // Nothing is asked while the provider's wait lasts, for any item.
    const waitingFor = await queue();
    expect({
      sent: provider.requests.length,
      reason: waitingFor.paused?.reason,
    }).toStrictEqual({ sent: 1, reason: "rate_limited" });
    await tick(60_000);
    const { parked, paused } = await queue([limited, next]);
    expect({
      sent: provider.requests.length,
      finished: seen.finished.toSorted(),
      parked,
      paused,
    }).toStrictEqual({
      sent: 3,
      finished: [limited, next].toSorted(),
      parked: [],
      paused: null,
    });
  });

  it("waits out an outage of the provider, parking nothing, and finishes everything once it is back", async () => {
    reset();
    later(60 * 60_000);
    const outage = { down: true };
    const provider = await answeringProvider(() =>
      outage.down ? { status: 500, errorType: "api_error" } : answer
    );
    const items = keysOf("outage", 3);
    for (const key of items) {
      behaviours.set(key, asksOnce);
    }
    await enqueueAll(items, { priority: "recent" }, quickWork);
    await tick();
    const first = await queue();
    // After the wait, the provider is still down.
    await tick(3 * 60_000);
    const still = await queue(items);
    outage.down = false;
    await tick(3 * 60_000);
    const { parked, paused, waiting } = await queue(items);
    expect({
      firstReason: first.paused?.reason,
      askedAgain: provider.requests.length > items.length,
      sinceKept:
        still.paused?.since.getTime() === first.paused?.since.getTime(),
      parkedMeanwhile: still.parked,
      finished: seen.finished.toSorted(),
      parked,
      paused,
      waiting,
    }).toStrictEqual({
      firstReason: "unavailable",
      askedAgain: true,
      sinceKept: true,
      parkedMeanwhile: [],
      finished: items.toSorted(),
      parked: [],
      paused: null,
      waiting: 0,
    });
  });

  it("parks an item that needs more model calls than fit in its time, with a bounded number of calls", async () => {
    reset();
    later(60 * 60_000);
    const provider = await answeringProvider(() => answer);
    const heavy = keyOf("heavy");
    behaviours.set(heavy, async ({ ask }) => {
      for (let call = 0; call < 1000; call += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call after another
        await ask({ system: "Say something.", input: heavy });
      }
    });
    await enqueue({ key: heavy, priority: "asked" }, mediumWork);
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked } = await queue([heavy]);
    // Each attempt: the bucket's burst, and what refills in its second.
    const most = workAttemptsMax * (workModelRate.burst + 2);
    expect({
      runs: runsOf(heavy),
      bounded: provider.requests.length <= most,
      parked: parked.map(({ attempts, error }) => ({ attempts, error })),
    }).toStrictEqual({
      runs: workAttemptsMax,
      bounded: true,
      parked: [{ attempts: workAttemptsMax, error: "timed_out" }],
    });
  });

  it("fails an item whose model request can't be sent as its own, never as the host gone", async () => {
    reset();
    const tooLong = keyOf("too-long");
    behaviours.set(tooLong, async ({ ask }) => {
      await ask({
        system: "Say something.",
        input: "x".repeat(workRequestMaxLength + 1),
      });
    });
    await enqueue({ key: tooLong, priority: "asked" });
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked, paused } = await queue([tooLong]);
    expect({
      paused,
      parked: parked.map(({ attempts, error }) => ({ attempts, error })),
    }).toStrictEqual({
      paused: null,
      parked: [{ attempts: workAttemptsMax, error: "invalid_request" }],
    });
  });

  it("parks an item whose request the provider refuses on Grasp's key, and runs the next, the queue never waiting", async () => {
    reset();
    later(60 * 60_000);
    await onGraspKey(async () => {
      const refused = keyOf("refused-grasp");
      const next = keyOf("next-grasp");
      behaviours.set(refused, asksOnce);
      behaviours.set(next, asksOnce);
      await plan(
        platformAnthropicKey,
        Array.from({ length: workAttemptsMax }, () => ({
          status: 400,
          body: {
            type: "error",
            error: { type: "invalid_request_error", message: "Refused." },
          },
        }))
      );
      await enqueue({ key: refused, priority: "asked" });
      const pausedSeen: unknown[] = [];
      for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
        // oxlint-disable-next-line no-await-in-loop -- tick after tick
        await tick(2 * 60 * 60_000);
        // oxlint-disable-next-line no-await-in-loop -- after each tick
        const { paused } = await brainWorkOverview(env);
        pausedSeen.push(paused);
      }
      await plan(platformAnthropicKey, [graspAnswer]);
      await enqueue({ key: next, priority: "asked" });
      await tick();
      const { parked } = await queue([refused, next]);
      expect({
        pausedSeen,
        finished: seen.finished,
        parked: parked.map(({ key, error }) => ({ key, error })),
      }).toStrictEqual({
        pausedSeen: Array.from({ length: workAttemptsMax }, () => null),
        finished: [next],
        parked: [{ key: refused, error: "model_refused" }],
      });
    });
  });

  it("waits out a provider failing on Grasp's key, parking nothing", async () => {
    reset();
    later(60 * 60_000);
    await onGraspKey(async () => {
      const item = keyOf("down-grasp");
      behaviours.set(item, asksOnce);
      await plan(platformAnthropicKey, [{ status: 503 }, graspAnswer]);
      await enqueue({ key: item, priority: "asked" }, quickWork);
      await tick();
      const meanwhile = await queue([item]);
      await tick(3 * 60_000);
      const { parked, paused } = await queue([item]);
      expect({
        reason: meanwhile.paused?.reason,
        parkedMeanwhile: meanwhile.parked,
        finished: seen.finished,
        parked,
        paused,
      }).toStrictEqual({
        reason: "unavailable",
        parkedMeanwhile: [],
        finished: [item],
        parked: [],
        paused: null,
      });
    });
  });

  it("waits out connect being unreachable, parking nothing", async () => {
    reset();
    later(60 * 60_000);
    await answeringProvider(() => answer);
    const item = keyOf("no-connect");
    behaviours.set(item, asksOnce);
    await enqueue({ key: item, priority: "asked" }, quickWork);
    await workBrain({ ...env, CONNECT: unreachableConnect }, later(1000));
    const meanwhile = await queue([item]);
    await tick(3 * 60_000);
    const { parked, paused } = await queue([item]);
    expect({
      reason: meanwhile.paused?.reason,
      parkedMeanwhile: meanwhile.parked,
      finished: seen.finished,
      parked,
      paused,
    }).toStrictEqual({
      reason: "unavailable",
      parkedMeanwhile: [],
      finished: [item],
      parked: [],
      paused: null,
    });
  });

  it("spends the attempt of a handler whose time is up before it asks the model", async () => {
    reset();
    const late = keyOf("asks-late");
    behaviours.set(late, async ({ ask }) => {
      // Past its time, within its grace, then asks.
      await pause(quickTimeMs * 1.5);
      await ask({ system: "Say something.", input: late });
    });
    await enqueue({ key: late, priority: "asked" }, quickWork);
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked } = await queue([late]);
    expect({
      runs: runsOf(late),
      parked: parked.map(({ attempts, error }) => ({ attempts, error })),
    }).toStrictEqual({
      runs: workAttemptsMax,
      parked: [{ attempts: workAttemptsMax, error: "timed_out" }],
    });
  });

  it("keeps a rate limit's pause for the provider's time, though a call sent before it answers", async () => {
    reset();
    later(60 * 60_000);
    await answeringProvider(async (requests) => {
      if (requests.length === 1) {
        // Sent before the limit, answered after it.
        await pause(500);
        return answer;
      }
      return {
        status: 429,
        errorType: "rate_limit_error",
        headers: { "retry-after": "60" },
      };
    });
    const [early, limited] = keysOf("before-limit", 2);
    const afterLimit = keyOf("after-limit");
    if (early === undefined || limited === undefined) {
      throw new Error("Expected two keys");
    }
    behaviours.set(early, asksOnce);
    behaviours.set(limited, asksOnce);
    await enqueue({ key: early, priority: "asked" });
    await enqueue({ key: limited, priority: "asked" });
    await tick();
    await enqueue({ key: afterLimit, priority: "archive" });
    // Inside the provider's 60 s.
    await tick(30_000);
    const meanwhile = await queue();
    const ranInside = seen.started.includes(afterLimit);
    await answeringProvider(() => answer);
    await tick(60_000);
    expect({
      finishedFirst: seen.finished.includes(early),
      reason: meanwhile.paused?.reason,
      ranInside,
      finished: [limited, afterLimit].every((key) =>
        seen.finished.includes(key)
      ),
    }).toStrictEqual({
      finishedFirst: true,
      reason: "rate_limited",
      ranInside: false,
      finished: true,
    });
  });

  it("keeps a pause's reason with the end it owns: a 5xx within a long rate limit neither relabels nor ends it", async () => {
    reset();
    const items = keysOf("pause-owner", 3);
    for (const key of items) {
      behaviours.set(key, asksOnce);
    }
    await enqueueAll(items, { priority: "asked" });
    const replies = { count: 0 };
    // Three calls under way at once, answered in turn: a long rate limit,
    // then a 5xx, then an answer.
    const host = async () => {
      replies.count += 1;
      const mine = replies.count;
      await pause(30 * mine);
      if (mine === 1) {
        return {
          kind: "busy" as const,
          reason: "rate_limited" as const,
          retryAfterSeconds: 600,
        };
      }
      if (mine === 2) {
        return { kind: "busy" as const, reason: "unavailable" as const };
      }
      return { kind: "answer" as const, text: "An answer." };
    };
    const at = later(1000);
    await store().work(host, at);
    const { paused } = await queue();
    expect({
      reason: paused?.reason,
      lasts: (paused?.until.getTime() ?? 0) - at.getTime() >= 590_000,
    }).toStrictEqual({ reason: "rate_limited", lasts: true });
  });

  it("parks the items a hanging provider timed out, and they come back a day later and finish", async () => {
    reset();
    later(60 * 60_000);
    const provider = { hangs: true };
    await answeringProvider(() => (provider.hangs ? { hang: true } : answer));
    const items = keysOf("hanging", 2);
    for (const key of items) {
      behaviours.set(key, asksOnce);
    }
    await enqueueAll(items, { priority: "asked" }, mediumWork);
    for (let tickNumber = 0; tickNumber < workAttemptsMax; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const meanwhile = await queue(items);
    provider.hangs = false;
    // A day after the last of them was parked.
    await tick(workParkedMs + 60_000);
    const { parked } = await queue(items);
    expect({
      parkedMeanwhile: meanwhile.parked.map(({ error, parks, final }) => ({
        error,
        parks,
        final,
      })),
      pausedMeanwhile: meanwhile.paused,
      finished: seen.finished.toSorted(),
      parked,
    }).toStrictEqual({
      parkedMeanwhile: items.map(() => ({
        error: "timed_out",
        parks: 1,
        final: false,
      })),
      pausedMeanwhile: null,
      finished: items.toSorted(),
      parked: [],
    });
  });

  it("pauses for an account problem as long as it lasts, parking nothing, and runs the backlog once it clears", async () => {
    reset();
    later(60 * 60_000);
    const key = { refused: true };
    await answeringProvider(() =>
      key.refused ? { status: 401, errorType: "authentication_error" } : answer
    );
    const backlog = keysOf("key-refused", 3);
    for (const item of backlog) {
      behaviours.set(item, asksOnce);
    }
    await enqueueAll(backlog, { priority: "recent" }, quickWork);
    await tick();
    const first = await queue(backlog);
    // 26 hours of it, a tick every half hour.
    for (let tickNumber = 0; tickNumber < 52; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(30 * 60_000);
    }
    const meanwhile = await queue(backlog);
    key.refused = false;
    await tick(30 * 60_000);
    const { parked, paused, waiting } = await queue(backlog);
    expect({
      reason: meanwhile.paused?.reason,
      sinceKept:
        meanwhile.paused?.since.getTime() === first.paused?.since.getTime(),
      parkedMeanwhile: meanwhile.parked,
      finished: seen.finished.toSorted(),
      parked,
      paused,
      waiting,
    }).toStrictEqual({
      reason: "account",
      sinceKept: true,
      parkedMeanwhile: [],
      finished: backlog.toSorted(),
      parked: [],
      paused: null,
      waiting: 0,
    });
  });

  it("claims nothing while the queue is paused", async () => {
    reset();
    later(60 * 60_000);
    const asking = keyOf("asking");
    const plain = keyOf("plain");
    behaviours.set(asking, asksOnce);
    await enqueue({ key: asking, priority: "asked" });
    await store().work(brokenHost, later(1000));
    await enqueue({ key: plain, priority: "archive" });
    // Within the pause's minute: nothing runs, not even work with no model.
    await tick(10_000);
    const meanwhile = [...seen.started];
    await answeringProvider(() => answer);
    await tick(60_000);
    expect({ meanwhile, finished: seen.finished.toSorted() }).toStrictEqual({
      meanwhile: [asking],
      finished: [asking, plain].toSorted(),
    });
  });

  it("parks a poisoned item for good after its third park, with a bounded number of model calls", async () => {
    reset();
    later(60 * 60_000);
    const provider = await answeringProvider(() => answer);
    const poisoned = keyOf("poisoned");
    behaviours.set(poisoned, async ({ ask }) => {
      await ask({ system: "Say something.", input: poisoned });
      throw new Error("The test's handler failed");
    });
    await enqueue({ key: poisoned, priority: "asked" });
    // Four days, a tick every two hours.
    for (let tickNumber = 0; tickNumber < 48; tickNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick(2 * 60 * 60_000);
    }
    const { parked } = await queue([poisoned]);
    expect({
      sent: provider.requests.length,
      parked: parked.map(({ error, parks, final }) => ({
        error,
        parks,
        final,
      })),
    }).toStrictEqual({
      sent: workParksMax * workAttemptsMax,
      parked: [{ error: "failed", parks: workParksMax, final: true }],
    });
  });

  it("parks nothing for restarts alone: a first stop gives the attempt back", async () => {
    reset();
    const healthy = keyOf("healthy");
    const gate = flag();
    behaviours.set(healthy, async () => {
      await gate.wait();
    });
    await enqueue({ key: healthy, priority: "asked" });
    for (let stop = 1; stop < workAttemptsMax; stop += 1) {
      const ticked = failed(tick(2 * 60 * 60_000));
      // oxlint-disable-next-line no-await-in-loop -- until this run began
      await until(() => runsOf(healthy) === stop);
      // oxlint-disable-next-line no-await-in-loop -- one restart at a time
      await killStore();
      // oxlint-disable-next-line no-await-in-loop -- the tick ended with it
      await ticked;
    }
    gate.set();
    await tick(2 * 60 * 60_000);
    const { parked } = await queue([healthy]);
    expect({ finished: seen.finished, parked }).toStrictEqual({
      finished: [healthy],
      parked: [],
    });
  });

  it("claims into free slots while a slow item runs", async () => {
    reset();
    const slow = keyOf("slow-one");
    const added = keyOf("added-meanwhile");
    const seenBySlow = { addedDone: false };
    const reached = flag();
    behaviours.set(slow, async () => {
      reached.set();
      // Runs on until the item added meanwhile is done, for at most 10 s.
      const giveUpAt = Date.now() + 10_000;
      while (!seen.finished.includes(added) && Date.now() < giveUpAt) {
        // oxlint-disable-next-line no-await-in-loop -- until it is done
        await pause(20);
      }
      seenBySlow.addedDone = seen.finished.includes(added);
    });
    await enqueue({ key: slow, priority: "asked" });
    const ticked = tick();
    await reached.wait();
    await enqueue({ key: added, priority: "archive" });
    await ticked;
    expect(seenBySlow.addedDone).toBeTruthy();
  });

  it("restarts the store when handlers past their time hold every slot, and runs the rest", async () => {
    reset();
    const hung = keysOf("hung", 5);
    const normal = keysOf("normal", 3);
    for (const key of hung) {
      behaviours.set(key, async () => {
        // Ignores its signal, well past its time and its grace.
        await pause(quickTimeMs * 3);
      });
    }
    await enqueueAll(hung, { priority: "asked" }, quickWork);
    await enqueueAll(normal, { priority: "archive" });
    const first = await failed(tick());
    // The four retried later; the fifth runs on its own beside the rest.
    await tick();
    const ran = seen.finished.filter((key) => normal.includes(key)).toSorted();
    // Clear the hung ones: their next runs end at once.
    await pause(quickTimeMs * 4);
    for (const key of hung) {
      behaviours.delete(key);
    }
    await tick(2 * 60 * 60_000);
    expect({ restarted: first, ran }).toStrictEqual({
      restarted: true,
      ran: normal.toSorted(),
    });
  });

  it("fails an attempt that asks the model more often than it may", async () => {
    reset();
    later(60 * 60_000);
    // The provider limits calls for half an hour: each call after the first
    // ends at once, so the count is reached without waiting for tokens.
    const provider = await answeringProvider(() => ({
      status: 429,
      errorType: "rate_limit_error",
      headers: { "retry-after": "1800" },
    }));
    const runaway = keyOf("runaway");
    const stopped = { code: "" };
    behaviours.set(runaway, async ({ ask }) => {
      // A runaway loop, which doesn't even let the pause through.
      for (let call = 0; call <= workCallsMax; call += 1) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one call after another
          await ask({ system: "Say something.", input: runaway });
        } catch (error) {
          if (error instanceof WorkError) {
            stopped.code = error.code;
            throw error;
          }
        }
      }
    });
    await enqueue({ key: runaway, priority: "asked" });
    await tick();
    expect({
      sent: provider.requests.length,
      code: stopped.code,
      finished: seen.finished,
    }).toStrictEqual({ sent: 1, code: "too_many_calls", finished: [] });
  });

  // An import is a backlog of one connection. Past 10,000 timers alive at
  // once workerd refuses another, so a drain this long fails if any timer
  // outlives its item; and it takes seconds only if a claim never walks
  // the backlog of a connection at its limit.
  it("drains 12,000 quick items of one connection, every timer it starts cleared", async () => {
    reset();
    const connection = `bulk-${crypto.randomUUID()}`;
    const items = keysOf("bulk", 12_000);
    await enqueueAll(items, { priority: "archive", connection });
    let ticks = 0;
    while (seen.finished.length < items.length && ticks < 20) {
      ticks += 1;
      // oxlint-disable-next-line no-await-in-loop -- tick after tick
      await tick();
    }
    const { waiting, running } = await queue();
    expect({ finished: seen.finished.length, waiting, running }).toStrictEqual({
      finished: items.length,
      waiting: 0,
      running: 0,
    });
  });
  // One sweep R2 never answers, its batch two leftover files: the setup
  // waits its 10 s once, and each test below checks one thing of it. File
  // A's delete lands late; file B's never does.
  describe("a sweep R2 doesn't answer", () => {
    const swept = {
      tookMs: 0,
      queued: "",
      inFlight: "",
      reason: "",
      reasonAfterIdle: "",
      deletesAfter: 0,
      refusalInDoubt: "",
      writesInDoubt: 0,
      aGoneOnceLanded: false,
      textA: "",
      hashB: "",
    };

    beforeAll(async () => {
      reset();
      swept.textA = `File A an add left, ${crypto.randomUUID()}`;
      const textB = `File B an add left, ${crypto.randomUUID()}`;
      const hashA = await crashedAdd(swept.textA);
      swept.hashB = await crashedAdd(textB);
      swept.inFlight = keyOf("in-flight");
      swept.queued = keyOf("queued");
      const gate = flag();
      const reached = flag();
      behaviours.set(swept.inFlight, async () => {
        reached.set();
        await gate.wait();
      });
      // An item under way from a tick before, past any earlier sweep's
      // wait; that tick's sweep finds R2 answering.
      const { held, restore } = await holdingDeletes([
        `sources/${swept.hashB}`,
      ]);
      held.released = true;
      await runInDurableObject(store(), (_store, state) => {
        state.storage.sql.exec(
          "UPDATE files SET written_at = ? WHERE hash IN (?, ?)",
          Date.now(),
          hashA,
          swept.hashB
        );
      });
      await enqueue({ key: swept.inFlight, priority: "asked" });
      const first = tick(16 * 60_000);
      await reached.wait();
      // Then the files are due, and R2 stops answering.
      await runInDurableObject(store(), (_store, state) => {
        state.storage.sql.exec(
          "UPDATE files SET written_at = 0 WHERE hash IN (?, ?)",
          hashA,
          swept.hashB
        );
      });
      held.released = false;
      const askedBefore = held.asked;
      await enqueue({ key: swept.queued, priority: "archive" });
      const began = Date.now();
      const second = tick(16 * 60_000);
      gate.set();
      await second;
      swept.tookMs = Date.now() - began;
      await first;
      const { stepsFailed } = await brainWorkOverview(env);
      swept.reason = stepsFailed.sweep?.reason ?? "";
      // Ticks within the quarter hour don't sweep.
      await tick(60_000);
      await tick(10 * 60_000);
      swept.deletesAfter = held.asked - askedBefore;
      // During the doubt, an add of file A's bytes is refused, writing nothing.
      swept.refusalInDoubt = await refusalOf(
        addOf(swept.textA, `person-${crypto.randomUUID()}`)
      );
      swept.writesInDoubt = held.writes;
      // File A's delete lands late; file B's never does.
      held.released = true;
      while (held.landed === 0) {
        // oxlint-disable-next-line no-await-in-loop -- until it landed
        await pause(20);
      }
      swept.aGoneOnceLanded =
        (await env.BRAIN_OBJECTS.head(`sources/${hashA}`)) === null;
      restore();
      // Past the quarter hour, a sweep finds nothing due (the kept files
      // were noted afresh): it never reached R2, so the failure stays.
      await tick(16 * 60_000);
      const idle = await brainWorkOverview(env);
      swept.reasonAfterIdle = idle.stepsFailed.sweep?.reason ?? "";
    }, 60_000);

    it("runs the queue's items that tick, within the bound, and leaves an item in flight untouched", () => {
      expect({
        withinBound: swept.tookMs < 15_000,
        finished: [swept.inFlight, swept.queued].map((key) =>
          seen.finished.includes(key)
        ),
        inFlightRuns: runsOf(swept.inFlight),
      }).toStrictEqual({
        withinBound: true,
        finished: [true, true],
        inFlightRuns: 1,
      });
    });

    it("says the sweep timed out, sweeps no more within the quarter hour, and keeps saying so after a sweep with nothing due", () => {
      expect({
        reason: swept.reason,
        deletes: swept.deletesAfter,
        afterIdle: swept.reasonAfterIdle,
      }).toStrictEqual({
        reason: "timed_out",
        deletes: 1,
        afterIdle: "timed_out",
      });
    });

    it("refuses an add of file A's bytes while its delete may land, then adds it once the doubt has passed", async () => {
      const { userId } = await signedInWithRole(idp, "user");
      const read = await withDateAhead(16 * 60_000, async () => {
        const added = await addOf(swept.textA, userId);
        return await readSourceVersionAs(env, userId, added);
      });
      expect({
        refusedInDoubt: swept.refusalInDoubt.includes("add it again"),
        writesInDoubt: swept.writesInDoubt,
        goneOnceLanded: swept.aGoneOnceLanded,
        readBack: read?.text,
      }).toStrictEqual({
        refusedInDoubt: true,
        writesInDoubt: 0,
        goneOnceLanded: true,
        readBack: swept.textA,
      });
    });

    it("sweeps file B, whose late delete never landed, once the doubt has passed, and shows no step failed after it", async () => {
      const inDoubt = await inDoubtNow(swept.hashB);
      await withDateAhead(16 * 60_000, async () => {
        await tick(16 * 60_000);
      });
      const { stepsFailed } = await brainWorkOverview(env);
      expect({
        inDoubt,
        noted: await noted(swept.hashB),
        fileThere:
          (await env.BRAIN_OBJECTS.head(`sources/${swept.hashB}`)) !== null,
        stepsFailed,
      }).toStrictEqual({
        inDoubt: true,
        noted: false,
        fileThere: false,
        // A sweep that finished clears the last one's failure; the repack
        // of the same tick finished too.
        stepsFailed: { sweep: null, repack: null },
      });
    });
  });
});
