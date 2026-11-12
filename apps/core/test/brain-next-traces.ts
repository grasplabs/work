/**
 * What the tests of the Brain's erasure look with (brain-next-erasure.test.ts,
 * brain-next-origins.test.ts): marks planted in sources and looked for in
 * every table and index page of the store and every object of its bucket,
 * the clock moved past a file's grace, ticks until no erasure is left, and
 * a bucket write held or failed.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { brainWorkOverview, workBrain } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { noProducers } from "./no-producers.ts";

/** The Brain's one store, as core reaches it. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** How long the store gives an add before it sweeps a file nothing holds. */
export const fileGraceMs = 15 * 60 * 1000;

/** A mark of 24 digits: found by its last 12 in every table and file. */
export const newMark = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    String(byte % 10)
  ).join("");

/** What is looked for of `mark`: its tail, whole in any index page. */
export const tailOf = (mark: string): string => mark.slice(-12);

/**
 * A word holding `mark`, as a source writes it: with an ending the
 * stemmers take off, so the mark is in the stems index too.
 */
export const wordOf = (mark: string): string => `zq${mark}ingen`;

/** Bytes as text, one character a byte: digits show as they are. */
const bytesAsText = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => String.fromCodePoint(byte)).join(
    ""
  );

/** A stored value as text, whatever its kind. */
const valueAsText = (value: SqlStorageValue): string =>
  value instanceof ArrayBuffer ? bytesAsText(value) : String(value);

/**
 * The tables of the store, every one, the word indexes' own pages and
 * copies among them, that hold any of `marks` anywhere in a row.
 */
export const tablesHolding = async (
  marks: readonly string[]
): Promise<string[]> =>
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    const names = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
      )
      .toArray()
      .map(({ name }) => name);
    const holding = new Set<string>();
    for (const name of names) {
      for (const row of sql.exec(`SELECT * FROM "${name}"`)) {
        const text = Object.values(row).map(valueAsText).join(" ");
        if (marks.some((mark) => text.includes(tailOf(mark)))) {
          holding.add(name);
        }
      }
    }
    return [...holding].toSorted();
  });

/** The keys of the bucket whose key or bytes hold any of `marks`. */
export const objectsHolding = async (
  marks: readonly string[]
): Promise<string[]> => {
  const holding: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed: R2Objects = await env.BRAIN_OBJECTS.list(
      cursor === undefined ? {} : { cursor }
    );
    for (const { key } of listed.objects) {
      // oxlint-disable-next-line no-await-in-loop -- one object at a time
      const object = await env.BRAIN_OBJECTS.get(key);
      // oxlint-disable-next-line no-await-in-loop -- one object at a time
      const body = object === null ? null : await object.arrayBuffer();
      const bytes = body === null ? "" : bytesAsText(body);
      if (marks.some((mark) => `${key} ${bytes}`.includes(tailOf(mark)))) {
        holding.push(key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return holding;
};

/** Moves the clock, for `Date` alone, to `ms` from now. */
export const later = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
};

/** Ticks core's clock past a file's grace, so the sweep takes what is due. */
export const tickPastGrace = async (): Promise<void> => {
  later(fileGraceMs + 1);
  await workBrain(env, new Date(), noProducers);
};

/** Ticks until no erasure is left unfinished, at most `most` ticks. */
export const tickUntilErased = async (most = 10): Promise<number> => {
  for (let tick = 1; tick <= most; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await workBrain(env, new Date(), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    const { erasing } = await brainWorkOverview(env);
    if (erasing === 0) {
      return tick;
    }
  }
  return Number.POSITIVE_INFINITY;
};

/**
 * Has the store's next write to its bucket go through `put`, given the
 * store's state and the write itself; its own bucket is back after it.
 * The shared store's, or the one named `name` (a person's own).
 */
export const nextBucketPut = async (
  put: (
    state: DurableObjectState,
    write: () => Promise<unknown>
  ) => Promise<unknown>,
  name = "brain"
): Promise<void> => {
  const stub = inJurisdiction(env, env.BRAIN_STORE).getByName(name);
  await runInDurableObject(stub, (instance, state) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    const once = {
      get: async (key: string) => await bucket.get(key),
      head: async (key: string) => await bucket.head(key),
      list: async (options: R2ListOptions) => await bucket.list(options),
      delete: async (keys: string | string[]) => {
        await bucket.delete(keys);
      },
      put: async (
        key: string,
        value: ArrayBufferView,
        options?: R2PutOptions
      ) => {
        Reflect.set(instance, "env", objectEnv);
        return await put(
          state,
          async () => await bucket.put(key, value, options)
        );
      },
    };
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: once });
  });
};

/**
 * Holds the store's next bucket write before it reaches the bucket, until
 * the test releases it: `reached` once it is there. Flags, not a promise,
 * since workerd won't let one request wait on another's.
 */
export const holdNextBucketPut = async (name = "brain") => {
  const gate = { reached: false, released: false };
  await nextBucketPut(async (_state, write) => {
    gate.reached = true;
    while (!gate.released) {
      // oxlint-disable-next-line no-await-in-loop -- until the test says
      await scheduler.wait(10);
    }
    return await write();
  }, name);
  return gate;
};

/** The SHA-256 of `text`'s UTF-8 bytes, in hex. */
export const hashOf = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** The ledger's entries naming `id` (a source's key or a person's id). */
export const ledgerOf = async (id: string): Promise<string[]> => {
  const subject = await hashOf(id);
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const listed: R2Objects = await env.BRAIN_OBJECTS.list({
      prefix: "erasures/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...listed.objects.map(({ key }) => key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
  return keys.filter((key) => key.endsWith(`-${subject}`));
};

/**
 * `promise`'s outcome, value or error, observed from now on: a promise
 * awaited later in a test never rejects with nothing watching it.
 */
export const settled = async <T>(
  promise: Promise<T>
): Promise<{ value: T } | { error: string }> => {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: String(error) };
  }
};
