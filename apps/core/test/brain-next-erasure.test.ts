import { brainOf } from "@grasp-os/brain-next/contract";
import type {
  Access,
  ChunkRef,
  VectorModel,
} from "@grasp-os/brain-next/contract";
import { defineWork, enqueueWork, WorkError } from "@grasp-os/brain-next/work";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { organizationId } from "../src/auth/auth.ts";
import {
  addInstructionFile,
  addSource,
  brainWorkOverview,
  eraseSource,
  erasePerson,
  readInstructionFilesAs,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  copyOfStore,
  killStore,
  restoreStore,
} from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// Erasure (GRA-1729), through core's functions into the Brain's store and
// its bucket. From the threat model on the issue: once an erasure returns
// it is in the ledger and nothing it covers is found or read; the tick
// deletes the rest, vector codes first and each block that held one
// repacked, the words and stems out of the index pages at once, the file
// by the sweep once no version holds it; an erased source's key is
// closed, an add under way included; a crash at any point, the same
// erasure twice and a store restored from an older copy all end with the
// content gone. Marks are digits alone, which no stemmer rewrites, and
// long enough that only their tail is looked for in the index pages:
// FTS5 keeps a term after the start it shares with the one before it.

const idp = mockIdp();

/** How long the store gives an add before it sweeps a file nothing holds. */
const fileGraceMs = 15 * 60 * 1000;

/** The Brain's one store, as core reaches it. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** The Brain's contract on the store, for what core has no way to (vectors). */
const brain = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A mark of 24 digits: found by its last 12 in every table and file. */
const newMark = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    String(byte % 10)
  ).join("");

/** What is looked for of `mark`: its tail, whole in any index page. */
const tailOf = (mark: string): string => mark.slice(-12);

/**
 * A word holding `mark`, as a source writes it: with an ending the
 * stemmers take off, so the mark is in the stems index too.
 */
const wordOf = (mark: string): string => `zq${mark}ingen`;

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

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** The store's key for `source`, as core names it. */
const keyOf = ({ producer, id }: SourceRef): string => `${producer}:${id}`;

/** Adds `text` as the next version of `source`. */
const add = async (
  source: SourceRef,
  text: string,
  readers: SourceReaders
): Promise<number> => {
  const { version } = await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return version;
};

/** What `personId` recalls for `question`: each chunk's text. */
const recalledAs = async (
  personId: string,
  question: string
): Promise<string[]> => {
  const { chunks } = await recallAs(env, personId, question);
  return chunks.map(({ text }) => text);
};

/** `source`'s `version` as `personId` reads it: null if not. */
const historyAs = async (
  personId: string,
  source: SourceRef,
  version: number
): Promise<string | null> => {
  const read = await readSourceVersionAs(env, personId, { source, version });
  return read?.text ?? null;
};

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
const tablesHolding = async (marks: readonly string[]): Promise<string[]> =>
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
const objectsHolding = async (marks: readonly string[]): Promise<string[]> => {
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

/** The SHA-256 of `text`'s UTF-8 bytes, in hex. */
const hashOf = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** The bucket's file holding `text`: null when there is none. */
const fileOf = async (text: string): Promise<string | null> => {
  const file = await env.BRAIN_OBJECTS.get(`sources/${await hashOf(text)}`);
  return file === null ? null : await file.text();
};

/** The ledger's entries naming `id` (a source's key or a person's id). */
const ledgerOf = async (id: string): Promise<string[]> => {
  const subject = await hashOf(id);
  const listed = await env.BRAIN_OBJECTS.list({ prefix: "erasures/" });
  return listed.objects
    .map(({ key }) => key)
    .filter((key) => key.endsWith(`-${subject}`));
};

/** How many entries of the ledger name `source`. */
const ledgerCount = async (source: SourceRef): Promise<number> => {
  const entries = await ledgerOf(keyOf(source));
  return entries.length;
};

/** Moves the clock, for `Date` alone, to `ms` from now. */
const later = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
};

/** Ticks core's clock past a file's grace, so the sweep takes what is due. */
const tickPastGrace = async (): Promise<void> => {
  later(fileGraceMs + 1);
  await workBrain(env, new Date());
};

/** Ticks until no erasure is left unfinished, at most `most` ticks. */
const tickUntilErased = async (most = 10): Promise<number> => {
  for (let tick = 1; tick <= most; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await workBrain(env, new Date());
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    const { erasing } = await brainWorkOverview(env);
    if (erasing === 0) {
      return tick;
    }
  }
  return Number.POSITIVE_INFINITY;
};

/**
 * `promise`'s outcome, value or error, observed from now on: a promise
 * awaited later in a test never rejects with nothing watching it.
 */
const settled = async <T>(
  promise: Promise<T>
): Promise<{ value: T } | { error: string }> => {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: String(error) };
  }
};

/**
 * Has the store's next write to its bucket go through `put`, given the
 * store's state and the write itself; its own bucket is back after it.
 */
const nextBucketPut = async (
  put: (
    state: DurableObjectState,
    write: () => Promise<unknown>
  ) => Promise<unknown>
): Promise<void> => {
  await runInDurableObject(store(), (instance, state) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    const once = {
      get: async (key: string) => await bucket.get(key),
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
const holdNextBucketPut = async () => {
  const gate = { reached: false, released: false };
  await nextBucketPut(async (_state, write) => {
    gate.reached = true;
    while (!gate.released) {
      // oxlint-disable-next-line no-await-in-loop -- until the test says
      await scheduler.wait(10);
    }
    return await write();
  });
  return gate;
};

/** Work the tests queue about a source: its payload holds a mark. */
const markedWork = defineWork({
  kind: `test.erasure_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({ note: z.string() }),
  run: async () => {
    await Promise.resolve();
  },
});

/** Queues an item about `source`, its payload holding `mark`. */
const queueAbout = async (source: SourceRef, mark: string): Promise<void> => {
  await runInDurableObject(store(), (_instance, state) => {
    enqueueWork(state.storage, markedWork, {
      key: keyOf(source),
      payload: { note: `About ${wordOf(mark)}` },
      // Last of all, so no tick of these tests runs it first.
      priority: "archive",
    });
  });
};

/** A model of the test's own, with a centre of its own. */
const modelOf = (dimensions = 16): VectorModel => ({
  name: `erasure-${crypto.randomUUID()}@1`,
  centre: Array.from({ length: dimensions }, () => 0),
});

/** Codes in a packed block (vectors.ts `blockSize`). */
const blockSize = 1024;

/**
 * A source of `count` chunks `access` may read, each paragraph a chunk of
 * its own, every one holding `words`: its chunks, as the contract names
 * them.
 */
const chunkedSource = async (
  source: SourceRef,
  access: Access,
  count: number,
  words: string
): Promise<ChunkRef[]> => {
  const { version } = await brain().addSource({
    source: keyOf(source),
    change: crypto.randomUUID(),
    text: Array.from({ length: count }, (_, index) =>
      `${words} ${index} `.padEnd(650, "x")
    ).join("\n\n"),
    access,
  });
  return Array.from({ length: count }, (_, position) => ({
    source: keyOf(source),
    version,
    position,
  }));
};

/** Puts a vector for each of `chunks`, as many puts as it takes. */
const putCodes = async (
  model: VectorModel,
  chunks: readonly ChunkRef[]
): Promise<void> => {
  for (let start = 0; start < chunks.length; start += 256) {
    // oxlint-disable-next-line no-await-in-loop -- one put at a time
    await brain().putVectors({
      model,
      vectors: chunks.slice(start, start + 256).map((chunk) => ({
        chunk,
        vector: Array.from(
          { length: model.centre.length },
          () => Math.random() * 2 - 1
        ),
      })),
    });
  }
};

/** The store's rows of the chunks of `source`'s versions. */
const chunkRowsOf = async (source: SourceRef): Promise<number[]> =>
  await runInDurableObject(store(), (_instance, state) =>
    state.storage.sql
      .exec<{ row: number }>(
        `SELECT chunks.row AS row FROM chunks
        JOIN source_versions ON source_versions.row = chunks.version_row
        WHERE source_versions.source = ?`,
        keyOf(source)
      )
      .toArray()
      .map(({ row }) => row)
  );

/**
 * Where the vector codes of `rows` still are: as codes, and in the rows
 * of packed blocks; and how many codes `kept` still has.
 */
const vectorsOf = async (rows: readonly number[], kept: readonly number[]) =>
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    const codes = sql
      .exec<{ chunk: number }>("SELECT chunk FROM vector_codes")
      .toArray()
      .map(({ chunk }) => chunk);
    const inBlocks = sql
      .exec<{ chunks: ArrayBuffer }>("SELECT chunks FROM vector_blocks")
      .toArray()
      .flatMap(({ chunks }) => [...new Float64Array(chunks)]);
    return {
      codes: codes.filter((chunk) => rows.includes(chunk)).length,
      inBlocks: inBlocks.filter((chunk) => rows.includes(chunk)).length,
      kept: codes.filter((chunk) => kept.includes(chunk)).length,
    };
  });

describe("erasing a source", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves nothing of it anywhere: recall, history, every table and index page, vector blocks, the queue, the bucket, the overview and the logs", async () => {
    const reader = await person();
    const marks = [newMark(), newMark(), newMark()];
    const erased = newSource();
    for (const mark of marks) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await add(
        erased,
        `Salary review ${wordOf(mark)} payingen`,
        owner(reader)
      );
    }
    // Its current version in 600 chunks, their codes packed in one block
    // with another source's 424.
    const model = modelOf();
    const packed = await chunkedSource(
      erased,
      { kind: "owner", person: reader },
      600,
      `Appendix ${wordOf(marks[2] ?? "")}`
    );
    const neighbourSource = newSource();
    const neighbour = await chunkedSource(
      neighbourSource,
      { kind: "owner", person: reader },
      blockSize - 600,
      "Neighbour"
    );
    await putCodes(model, [...packed, ...neighbour]);
    await queueAbout(erased, marks[0] ?? "");
    const erasedRows = await chunkRowsOf(erased);
    const keptRows = await chunkRowsOf(neighbourSource);
    // What the scans find before: so finding nothing after means gone.
    const objectsBefore = await objectsHolding(marks);
    const before = {
      tables: await tablesHolding(marks),
      objects: objectsBefore.length,
      vectors: await vectorsOf(erasedRows, keptRows),
    };

    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method)
    );
    await eraseSource(env, { source: erased, reason: "deleted" });
    // Before any tick: the erasure's own batch took the current version,
    // its codes and the block they were packed in, and its index entries.
    const holdingAtOnce = await tablesHolding([marks[2] ?? ""]);
    const atOnce = {
      recalled: await recalledAs(reader, wordOf(marks[0] ?? "")),
      history: await historyAs(reader, erased, 1),
      vectors: await vectorsOf(erasedRows, keptRows),
      indexes: holdingAtOnce.filter((table) => table.startsWith("chunk_")),
    };
    await tickPastGrace();
    await tickPastGrace();
    const logs = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const spy of spies) {
      spy.mockRestore();
    }

    expect({
      before: {
        ...before,
        tables: [
          "chunk_stems_content",
          "chunk_stems_data",
          "chunk_words_content",
          "chunk_words_data",
          "chunks",
          "work_items",
        ].every((table) => before.tables.includes(table)),
      },
      atOnce,
      tables: await tablesHolding(marks),
      objects: await objectsHolding(marks),
      vectors: await vectorsOf(erasedRows, keptRows),
      overview: [JSON.stringify(await brainWorkOverview(env)), logs].filter(
        (text) => marks.some((mark) => text.includes(tailOf(mark)))
      ),
    }).toStrictEqual({
      before: {
        tables: true,
        objects: 4,
        vectors: { codes: 600, inBlocks: 600, kept: 424 },
      },
      atOnce: {
        recalled: [],
        history: null,
        vectors: { codes: 0, inBlocks: 0, kept: 424 },
        indexes: [],
      },
      tables: [],
      objects: [],
      vectors: { codes: 0, inBlocks: 0, kept: 424 },
      overview: [],
    });
  });

  it("keeps a file two sources share until both are erased", async () => {
    const reader = await person();
    const mark = newMark();
    const text = `Shared contract ${wordOf(mark)}`;
    const [first, second] = [newSource(), newSource()];
    await add(first, text, owner(reader));
    await add(second, text, owner(reader));

    await eraseSource(env, { source: first, reason: "deleted" });
    await tickPastGrace();
    const oneErased = {
      file: await fileOf(text),
      second: await historyAs(reader, second, 1),
    };
    await eraseSource(env, { source: second, reason: "retention" });
    await tickPastGrace();

    expect({
      oneErased,
      bothErased: await fileOf(text),
      tables: await tablesHolding([mark]),
    }).toStrictEqual({
      oneErased: { file: text, second: text },
      bothErased: null,
      tables: [],
    });
  });

  it("answers alike for a source that never was, records each once, and closes the key for good", async () => {
    const reader = await person();
    const mark = newMark();
    const text = `Board minutes ${wordOf(mark)}`;
    const [held, never] = [newSource(), newSource()];
    await add(held, text, owner(reader));

    const answers = [
      await settled(eraseSource(env, { source: held, reason: "deleted" })),
      await settled(eraseSource(env, { source: never, reason: "deleted" })),
      // The same erasure delivered twice.
      await settled(eraseSource(env, { source: held, reason: "deleted" })),
    ];
    const lateAdd = await settled(add(held, text, owner(reader)));
    await tickPastGrace();
    // The same bytes under a source of their own are that source's: their
    // file is stored again, after the sweep took the erased one's.
    const again = newSource();
    const fileBefore = await fileOf(text);
    await add(again, text, owner(reader));

    const [heldLedger, neverLedger] = [
      await ledgerOf(keyOf(held)),
      await ledgerOf(keyOf(never)),
    ];
    expect({
      answers,
      ledger: [heldLedger.length, neverLedger.length],
      lateAdd,
      fileBefore,
      again: await historyAs(reader, again, 1),
      file: await fileOf(text),
      recalled: await recalledAs(reader, wordOf(mark)),
    }).toStrictEqual({
      answers: [
        { value: undefined },
        { value: undefined },
        { value: undefined },
      ],
      ledger: [1, 1],
      lateAdd: {
        error: "Error: The Brain refused it: what this adds was erased",
      },
      fileBefore: null,
      again: text,
      file: text,
      recalled: [text],
    });
  });

  it("refuses an add of the source that was writing its file as the erasure landed", async () => {
    const reader = await person();
    const mark = newMark();
    const source = newSource();
    const text = `In flight ${wordOf(mark)}`;
    const gate = await holdNextBucketPut();
    const adding = settled(add(source, text, owner(reader)));
    await vi.waitFor(() => {
      expect(gate.reached).toBeTruthy();
    });
    await eraseSource(env, { source, reason: "deleted" });
    gate.released = true;
    const added = await adding;
    await tickPastGrace();

    expect({
      added,
      recalled: await recalledAs(reader, wordOf(mark)),
      file: await fileOf(text),
      tables: await tablesHolding([mark]),
    }).toStrictEqual({
      added: {
        error: "Error: The Brain refused it: what this adds was erased",
      },
      recalled: [],
      file: null,
      tables: [],
    });
  });

  it("erases a source while the word indexes rebuild and repacks wait, and both finish without it", async () => {
    const reader = await person();
    const [erasedMark, keptMark] = [newMark(), newMark()];
    const [erased, kept] = [newSource(), newSource()];
    await add(erased, `Going ${wordOf(erasedMark)}`, owner(reader));
    await add(kept, `Staying ${wordOf(keptMark)}`, owner(reader));
    // A block with removed codes waiting for its repack: a source's
    // version replaced after its codes were packed with the erased one's.
    const model = modelOf();
    const access: Access = { kind: "owner", person: reader };
    const replaced = newSource();
    const erasedChunks = await chunkedSource(
      erased,
      access,
      500,
      `More ${wordOf(erasedMark)}`
    );
    const replacedChunks = await chunkedSource(
      replaced,
      access,
      blockSize - 500,
      "Replaced"
    );
    await putCodes(model, [...erasedChunks, ...replacedChunks]);
    await add(replaced, "Replaced again", owner(reader));
    // The word indexes behind their rules: a rebuild under way.
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE word_index SET version = 0, target = 0, cursor = 0 WHERE id = 1"
      );
    });
    const erasedRows = await chunkRowsOf(erased);

    await eraseSource(env, { source: erased, reason: "deleted" });
    for (let tick = 0; tick < 5; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick at a time
      await tickPastGrace();
    }

    expect({
      tables: await tablesHolding([erasedMark]),
      vectors: await vectorsOf(erasedRows, []),
      kept: await recalledAs(reader, wordOf(keptMark)),
    }).toStrictEqual({
      tables: [],
      vectors: { codes: 0, inBlocks: 0, kept: 0 },
      kept: [`Staying ${wordOf(keptMark)}`],
    });
  });

  it("deletes an erased source's file once a sweep R2 didn't answer is past its doubt, and stores its bytes again only then", async () => {
    const reader = await person();
    const text = `Doubtful ${wordOf(newMark())}`;
    const erased = newSource();
    await add(erased, text, owner(reader));
    await eraseSource(env, { source: erased, reason: "deleted" });
    later(fileGraceMs + 1);
    // R2 hangs on the delete: the sweep gives up, and the file is in doubt.
    const gate = { released: false };
    await runInDurableObject(store(), (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      Reflect.set(instance, "env", {
        ...objectEnv,
        BRAIN_OBJECTS: {
          delete: async () => {
            while (!gate.released) {
              // oxlint-disable-next-line no-await-in-loop -- until the test says
              await scheduler.wait(50);
            }
          },
        },
      });
    });
    await workBrain(env, new Date());
    gate.released = true;
    // A store of its own bucket again.
    await killStore();
    const inDoubt = await settled(add(newSource(), text, owner(reader)));
    const keptInDoubt = await fileOf(text);
    later(fileGraceMs + 1);
    await workBrain(env, new Date());
    const swept = await fileOf(text);
    const again = newSource();
    await add(again, text, owner(reader));

    expect({
      inDoubt,
      keptInDoubt,
      swept,
      again: await historyAs(reader, again, 1),
      file: await fileOf(text),
    }).toStrictEqual({
      inDoubt: {
        error: "Error: The Brain lost the file while adding it: add it again",
      },
      keptInDoubt: text,
      swept: null,
      again: text,
      file: text,
    });
  });
});

describe("erasing a person", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("erases what they alone may read, whole where it is theirs now, and keeps what others read and what comes later", async () => {
    const [erasedPerson, colleague] = await Promise.all([person(), person()]);
    const team = await teamOf(erasedPerson, colleague);
    const [own, shared, narrowed, file] = [
      newMark(),
      newMark(),
      newMark(),
      newMark(),
    ];
    const teamMark = newMark();
    // Their own source, two versions.
    const ownSource = newSource();
    await add(ownSource, `Own draft ${wordOf(own)}`, owner(erasedPerson));
    await add(ownSource, `Own final ${wordOf(own)}`, owner(erasedPerson));
    // A source first theirs alone, then the team's.
    const sharedSource = newSource();
    await add(
      sharedSource,
      `Private note ${wordOf(shared)}`,
      owner(erasedPerson)
    );
    await add(sharedSource, `Team note ${wordOf(teamMark)}`, {
      kind: "team",
      teamId: team,
    });
    // A source first the team's, then narrowed to them alone.
    const narrowedSource = newSource();
    await add(narrowedSource, `Team plan ${wordOf(narrowed)}`, {
      kind: "team",
      teamId: team,
    });
    await add(
      narrowedSource,
      `My plan ${wordOf(narrowed)}`,
      owner(erasedPerson)
    );
    await addInstructionFile(env, {
      file: { scope: "person", personId: erasedPerson },
      change: crypto.randomUUID(),
      text: `Call me ${wordOf(file)}`,
    });

    await erasePerson(env, { personId: erasedPerson, reason: "person_erased" });
    // What comes for them afterwards is new, and kept.
    const afterward = newSource();
    await add(afterward, "Written afterwards", owner(erasedPerson));
    await tickUntilErased();
    await tickPastGrace();

    const teamTables = await tablesHolding([teamMark]);
    const memberSets = await runInDurableObject(
      store(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM reader_set_members WHERE principal = ?",
            erasedPerson
          )
          .one().count
    );
    expect({
      tables: await tablesHolding([own, shared, narrowed, file]),
      objects: await objectsHolding([own, shared, narrowed, file]),
      ownSource: await historyAs(erasedPerson, ownSource, 2),
      sharedFirst: await historyAs(erasedPerson, sharedSource, 1),
      sharedNow: await historyAs(colleague, sharedSource, 2),
      narrowedNow: await historyAs(erasedPerson, narrowedSource, 2),
      files: await readInstructionFilesAs(env, { userId: erasedPerson }, [
        { scope: "person", personId: erasedPerson },
      ]),
      afterward: await historyAs(erasedPerson, afterward, 1),
      teamKept: teamTables.includes("chunks"),
      memberSets,
    }).toStrictEqual({
      tables: [],
      objects: [],
      ownSource: null,
      sharedFirst: null,
      sharedNow: `Team note ${wordOf(teamMark)}`,
      narrowedNow: null,
      files: [],
      afterward: "Written afterwards",
      teamKept: true,
      memberSets: 1,
    });
  });

  it("answers alike for a person with nothing, and finishes a large erasure over ticks though the store is killed in the middle", async () => {
    const [erasedPerson, nobody] = [
      await person(),
      `nobody-${crypto.randomUUID()}`,
    ];
    const mark = newMark();
    const access: Access = { kind: "owner", person: erasedPerson };
    for (let source = 0; source < 3; source += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await chunkedSource(newSource(), access, 600, `Archive ${wordOf(mark)}`);
    }

    const answers = [
      await settled(
        erasePerson(env, { personId: erasedPerson, reason: "withdrawn" })
      ),
      await settled(
        erasePerson(env, { personId: nobody, reason: "withdrawn" })
      ),
    ];
    const { erasing } = await brainWorkOverview(env);
    const recalledAtOnce = await recalledAs(erasedPerson, wordOf(mark));
    await killStore();
    const recalledAfterKill = await recalledAs(erasedPerson, wordOf(mark));
    const ticks = await tickUntilErased();
    await tickPastGrace();

    expect({
      answers,
      erasing,
      recalledAtOnce,
      recalledAfterKill,
      finished: ticks <= 3,
      tables: await tablesHolding([mark]),
      objects: await objectsHolding([mark]),
      // Their id goes with the last version that named them.
      named: await tablesHolding([erasedPerson]),
    }).toStrictEqual({
      answers: [{ value: undefined }, { value: undefined }],
      erasing: 1,
      recalledAtOnce: [],
      recalledAfterKill: [],
      finished: true,
      tables: [],
      objects: [],
      named: [],
    });
  });
});

describe(
  "an erasure the store crashed in, or a store restored from before it",
  { timeout: 120_000 },
  () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is applied as the store starts again when it crashed after the ledger and before its own record", async () => {
      const reader = await person();
      const mark = newMark();
      const source = newSource();
      await add(source, `Crash ${wordOf(mark)}`, owner(reader));
      await nextBucketPut(async (state, write) => {
        await write();
        state.abort("Crashed by the test, the ledger written");
      });

      const erased = await settled(
        eraseSource(env, { source, reason: "deleted" })
      );
      // The next call starts the store afresh: the ledger is read first.
      const recalled = await recalledAs(reader, wordOf(mark));
      await tickUntilErased();
      await tickPastGrace();

      expect({
        crashed: "error" in erased,
        recalled,
        history: await historyAs(reader, source, 1),
        tables: await tablesHolding([mark]),
        objects: await objectsHolding([mark]),
        lateAdd: await settled(add(source, "Back again", owner(reader))),
      }).toStrictEqual({
        crashed: true,
        recalled: [],
        history: null,
        tables: [],
        objects: [],
        lateAdd: {
          error: "Error: The Brain refused it: what this adds was erased",
        },
      });
    });

    it("erases again what was erased since an older copy of the store came back, before it answers anything", async () => {
      const reader = await person();
      const [sourceMark, personMark] = [newMark(), newMark()];
      const source = newSource();
      await add(source, `Restored ${wordOf(sourceMark)}`, owner(reader));
      const leaver = await person();
      const theirs = newSource();
      await add(theirs, `Leaver ${wordOf(personMark)}`, owner(leaver));
      const kept = newSource();
      await add(kept, "Kept through the restore", owner(reader));
      const backup = await copyOfStore();

      await eraseSource(env, { source, reason: "deleted" });
      await erasePerson(env, { personId: leaver, reason: "person_erased" });
      await tickUntilErased();
      await tickPastGrace();
      // The copy from before both erasures comes back; the bucket, its files
      // already swept, stays as it is.
      await restoreStore(backup);

      const atOnce = {
        recalled: await recalledAs(reader, wordOf(sourceMark)),
        history: await historyAs(reader, source, 1),
        leaver: await historyAs(leaver, theirs, 1),
        kept: await historyAs(reader, kept, 1),
      };
      await tickUntilErased();
      await tickPastGrace();

      expect({
        atOnce,
        tables: await tablesHolding([sourceMark, personMark]),
        objects: await objectsHolding([sourceMark, personMark]),
        lateAdd: await settled(add(source, "Back again", owner(reader))),
      }).toStrictEqual({
        atOnce: {
          recalled: [],
          history: null,
          leaver: null,
          kept: "Kept through the restore",
        },
        tables: [],
        objects: [],
        lateAdd: {
          error: "Error: The Brain refused it: what this adds was erased",
        },
      });
    });

    it("reads a version whose file is gone as missing, and the others whole", async () => {
      const reader = await person();
      const [gone, whole] = [newSource(), newSource()];
      const goneText = `Gone file ${newMark()}`;
      await add(gone, goneText, owner(reader));
      await add(whole, "Whole file", owner(reader));
      // As a restore brings back a version whose file the sweep deleted.
      await env.BRAIN_OBJECTS.delete(`sources/${await hashOf(goneText)}`);
      const warned = vi.spyOn(console, "warn");
      const current = await brain().readCurrent({
        sources: [keyOf(gone), keyOf(whole)],
        reader: { person: reader, groups: [] },
      });
      const history = {
        gone: await historyAs(reader, gone, 1),
        whole: await historyAs(reader, whole, 1),
      };
      const warnings = warned.mock.calls;
      warned.mockRestore();

      expect({
        ...history,
        current: current.map(({ text }) => text),
        // Noticed, one fixed event a read, with nothing of what it held.
        warnings,
      }).toStrictEqual({
        gone: null,
        whole: "Whole file",
        current: ["Whole file"],
        warnings: [
          [{ event: "brain.version_file_missing" }],
          [{ event: "brain.version_file_missing" }],
        ],
      });
    });
  }
);

/** What the recording work's handler saw, by its item's key. */
const handled = new Map<
  string,
  { runs: number; abortedAfter?: string | undefined }
>();

/** What the recording work's handler does for a key, if anything. */
const handling = new Map<string, (signal: AbortSignal) => Promise<void>>();

/** Work about a source whose handler records each run, and waits if told. */
const recordingWork = defineWork({
  kind: `test.erasing_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({ key: z.string() }),
  run: async ({ key }, { signal }) => {
    const seen = handled.get(key) ?? { runs: 0 };
    seen.runs += 1;
    handled.set(key, seen);
    await handling.get(key)?.(signal);
  },
});

/** Queues an item of the recording work about `source`, first of all. */
const queueRecorded = async (source: SourceRef): Promise<void> => {
  await runInDurableObject(store(), (_instance, state) => {
    enqueueWork(state.storage, recordingWork, {
      key: keyOf(source),
      payload: { key: keyOf(source) },
      priority: "asked",
    });
  });
};

/** How many items wait or run about `source` in the queue. */
const queuedAbout = async (source: SourceRef): Promise<number> =>
  await runInDurableObject(
    store(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM work_items WHERE key = ?",
          keyOf(source)
        )
        .one().count
  );

/** The rows of the chunks of `source`'s current version, by position. */
const currentChunksOf = async (source: SourceRef): Promise<ChunkRef[]> =>
  await runInDurableObject(store(), (_instance, state) =>
    state.storage.sql
      .exec<{ version: number; position: number }>(
        `SELECT source_versions.version AS version, chunks.position AS position
        FROM source_versions
        JOIN chunks ON chunks.version_row = source_versions.row
        WHERE source_versions.source = ?
        ORDER BY source_versions.version, chunks.position`,
        keyOf(source)
      )
      .toArray()
      .map(({ version, position }) => ({
        source: keyOf(source),
        version,
        position,
      }))
  );

describe("an add under way as an erasure lands", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses an add for a person alone that was writing its file as they were erased, and keeps one begun after", async () => {
    const leaver = await person();
    const [inFlight, after] = [newMark(), newMark()];
    const source = newSource();
    const gate = await holdNextBucketPut();
    const adding = settled(
      add(source, `In flight ${wordOf(inFlight)}`, owner(leaver))
    );
    await vi.waitFor(() => {
      expect(gate.reached).toBeTruthy();
    });
    await erasePerson(env, { personId: leaver, reason: "withdrawn" });
    gate.released = true;
    const added = await adding;
    // Begun after the erasure returned: new, and kept.
    const afterwardSource = newSource();
    await add(afterwardSource, `Afterwards ${wordOf(after)}`, owner(leaver));
    await tickUntilErased();
    await tickPastGrace();

    expect({
      added,
      recalled: await recalledAs(leaver, wordOf(inFlight)),
      history: await historyAs(leaver, source, 1),
      tables: await tablesHolding([inFlight]),
      objects: await objectsHolding([inFlight]),
      afterwards: await historyAs(leaver, afterwardSource, 1),
    }).toStrictEqual({
      added: {
        error: "Error: The Brain refused it: what this adds was erased",
      },
      recalled: [],
      history: null,
      tables: [],
      objects: [],
      afterwards: `Afterwards ${wordOf(after)}`,
    });
  });

  it("refuses a version only they may read of a source others read, under way as they were erased, and keeps the others' version", async () => {
    const [leaver, colleague] = await Promise.all([person(), person()]);
    const team = await teamOf(leaver, colleague);
    const [teamMark, theirs] = [newMark(), newMark()];
    const source = newSource();
    await add(source, `Team plan ${wordOf(teamMark)}`, {
      kind: "team",
      teamId: team,
    });
    const gate = await holdNextBucketPut();
    const adding = settled(
      add(source, `My plan ${wordOf(theirs)}`, owner(leaver))
    );
    await vi.waitFor(() => {
      expect(gate.reached).toBeTruthy();
    });
    await erasePerson(env, { personId: leaver, reason: "person_erased" });
    gate.released = true;
    const added = await adding;
    await tickPastGrace();

    expect({
      added,
      current: await recalledAs(colleague, wordOf(teamMark)),
      version2: await historyAs(leaver, source, 2),
      tables: await tablesHolding([theirs]),
    }).toStrictEqual({
      added: {
        error: "Error: The Brain refused it: what this adds was erased",
      },
      current: [`Team plan ${wordOf(teamMark)}`],
      version2: null,
      tables: [],
    });
  });
});

describe("queued work about what is erased", { timeout: 120_000 }, () => {
  it("drops an item waiting about an erased source before any tick, and its handler never runs", async () => {
    const reader = await person();
    const source = newSource();
    await add(source, `Queued ${wordOf(newMark())}`, owner(reader));
    await queueRecorded(source);
    const before = await queuedAbout(source);

    await eraseSource(env, { source, reason: "deleted" });
    const atOnce = await queuedAbout(source);
    await workBrain(env, new Date());
    await workBrain(env, new Date());

    expect({ before, atOnce, ran: handled.get(keyOf(source)) }).toStrictEqual({
      before: 1,
      atOnce: 0,
      ran: undefined,
    });
  });

  it("stops an item running about a source as it is erased: its signal aborts, its row goes, it never runs again, and what it would write for the source is not kept", async () => {
    const reader = await person();
    const source = newSource();
    const access: Access = { kind: "owner", person: reader };
    await chunkedSource(source, access, 3, `Running ${wordOf(newMark())}`);
    const chunks = await currentChunksOf(source);
    const gate = { reached: false, released: false };
    handling.set(keyOf(source), async (signal) => {
      gate.reached = true;
      while (!gate.released) {
        // oxlint-disable-next-line no-await-in-loop -- until the test says
        await scheduler.wait(10);
      }
      const seen = handled.get(keyOf(source));
      if (seen !== undefined) {
        const reason: unknown = signal.reason;
        seen.abortedAfter =
          signal.aborted && reason instanceof WorkError
            ? reason.code
            : undefined;
      }
    });
    await queueRecorded(source);
    const ticking = settled(workBrain(env, new Date()));
    await vi.waitFor(() => {
      expect(gate.reached).toBeTruthy();
    });

    await eraseSource(env, { source, reason: "deleted" });
    const queuedAtOnce = await queuedAbout(source);
    gate.released = true;
    await ticking;
    // As an embedding handler would, once it ends: its codes for the
    // erased chunks are refused by the store's own check.
    const model = modelOf();
    await putCodes(model, chunks);
    const rows = await chunkRowsOf(source);
    await workBrain(env, new Date());

    expect({
      queuedAtOnce,
      seen: handled.get(keyOf(source)),
      queued: await queuedAbout(source),
      rows,
      codes: await runInDurableObject(
        store(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT count(*) AS count FROM vector_codes
              WHERE model = (SELECT id FROM vector_models WHERE name = ?)`,
              model.name
            )
            .one().count
      ),
    }).toStrictEqual({
      queuedAtOnce: 0,
      seen: {
        runs: 1,
        abortedAfter: "erased",
      },
      queued: 0,
      rows: [],
      codes: 0,
    });
  });
});

describe(
  "a person's erasure replayed after a restore",
  { timeout: 120_000 },
  () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("erases again what it erased, though the older copy's readers say the source was shared then", async () => {
      const [leaver, colleague] = await Promise.all([person(), person()]);
      const team = await teamOf(leaver, colleague);
      const mark = newMark();
      const source = newSource();
      await add(source, `Team draft ${wordOf(mark)}`, {
        kind: "team",
        teamId: team,
      });
      const backup = await copyOfStore();
      // Narrowed to the leaver, then the leaver erased: the source goes
      // whole, its first version, the team's, too.
      await add(source, `Mine now ${wordOf(newMark())}`, owner(leaver));
      await erasePerson(env, { personId: leaver, reason: "person_erased" });
      await tickUntilErased();
      await tickPastGrace();

      await restoreStore(backup);
      const atOnce = {
        recalled: await recalledAs(colleague, wordOf(mark)),
        history: await historyAs(colleague, source, 1),
      };
      await tickUntilErased();

      expect({ atOnce, tables: await tablesHolding([mark]) }).toStrictEqual({
        atOnce: { recalled: [], history: null },
        tables: [],
      });
    });

    it("erases again only what it erased, though the older copy's readers say a source was theirs alone then", async () => {
      const [leaver, colleague] = await Promise.all([person(), person()]);
      const team = await teamOf(leaver, colleague);
      const [teamFirst, theirs, teamNow] = [newMark(), newMark(), newMark()];
      const source = newSource();
      await add(source, `Team first ${wordOf(teamFirst)}`, {
        kind: "team",
        teamId: team,
      });
      await add(source, `Theirs ${wordOf(theirs)}`, owner(leaver));
      const backup = await copyOfStore();
      // Shared again, then the leaver erased: only their own version goes.
      await add(source, `Team now ${wordOf(teamNow)}`, {
        kind: "team",
        teamId: team,
      });
      await erasePerson(env, { personId: leaver, reason: "person_erased" });
      await tickUntilErased();

      await restoreStore(backup);
      await tickUntilErased();

      // The team's first version was not erased, and is still kept; the
      // leaver's own is gone. (Without a current version, which the copy
      // had as theirs, the source answers no one: the team's latest version
      // came after the copy.)
      const teamFirstTables = await tablesHolding([teamFirst]);
      expect({
        tables: await tablesHolding([theirs]),
        teamFirstKept: teamFirstTables.includes("chunks"),
      }).toStrictEqual({
        tables: [],
        teamFirstKept: true,
      });
    });
  }
);

describe(
  "an erasure that takes more than one batch, or that fails",
  { timeout: 120_000 },
  () => {
    it("hides a version of a source others read from its person's history before the batch that deletes it", async () => {
      const [leaver, colleague] = await Promise.all([person(), person()]);
      const team = await teamOf(leaver, colleague);
      const access: Access = { kind: "owner", person: leaver };
      // Two of their own sources, more than one batch, before the version.
      await chunkedSource(newSource(), access, 600, "Archive one");
      await chunkedSource(newSource(), access, 600, "Archive two");
      const source = newSource();
      const theirs = `Mine first ${wordOf(newMark())}`;
      await add(source, theirs, owner(leaver));
      await add(source, "Ours now", { kind: "team", teamId: team });
      const before = await historyAs(leaver, source, 1);

      await erasePerson(env, { personId: leaver, reason: "withdrawn" });
      const { erasing } = await brainWorkOverview(env);

      expect({
        before,
        erasing,
        history: await historyAs(leaver, source, 1),
        current: await historyAs(colleague, source, 2),
      }).toStrictEqual({
        before: theirs,
        erasing: 1,
        history: null,
        current: "Ours now",
      });
    });

    it("goes on with the erasures behind a version that keeps failing, says so, and deletes it once it can", async () => {
      const reader = await person();
      const [stuck, free] = [newSource(), newSource()];
      const [stuckMark, freeMark] = [newMark(), newMark()];
      await add(stuck, `Stuck ${wordOf(stuckMark)}`, owner(reader));
      await add(free, `Free ${wordOf(freeMark)}`, owner(reader));
      // Deleting the stuck source's version fails, as a fault would.
      await runInDurableObject(store(), (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER test_stuck_version BEFORE DELETE ON source_versions
        WHEN OLD.source = '${keyOf(stuck)}'
        BEGIN SELECT RAISE(ABORT, 'stuck by the test'); END`
        );
      });

      await eraseSource(env, { source: stuck, reason: "deleted" });
      await eraseSource(env, { source: free, reason: "deleted" });
      await workBrain(env, new Date());
      const failing = await brainWorkOverview(env);
      const whileStuck = {
        erasing: failing.erasing,
        failed: failing.stepsFailed.erase?.reason,
        free: await tablesHolding([freeMark]),
        stuckHidden: await recalledAs(reader, wordOf(stuckMark)),
      };
      await runInDurableObject(store(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER test_stuck_version");
      });
      await workBrain(env, new Date());
      const after = await brainWorkOverview(env);

      expect({
        whileStuck,
        after: {
          erasing: after.erasing,
          failed: after.stepsFailed.erase,
          stuck: await tablesHolding([stuckMark]),
        },
      }).toStrictEqual({
        whileStuck: {
          erasing: 1,
          failed: "failed",
          free: [],
          stuckHidden: [],
        },
        after: { erasing: 0, failed: null, stuck: [] },
      });
    });
  }
);

describe("the erasure ledger out of reach", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an erasure whose ledger write failed hidden, writes it at the next tick, and erases it again after a restore", async () => {
    const reader = await person();
    const mark = newMark();
    const source = newSource();
    await add(source, `Unwritten ${wordOf(mark)}`, owner(reader));
    const backup = await copyOfStore();
    await nextBucketPut(async () => {
      await Promise.resolve();
      throw new Error("R2 failed, by the test");
    });

    const erased = await settled(
      eraseSource(env, { source, reason: "deleted" })
    );
    const unwritten = {
      recalled: await recalledAs(reader, wordOf(mark)),
      ledger: await ledgerCount(source),
    };
    await workBrain(env, new Date());
    const written = await ledgerCount(source);
    const { stepsFailed } = await brainWorkOverview(env);
    await restoreStore(backup);
    const restored = await recalledAs(reader, wordOf(mark));

    expect({
      erased,
      unwritten,
      written,
      ledgerFailed: stepsFailed.ledger,
      restored,
    }).toStrictEqual({
      erased: {
        error: "Error: The Brain could not record the erasure: erase it again",
      },
      unwritten: { recalled: [], ledger: 0 },
      written: 1,
      ledgerFailed: null,
      restored: [],
    });
  });

  it("writes one entry for an erasure whose write landed though its answer was lost, retried", async () => {
    const reader = await person();
    const source = newSource();
    await add(source, `Landed ${wordOf(newMark())}`, owner(reader));
    await nextBucketPut(async (_state, write) => {
      await write();
      throw new Error("The answer lost, by the test");
    });

    const first = await settled(
      eraseSource(env, { source, reason: "deleted" })
    );
    const retried = await settled(
      eraseSource(env, { source, reason: "deleted" })
    );

    expect({
      first: "error" in first,
      retried,
      ledger: await ledgerCount(source),
    }).toStrictEqual({
      first: true,
      retried: { value: undefined },
      ledger: 1,
    });
  });

  it("answers nothing but its overview while it can't read its ledger, with why, and everything once it can", async () => {
    const reader = await person();
    const source = newSource();
    await add(source, "Readable", owner(reader));
    const bucket = env.BRAIN_OBJECTS;
    const unreachable = {
      list: async () => {
        await Promise.resolve();
        throw new Error("R2 out of reach, by the test");
      },
    };
    Reflect.set(env, "BRAIN_OBJECTS", unreachable);
    try {
      await killStore();
      const refused = await settled(historyAs(reader, source, 1));
      const overview = await settled(brainWorkOverview(env));
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
      // Read again once its wait is over.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });
      const read = await historyAs(reader, source, 1);

      expect({
        refused,
        ledger:
          "value" in overview ? overview.value.stepsFailed.ledger?.reason : "",
        read,
      }).toStrictEqual({
        refused: {
          error:
            "Error: The Brain can't read its erasure ledger yet, so it answers nothing: try again shortly",
        },
        ledger: "failed",
        read: "Readable",
      });
    } finally {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
    }
  });
});
