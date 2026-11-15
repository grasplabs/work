// A memory's quote against its source's current version (quotes.ts;
// GRA-1915, the threat model is on the issue), through the store's own
// methods: what a reader reads, as of now and of a moment before, and
// what the store keeps and lets go of. The generated cases against twins
// and a from-scratch oracle are in quotes-twins.test.ts.
import type {
  Access,
  MemoriesCursor,
  NewMemory,
  PersonReader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chunksOf } from "../src/chunks.ts";
import { fileKeyOf } from "../src/files.ts";
import { quoteIndexOf } from "../src/quotes.ts";
import type { BrainStore } from "../src/store.ts";
import { sequenceOf } from "../src/words.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const unique = (name: string): string =>
  `${name}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const audience = (group: string): Access => ({ kind: "audience", group });

const readerOf = (...groups: string[]): PersonReader => ({
  person: unique("p"),
  groups,
});

/** One tick of the store's clock, with no model and nothing to hand over. */
const tick = async (): Promise<void> => {
  await shared().work({
    ask: async () => {
      await Promise.resolve();
      return { kind: "refused" };
    },
    at: new Date(),
    embedders: {
      model: null,
      embed: async () => {
        await Promise.resolve();
        return { kind: "unavailable" };
      },
    },
    handOvers: {
      handOver: async () => {
        await Promise.resolve();
        return { kind: "nothing" };
      },
    },
    contextTokens: null,
  });
};

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** Adds `text` as the next version of `source`: its number. */
const version = async (
  source: string,
  text: string,
  group: string,
  extra: { thread?: boolean } = {}
): Promise<number> => {
  const added = await called(
    shared().addSource({
      source,
      change: crypto.randomUUID(),
      text,
      access: audience(group),
      ...extra,
    })
  );
  return added.version;
};

/** A memory resting on `version` of `source`, quoting `quote`, about the entity `entity` or a new one named `name`. */
const memoryOn = async (
  {
    source,
    version: on,
    quote,
    group,
  }: { source: string; version: number; quote: string; group: string },
  about: { entity: string } | { name: string },
  extra: Partial<NewMemory> = {}
): Promise<{ memory: string; entity: string }> => {
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(group),
    entities: [
      "entity" in about
        ? { key: "c", id: about.entity, kind: "customer" }
        : { key: "c", kind: "customer", names: [about.name] },
    ],
    memories: [
      {
        about: "c",
        type: "fact",
        statement: `${quote}.`,
        speaker: { kind: "outside" },
        basis: { kind: "source", source, version: on, quote },
        ...extra,
      },
    ],
  });
  return { memory: added.memories[0] ?? "", entity: added.entities.c ?? "" };
};

/** When `reader` read `memory` end, as of `asOf` if given: "unread", null while current, or the moment. */
const endOf = async (
  entity: string,
  memory: string,
  reader: PersonReader,
  asOf?: Date
): Promise<number | null | "unread"> => {
  const { memories } = await shared().readMemories({
    entity,
    reader,
    history: true,
    ...(asOf === undefined ? {} : { asOf }),
  });
  const found = memories.find(({ id }) => id === memory);
  if (found === undefined) {
    return "unread";
  }
  return found.endedAt?.getTime() ?? null;
};

/** When version `number` of `source` was added. */
const addedAt = async (
  source: string,
  number: number,
  reader: PersonReader
): Promise<number> => {
  const found = await shared().readVersion({
    source,
    version: number,
    reader,
  });
  return found?.addedAt.getTime() ?? Number.NaN;
};

/** How many rows the store keeps of `memories` in `table`. */
const rowsOf = async (
  table: "memory_outs" | "memory_ins",
  memories: readonly string[]
): Promise<number> =>
  await runInDurableObject(
    shared(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT count(*) AS count FROM ${table}
          WHERE memory IN (
            SELECT row FROM memories WHERE id IN (SELECT value FROM json_each(?))
          )`,
          JSON.stringify(memories)
        )
        .one().count
  );

describe("a memory whose quote left its source", () => {
  it("ends at the add of the version that no longer holds it, keeps its history, and is current again when a later version says it again", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}. Hello.`, group);
    const { memory, entity } = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    const kept = await version(source, `Hello. ${line}, monthly.`, group);
    const whileHeld = await endOf(entity, memory, reader);
    const without = await version(source, "Hello, nothing more.", group);
    const out = await endOf(entity, memory, reader);
    const outAt = await addedAt(source, without, reader);
    const before = await endOf(entity, memory, reader, new Date(outAt - 1));
    await version(source, `${line} again.`, group);
    const found = await shared().findEntities({ reader, name });

    expect({
      kept,
      whileHeld,
      out,
      before,
      back: await endOf(entity, memory, reader),
      // Ended, not retired: its entity is still found by its name.
      found: found.entities.map(({ id }) => id),
    }).toStrictEqual({
      kept: 2,
      whileHeld: null,
      out: outAt,
      before: null,
      back: null,
      found: [entity],
    });
  });

  it("judges a memory added late against the current version, never one between, and a memory on the current version against nothing", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} renews in May`;
    const first = await version(source, `${line}.`, group);
    const second = await version(source, "Nothing about renewals.", group);
    const third = await version(source, `Again: ${line}.`, group);
    // Late, on the second version, which never said it: the current one does.
    const onSecond = await memoryOn(
      { source, version: second, quote: line, group },
      { name }
    );
    // Late, on the first, quoting what only the second said.
    const onFirst = await memoryOn(
      { source, version: first, quote: "Nothing about renewals", group },
      { entity: onSecond.entity }
    );
    // On the current version, quoting what it doesn't say: not judged.
    const onCurrent = await memoryOn(
      { source, version: third, quote: "Something else entirely", group },
      { entity: onSecond.entity }
    );
    const thirdAt = await addedAt(source, third, reader);
    const learned = async (memory: string): Promise<number> => {
      const { memories } = await shared().readMemories({
        entity: onSecond.entity,
        reader,
        history: true,
      });
      return (
        memories.find(({ id }) => id === memory)?.learnedAt.getTime() ??
        Number.NaN
      );
    };

    expect({
      onSecond: await endOf(onSecond.entity, onSecond.memory, reader),
      onFirst: await endOf(onSecond.entity, onFirst.memory, reader),
      onCurrent: await endOf(onSecond.entity, onCurrent.memory, reader),
    }).toStrictEqual({
      onSecond: null,
      // Ended when it was learned: later than the current version's add.
      onFirst: Math.max(await learned(onFirst.memory), thirdAt),
      onCurrent: null,
    });
  });

  it("ends nothing of an older memory once the newer one that ended it is out: Anna, Bob, then Anna again", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const first = await version(source, `${name} is Active.`, group);
    const active = await memoryOn(
      { source, version: first, quote: `${name} is Active`, group },
      { name },
      { attribute: "status", value: "Active" }
    );
    const second = await version(source, `${name} is Churned.`, group);
    const churned = await memoryOn(
      { source, version: second, quote: `${name} is Churned`, group },
      { entity: active.entity },
      { attribute: "status", value: "Churned" }
    );
    const whileChurned = await endOf(active.entity, active.memory, reader);
    const third = await version(source, `${name} is Active.`, group);
    const thirdAt = await addedAt(source, third, reader);
    const { memories: current } = await shared().readMemories({
      entity: active.entity,
      reader,
    });

    expect({
      endedWhileChurned: typeof whileChurned === "number",
      active: await endOf(active.entity, active.memory, reader),
      churned: await endOf(active.entity, churned.memory, reader),
      current: current.map(({ value }) => value),
    }).toStrictEqual({
      endedWhileChurned: true,
      active: null,
      churned: thirdAt,
      current: ["Active"],
    });
  });

  it("is judged against the whole text, not its chunks: a quote across a cut inside a run without spaces stays held", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    // A run without whitespace far past a chunk: cut inside a word.
    const text = `${name}: ${"顧客は毎月カードで支払い、三月に更新します。".repeat(200)}`;
    const whole = sequenceOf(text);
    const joined = chunksOf(text).flatMap((chunk) => sequenceOf(chunk));
    const split = whole.findIndex((word, index) => joined[index] !== word);
    const quote = whole.slice(split - 1, split + 2).join(" ");
    const first = await version(source, text, group);
    const drawn = await memoryOn(
      { source, version: first, quote, group },
      { name }
    );
    await version(source, `${text} More.`, group);
    // A statement of its own: the same one again would end the first as
    // a restatement.
    const late = await memoryOn(
      { source, version: first, quote, group },
      { entity: drawn.entity },
      { statement: `${name} renews in March.` }
    );

    expect({
      cutInsideWord: split > 0,
      drawn: await endOf(drawn.entity, drawn.memory, reader),
      late: await endOf(drawn.entity, late.memory, reader),
    }).toStrictEqual({ cutInsideWord: true, drawn: null, late: null });
  });

  it("reads as the store did before the current version's add when asked as of a moment before it", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}.`, group);
    const { memory, entity } = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    const second = await version(source, "Paid in cash.", group);
    const at = await addedAt(source, second, reader);

    expect({
      before: await endOf(entity, memory, reader, new Date(at - 1)),
      at: await endOf(entity, memory, reader, new Date(at)),
    }).toStrictEqual({ before: null, at });
  });
});

describe("what never takes part", () => {
  it("never puts out what an earlier message of a thread said, and a thread's extracted message ends nothing, where a document's does", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const name = unique("Acme");
    const ofKind = async (thread: boolean) => {
      const source = unique(thread ? "thread" : "doc");
      const line = `${name} pays by card`;
      const first = await version(source, `${line}.`, group, { thread });
      const said = await memoryOn(
        { source, version: first, quote: line, group },
        { name }
      );
      // Still holding the line, so a document's memory ends by the mark alone.
      const second = await version(
        source,
        `${line}. Anna asked about invoices.`,
        group,
        { thread }
      );
      const whileUnmarked = await endOf(said.entity, said.memory, reader);
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: audience(group),
        entities: [],
        memories: [],
        extracted: { source, version: second },
      });
      const marked = await endOf(said.entity, said.memory, reader);
      await version(source, "Bob replied, thanks.", group, { thread });
      return {
        whileUnmarked,
        marked: marked === null ? "current" : "ended",
        out:
          (await endOf(said.entity, said.memory, reader)) === null
            ? "current"
            : "ended",
      };
    };

    expect({
      thread: await ofKind(true),
      document: await ofKind(false),
    }).toStrictEqual({
      thread: { whileUnmarked: null, marked: "current", out: "current" },
      document: { whileUnmarked: null, marked: "ended", out: "ended" },
    });
  });

  it("refuses an add that says otherwise than its source's first whether it is a thread", async () => {
    const group = unique("g");
    const thread = unique("thread");
    const document = unique("doc");
    await version(thread, "First message.", group, { thread: true });
    await version(document, "First draft.", group);
    const refusal = async (
      source: string,
      isThread: boolean
    ): Promise<string> => {
      try {
        await version(source, unique("Next"), group, { thread: isThread });
        return "added";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    expect({
      thread: await refusal(thread, false),
      document: await refusal(document, true),
      threadAgain: await refusal(thread, true),
    }).toStrictEqual({
      thread:
        "The Brain refused it: a source keeps whether it is a thread, as its first version said",
      document:
        "The Brain refused it: a source keeps whether it is a thread, as its first version said",
      threadAgain: "added",
    });
  });

  it("never judges a memory of a source kept whole", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = `instructions:test:${crypto.randomUUID()}`;
    const name = unique("Acme");
    const line = `${name} prefers mail`;
    const { version: first } = await shared().addInstructions({
      source,
      change: crypto.randomUUID(),
      text: `${line}.`,
      access: audience(group),
    });
    const { memory, entity } = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    await shared().addInstructions({
      source,
      change: crypto.randomUUID(),
      text: "Nothing about mail.",
      access: audience(group),
    });

    await expect(endOf(entity, memory, reader)).resolves.toBeNull();
  });
});

describe("what the store keeps of it", () => {
  it("lets go of a memory's rows with the memory when its source is erased, and the store enforces that", async () => {
    const group = unique("g");
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}. Also ${name} is big.`, group);
    const out = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    const held = await memoryOn(
      { source, version: first, quote: `${name} is big`, group },
      { entity: out.entity }
    );
    await version(source, `${name} is big.`, group);
    const memories = [out.memory, held.memory];
    const before = {
      outs: await rowsOf("memory_outs", memories),
      ins: await rowsOf("memory_ins", memories),
    };
    await shared().eraseSource({ source, reason: "deleted" });
    // The source's versions hidden whole at once, its current one with them.
    const visible = await runInDurableObject(
      shared(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT count(*) AS count FROM source_versions
            WHERE source = ? AND row NOT IN (SELECT version_row FROM erasing_versions)`,
            source
          )
          .one().count
    );
    for (let round = 0; round < 5; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the tick deletes what the erasure hid
      await tick();
    }
    const foreignKeys = await runInDurableObject(
      shared(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ foreign_keys: number }>("PRAGMA foreign_keys")
          .one().foreign_keys
    );

    expect({
      before,
      visible,
      outs: await rowsOf("memory_outs", memories),
      orphans: await runInDurableObject(
        shared(),
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT count(*) AS count FROM memory_outs
              WHERE memory NOT IN (SELECT row FROM memories)`
            )
            .one().count +
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT count(*) AS count FROM memory_ins
              WHERE memory NOT IN (SELECT row FROM memories)`
            )
            .one().count
      ),
      foreignKeys,
    }).toStrictEqual({
      before: { outs: 1, ins: 1 },
      visible: 0,
      outs: 0,
      orphans: 0,
      foreignKeys: 1,
    });
  });

  it("counts no source's out memories once the word rules change, until a version judges it by the new ones", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}.`, group);
    const { memory, entity } = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    await version(source, "Paid in cash.", group);
    const out = await endOf(entity, memory, reader);
    // A rebuild to other rules than the store's (words.ts `reindexWords`),
    // as a release with new rules starts one.
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE word_index SET version = 0, target = 0, cursor = 0, memory_cursor = 0 WHERE id = 1"
      );
    });
    await tick();
    const afterRules = await endOf(entity, memory, reader);
    const third = await version(source, "Paid in cash, still.", group);

    expect({
      out: typeof out === "number",
      afterRules,
      judgedAgain: await endOf(entity, memory, reader),
    }).toStrictEqual({
      out: true,
      afterRules: null,
      judgedAgain: await addedAt(source, third, reader),
    });
  });
});

describe("what judging against the current version rests on", () => {
  // Main's rules (memories.ts `visibleSql`; erasure.ts hides a source
  // whole): whoever may see a memory of a source may read its current
  // version, and that version is never hidden alone. The second is pinned
  // with the erasure above; a change to either reopens quotes.ts's design.
  it("shows a memory only to a reader of its source's current version", async () => {
    const wide = unique("wide");
    const narrow = unique("narrow");
    const wideOnly = readerOf(wide);
    const both = readerOf(wide, narrow);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}.`, wide);
    const { memory, entity } = await memoryOn(
      { source, version: first, quote: line, group: wide },
      { name }
    );
    await version(source, `${line}, narrowed.`, narrow);
    const readable = async (reader: PersonReader) =>
      await shared().readableMemories({ memories: [memory], reader });

    expect({
      wideOnly: await endOf(entity, memory, wideOnly),
      wideOnlyReadable: await readable(wideOnly),
      both: await endOf(entity, memory, both),
    }).toStrictEqual({ wideOnly: "unread", wideOnlyReadable: [], both: null });
  });
});

/** How many memories about `entity` `reader` reads as current, page by page. */
const currentCount = async (
  entity: string,
  reader: PersonReader
): Promise<number> => {
  let count = 0;
  let after: MemoriesCursor | undefined;
  for (let pages = 0; pages < 100; pages += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const page = await shared().readMemories({
      entity,
      reader,
      ...(after === undefined ? {} : { after }),
    });
    count += page.memories.length;
    if (page.next === undefined) {
      return count;
    }
    after = page.next;
  }
  throw new Error("More pages than a test makes");
};

/** A text of about `bytes`, its sentences of its own words, each holding `tag`. */
const largeText = (tag: string, bytes: number): string => {
  const sentences: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const sentence = `${tag} clause ${index} holds ${tag}x${index} and pays on time`;
    sentences.push(sentence);
    size += sentence.length + 2;
  }
  return sentences.join(". ");
};

describe("late adds and large sources", () => {
  it("judges one add citing several large sources, each against its own current text", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const sources = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const source = unique(`doc${index}`);
        const tag = unique("t");
        const first = await version(source, largeText(tag, 990_000), group);
        // Kept: the clause 1 line; dropped: clause 0's.
        await version(
          source,
          largeText(tag, 990_000).replace(`${tag} clause 0 holds`, "gone"),
          group
        );
        return { source, tag, first };
      })
    );
    const name = unique("Acme");
    const added = await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [{ key: "c", kind: "customer", names: [name] }],
      memories: sources.flatMap(({ source, tag, first }) =>
        [0, 1].map((clause): NewMemory => ({
          about: "c",
          type: "fact",
          statement: `${name} ${source} clause ${clause}.`,
          speaker: { kind: "outside" },
          basis: {
            kind: "source",
            source,
            version: first,
            quote: `${tag} clause ${clause} holds`,
          },
        }))
      ),
    });
    const entity = added.entities.c ?? "";
    const states = await Promise.all(
      added.memories.map(async (memory) =>
        (await endOf(entity, memory, reader)) === null ? "current" : "ended"
      )
    );

    expect(states).toStrictEqual(sources.flatMap(() => ["ended", "current"]));
  }, 120_000);

  it("lands a late memory as out when its source's current file is gone, and brings it back when a later version says it", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const name = unique("Acme");
    const line = `${name} pays by card`;
    const first = await version(source, `${line}.`, group);
    const second = await version(source, `${line}, monthly.`, group);
    const file = await runInDurableObject(
      shared(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ file: string }>(
            "SELECT file FROM source_versions WHERE source = ? AND version = ?",
            source,
            second
          )
          .one().file
    );
    await env.BRAIN_OBJECTS.delete(fileKeyOf(file));
    const late = await memoryOn(
      { source, version: first, quote: line, group },
      { name }
    );
    const lost = await endOf(late.entity, late.memory, reader);
    await version(source, `${line}, yearly.`, group);

    expect({
      lost: typeof lost === "number",
      back: await endOf(late.entity, late.memory, reader),
    }).toStrictEqual({ lost: true, back: null });
  });

  it("reads a memory ended alike whether or not memories of others rest on a version it can't read", async () => {
    const a = unique("a");
    const b = unique("b");
    const reader = readerOf(a);
    const side = async (hidden: boolean) => {
      const source = unique("doc");
      const name = unique("Acme");
      const line = `${name} pays by card`;
      const first = await version(source, `${line}. ${unique("x")}`, a);
      const { memory, entity } = await memoryOn(
        { source, version: first, quote: line, group: a },
        { name }
      );
      if (hidden) {
        const narrow = await version(source, `${line}. ${unique("y")}`, b);
        for (let index = 0; index < 3; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one add at a time
          await memoryOn(
            { source, version: narrow, quote: line, group: b },
            { name: unique("Other") },
            { statement: `${line} ${index}.` }
          );
        }
      }
      await version(source, `Paid in cash. ${unique("z")}`, a);
      return (await endOf(entity, memory, reader)) === null
        ? "current"
        : "ended";
    };

    expect({ real: await side(true), twin: await side(false) }).toStrictEqual({
      real: "ended",
      twin: "ended",
    });
  });

  it("keeps a source with many memories judged across many adds", async () => {
    const group = unique("g");
    const reader = readerOf(group);
    const source = unique("doc");
    const tag = unique("t");
    const name = unique("Acme");
    const sentences = Array.from(
      { length: 600 },
      (_, index) => `${tag} clause ${index} holds ${tag}x${index}`
    );
    const first = await version(source, sentences.join(". "), group);
    let entity: string | undefined;
    const memories: string[] = [];
    for (let start = 0; start < 600; start += 100) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      const added = await shared().addMemories({
        change: crypto.randomUUID(),
        access: audience(group),
        entities: [
          entity === undefined
            ? { key: "c", kind: "customer", names: [name] }
            : { key: "c", id: entity, kind: "customer" },
        ],
        memories: Array.from({ length: 100 }, (_, offset) => ({
          about: "c",
          type: "fact" as const,
          statement: `${name} fact ${start + offset}.`,
          speaker: { kind: "outside" as const },
          basis: {
            kind: "source" as const,
            source,
            version: first,
            quote: sentences[start + offset] ?? "",
          },
        })),
      });
      entity ??= added.entities.c;
      memories.push(...added.memories);
    }
    // Each version drops a hundred more sentences.
    const kept: number[] = [];
    for (let dropped = 100; dropped <= 300; dropped += 100) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await version(source, sentences.slice(dropped).join(". "), group);
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      kept.push(await currentCount(entity ?? "", reader));
    }

    expect(kept).toStrictEqual([500, 400, 300]);
  }, 120_000);
});

/** The rule from scratch: the folded words, one space apart. */
const holdsRun = (text: string, quote: string): boolean => {
  const run = sequenceOf(quote).join(" ");
  return run !== "" && ` ${sequenceOf(text).join(" ")} `.includes(` ${run} `);
};

/** A thousand words "z", the `capital`th written "Z". */
const quoteOf = (capital: number): string =>
  Array.from({ length: 1000 }, (_, at) => (at === capital ? "Z" : "z")).join(
    " "
  );

describe("matching a quote against a text", () => {
  it("finds exactly the runs of words a text holds, whatever their case and form", () => {
    let state = 7;
    const random = (): number => {
      state = (state * 48_271) % 2_147_483_647;
      return state / 2_147_483_647;
    };
    const words = ["a", "B", "c", "ä", "Ab", "b"];
    const textOf = (length: number): string =>
      Array.from(
        { length },
        () => words[Math.floor(random() * words.length)] ?? ""
      ).join(random() < 0.5 ? " " : ", ");
    const differ: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const text = textOf(40);
      const index = quoteIndexOf(text);
      for (let asked = 0; asked < 10; asked += 1) {
        const quote = textOf(1 + Math.floor(random() * 5));
        if (index.holds(quote) !== holdsRun(text, quote)) {
          differ.push(`${text} / ${quote}`);
        }
      }
    }

    expect(differ).toStrictEqual([]);
  });

  it("checks a quote in steps linear in the text's and the quote's words, and a quote that folds alike once", () => {
    // 999 words of one kind, then one of another, again and again: each
    // place of the quote's word starts a near match.
    const segment = `${"z ".repeat(999)}q `;
    const text = segment.repeat(200);
    const textWords = 200 * 1000;
    const index = quoteIndexOf(text);
    const first = index.holds(quoteOf(0));
    const afterFirst = index.steps();
    const again = Array.from({ length: 50 }, (_, capital) =>
      index.holds(quoteOf(capital + 1))
    );

    expect({
      first,
      again: again.every((held) => !held),
      linear: afterFirst <= 2 * (textWords + 1000),
      foldedOnce: index.steps() === afterFirst,
      held: index.holds("z z q Z"),
    }).toStrictEqual({
      first: false,
      again: true,
      linear: true,
      foldedOnce: true,
      held: true,
    });
  });
});
