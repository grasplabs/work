import { sourceTextMaxBytes } from "@grasp-os/brain-next/contract";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, readSourceVersionAs, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// Sources kept whole and versioned (GRA-1723), through core's functions
// into the Brain's store and its bucket: a source has one identity across
// versions; each version's original file is in R2 under the SHA-256 of
// its bytes, stored once and counted by the versions that hold it; recall
// searches the chunks of current versions only, and history is read whole
// through its own call, by that version's own readers. Adding is safe to
// repeat, and a crash between the file and the version leaves nothing
// visible: a retry finishes it, and otherwise the sweep removes the file.

const idp = mockIdp();

/** How long the store gives an add before it sweeps the file it left. */
const fileGraceMs = 15 * 60 * 1000;

/** A word no other test's sources hold. */
const word = () => `w${unique()}`;

/** A source identity of its own, as a producer gives one. */
const newSource = () => `test:${crypto.randomUUID()}`;

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** A team of the organization with `members` in it. */
const teamOf = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId: id,
      userId,
      createdAt: new Date(),
    });
  }
  return id;
};

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** What `personId` recalls for `question`: each chunk's source and version. */
const recalledAs = async (personId: string, question: string) => {
  const { chunks } = await recallAs(env, personId, question);
  return chunks.map(({ source, version }) => ({ source, version }));
};

/** The text of `source`'s `version` as `personId` reads it: null if not. */
const historyAs = async (
  personId: string,
  source: string,
  version: number
): Promise<string | null> => {
  const read = await readSourceVersionAs(env, personId, { source, version });
  return read?.text ?? null;
};

/** The SHA-256 of `text`'s UTF-8 bytes, in hex. */
const hashOf = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** The bucket's file holding `text`, by its hash: null when there is none. */
const fileOf = async (text: string): Promise<string | null> => {
  const file = await env.BRAIN_OBJECTS.get(`sources/${await hashOf(text)}`);
  return file === null ? null : await file.text();
};

/** The Brain's one store. */
const store = () => env.BRAIN_STORE.getByName("brain");

/**
 * How many source versions the store counts on the file holding `text`:
 * what erasure (GRA-1729) deletes a file by, read here until it exists.
 */
const countOn = async (text: string): Promise<number | null> => {
  const hash = await hashOf(text);
  return await runInDurableObject(
    store(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ refs: number }>("SELECT refs FROM files WHERE hash = ?", hash)
        .toArray()
        .at(0)?.refs ?? null
  );
};

/**
 * Has the store's next `count` file writes go through `put` instead of
 * straight to the bucket, given the store's state; its own bucket is back
 * once they have all started.
 */
const nextFileWrites = async (
  count: number,
  put: (
    state: DurableObjectState,
    write: () => Promise<unknown>,
    started: Promise<unknown>
  ) => Promise<unknown>
): Promise<void> => {
  await runInDurableObject(store(), (instance, state) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    const all = Promise.withResolvers<boolean>();
    let arrived = 0;
    const writes = {
      put: async (
        key: string,
        value: ArrayBufferView,
        options?: R2PutOptions
      ) => {
        arrived += 1;
        if (arrived === count) {
          Reflect.set(instance, "env", objectEnv);
          all.resolve(true);
        }
        return await put(
          state,
          async () => await bucket.put(key, value, options),
          all.promise
        );
      },
    };
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: writes });
  });
};

/**
 * Has the store's next file land in the bucket and the store then crash,
 * before it records the version: as a restart between the two would. The
 * store wakes afresh on the next call.
 */
const crashAfterNextFile = async (): Promise<void> => {
  await nextFileWrites(1, async (state, write) => {
    await write();
    state.abort("Crashed by the test, the file stored");
  });
};

/**
 * Holds the store's next `count` file writes until all have started, so
 * those adds are between the file and the version side by side.
 */
const meetAtFiles = async (count: number): Promise<void> => {
  await nextFileWrites(count, async (_state, write, started) => {
    await started;
    return await write();
  });
};

/** The crash an add stops with: the store's own reset. */
const crashed = /Crashed by the test/u;

describe("sources kept whole and versioned", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds the same content for the same source once: one version, one file counted once", async () => {
    const reader = await person();
    const source = newSource();
    const secret = word();
    const text = `Offer ${secret}`;
    const add = async () =>
      await addSource(env, { source, text, readers: owner(reader) });

    // Three at once, as retries racing each other, all between the file
    // and the version together; then one after the first reply was lost.
    await meetAtFiles(3);
    const racing = await Promise.all([add(), add(), add()]);
    const retried = await add();

    const first = { source, version: 1 };
    expect({
      racing,
      retried,
      recalled: await recalledAs(reader, secret),
      second: await historyAs(reader, source, 2),
      file: await fileOf(text),
      count: await countOn(text),
    }).toStrictEqual({
      racing: [first, first, first],
      retried: first,
      recalled: [first],
      second: null,
      file: text,
      count: 1,
    });
  });

  it("keeps the same content under two sources as two sources sharing one file, counted twice", async () => {
    const reader = await person();
    const [one, two] = [newSource(), newSource()];
    const secret = word();
    const text = `Shared ${secret}`;

    await addSource(env, { source: one, text, readers: owner(reader) });
    await addSource(env, { source: two, text, readers: owner(reader) });

    const recalled = await recalledAs(reader, secret);
    const listed = await env.BRAIN_OBJECTS.list({
      prefix: `sources/${await hashOf(text)}`,
    });
    expect({
      sources: recalled.map(({ source }) => source).toSorted(),
      files: listed.objects.length,
      file: await fileOf(text),
      count: await countOn(text),
    }).toStrictEqual({
      sources: [one, two].toSorted(),
      files: 1,
      file: text,
      count: 2,
    });
  });

  it("recalls a new version and not the old, which its own readers still read whole as history", async () => {
    const [writer, teammate, outsider] = await Promise.all([
      person(),
      person(),
      person(),
    ]);
    const team = await teamOf(teammate);
    const source = newSource();
    const [before, after] = [word(), word()];
    const draft = `Draft ${before}`;
    const final = `Final ${after}`;

    const added = [
      await addSource(env, { source, text: draft, readers: owner(writer) }),
      // The source's readers change with the new version.
      await addSource(env, {
        source,
        text: final,
        readers: { kind: "team", teamId: team },
      }),
    ];

    expect({
      added,
      // Recall finds the current version only, for its readers only.
      recalled: {
        teammateNew: await recalledAs(teammate, after),
        writerOld: await recalledAs(writer, before),
        teammateOld: await recalledAs(teammate, before),
        writerNew: await recalledAs(writer, after),
      },
      // History: each version whole, read by its own readers; no one else
      // learns it exists.
      history: {
        writerFirst: await historyAs(writer, source, 1),
        teammateFirst: await historyAs(teammate, source, 1),
        outsiderFirst: await historyAs(outsider, source, 1),
        teammateSecond: await historyAs(teammate, source, 2),
        writerSecond: await historyAs(writer, source, 2),
        writerThird: await historyAs(writer, source, 3),
      },
    }).toStrictEqual({
      added: [
        { source, version: 1 },
        { source, version: 2 },
      ],
      recalled: {
        teammateNew: [{ source, version: 2 }],
        writerOld: [],
        teammateOld: [],
        writerNew: [],
      },
      history: {
        writerFirst: draft,
        teammateFirst: null,
        outsiderFirst: null,
        teammateSecond: final,
        writerSecond: null,
        writerThird: null,
      },
    });
  });

  it("makes content added again after another version a new version, holding the same file", async () => {
    const writer = await person();
    const source = newSource();
    const [before, after] = [word(), word()];
    const draft = `Draft ${before}`;

    await addSource(env, { source, text: draft, readers: owner(writer) });
    await addSource(env, {
      source,
      text: `Final ${after}`,
      readers: owner(writer),
    });
    const again = await addSource(env, {
      source,
      text: draft,
      readers: owner(writer),
    });

    expect({
      again,
      recalledDraft: await recalledAs(writer, before),
      recalledFinal: await recalledAs(writer, after),
      count: await countOn(draft),
    }).toStrictEqual({
      again: { source, version: 3 },
      recalledDraft: [{ source, version: 3 }],
      recalledFinal: [],
      count: 2,
    });
  });

  it("makes the same content with other readers a new version", async () => {
    const [first, second] = await Promise.all([person(), person()]);
    const source = newSource();
    const secret = word();
    const text = `Plan ${secret}`;

    await addSource(env, { source, text, readers: owner(first) });
    const added = await addSource(env, {
      source,
      text,
      readers: owner(second),
    });

    expect({
      added,
      second: await recalledAs(second, secret),
      first: await recalledAs(first, secret),
      count: await countOn(text),
    }).toStrictEqual({
      added: { source, version: 2 },
      second: [{ source, version: 2 }],
      first: [],
      count: 2,
    });
  });

  it("recalls the chunk that holds the words, pointing at its version, and reads the version whole", async () => {
    const reader = await person();
    const source = newSource();
    const secret = word();
    const filler = Array.from(
      { length: 12 },
      (_, index) => `Paragraph ${index}: ${"plain words here ".repeat(20)}`
    );
    const last = `The clause on ${secret} at the end.`;
    const text = [...filler, last].join("\n\n");

    await addSource(env, { source, text, readers: owner(reader) });

    const { chunks } = await recallAs(env, reader, secret);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ source, version: 1 });
    expect(chunks[0]?.text.endsWith(last)).toBeTruthy();
    expect(chunks[0]?.text.length).toBeLessThan(text.length);
    await expect(historyAs(reader, source, 1)).resolves.toBe(text);
  });

  it("leaves nothing visible after a crash between the file and the version, and a retry finishes the add", async () => {
    const reader = await person();
    const source = newSource();
    const secret = word();
    const text = `Contract ${secret}`;
    const add = async () =>
      await addSource(env, { source, text, readers: owner(reader) });

    await crashAfterNextFile();
    await expect(add()).rejects.toThrow(crashed);
    // The file is stored; nothing points at it, so nothing shows.
    const afterCrash = {
      file: await fileOf(text),
      recalled: await recalledAs(reader, secret),
      history: await historyAs(reader, source, 1),
    };
    const retried = await add();

    expect({
      afterCrash,
      retried,
      recalled: await recalledAs(reader, secret),
      history: await historyAs(reader, source, 1),
      count: await countOn(text),
    }).toStrictEqual({
      afterCrash: { file: text, recalled: [], history: null },
      retried: { source, version: 1 },
      recalled: [{ source, version: 1 }],
      history: text,
      count: 1,
    });
  });

  it("sweeps the file a crashed add left once its time is past, and keeps every file a version holds", async () => {
    const reader = await person();
    const [kept, lost] = [newSource(), newSource()];
    const keptText = `Kept ${word()}`;
    const lostText = `Lost ${word()}`;
    await addSource(env, {
      source: kept,
      text: keptText,
      readers: owner(reader),
    });
    await crashAfterNextFile();
    await expect(
      addSource(env, { source: lost, text: lostText, readers: owner(reader) })
    ).rejects.toThrow(crashed);

    // Within an add's time, the sweep leaves the file for the add.
    await runDurableObjectAlarm(store());
    const withinTime = await fileOf(lostText);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + fileGraceMs + 1 });
    await runDurableObjectAlarm(store());
    const pastTime = {
      file: await fileOf(lostText),
      count: await countOn(lostText),
      kept: await historyAs(reader, kept, 1),
    };
    // Added again later, it is stored anew.
    const again = await addSource(env, {
      source: lost,
      text: lostText,
      readers: owner(reader),
    });

    expect({
      withinTime,
      pastTime,
      again,
      history: await historyAs(reader, lost, 1),
    }).toStrictEqual({
      withinTime: lostText,
      pastTime: { file: null, count: null, kept: keptText },
      again: { source: lost, version: 1 },
      history: lostText,
    });
  });

  it("holds a source to its bound as the word index takes it, not only as given", async () => {
    const reader = await person();
    // "ﷺ" is 3 bytes as given and 33 as indexed: 30,303 of them are
    // 999,999 bytes indexed, one more is past the bound, though either is
    // under 100 kB as given.
    const indexedBytes = 33;
    const most = Math.floor(sourceTextMaxBytes / indexedBytes);
    const add = async (count: number) =>
      await addSource(env, {
        source: newSource(),
        text: "ﷺ".repeat(count),
        readers: owner(reader),
      });

    await expect(add(most)).resolves.toMatchObject({ version: 1 });
    await expect(add(most + 1)).rejects.toThrow(/as indexed/u);
  });

  it("refuses a source without an identity, or with one too long, and stores nothing", async () => {
    const reader = await person();
    const secret = word();
    for (const source of ["", "s".repeat(257)]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await expect(
        addSource(env, { source, text: secret, readers: owner(reader) })
      ).rejects.toThrow(/^The Brain refused it/u);
    }
    await expect(recalledAs(reader, secret)).resolves.toStrictEqual([]);
  });
});
