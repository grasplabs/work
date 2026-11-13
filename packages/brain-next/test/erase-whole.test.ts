// A person's own store erased whole (store.ts `#eraseWhole`) against
// writes that land late: one rule. Done only when no write of the instance
// is on its way (every put and delete, counted from when it is sent until
// R2 answers, whoever sent it and whether or not it still waits), the grace
// has passed since the record's moment, and the listing is empty. A write
// still on its way a grace on moves the moment and restarts the store: two
// graces at most. GRA-1839 (review round 5), GRA-1866.
import type { Access, EmbedModel } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { fileGraceMs } from "../src/files.ts";
import { ledgerRetryMs } from "../src/store.ts";
import type { Store } from "./export-reads.ts";
import { kill } from "./store-copy.ts";

const unique = (): string => crypto.randomUUID();
const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);
const alone = (person: string): Access => ({ kind: "owner", person });

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** What is under `person`'s prefix but the record of their erasure. */
const leftOf = async (person: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({
    prefix: `people/${await sha256(person)}/`,
  });
  return listed.objects
    .map(({ key }) => key)
    .filter((key) => !key.endsWith("/erased"));
};

/** The record of `person`'s erasure moved back past the grace, as time passing would. */
const aGraceLater = async (person: string): Promise<void> => {
  const key = `people/${await sha256(person)}/erased`;
  const record = await env.BRAIN_OBJECTS.get(key);
  const { reason, at } = z
    .object({ reason: z.string(), at: z.number() })
    .parse(JSON.parse((await record?.text()) ?? "null"));
  await env.BRAIN_OBJECTS.put(
    key,
    JSON.stringify({ reason, at: at - fileGraceMs - 1 })
  );
};

/** One call of `person`'s erasure: how it ended. */
const erase = async (person: string): Promise<string> => {
  const [outcome] = await Promise.allSettled([
    called(own(person).erasePerson({ person, reason: "person_erased" })),
  ]);
  return outcome?.status ?? "none";
};

/** How often `until` looks, and how many times before it gives up: 10 s. */
const untilEveryMs = 20;
const untilLooks = 500;

/** Waits until `open` says so, by the runtime's `scheduler.wait`, which faked timers leave real. */
const until = async (open: () => boolean, what: string): Promise<void> => {
  for (let look = 0; !open(); look += 1) {
    if (look === untilLooks) {
      throw new Error(`Waited 10 s for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until released
    await scheduler.wait(untilEveryMs);
  }
};

/** A write held on its way: R2 hasn't answered it. */
interface Held {
  held: boolean;
  released: boolean;
  write?: { key: string; value: ArrayBuffer | ArrayBufferView | string };
}

/**
 * Has `person`'s store reach the bucket through one that holds the first
 * write whose key `holds` picks: it moves the faked timers (the store's
 * too, in this isolate) on by `waitMs`, past the wait of whoever sent it,
 * and never answers. The test lands its bytes (`land`), as R2 completing
 * a request may, and releases it: then it fails, as its instance is gone.
 */
const holdWrite = async (
  person: string,
  holds: (key: string) => boolean,
  waitMs: number
): Promise<Held> => {
  const state: Held = { held: false, released: false };
  const real = env.BRAIN_OBJECTS;
  const bucket = {
    get: async (key: string) => await real.get(key),
    head: async (key: string) => await real.head(key),
    list: async (options?: R2ListOptions) => await real.list(options),
    delete: async (keys: string | string[]) => {
      await real.delete(keys);
    },
    put: async (
      key: string,
      value: ArrayBuffer | ArrayBufferView | string,
      options?: R2PutOptions
    ) => {
      if (state.held || !holds(key)) {
        return await real.put(key, value, options);
      }
      state.held = true;
      state.write = { key, value };
      await vi.advanceTimersByTimeAsync(waitMs);
      await until(() => state.released, "the test to release a write");
      throw new Error("Its instance was ended before R2 answered");
    },
  };
  await runInDurableObject(own(person), (instance) => {
    Reflect.set(instance, "env", { ...env, BRAIN_OBJECTS: bucket });
  });
  return state;
};

/** The held write landed in the bucket as it was sent, and released. */
const land = async (held: Held): Promise<void> => {
  if (held.write === undefined) {
    throw new Error("No write was held");
  }
  held.released = true;
  await env.BRAIN_OBJECTS.put(held.write.key, held.write.value);
};

const quietAsk = async () => {
  await Promise.resolve();
  return { kind: "answer" as const, text: "" };
};

const model: EmbedModel = { name: "erase-test", build: "1" };

/** One tick of `person`'s store, its embedders answering every text with a vector. */
const tick = async (person: string, embedding = false): Promise<void> => {
  await own(person).work({
    ask: quietAsk,
    at: new Date(),
    embedders: {
      model: embedding ? model : null,
      embed: async ({ texts }) => {
        await Promise.resolve();
        return {
          kind: "vectors",
          model,
          results: texts.map(() => [1, 0, 0, 0]),
        };
      },
    },
    handOvers: {
      handOver: async () => {
        await Promise.resolve();
        return { kind: "nothing" };
      },
    },
  });
};

/**
 * The erasure of `person`, a write held on its way: not done while it is,
 * and past the grace it moves the moment and restarts the store; the write
 * lands; the next instance is done a grace on, with nothing left.
 */
const erasedPastHeldWrite = async (person: string, held: Held) => {
  const recorded = await erase(person);
  await aGraceLater(person);
  const whileOnItsWay = await erase(person);
  await land(held);
  const afterLanding = await leftOf(person);
  const withinTheNewGrace = await erase(person);
  await aGraceLater(person);
  const done = await erase(person);
  return {
    held: held.held,
    recorded,
    whileOnItsWay,
    landed: afterLanding.length > 0,
    withinTheNewGrace,
    done,
    left: await leftOf(person),
  };
};

const expected = {
  held: true,
  recorded: "rejected",
  whileOnItsWay: "rejected",
  landed: true,
  withinTheNewGrace: "rejected",
  done: "fulfilled",
  left: [],
};

describe("a person's own store erased whole, against writes that land late", () => {
  // The reviewer's probe: a ledger write the store stopped waiting for
  // (erasure.ts `inTime`, 10 s) is counted until R2 answers it.
  it("isn't done while a ledger write the store stopped waiting for is on its way", async () => {
    const person = unique();
    const source = `test:${unique()}`;
    await own(person).addSource({
      source,
      change: unique(),
      text: "Mine alone",
      access: alone(person),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const held = await holdWrite(
        person,
        (key) => key.includes("/erasures/"),
        11_000
      );
      await Promise.allSettled([
        called(own(person).eraseSource({ source, reason: "retention" })),
      ]);
      await Promise.allSettled([tick(person)]);
      await expect(erasedPastHeldWrite(person, held)).resolves.toStrictEqual(
        expected
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // A vector write the embedding's handler stopped waiting for
  // (embedding.ts `bucketCall`, 10 s).
  it("isn't done while a vector write its handler stopped waiting for is on its way", async () => {
    const person = unique();
    await own(person).addSource({
      source: `test:${unique()}`,
      change: unique(),
      text: "Mine alone, to embed",
      access: alone(person),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const held = await holdWrite(
        person,
        (key) => key.includes("/vectors/"),
        11_000
      );
      for (let ticks = 0; ticks < 4 && !held.held; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await Promise.allSettled([tick(person, true)]);
      }
      await expect(erasedPastHeldWrite(person, held)).resolves.toStrictEqual(
        expected
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // A write that never answers: two graces, the restart the store's own.
  it("is done two graces on though a write never answers, restarting the store itself", async () => {
    const person = unique();
    const source = `test:${unique()}`;
    await own(person).addSource({
      source,
      change: unique(),
      text: "Mine alone",
      access: alone(person),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const held = await holdWrite(
        person,
        (key) => key.includes("/erasures/"),
        11_000
      );
      await Promise.allSettled([
        called(own(person).eraseSource({ source, reason: "retention" })),
      ]);
      const recorded = await erase(person);
      await aGraceLater(person);
      const firstGrace = await erase(person);
      const withinTheSecond = await erase(person);
      await aGraceLater(person);
      const done = await erase(person);
      expect({
        held: held.held,
        recorded,
        firstGrace,
        withinTheSecond,
        done,
        left: await leftOf(person),
      }).toStrictEqual({
        held: true,
        recorded: "rejected",
        firstGrace: "rejected",
        withinTheSecond: "rejected",
        done: "fulfilled",
        left: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review finding 2: the instance a restart makes can't read the record
  // as it starts, writes it again, and finds no schema. It is no store
  // that was never written (an erasure was recorded before), and while it
  // can't read whether it was erased it is never done.
  it.each([
    ["can't read the record as it starts", 1],
    ["can't read whether it was erased at all", Number.POSITIVE_INFINITY],
  ])(
    "isn't done by the instance a restart made, which finds no schema and %s",
    async (_case, failing) => {
      const person = unique();
      const source = `test:${unique()}`;
      await own(person).addSource({
        source,
        change: unique(),
        text: "Mine alone",
        access: alone(person),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const held = await holdWrite(
          person,
          (key) => key.includes("/erasures/"),
          11_000
        );
        await Promise.allSettled([
          called(own(person).eraseSource({ source, reason: "retention" })),
        ]);
        await erase(person);
        await aGraceLater(person);
        // Past the grace, the write still on its way: the store restarts.
        const restarting = await erase(person);
        await land(held);
        await kill(own(person));
        // The next instance's reads of whether it was erased fail.
        const bucket = env.BRAIN_OBJECTS;
        let heads = 0;
        Reflect.set(env, "BRAIN_OBJECTS", {
          get: async (key: string) => await bucket.get(key),
          list: async (options?: R2ListOptions) => await bucket.list(options),
          put: async (
            key: string,
            value: ArrayBuffer | string,
            options?: R2PutOptions
          ) => await bucket.put(key, value, options),
          delete: async (keys: string | string[]) => {
            await bucket.delete(keys);
          },
          head: async (key: string) => {
            heads += 1;
            if (heads <= failing) {
              await Promise.resolve();
              throw new Error("R2 out of reach");
            }
            return await bucket.head(key);
          },
        });
        let fresh = "";
        let aGraceOn = "";
        try {
          fresh = await erase(person);
          await aGraceLater(person);
          aGraceOn =
            failing === 1 ? "not asked: it can read it" : await erase(person);
        } finally {
          Reflect.set(env, "BRAIN_OBJECTS", bucket);
        }
        await aGraceLater(person);
        // R2 answers again: the store reads it once its wait after a
        // failed read is over.
        vi.setSystemTime(Date.now() + ledgerRetryMs);
        const done = await erase(person);
        expect({
          restarting,
          fresh,
          aGraceOn,
          done,
          left: await leftOf(person),
        }).toStrictEqual({
          restarting: "rejected",
          fresh: "rejected",
          aGraceOn: failing === 1 ? "not asked: it can read it" : "rejected",
          done: "fulfilled",
          left: [],
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  // Review finding 3: no rule of an instance's own time. One evicted
  // between every call still finishes, by the record's moment alone.
  it("is done though its instance is evicted between every call", async () => {
    const person = unique();
    await own(person).addSource({
      source: `test:${unique()}`,
      change: unique(),
      text: "Mine alone",
      access: alone(person),
    });
    const recorded = await erase(person);
    await kill(own(person));
    const withinTheGrace = await erase(person);
    await kill(own(person));
    await aGraceLater(person);
    await kill(own(person));
    const done = await erase(person);
    expect({
      recorded,
      withinTheGrace,
      done,
      left: await leftOf(person),
    }).toStrictEqual({
      recorded: "rejected",
      withinTheGrace: "rejected",
      done: "fulfilled",
      left: [],
    });
  });
});
