import {
  brainOf,
  recallBudgetMax,
  vectorModelNameOf,
} from "@grasp-os/brain-next/contract";
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

import { embedInProcess } from "../../../packages/embed/test/test-models.ts";
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
  const { items } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ text }) => text);
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

  it("takes a source's vectors with it: their objects and rows go with the sweep, its passages' marks with the erasure", async () => {
    const reader = await person();
    const erased = newSource();
    // One passage: one chunk, one vector.
    const texts = [`Vector passage ${crypto.randomUUID()}`];
    await add(erased, texts.join(""), owner(reader));
    // The queue embeds it, with the embed package's test model.
    const { model } = await embedInProcess([]);
    const name = vectorModelNameOf(model);
    await brainOf(inJurisdiction(env, env.BRAIN_STORE)).work(
      async () => {
        await Promise.resolve();
        return { kind: "answer", text: "" };
      },
      new Date(),
      {
        model,
        embed: async ({ texts: asked }) => {
          const embedded = await embedInProcess(asked);
          return {
            kind: "vectors",
            model: embedded.model,
            results: embedded.vectors,
          };
        },
      }
    );
    const hashes = await Promise.all(texts.map(hashOf));
    const kept = async () => {
      const objects = await Promise.all(
        hashes.map(
          async (hash) =>
            await env.BRAIN_OBJECTS.head(
              `vectors/${encodeURIComponent(name)}/${hash}`
            )
        )
      );
      const rows = await runInDurableObject(store(), (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT 1 FROM vector_files WHERE hash IN (SELECT value FROM json_each(?))",
            JSON.stringify(hashes)
          )
          .toArray()
      );
      return {
        objects: objects.filter((object) => object !== null).length,
        rows: rows.length,
      };
    };
    const before = await kept();

    await eraseSource(env, { source: erased, reason: "deleted" });
    await tickPastGrace();
    await tickPastGrace();

    expect({ before, after: await kept() }).toStrictEqual({
      before: { objects: 1, rows: 1 },
      after: { objects: 0, rows: 0 },
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
      // Its own, and the embedding its add queued.
      before: 2,
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
      // The copy's own count, as it comes back.
      const { sourcesWithoutCurrent: inCopy } = await brainWorkOverview(env);
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
      // leaver's own is gone. Without a current version, which the copy
      // had as theirs, the source answers no one (the team's latest
      // version came after the copy): history never becomes recall. The
      // overview counts it, so it is never out of sight.
      const teamFirstTables = await tablesHolding([teamFirst]);
      const { sourcesWithoutCurrent } = await brainWorkOverview(env);
      expect({
        tables: await tablesHolding([theirs]),
        teamFirstKept: teamFirstTables.includes("chunks"),
        teamFirstRead: await historyAs(colleague, source, 1),
        counted: sourcesWithoutCurrent - inCopy,
      }).toStrictEqual({
        tables: [],
        teamFirstKept: true,
        teamFirstRead: null,
        counted: 1,
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
    // An outage of R2 as the store starts: the store reads its bucket from
    // the env it is constructed with, so only a bucket swapped on the
    // shared env reaches a new instance (a swap on the running instance,
    // as other tests here do, is gone with it). Put back in `finally`,
    // before anything else of the file runs.
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
        ledger: "value" in overview ? overview.value.ledgerReplay : "",
        read,
      }).toStrictEqual({
        refused: {
          error:
            "Error: The Brain can't read its erasure ledger yet, so it answers nothing: try again shortly",
        },
        ledger: "unreadable",
        read: "Readable",
      });
    } finally {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
      // And no instance that started during the outage serves the next
      // test: the next call starts the store afresh, with its own bucket.
      await killStore();
    }
  });
});

/** Most versions one part of a person's ledger entry names (erasure.ts). */
const ledgerPartVersions = 1000;

/** The ledger's objects under the entry naming `id`: its parts. */
const ledgerPartsOf = async (id: string): Promise<string[]> => {
  const [entry] = await ledgerOf(id);
  if (entry === undefined) {
    return [];
  }
  const listed = await env.BRAIN_OBJECTS.list({ prefix: `${entry}/` });
  return listed.objects.map(({ key }) => key);
};

/**
 * Has the store's next bucket writes go through, and the store crash as
 * the `crashAt`-th begins, before it writes: as a restart between two
 * writes of one ledger entry would.
 */
const crashAtBucketPut = async (crashAt: number): Promise<void> => {
  await runInDurableObject(store(), (instance, state) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    let puts = 0;
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_OBJECTS: {
        get: async (key: string) => await bucket.get(key),
        list: async (options: R2ListOptions) => await bucket.list(options),
        put: async (key: string, value: string) => {
          puts += 1;
          if (puts === crashAt) {
            state.abort("Crashed by the test, between two writes");
          }
          return await bucket.put(key, value);
        },
      },
    });
  });
};

/**
 * Counts the store's listings and reads of its bucket from its next
 * start, calling `onGet` before each read. As in the outage test, only a
 * bucket on the shared env reaches a store as it starts; `restore` puts
 * the bucket back and kills the store, so no later test meets it.
 */
const countLedgerCalls = (onGet: () => void = () => {}) => {
  const bucket = env.BRAIN_OBJECTS;
  const calls = { lists: 0, gets: 0 };
  Reflect.set(env, "BRAIN_OBJECTS", {
    list: async (options: R2ListOptions) => {
      calls.lists += 1;
      return await bucket.list(options);
    },
    get: async (key: string) => {
      // The ledger's reads only, not a version's file.
      if (key.startsWith("erasures/")) {
        calls.gets += 1;
        onGet();
      }
      return await bucket.get(key);
    },
    put: async (key: string, value: string) => await bucket.put(key, value),
    delete: async (keys: string | string[]) => {
      await bucket.delete(keys);
    },
    head: async (key: string) => await bucket.head(key),
  });
  return {
    calls,
    restore: async () => {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
      await killStore();
    },
  };
};

describe(
  "a ledger entry of any size, and a replay of any length",
  { timeout: 300_000 },
  () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("writes a person's erasure in parts of a bounded size, goes on after a crash between parts, and erases it all again after a restore", async () => {
      const leaver = await person();
      const mark = newMark();
      const access: Access = { kind: "owner", person: leaver };
      // More versions than one part names, each a source of its own.
      const count = ledgerPartVersions + 50;
      for (let start = 0; start < count; start += 25) {
        // oxlint-disable-next-line no-await-in-loop -- a few adds at a time
        await Promise.all(
          Array.from(
            { length: Math.min(25, count - start) },
            async (_, index) => {
              await brain().addSource({
                source: keyOf(newSource()),
                change: crypto.randomUUID(),
                text: `Run ${start + index} ${wordOf(mark)}`,
                access,
              });
            }
          )
        );
      }
      const backup = await copyOfStore();
      // The first part is written; the store crashes as the second begins.
      await crashAtBucketPut(2);

      const erased = await settled(
        erasePerson(env, { personId: leaver, reason: "person_erased" })
      );
      const afterCrash = {
        recalled: await recalledAs(leaver, wordOf(mark)),
        // Its parts so far, and no entry: not yet in the ledger.
        entries: await ledgerOf(leaver),
      };
      await workBrain(env, new Date());
      const parts = await ledgerPartsOf(leaver);
      const entries = await ledgerOf(leaver);
      await tickUntilErased(5);
      await restoreStore(backup);
      const restored = await recalledAs(leaver, wordOf(mark));
      await tickUntilErased(5);

      expect({
        crashed: "error" in erased,
        afterCrash,
        entries: entries.length,
        parts: parts.length,
        restored,
        tables: await tablesHolding([mark]),
      }).toStrictEqual({
        crashed: true,
        afterCrash: { recalled: [], entries: [] },
        entries: 1,
        parts: 2,
        restored: [],
        tables: [],
      });
    });

    it("goes through a backlog longer than one page a page a step, each step one listing, an erased source's entry taking no read", async () => {
      const reader = await person();
      const mark = newMark();
      const source = newSource();
      await add(source, `Restored late ${wordOf(mark)}`, owner(reader));
      const backup = await copyOfStore();
      await eraseSource(env, { source, reason: "deleted" });
      // More entries than two pages of the listing (1,000 keys a page):
      // erased sources no one added, as the ledger names them.
      const after = await runInDurableObject(
        store(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ at: number }>("SELECT max(erased_at) AS at FROM erasures")
            .one().at
      );
      await Promise.all(
        Array.from({ length: 2100 }, async (_, index) => {
          const subject = await hashOf(crypto.randomUUID());
          await env.BRAIN_OBJECTS.put(
            `erasures/${String(after + 1 + index).padStart(15, "0")}-source-deleted-${subject}`,
            ""
          );
        })
      );

      await restoreStore(backup);
      const counted = countLedgerCalls();
      try {
        const calls: { lists: number; gets: number; answer: string }[] = [];
        for (let call = 0; call < 5; call += 1) {
          const before = { ...counted.calls };
          // oxlint-disable-next-line no-await-in-loop -- one call at a time
          const answered = await settled(historyAs(reader, source, 1));
          calls.push({
            lists: counted.calls.lists - before.lists,
            gets: counted.calls.gets - before.gets,
            answer: "value" in answered ? "answered" : answered.error,
          });
          if ("value" in answered) {
            break;
          }
        }
        const { ledgerReplay } = await brainWorkOverview(env);

        expect({
          calls,
          ledgerReplay,
          recalled: await recalledAs(reader, wordOf(mark)),
        }).toStrictEqual({
          // As it starts, a step; then a step a call until it is through.
          calls: [
            {
              lists: 2,
              gets: 0,
              answer:
                "Error: The Brain is applying its erasure ledger after a restore, so it answers nothing yet: try again shortly",
            },
            { lists: 1, gets: 0, answer: "answered" },
          ],
          ledgerReplay: "through",
          recalled: [],
        });
      } finally {
        await counted.restore();
      }
    });

    it("stops a step whose reads are slow once its time is up, keeping what it applied, and the next step goes on", async () => {
      const reader = await person();
      const source = newSource();
      await add(source, "Answered once through", owner(reader));
      const backup = await copyOfStore();
      // Nine people's erasures, each an entry of the ledger to read.
      for (let erased = 0; erased < 9; erased += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await erasePerson(env, {
          personId: `nobody-${crypto.randomUUID()}`,
          reason: "withdrawn",
        });
      }

      await restoreStore(backup);
      // Each read takes 4 s, as the clock sees it: a step (10 s) starts
      // three.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const counted = countLedgerCalls(() => {
        vi.setSystemTime(Date.now() + 4000);
      });
      try {
        const first = await settled(historyAs(reader, source, 1));
        const afterFirst = counted.calls.gets;
        const { ledgerReplay } = await brainWorkOverview(env);
        const second = await settled(historyAs(reader, source, 1));

        expect({
          first,
          afterFirst,
          ledgerReplay,
          second,
          afterSecond: counted.calls.gets - afterFirst,
        }).toStrictEqual({
          first: {
            error:
              "Error: The Brain is applying its erasure ledger after a restore, so it answers nothing yet: try again shortly",
          },
          // Three as it starts, three by the first call.
          afterFirst: 6,
          ledgerReplay: "replaying",
          second: { value: "Answered once through" },
          afterSecond: 3,
        });
      } finally {
        await counted.restore();
      }
    });

    it("stays unreadable on a ledger key it can't read, answering nothing but its overview and applying nothing after it", async () => {
      const reader = await person();
      const mark = newMark();
      const source = newSource();
      await add(source, `Behind an unknown key ${wordOf(mark)}`, owner(reader));
      const backup = await copyOfStore();
      await eraseSource(env, { source, reason: "deleted" });
      const [erasure] = await ledgerOf(keyOf(source));
      // As a later release's reason, kept through a rollback, would be:
      // the same time, sorting before the erasure after it.
      const unknown = `${erasure?.slice(0, "erasures/".length + 15) ?? ""}-source-archived-${await hashOf(crypto.randomUUID())}`;
      await env.BRAIN_OBJECTS.put(unknown, "");
      try {
        await restoreStore(backup);
        const answered = await settled(historyAs(reader, source, 1));
        const { ledgerReplay } = await brainWorkOverview(env);
        const applied = await runInDurableObject(
          store(),
          (_instance, state) =>
            state.storage.sql
              .exec<{ count: number }>(
                "SELECT count(*) AS count FROM erasures WHERE key = ?",
                erasure ?? ""
              )
              .one().count
        );

        expect({ answered, ledgerReplay, applied }).toStrictEqual({
          answered: {
            error:
              "Error: The Brain can't read its erasure ledger yet, so it answers nothing: try again shortly",
          },
          ledgerReplay: "unreadable",
          applied: 0,
        });
      } finally {
        await env.BRAIN_OBJECTS.delete(unknown);
        await killStore();
      }
    });

    it("lists on past a page of orphan parts, whose entry was never written, to the entry after them", async () => {
      const reader = await person();
      const mark = newMark();
      const source = newSource();
      await add(source, `Behind orphan parts ${wordOf(mark)}`, owner(reader));
      const backup = await copyOfStore();
      await eraseSource(env, { source, reason: "deleted" });
      const [erasure] = await ledgerOf(keyOf(source));
      // More parts than a page of the listing, of a person's entry that
      // crashed before its entry: at the same time, sorting before the
      // erasure after them.
      const orphan = `${erasure?.slice(0, "erasures/".length + 15) ?? ""}-person-person_erased-${await hashOf(crypto.randomUUID())}`;
      const parts = Array.from(
        { length: 1001 },
        (_, index) => `${orphan}/${String(index).padStart(4, "0")}`
      );
      await Promise.all(
        parts.map(async (part) => await env.BRAIN_OBJECTS.put(part, "[]"))
      );
      try {
        await restoreStore(backup);
        const answered = await settled(historyAs(reader, source, 1));

        expect({
          answered,
          recalled: await recalledAs(reader, wordOf(mark)),
        }).toStrictEqual({
          answered: { value: null },
          recalled: [],
        });
      } finally {
        await env.BRAIN_OBJECTS.delete(parts);
        await killStore();
      }
    });
  }
);

/**
 * Has the running store's writes to its ledger fail while `failing` is
 * set, every other call of its bucket going through, until the store
 * restarts. Answers the switch.
 */
const failLedgerWrites = async (): Promise<{ failing: boolean }> => {
  const switched = { failing: true };
  await runInDurableObject(store(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_OBJECTS: {
        get: async (key: string) => await bucket.get(key),
        head: async (key: string) => await bucket.head(key),
        list: async (options: R2ListOptions) => await bucket.list(options),
        delete: async (keys: string | string[]) => {
          await bucket.delete(keys);
        },
        put: async (
          key: string,
          value: ArrayBufferView | string,
          options?: R2PutOptions
        ) => {
          if (switched.failing && key.startsWith("erasures/")) {
            throw new Error("R2 failed, by the test");
          }
          return await bucket.put(key, value, options);
        },
      },
    });
  });
  return switched;
};

/**
 * Holds the store's next read of its bucket before it reaches the bucket,
 * until the test releases it: `reached` once it is there.
 */
const holdNextBucketGet = async () => {
  const gate = { reached: false, released: false };
  await runInDurableObject(store(), (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const bucket = env.BRAIN_OBJECTS;
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_OBJECTS: {
        get: async (key: string) => {
          Reflect.set(instance, "env", objectEnv);
          gate.reached = true;
          while (!gate.released) {
            // oxlint-disable-next-line no-await-in-loop -- until the test says
            await scheduler.wait(10);
          }
          return await bucket.get(key);
        },
        list: async (options: R2ListOptions) => await bucket.list(options),
        put: async (key: string, value: string) => await bucket.put(key, value),
      },
    });
  });
  return gate;
};

/** Holds the recording work's handler for `source` until released. */
const holdHandlerOf = (source: SourceRef) => {
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
        signal.aborted && reason instanceof WorkError ? reason.code : undefined;
    }
  });
  return gate;
};

describe(
  "what must hold when an erasure's ledger write fails, and identities an erasure frees",
  { timeout: 120_000 },
  () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ["no tick", "none"],
      ["a tick that can't write the entry and deletes what it hid", "failing"],
      ["a tick that writes the first entry", "writing"],
    ] as const)(
      "erases on a retry of a person's erasure what was added for them since the call that failed, with %s between, and a restore erases both again",
      async (_between, tick) => {
        const leaver = await person();
        const [before, since] = [newMark(), newMark()];
        await add(newSource(), `Before ${wordOf(before)}`, owner(leaver));
        const backup = await copyOfStore();
        const switched = await failLedgerWrites();

        const first = await settled(
          erasePerson(env, { personId: leaver, reason: "person_erased" })
        );
        // Added for them after the call that failed, before its retry.
        await add(newSource(), `Since ${wordOf(since)}`, owner(leaver));
        if (tick === "failing") {
          await workBrain(env, new Date());
        }
        switched.failing = false;
        if (tick === "writing") {
          await workBrain(env, new Date());
        }
        const retried = await settled(
          erasePerson(env, { personId: leaver, reason: "person_erased" })
        );
        await tickUntilErased();
        const afterRetry = {
          before: await recalledAs(leaver, wordOf(before)),
          since: await recalledAs(leaver, wordOf(since)),
        };
        const entries = await ledgerOf(leaver);
        await restoreStore(backup);
        const restored = await recalledAs(leaver, wordOf(before));
        await tickUntilErased();

        expect({
          first: "error" in first,
          retried,
          afterRetry,
          entries: entries.length,
          restored,
          tables: await tablesHolding([before, since]),
        }).toStrictEqual({
          first: true,
          retried: { value: undefined },
          afterRetry: { before: [], since: [] },
          entries: 2,
          restored: [],
          tables: [],
        });
      }
    );

    it("refuses an add to a source between its erasure that failed to be written and the retry", async () => {
      const reader = await person();
      const source = newSource();
      await add(source, `Erased ${wordOf(newMark())}`, owner(reader));
      const switched = await failLedgerWrites();
      const first = await settled(
        eraseSource(env, { source, reason: "deleted" })
      );
      const between = await settled(
        add(source, "Added between", owner(reader))
      );
      switched.failing = false;
      const retried = await settled(
        eraseSource(env, { source, reason: "deleted" })
      );

      expect({ first: "error" in first, between, retried }).toStrictEqual({
        first: true,
        between: {
          error: "Error: The Brain refused it: what this adds was erased",
        },
        retried: { value: undefined },
      });
    });

    it("writes the erasure's ledger entry though an abort listener of a handler under way throws", async () => {
      const reader = await person();
      const source = newSource();
      await add(source, `Listened ${wordOf(newMark())}`, owner(reader));
      const gate = { reached: false, released: false };
      handling.set(keyOf(source), async (signal) => {
        signal.addEventListener("abort", () => {
          throw new Error("A listener that throws, by the test");
        });
        gate.reached = true;
        while (!gate.released) {
          // oxlint-disable-next-line no-await-in-loop -- until the test says
          await scheduler.wait(10);
        }
      });
      await queueRecorded(source);
      const ticking = settled(workBrain(env, new Date()));
      await vi.waitFor(() => {
        expect(gate.reached).toBeTruthy();
      });

      const erased = await settled(
        eraseSource(env, { source, reason: "deleted" })
      );
      gate.released = true;
      await ticking;

      const entries = await ledgerOf(keyOf(source));
      const { ledgerReplay } = await brainWorkOverview(env);
      expect({
        erased,
        entries: entries.length,
        ledgerReplay,
      }).toStrictEqual({
        erased: { value: undefined },
        entries: 1,
        ledgerReplay: "through",
      });
    });

    it("aborts the handler under way on an erased source though the erasure's ledger write failed", async () => {
      const reader = await person();
      const source = newSource();
      await add(source, `Under way ${wordOf(newMark())}`, owner(reader));
      const gate = holdHandlerOf(source);
      await queueRecorded(source);
      const ticking = settled(workBrain(env, new Date()));
      await vi.waitFor(() => {
        expect(gate.reached).toBeTruthy();
      });
      await nextBucketPut(async () => {
        await Promise.resolve();
        throw new Error("R2 failed, by the test");
      });

      const erased = await settled(
        eraseSource(env, { source, reason: "deleted" })
      );
      gate.released = true;
      await ticking;

      expect({
        failed: "error" in erased,
        seen: handled.get(keyOf(source)),
      }).toStrictEqual({
        failed: true,
        seen: { runs: 1, abortedAfter: "erased" },
      });
    });

    it("settles a handler that ends after its source was erased without touching an item added after it", async () => {
      const reader = await person();
      const [erased, next] = [newSource(), newSource()];
      await add(erased, `Erased ${wordOf(newMark())}`, owner(reader));
      const first = holdHandlerOf(erased);
      const second = holdHandlerOf(next);
      await queueRecorded(erased);
      const ticking = settled(workBrain(env, new Date()));
      await vi.waitFor(() => {
        expect(first.reached).toBeTruthy();
      });
      await eraseSource(env, { source: erased, reason: "deleted" });
      // Added after the erasure deleted the first one's row.
      await queueRecorded(next);
      await vi.waitFor(() => {
        expect(second.reached).toBeTruthy();
      });
      first.released = true;
      await vi.waitFor(() => {
        expect(handled.get(keyOf(erased))?.abortedAfter).toBe("erased");
      });
      const queuedWhileRunning = await queuedAbout(next);
      second.released = true;
      await ticking;

      expect(queuedWhileRunning).toBe(1);
    });

    it("never answers a read of a version erased while its file was being read", async () => {
      const reader = await person();
      const [history, current] = [newSource(), newSource()];
      await add(history, `Read late ${wordOf(newMark())}`, owner(reader));
      await add(current, `Read late too ${wordOf(newMark())}`, owner(reader));

      const heldHistory = await holdNextBucketGet();
      const readingHistory = settled(historyAs(reader, history, 1));
      await vi.waitFor(() => {
        expect(heldHistory.reached).toBeTruthy();
      });
      await eraseSource(env, { source: history, reason: "deleted" });
      heldHistory.released = true;

      const heldCurrent = await holdNextBucketGet();
      const readingCurrent = settled(
        brain().readCurrent({
          sources: [keyOf(current)],
          reader: { person: reader, groups: [] },
        })
      );
      await vi.waitFor(() => {
        expect(heldCurrent.reached).toBeTruthy();
      });
      await eraseSource(env, { source: current, reason: "deleted" });
      heldCurrent.released = true;

      expect({
        history: await readingHistory,
        current: await readingCurrent,
      }).toStrictEqual({
        history: { value: null },
        current: { value: [] },
      });
    });

    it("numbers a source's next version past those a person's erasure deleted, so a late vector put for the old one writes nothing", async () => {
      const leaver = await person();
      const source = newSource();
      const access: Access = { kind: "owner", person: leaver };
      const [old] = await chunkedSource(source, access, 1, "Old text");
      await erasePerson(env, { personId: leaver, reason: "withdrawn" });
      await tickUntilErased();
      // Their own again, after the erasure: new, and kept.
      const version = await add(source, "New text", owner(leaver));
      const model = modelOf();
      await putCodes(model, old === undefined ? [] : [old]);
      const codes = await runInDurableObject(
        store(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT count(*) AS count FROM vector_codes
              WHERE model = (SELECT id FROM vector_models WHERE name = ?)`,
              model.name
            )
            .one().count
      );

      expect({ old: old?.version, version, codes }).toStrictEqual({
        old: 1,
        version: 2,
        codes: 0,
      });
    });

    it("repacks at once each block that held a code of an erased source's earlier version", async () => {
      const reader = await person();
      const source = newSource();
      const access: Access = { kind: "owner", person: reader };
      const model = modelOf();
      const earlier = await chunkedSource(source, access, 600, "Earlier");
      const neighbour = await chunkedSource(
        newSource(),
        access,
        blockSize - 600,
        "Neighbour"
      );
      await putCodes(model, [...earlier, ...neighbour]);
      const earlierRows = await chunkRowsOf(source);
      // A new version: the earlier one's codes are marked removed in their
      // block, waiting for a repack.
      await add(source, "Later", owner(reader));
      const waiting = await vectorsOf(earlierRows, []);

      await eraseSource(env, { source, reason: "deleted" });
      const afterErasure = await vectorsOf(earlierRows, []);

      expect({
        waiting: waiting.inBlocks,
        afterErasure: afterErasure.inBlocks,
      }).toStrictEqual({ waiting: 600, afterErasure: 0 });
    });

    it("leaves no plain source key or person id once a person's sources and instruction file are erased, nor for a source erased before it was added", async () => {
      const leaver = await person();
      await add(newSource(), `Theirs ${wordOf(newMark())}`, owner(leaver));
      await addInstructionFile(env, {
        file: { scope: "person", personId: leaver },
        change: crypto.randomUUID(),
        text: "Call me by my name",
      });
      const never = newSource();

      await erasePerson(env, { personId: leaver, reason: "person_erased" });
      await eraseSource(env, { source: never, reason: "deleted" });
      await tickUntilErased();

      await expect(tablesHolding([leaver, never.id])).resolves.toStrictEqual(
        []
      );
    });
  }
);

/** Adds as `add` does with the clock at `at`. */
const addAt = async (
  at: number,
  ...adding: Parameters<typeof add>
): Promise<number> => {
  vi.useFakeTimers({ toFake: ["Date"], now: at });
  try {
    return await add(...adding);
  } finally {
    vi.useRealTimers();
  }
};

/** Every version `personId`'s packs cite for the questions, as of each moment. */
const citedBy = async (
  personId: string,
  questions: readonly string[],
  moments: readonly (Date | undefined)[]
): Promise<string[]> => {
  const packs = await Promise.all(
    questions.flatMap((question) =>
      moments.map(
        async (asOf) =>
          await recallAs(env, personId, {
            question,
            budget: { tokens: recallBudgetMax },
            ...(asOf === undefined ? {} : { asOf }),
          })
      )
    )
  );
  return packs.flatMap(({ items }) =>
    items.map(({ source, version }) => `${source.id} v${version}`)
  );
};

// The cited pack (GRA-1728) after an erasure: no way of recall (words,
// an exact ID, a quoted phrase, as of a moment) reaches an erased version,
// before the tick deletes it or after; a source added again for a person
// after their erasure is cited at its new version; and while the store
// replays its ledger, recall is refused as every call is.
describe("a pack after an erasure", { timeout: 120_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never cites a version erased with its source or its person, by words, ID, phrase or as of when it was current, before the tick deletes it or after", async () => {
    const [reader, erased] = await Promise.all([person(), person()]);
    const team = await teamOf(reader, erased);
    const [sourceMark, personMark] = [newMark(), newMark()];
    const hour = 3_600_000;
    const start = Date.now() - 10 * hour;
    // More of the erased person's own chunks than one batch deletes, added
    // first: the erasure returns with the versions below still to delete.
    const access: Access = { kind: "owner", person: erased };
    await chunkedSource(newSource(), access, 600, "Archive one");
    await chunkedSource(newSource(), access, 600, "Archive two");
    // A source of the reader's, two versions, erased whole.
    const whole = newSource();
    await addAt(
      start,
      whole,
      `Draft ${wordOf(sourceMark)} INV-${sourceMark} "night rota ${sourceMark}"`,
      owner(reader)
    );
    await addAt(
      start + 2 * hour,
      whole,
      `Final ${wordOf(sourceMark)} INV-${sourceMark} night rota ${sourceMark}`,
      owner(reader)
    );
    // A team's source with a middle version the erased person alone could
    // read: as of then, the version before it answers, never it.
    const middle = newSource();
    const before = await addAt(
      start,
      middle,
      `Team plan ${wordOf(personMark)}`,
      { kind: "team", teamId: team }
    );
    await addAt(
      start + 2 * hour,
      middle,
      `Private plan ${wordOf(personMark)} INV-${personMark} night rota ${personMark}`,
      owner(erased)
    );
    await addAt(
      start + 4 * hour,
      middle,
      `Team plan again ${wordOf(personMark)}`,
      {
        kind: "team",
        teamId: team,
      }
    );
    const questions = (mark: string): string[] => [
      wordOf(mark),
      `INV-${mark}`,
      `"night rota ${mark}"`,
    ];
    const moments = [
      undefined,
      new Date(start + hour),
      new Date(start + 3 * hour),
      new Date(start + 5 * hour),
    ];

    await eraseSource(env, { source: whole, reason: "deleted" });
    await erasePerson(env, { personId: erased, reason: "withdrawn" });
    const { erasing: left } = await brainWorkOverview(env);
    const erasing = {
      source: await citedBy(reader, questions(sourceMark), moments),
      person: await citedBy(reader, questions(personMark), moments),
    };
    await tickUntilErased();
    const deleted = {
      source: await citedBy(reader, questions(sourceMark), moments),
      person: await citedBy(reader, questions(personMark), moments),
    };

    // Of the team's source: by its words, the version current at each
    // moment that isn't erased (v1 for the hours v1 and the erased v2
    // were current, v3 since and now); never v2, and nothing of the
    // erased source.
    const team1 = `${middle.id} v${before}`;
    const team3 = `${middle.id} v3`;
    const expected = {
      source: [],
      person: [team3, team1, team1, team3],
    };
    expect({ left: left > 0, erasing, deleted }).toStrictEqual({
      left: true,
      erasing: expected,
      deleted: expected,
    });
  });

  it("cites a source added again for a person after their erasure at its new version", async () => {
    const reader = await person();
    const mark = newMark();
    const source = newSource();
    await add(source, `Old note ${wordOf(mark)} INV-${mark}`, owner(reader));
    await erasePerson(env, { personId: reader, reason: "withdrawn" });
    await tickUntilErased();
    const again = `New note ${wordOf(mark)} INV-${mark}`;
    const version = await add(source, again, owner(reader));

    const { items } = await recallAs(env, reader, {
      question: `INV-${mark}`,
      budget: { tokens: recallBudgetMax },
    });

    expect(
      items.map(({ source: cited, version: at, text }) => ({
        source: cited,
        version: at,
        text,
      }))
    ).toStrictEqual([{ source, version, text: again }]);
    await expect(historyAs(reader, source, version)).resolves.toBe(again);
  });

  it("refuses a recall while the store replays its ledger after a restore, as every other call", async () => {
    const reader = await person();
    const source = newSource();
    await add(source, "Recalled once through", owner(reader));
    const backup = await copyOfStore();
    for (let erased = 0; erased < 9; erased += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await erasePerson(env, {
        personId: `nobody-${crypto.randomUUID()}`,
        reason: "withdrawn",
      });
    }

    await restoreStore(backup);
    // Each read of the ledger takes 4 s, as the clock sees it: a step
    // reads three of nine, so the store is still replaying after it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const counted = countLedgerCalls(() => {
      vi.setSystemTime(Date.now() + 4000);
    });
    try {
      const recalled = await settled(
        recallAs(env, reader, {
          question: "recalled",
          budget: { tokens: recallBudgetMax },
        })
      );
      const { ledgerReplay } = await brainWorkOverview(env);

      expect({ recalled, ledgerReplay }).toStrictEqual({
        recalled: {
          error:
            "Error: The Brain is applying its erasure ledger after a restore, so it answers nothing yet: try again shortly",
        },
        ledgerReplay: "replaying",
      });
    } finally {
      await counted.restore();
    }
  });
});

/**
 * A scene for the vector scan beside an erasure: `reader`'s own source of
 * a few chunks with codes, and one live passage their team reads, also
 * with a code. The scan may offer a code only of a current version the
 * reader may read (vectors.ts), so the erased chunks' codes must leave it
 * as the erasure hides them, whatever happens to its ledger write: else,
 * past the candidates the scan keeps, nearer hidden chunks would crowd out
 * live ones (packages/brain-next/test/meaning.test.ts shows it with 300).
 */
const erasedBesideLive = async () => {
  const reader = await person();
  const team = await teamOf(reader);
  const model = modelOf(8);
  const live = newSource();
  const erased = newSource();
  const livePassages = await chunkedSource(
    live,
    { kind: "audience", group: `team:${team}` },
    1,
    "Live"
  );
  await putCodes(model, livePassages);
  await putCodes(
    model,
    await chunkedSource(erased, { kind: "owner", person: reader }, 3, "Erased")
  );
  const erasedRows = await chunkRowsOf(erased);
  const at = model.name.lastIndexOf("@");
  /** The codes of the erased chunks the scan can still offer. */
  const inScan = async (): Promise<number> => {
    const { codes } = await vectorsOf(erasedRows, []);
    return codes;
  };
  /** The sources recall by meaning cites for the reader. */
  const foundByMeaning = async (): Promise<string[]> => {
    const { items } = await brain().recall({
      question: "Unheardof",
      reader: { person: reader, groups: [`team:${team}`] },
      budget: { tokens: recallBudgetMax },
      meaning: {
        model: {
          name: model.name.slice(0, at),
          build: model.name.slice(at + 1),
        },
        vector: Array.from({ length: 8 }, () => 1),
      },
    });
    return [...new Set(items.map(({ source }) => source))];
  };
  return { reader, erased, live: keyOf(live), inScan, foundByMeaning };
};

type Scene = Awaited<ReturnType<typeof erasedBesideLive>>;

/** How long a test waits for the store to reach its held ledger write. */
const heldWriteMs = 30_000;

describe("the vector scan beside an erasure", { timeout: 120_000 }, () => {
  const erasures = [
    {
      name: "a source's",
      erase: async (scene: Scene) => {
        await eraseSource(env, { source: scene.erased, reason: "deleted" });
      },
    },
    {
      name: "a person's",
      erase: async (scene: Scene) => {
        await erasePerson(env, {
          personId: scene.reader,
          reason: "person_erased",
        });
      },
    },
  ];

  it.for(erasures)(
    "takes the erased chunks' codes out of the scan as $name erasure hides them, while its ledger write waits",
    async ({ erase }) => {
      const scene = await erasedBesideLive();
      const before = await scene.inScan();
      const gate = await holdNextBucketPut();
      const erasing = settled(erase(scene));
      const waitUntil = Date.now() + heldWriteMs;
      while (!gate.reached) {
        if (Date.now() > waitUntil) {
          throw new Error(
            `The erasure didn't reach its ledger write in ${heldWriteMs} ms`
          );
        }
        // oxlint-disable-next-line no-await-in-loop -- until the erasure writes its ledger
        await scheduler.wait(10);
      }

      const inScan = await scene.inScan();
      const overview = await brainWorkOverview(env);
      const found = await scene.foundByMeaning();
      gate.released = true;
      const returned = await erasing;

      expect({
        before,
        waiting: { inScan, erasing: overview.erasing > 0, found },
        returned,
        afterErasure: await scene.foundByMeaning(),
      }).toStrictEqual({
        before: 3,
        waiting: { inScan: 0, erasing: true, found: [scene.live] },
        returned: { value: undefined },
        afterErasure: [scene.live],
      });
    }
  );

  it.for(erasures)(
    "keeps the erased chunks' codes out of the scan after $name erasure whose ledger write failed, and after it is erased again",
    async ({ erase }) => {
      const scene = await erasedBesideLive();
      const switched = await failLedgerWrites();

      const failed = await settled(erase(scene));
      const unwritten = await scene.inScan();
      switched.failing = false;
      const retried = await settled(erase(scene));

      expect({
        failed: "error" in failed,
        unwritten,
        retried,
        afterRetry: await scene.inScan(),
        found: await scene.foundByMeaning(),
      }).toStrictEqual({
        failed: true,
        unwritten: 0,
        retried: { value: undefined },
        afterRetry: 0,
        found: [scene.live],
      });
    }
  );
});
