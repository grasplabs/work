import {
  recallBudgetMax,
  sourceTextMaxBytes,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// Sources kept whole and versioned (GRA-1723), through core's functions
// into the Brain's store and its bucket. From the threat model on the
// issue: a source is named by its producer, and no producer reaches
// another's; each change a producer adds is recognised by its key, so a
// retry, late or at once, answers with the version it made; each
// version's original file is in R2 under the SHA-256 of its bytes, stored
// once and counted by the versions that hold it; recall searches current
// versions only, and history is read whole only by those who could read
// it then and can read the source now; a crash between the file and the
// version leaves nothing visible, a retry finishes it, and otherwise
// core's clock sweeps the file away.

const idp = mockIdp();

/** How long the store gives an add before it sweeps the file it left. */
const fileGraceMs = 15 * 60 * 1000;

/** A word no other test's sources hold. */
const word = () => `w${unique()}`;

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** A change's key of its own. */
const newChange = () => crypto.randomUUID();

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

const team = (teamId: string): SourceReaders => ({ kind: "team", teamId });

/** What `personId` recalls for `question`: each chunk's source and version. */
const recalledAs = async (personId: string, question: string) => {
  const { items: chunks } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
  });
  return chunks.map(({ source, version }) => ({ source, version }));
};

/** The text of `source`'s `version` as `personId` reads it: null if not. */
const historyAs = async (
  personId: string,
  source: SourceRef,
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
 * Null when the store has no row for it.
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

/**
 * Holds the store's next file write before it reaches the bucket, until
 * the test releases it: `reached` once the add is there. Flags, not a
 * promise, since workerd won't let one request wait on another's.
 */
const holdNextFileWrite = async () => {
  const gate = { reached: false, released: false };
  await nextFileWrites(1, async (_state, write) => {
    gate.reached = true;
    while (!gate.released) {
      // oxlint-disable-next-line no-await-in-loop -- until the test says
      await scheduler.wait(10);
    }
    return await write();
  });
  return gate;
};

/**
 * Has the store's bucket refuse to delete the file holding `text`, alone or
 * with others, as an R2 that keeps failing for it would; deleting the rest
 * goes through. Answers how to give the store its own bucket back.
 */
const refuseDeleting = async (text: string): Promise<() => void> => {
  const key = `sources/${await hashOf(text)}`;
  return await runInDurableObject(store(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    const refusing = {
      delete: async (keys: string | string[]) => {
        const named = [keys].flat();
        if (named.includes(key)) {
          throw new Error("Refused by the test");
        }
        await bucket.delete(named);
      },
    };
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: refusing });
    return () => {
      Reflect.set(instance, "env", objectEnv);
    };
  });
};

/**
 * `promise`'s outcome, value or error, observed from now on: a promise
 * awaited later in a test never rejects with nothing watching it.
 */
const settled = async <T>(
  promise: Promise<T>
): Promise<{ value: T } | { error: unknown }> => {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
};

/** Moves the clock, for `Date` alone, to `ms` from now. */
const later = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
};

/** The crash an add stops with: the store's own reset. */
const crashed = /Crashed by the test/u;

/** What the Brain or core says when it refuses an input. */
const refused = /^(?:The Brain refused it|Refused)/u;

describe("sources kept whole and versioned", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes one version of one change, however often it is added, at once or after", async () => {
    const reader = await person();
    const source = newSource();
    const change = newChange();
    const secret = word();
    const text = `Offer ${secret}`;
    const add = async () =>
      await addSource(env, { source, change, text, readers: owner(reader) });

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

  it("answers a change added again late with the version it made, never bringing back what replaced it", async () => {
    const [writer, teammate] = await Promise.all([person(), person()]);
    const everyone = await teamOf(writer, teammate);
    const source = newSource();
    const secret = word();
    const text = `Salaries ${secret}`;
    const shared = newChange();

    // Added for the team; its reply lost. Then narrowed to the writer.
    await addSource(env, {
      source,
      change: shared,
      text,
      readers: team(everyone),
    });
    const narrowed = await addSource(env, {
      source,
      change: newChange(),
      text,
      readers: owner(writer),
    });
    // The first add's retry comes late.
    const retried = await addSource(env, {
      source,
      change: shared,
      text,
      readers: team(everyone),
    });

    expect({
      narrowed,
      retried,
      writer: await recalledAs(writer, secret),
      teammate: await recalledAs(teammate, secret),
      count: await countOn(text),
    }).toStrictEqual({
      narrowed: { source, version: 2 },
      retried: { source, version: 1 },
      writer: [{ source, version: 2 }],
      teammate: [],
      count: 2,
    });
  });

  it("refuses a change added again with other text or readers, and keeps what it made", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const source = newSource();
    const change = newChange();
    const secret = word();
    const text = `Notes ${secret}`;
    await addSource(env, { source, change, text, readers: owner(reader) });

    await expect(
      addSource(env, {
        source,
        change,
        text: `${text} and more`,
        readers: owner(reader),
      })
    ).rejects.toThrow(/added before with other text or readers/u);
    await expect(
      addSource(env, { source, change, text, readers: owner(other) })
    ).rejects.toThrow(/added before with other text or readers/u);
    expect({
      reader: await recalledAs(reader, secret),
      other: await recalledAs(other, secret),
      second: await historyAs(reader, source, 2),
    }).toStrictEqual({
      reader: [{ source, version: 1 }],
      other: [],
      second: null,
    });
  });

  it("knows a change by its key first, and a new change with nothing changed as the current version", async () => {
    const reader = await person();
    const source = newSource();
    const [first, unchanged, edited] = [newChange(), newChange(), newChange()];
    const text = `Plan ${word()}`;
    const add = async (change: string, body: string) =>
      await addSource(env, {
        source,
        change,
        text: body,
        readers: owner(reader),
      });

    const added = await add(first, text);
    // Nothing changed: the current version, with this key kept for it.
    const same = await add(unchanged, text);
    const next = await add(edited, `${text} edited`);
    // By its key: the version it was, though another is current now.
    const retried = await add(unchanged, text);

    expect({ added, same, next, retried }).toStrictEqual({
      added: { source, version: 1 },
      same: { source, version: 1 },
      next: { source, version: 2 },
      retried: { source, version: 1 },
    });
  });

  it("keeps the same content under two sources as two sources sharing one file, counted twice", async () => {
    const reader = await person();
    const [one, two] = [newSource(), newSource()];
    const secret = word();
    const text = `Shared ${secret}`;

    for (const source of [one, two]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await addSource(env, {
        source,
        change: newChange(),
        text,
        readers: owner(reader),
      });
    }

    const recalled = await recalledAs(reader, secret);
    const listed = await env.BRAIN_OBJECTS.list({
      prefix: `sources/${await hashOf(text)}`,
    });
    expect({
      sources: recalled.map(({ source }) => source.id).toSorted(),
      files: listed.objects.length,
      file: await fileOf(text),
      count: await countOn(text),
    }).toStrictEqual({
      sources: [one.id, two.id].toSorted(),
      files: 1,
      file: text,
      count: 2,
    });
  });

  it("keeps one producer's sources apart from another's of the same id", async () => {
    const reader = await person();
    const id = crypto.randomUUID();
    const upload: SourceRef = { producer: "upload", id };
    const chat: SourceRef = { producer: "chat", id };
    const [mine, theirs] = [word(), word()];

    await addSource(env, {
      source: upload,
      change: newChange(),
      text: `Upload ${mine}`,
      readers: owner(reader),
    });
    // The same id from another producer is another source: it supersedes
    // nothing of the upload's.
    const added = await addSource(env, {
      source: chat,
      change: newChange(),
      text: `Chat ${theirs}`,
      readers: owner(reader),
    });

    expect({
      added,
      upload: await recalledAs(reader, mine),
      chat: await recalledAs(reader, theirs),
      uploadFirst: await historyAs(reader, upload, 1),
      uploadSecond: await historyAs(reader, upload, 2),
    }).toStrictEqual({
      added: { source: chat, version: 1 },
      upload: [{ source: upload, version: 1 }],
      chat: [{ source: chat, version: 1 }],
      uploadFirst: `Upload ${mine}`,
      uploadSecond: null,
    });
  });

  it("recalls a new version and not the old", async () => {
    const reader = await person();
    const source = newSource();
    const [before, after] = [word(), word()];

    for (const text of [`Draft ${before}`, `Final ${after}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await addSource(env, {
        source,
        change: newChange(),
        text,
        readers: owner(reader),
      });
    }

    expect({
      old: await recalledAs(reader, before),
      current: await recalledAs(reader, after),
    }).toStrictEqual({ old: [], current: [{ source, version: 2 }] });
  });

  it("hides history from those taken off a source, and keeps it for those still on it", async () => {
    const [writer, teammate, outsider] = await Promise.all([
      person(),
      person(),
      person(),
    ]);
    const everyone = await teamOf(writer, teammate);
    const source = newSource();
    const draft = `Draft ${word()}`;
    const final = `Final ${word()}`;

    // Overshared at first, then narrowed to the writer.
    await addSource(env, {
      source,
      change: newChange(),
      text: draft,
      readers: team(everyone),
    });
    await addSource(env, {
      source,
      change: newChange(),
      text: final,
      readers: owner(writer),
    });

    expect({
      writer: [
        await historyAs(writer, source, 1),
        await historyAs(writer, source, 2),
      ],
      teammate: [
        await historyAs(teammate, source, 1),
        await historyAs(teammate, source, 2),
      ],
      outsider: await historyAs(outsider, source, 1),
      missing: await historyAs(writer, source, 3),
    }).toStrictEqual({
      writer: [draft, final],
      // Taken off: no longer the history either, as if it weren't there.
      teammate: [null, null],
      outsider: null,
      missing: null,
    });
  });

  it("shows a reader added in a later version only what came since", async () => {
    const [writer, newcomer] = await Promise.all([person(), person()]);
    const both = await teamOf(writer, newcomer);
    const source = newSource();
    const draft = `Draft ${word()}`;
    const final = `Final ${word()}`;

    // The writer's alone at first, then shared with the team.
    await addSource(env, {
      source,
      change: newChange(),
      text: draft,
      readers: owner(writer),
    });
    await addSource(env, {
      source,
      change: newChange(),
      text: final,
      readers: team(both),
    });

    expect({
      writer: [
        await historyAs(writer, source, 1),
        await historyAs(writer, source, 2),
      ],
      newcomer: [
        await historyAs(newcomer, source, 1),
        await historyAs(newcomer, source, 2),
      ],
    }).toStrictEqual({
      writer: [draft, final],
      // They could not read the first then, so they can't now.
      newcomer: [null, final],
    });
  });

  it("makes content added again after another version a new version, holding the same file", async () => {
    const writer = await person();
    const source = newSource();
    const [before, after] = [word(), word()];
    const draft = `Draft ${before}`;

    for (const text of [draft, `Final ${after}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await addSource(env, {
        source,
        change: newChange(),
        text,
        readers: owner(writer),
      });
    }
    const again = await addSource(env, {
      source,
      change: newChange(),
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

    await addSource(env, {
      source,
      change: newChange(),
      text,
      readers: owner(first),
    });
    const added = await addSource(env, {
      source,
      change: newChange(),
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

    await addSource(env, {
      source,
      change: newChange(),
      text,
      readers: owner(reader),
    });

    const { items: chunks } = await recallAs(env, reader, {
      question: secret,
      budget: { tokens: recallBudgetMax },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ source, version: 1 });
    expect(chunks[0]?.text.endsWith(last)).toBeTruthy();
    expect(chunks[0]?.text.length).toBeLessThan(text.length);
    await expect(historyAs(reader, source, 1)).resolves.toBe(text);
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
        change: newChange(),
        text: "ﷺ".repeat(count),
        readers: owner(reader),
      });

    await expect(add(most)).resolves.toMatchObject({ version: 1 });
    await expect(add(most + 1)).rejects.toThrow(/as indexed/u);
  });

  it("refuses half a surrogate pair anywhere, so two strings never become one, and gives back astral text as given", async () => {
    const reader = await person();
    const source = newSource();
    const change = newChange();
    // Encoded, the lone half becomes U+FFFD: the two would be one file.
    const lone = "note \uD800";
    const replaced = "note �";
    const astral = "Brain 🧠 and 𝔸 𝔹, as given";
    const add = async (
      text: string,
      on: SourceRef = source,
      key: string = change
    ) =>
      await addSource(env, {
        source: on,
        change: key,
        text,
        readers: owner(reader),
      });

    // Calls, not promises: each is made only when its refusal is awaited,
    // so none rejects before anything observes it.
    const refusals = [
      async () => await add(lone),
      async () => await add("text", { producer: "upload", id: "id \uDC00" }),
      async () => await add("text", newSource(), "change \uD800"),
      async () =>
        await recallAs(env, reader, {
          question: "question \uD800",
          budget: { tokens: recallBudgetMax },
        }),
      async () =>
        await readSourceVersionAs(env, reader, {
          source: { producer: "upload", id: "id \uDC00" },
          version: 1,
        }),
    ];
    for (const refusal of refusals) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await expect(refusal()).rejects.toThrow(refused);
    }
    // Nothing was kept of the refused text: its change is a first add.
    const first = await add(replaced);
    await expect(add(lone)).rejects.toThrow(refused);
    const astralSource = newSource();
    await add(astral, astralSource, newChange());

    expect({
      first,
      replaced: await historyAs(reader, source, 1),
      astral: await historyAs(reader, astralSource, 1),
    }).toStrictEqual({
      first: { source, version: 1 },
      replaced,
      astral,
    });
  });

  it("refuses a source it can't name or text with nothing in it, and stores nothing", async () => {
    const reader = await person();
    const secret = word();
    // Calls, not promises, as above: made one at a time as awaited.
    const adds = [
      { producer: "upload", id: "" },
      { producer: "upload", id: "s".repeat(257) },
      { producer: "somewhere", id: crypto.randomUUID() },
      { producer: "upload:chat", id: crypto.randomUUID() },
      { producer: "upload", id: "a\u0000b" },
      { producer: "upload", id: "line\nbreak" },
    ].map(
      (source) => async () =>
        await addSource(env, {
          // SAFETY: core checks what it is given; these hand it what the
          // type rules out, as a call from outside TypeScript could.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          source: source as SourceRef,
          change: newChange(),
          text: secret,
          readers: owner(reader),
        })
    );
    for (const add of adds) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await expect(add()).rejects.toThrow(refused);
    }
    for (const [change, text] of [
      [newChange(), " \n\t "],
      [`change\u0007${newChange()}`, secret],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await expect(
        addSource(env, {
          source: newSource(),
          change,
          text,
          readers: owner(reader),
        })
      ).rejects.toThrow(refused);
    }
    await expect(recalledAs(reader, secret)).resolves.toStrictEqual([]);
  });
});

describe(
  "an add that crashed between its file and its version",
  {
    timeout: 60_000,
  },
  () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("leaves nothing visible, and a retry finishes the add", async () => {
      const reader = await person();
      const source = newSource();
      const change = newChange();
      const secret = word();
      const text = `Contract ${secret}`;
      const add = async () =>
        await addSource(env, { source, change, text, readers: owner(reader) });

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

    it("has its file swept by core's clock once past an add's time, and keeps every file a version holds", async () => {
      const reader = await person();
      const [kept, lost] = [newSource(), newSource()];
      const keptText = `Kept ${word()}`;
      const lostText = `Lost ${word()}`;
      await addSource(env, {
        source: kept,
        change: newChange(),
        text: keptText,
        readers: owner(reader),
      });
      await crashAfterNextFile();
      await expect(
        addSource(env, {
          source: lost,
          change: newChange(),
          text: lostText,
          readers: owner(reader),
        })
      ).rejects.toThrow(crashed);

      // Within an add's time, the sweep leaves the file for the add, even
      // when its caller's clock runs ahead.
      await workBrain(env, new Date(), noProducers);
      await workBrain(
        env,
        new Date(Date.now() + fileGraceMs + 60_000),
        noProducers
      );
      const withinTime = await fileOf(lostText);
      later(fileGraceMs + 1);
      await workBrain(env, new Date(), noProducers);
      // Late or twice is harmless.
      await workBrain(env, new Date(), noProducers);
      const pastTime = {
        file: await fileOf(lostText),
        count: await countOn(lostText),
        kept: await historyAs(reader, kept, 1),
      };

      expect({ withinTime, pastTime }).toStrictEqual({
        withinTime: lostText,
        pastTime: { file: null, count: null, kept: keptText },
      });
    });

    it("has the others swept when R2 won't delete one file, and that one a grace later", async () => {
      const reader = await person();
      const [stuckText, freeText] = [`Stuck ${word()}`, `Free ${word()}`];
      for (const text of [stuckText, freeText]) {
        // oxlint-disable-next-line no-await-in-loop -- one crash at a time
        await crashAfterNextFile();
        // oxlint-disable-next-line no-await-in-loop -- one crash at a time
        await expect(
          addSource(env, {
            source: newSource(),
            change: newChange(),
            text,
            readers: owner(reader),
          })
        ).rejects.toThrow(crashed);
      }

      later(fileGraceMs + 1);
      const restore = await refuseDeleting(stuckText);
      await workBrain(env, new Date(), noProducers);
      restore();
      const afterRefusal = {
        stuck: await fileOf(stuckText),
        free: await fileOf(freeText),
      };
      // Noted afresh: it waits a grace before it is tried again.
      await workBrain(env, new Date(), noProducers);
      const sameTick = await fileOf(stuckText);
      later(fileGraceMs + 1);
      await workBrain(env, new Date(), noProducers);

      expect({
        afterRefusal,
        sameTick,
        graceLater: await fileOf(stuckText),
      }).toStrictEqual({
        afterRefusal: { stuck: stuckText, free: null },
        sameTick: stuckText,
        graceLater: null,
      });
    });

    it("is finished by a retry long after, though the clock sweeps while it writes the file", async () => {
      const reader = await person();
      const source = newSource();
      const change = newChange();
      const text = `Late ${word()}`;
      const add = async () =>
        await addSource(env, { source, change, text, readers: owner(reader) });
      await crashAfterNextFile();
      await expect(add()).rejects.toThrow(crashed);

      // Long past an add's time, the retry notes the file afresh; the sweep
      // that runs while it writes leaves it be.
      later(fileGraceMs + 60_000);
      const gate = await holdNextFileWrite();
      // Settled into a value either way at once, so a refusal is never left
      // unobserved while the test waits.
      const retry = settled(add());
      await vi.waitFor(() => {
        expect(gate.reached).toBeTruthy();
      });
      await workBrain(env, new Date(), noProducers);
      gate.released = true;

      expect({
        retried: await retry,
        history: await historyAs(reader, source, 1),
        count: await countOn(text),
      }).toStrictEqual({
        retried: { value: { source, version: 1 } },
        history: text,
        count: 1,
      });
    });

    it("fails an add whose file was swept while it wrote, and a retry then finishes it", async () => {
      const reader = await person();
      const source = newSource();
      const change = newChange();
      const text = `Swept ${word()}`;
      const add = async () =>
        await addSource(env, { source, change, text, readers: owner(reader) });
      await crashAfterNextFile();
      await expect(add()).rejects.toThrow(crashed);

      // An add stalled past its time while it writes the file, and the
      // sweep takes the file's row meanwhile.
      const gate = await holdNextFileWrite();
      const stalled = settled(add());
      await vi.waitFor(() => {
        expect(gate.reached).toBeTruthy();
      });
      later(fileGraceMs + 60_000);
      await workBrain(env, new Date(), noProducers);
      gate.released = true;
      const outcome = await stalled;
      expect("error" in outcome ? String(outcome.error) : "added").toMatch(
        /add it again/u
      );
      const afterStall = {
        recalled: await historyAs(reader, source, 1),
        count: await countOn(text),
      };

      expect({
        afterStall,
        retried: await add(),
        history: await historyAs(reader, source, 1),
        file: await fileOf(text),
        count: await countOn(text),
      }).toStrictEqual({
        afterStall: { recalled: null, count: 0 },
        retried: { source, version: 1 },
        history: text,
        file: text,
        count: 1,
      });
    });
  }
);
