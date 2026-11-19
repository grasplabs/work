// A memory its writer says replaces earlier ones of theirs (contract.ts
// `NewMemory.replaces`, GRA-2184, threat model on the issue), through the
// store's own methods: each one it names ends from its start, kept as
// history, for a reader who may read it; retired, it ends nothing, so the
// one it replaced is current again. Only the writer's own memories, about
// the same entity and readable by the add's reader, may be named; anything
// else is refused, writing nothing, alike for one there isn't. The ways it
// can fail, tried here: ending what sits beside it, another writer's
// memory, one the reader can't read; a reader told of a memory they can't
// read; a repeat that replaces twice; a chain undone; an erasure that
// can't delete what a link holds; an export that loses the links.
import type {
  Access,
  Memory,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { audience, readerOf, shared, unique } from "./entity-helpers.ts";
import { exportSettled, restoredAfterLoss, tick } from "./export-reads.ts";
import { copyOf } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

/** How every refusal of a replacement reads. */
const refusal = /replaces a memory it may not name/u;

/** A requirement of the customer, in `writer`'s word, replacing `replaces`. */
const requirement = (
  statement: string,
  writer: string,
  replaces?: string[]
): NewMemory => ({
  about: "c",
  attribute: "requirement",
  value: statement,
  type: "fact",
  statement,
  speaker: { kind: "system" },
  basis: { kind: "writer", writer },
  ...(replaces === undefined ? {} : { replaces }),
});

/** A customer of its own, its readers, and a writer and a reader of it. */
const setUp = () => {
  const group = unique("g");
  return {
    group,
    access: audience(group),
    reader: readerOf(unique("p"), group),
    writer: `app:${crypto.randomUUID()}`,
    customer: { key: "c", kind: "customer" as const, names: [unique("Acme")] },
  };
};

/** Adds one memory, `memory`, about the customer of `entity` (or a new one): its id and the entity's. */
const add = async (
  {
    access,
    customer,
  }: { access: Access; customer: ReturnType<typeof setUp>["customer"] },
  memory: NewMemory,
  {
    entity,
    reader,
    change,
  }: { entity?: string; reader?: Reader; change?: string } = {}
) => {
  const added = await shared().addMemories({
    change: change ?? crypto.randomUUID(),
    access,
    entities: [
      entity === undefined
        ? customer
        : { key: "c", kind: "customer", id: entity },
    ],
    memories: [memory],
    ...(reader === undefined ? {} : { reader }),
  });
  return { memory: added.memories[0] ?? "", entity: added.entities.c ?? "" };
};

/** What `reader` reads of `entity`: the current statements, and each memory's end. */
const readOf = async (entity: string, reader: Reader) => {
  const [current, all] = await Promise.all([
    shared().readMemories({ entity, reader }),
    shared().readMemories({ entity, reader, history: true }),
  ]);
  return {
    current: current.memories.map(({ statement }) => statement).toSorted(),
    ended: Object.fromEntries(
      all.memories.map(({ statement, endedAt }: Memory) => [statement, endedAt])
    ),
  };
};

/** The current statements `reader` reads of `entity`. */
const currentOf = async (entity: string, reader: Reader): Promise<string[]> => {
  const { current } = await readOf(entity, reader);
  return current;
};

describe("a memory that replaces earlier ones of its writer", () => {
  /** The shared store before any test of this file added to it: empty. */
  let empty: Copy = { tables: [], others: [] };
  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it("ends each one it names from its start, kept as history, and nothing that sits beside them", async () => {
    const at = setUp();
    const pizza = await add(at, requirement("pizza", at.writer));
    await add(at, requirement("pasta", at.writer), { entity: pizza.entity });
    const sushi = await add(
      at,
      requirement("sushi", at.writer, [pizza.memory]),
      { entity: pizza.entity, reader: at.reader }
    );
    // Added beside, naming nothing: ends nothing.
    await add(at, requirement("ramen", at.writer), { entity: pizza.entity });
    const read = await readOf(pizza.entity, at.reader);
    const { memories } = await shared().readMemories({
      entity: pizza.entity,
      reader: at.reader,
    });
    const sushiStart = memories.find(
      ({ id }) => id === sushi.memory
    )?.learnedAt;

    expect(read).toStrictEqual({
      current: ["pasta", "ramen", "sushi"],
      ended: { pizza: sushiStart, pasta: null, sushi: null, ramen: null },
    });
  });

  it("brings what it replaced back once it is retired, link by link along a chain", async () => {
    const at = setUp();
    const first = await add(at, requirement("first", at.writer));
    const options = { entity: first.entity, reader: at.reader };
    const second = await add(
      at,
      requirement("second", at.writer, [first.memory]),
      options
    );
    const third = await add(
      at,
      requirement("third", at.writer, [second.memory]),
      options
    );
    const retire = async (memory: string) =>
      await shared().retireMemory({
        memory,
        reader: at.reader,
        writer: at.writer,
        change: `undo:${memory}`,
      });
    const reads = [await currentOf(first.entity, at.reader)];
    await retire(third.memory);
    reads.push(await currentOf(first.entity, at.reader));
    await retire(second.memory);
    reads.push(await currentOf(first.entity, at.reader));

    expect(reads).toStrictEqual([["third"], ["second"], ["first"]]);
  });

  it("refuses, writing nothing, to replace another writer's memory, one about another entity, one the reader can't read, one there isn't, or any without a reader", async () => {
    const at = setUp();
    const mine = await add(at, requirement("mine", at.writer));
    const theirs = await add(
      at,
      requirement("theirs", `app:${crypto.randomUUID()}`),
      {
        entity: mine.entity,
      }
    );
    const elsewhere = await add(
      { ...at, customer: { ...at.customer, names: [unique("Other")] } },
      requirement("elsewhere", at.writer)
    );
    // Readers the add's reader isn't among.
    const hidden = await add(
      { ...at, access: audience(unique("g")) },
      requirement("hidden", at.writer),
      { entity: mine.entity, reader: at.reader }
    );
    const asked: [string, string[], Reader | undefined][] = [
      ["another writer's", [theirs.memory], at.reader],
      ["another entity's", [elsewhere.memory], at.reader],
      ["unreadable", [hidden.memory], at.reader],
      ["none there", [crypto.randomUUID()], at.reader],
      ["one of them not", [mine.memory, crypto.randomUUID()], at.reader],
      ["no reader", [mine.memory], undefined],
    ];
    const outcomes: Record<string, string> = {};
    for (const [name, replaces, reader] of asked) {
      const change = crypto.randomUUID();
      // oxlint-disable-next-line no-await-in-loop -- one add after another
      outcomes[name] = await add(
        at,
        requirement(`new ${name}`, at.writer, replaces),
        {
          entity: mine.entity,
          change,
          ...(reader === undefined ? {} : { reader }),
        }
      ).then(
        () => "added",
        (error: unknown) =>
          error instanceof Error && refusal.test(error.message)
            ? "refused"
            : String(error)
      );
      // Nothing of it was kept, its change included: the change is free.
      // oxlint-disable-next-line no-await-in-loop -- one add after another
      await add(at, requirement(`retried ${name}`, at.writer), {
        entity: mine.entity,
        change,
      });
    }
    const read = await readOf(mine.entity, at.reader);

    expect({
      outcomes,
      current: read.current.filter(
        (statement) => !statement.startsWith("retried")
      ),
    }).toStrictEqual({
      outcomes: Object.fromEntries(asked.map(([name]) => [name, "refused"])),
      current: ["mine", "theirs"],
    });
  });

  it("is never named by a memory drawn from a source", async () => {
    const at = setUp();
    await expect(
      (async () => {
        await shared().addMemories({
          change: crypto.randomUUID(),
          access: at.access,
          entities: [at.customer],
          memories: [
            {
              ...requirement("drawn", at.writer, [crypto.randomUUID()]),
              basis: {
                kind: "source",
                source: "upload:x",
                version: 1,
                quote: "drawn",
              },
            },
          ],
          reader: at.reader,
        });
      })()
    ).rejects.toThrow("Only a writer's memory replaces memories");
  });

  it("ends nothing for a reader who can't read the newer memory, as a store without it would tell", async () => {
    const at = setUp();
    const narrow = unique("g");
    const both = readerOf(unique("p"), at.group, narrow);
    const outside = readerOf(unique("p"), at.group);
    const old = await add(at, requirement("old", at.writer));
    await add(
      { ...at, access: audience(narrow) },
      requirement("new", at.writer, [old.memory]),
      { entity: old.entity, reader: both }
    );

    expect({
      both: await currentOf(old.entity, both),
      outside: await readOf(old.entity, outside),
    }).toStrictEqual({
      both: ["new"],
      outside: { current: ["old"], ended: { old: null } },
    });
  });

  it("answers a repeat of its change with what it added, replacing once, and refuses the change naming others", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const other = await add(at, requirement("other", at.writer), {
      entity: old.entity,
    });
    const change = crypto.randomUUID();
    const options = { entity: old.entity, reader: at.reader, change };
    const first = await add(
      at,
      requirement("new", at.writer, [old.memory]),
      options
    );
    const again = await add(
      at,
      requirement("new", at.writer, [old.memory]),
      options
    );
    const read = await readOf(old.entity, at.reader);

    await expect(
      add(at, requirement("new", at.writer, [other.memory]), options)
    ).rejects.toThrow("was added before with other memories");
    expect({ again, current: read.current }).toStrictEqual({
      again: first,
      current: ["new", "other"],
    });
  });

  it("brings the replaced memory back when a person's erasure hides the one in their word that replaced it", async () => {
    const at = setUp();
    const person = unique("person");
    const old = await add(at, requirement("old", at.writer));
    await add(
      at,
      {
        ...requirement("theirs", at.writer, [old.memory]),
        speaker: { kind: "internal", person },
      },
      { entity: old.entity, reader: at.reader }
    );
    const before = await currentOf(old.entity, at.reader);
    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });

    expect({
      before,
      after: await currentOf(old.entity, at.reader),
    }).toStrictEqual({
      before: ["theirs"],
      after: ["old"],
    });
  });

  it("deletes memories that replaced one another with their writer's erasure", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const options = { entity: old.entity, reader: at.reader };
    const middle = await add(
      at,
      requirement("middle", at.writer, [old.memory]),
      options
    );
    await add(at, requirement("new", at.writer, [middle.memory]), options);
    await shared().eraseWriter({
      writer: at.writer,
      reason: "deleted",
      change: "reset",
    });
    await tick(shared());
    const held = await runInDurableObject(shared(), (_instance, state) =>
      state.storage.sql
        .exec<{ memories: number }>(
          "SELECT count(*) AS memories FROM memories WHERE writer = ?",
          at.writer
        )
        .one()
    );

    expect(held).toStrictEqual({ memories: 0 });
  });

  it("takes back what it replaced with it when its writer takes it back", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const replacing = await add(
      at,
      requirement("new", at.writer, [old.memory]),
      { entity: old.entity, reader: at.reader }
    );
    await shared().retireWritten({
      memory: replacing.memory,
      writer: at.writer,
      change: "taken back",
    });

    await expect(currentOf(old.entity, at.reader)).resolves.toStrictEqual([]);
  });

  it("takes back what a chain ends when its writer takes back the last of it, also one that ends the next by its attribute", async () => {
    const at = setUp();
    const first = await add(at, requirement("first", at.writer));
    const options = { entity: first.entity, reader: at.reader };
    const second = await add(
      at,
      requirement("second", at.writer, [first.memory]),
      options
    );
    const third = await add(
      at,
      requirement("third", at.writer, [second.memory]),
      options
    );
    // A status twice, the second ending the first by its attribute alone,
    // then a requirement that replaces the second.
    const status = (statement: string): NewMemory => ({
      ...requirement(statement, at.writer),
      attribute: "status",
    });
    await add(at, status("older"), options);
    const newer = await add(at, status("newer"), options);
    const last = await add(
      at,
      requirement("last", at.writer, [newer.memory]),
      options
    );
    const before = await currentOf(first.entity, at.reader);
    for (const memory of [third.memory, last.memory]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await shared().retireWritten({
        memory,
        writer: at.writer,
        change: `taken back ${memory}`,
      });
    }

    expect({
      before,
      after: await currentOf(first.entity, at.reader),
    }).toStrictEqual({ before: ["last", "third"], after: [] });
  });

  it("keeps what a memory replaced ended when that memory is forgotten after it was itself replaced, for a reader of what replaced it", async () => {
    const at = setUp();
    const narrow = unique("g");
    const both = readerOf(unique("p"), at.group, narrow);
    const first = await add(at, requirement("first", at.writer));
    const second = await add(
      at,
      requirement("second", at.writer, [first.memory]),
      { entity: first.entity, reader: at.reader }
    );
    // Only readers of `narrow` may read what replaced the second.
    await add(
      { ...at, access: audience(narrow) },
      requirement("third", at.writer, [second.memory]),
      { entity: first.entity, reader: both }
    );
    // Forgotten as history, from the Memories page.
    await shared().retireMemory({
      memory: second.memory,
      reader: both,
      writer: at.writer,
      change: "forget second",
    });

    expect({
      both: await currentOf(first.entity, both),
      // Without the third, the second was forgotten while current.
      outside: await currentOf(first.entity, at.reader),
    }).toStrictEqual({ both: ["third"], outside: ["first"] });
  });

  it("keeps a chain ended when each memory of it is forgotten after the next replaced it", async () => {
    const at = setUp();
    const options = (entity: string) => ({ entity, reader: at.reader });
    const first = await add(at, requirement("first", at.writer));
    const second = await add(
      at,
      requirement("second", at.writer, [first.memory]),
      options(first.entity)
    );
    const third = await add(
      at,
      requirement("third", at.writer, [second.memory]),
      options(first.entity)
    );
    await add(
      at,
      requirement("fourth", at.writer, [third.memory]),
      options(first.entity)
    );
    // The third, then the second, forgotten as history.
    for (const memory of [third.memory, second.memory]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await shared().retireMemory({
        memory,
        reader: at.reader,
        writer: at.writer,
        change: `forget ${memory}`,
      });
    }

    await expect(currentOf(first.entity, at.reader)).resolves.toStrictEqual([
      "fourth",
    ]);
  });

  describe("through an export", () => {
    it("is restored with what it replaces, and still brings it back once retired", async () => {
      const at = setUp();
      const old = await add(at, requirement("old", at.writer));
      const replacing = await add(
        at,
        requirement("new", at.writer, [old.memory]),
        { entity: old.entity, reader: at.reader }
      );
      const { id } = await shared().startExport("test");
      await expect(exportSettled(shared, id)).resolves.toBe("done");

      await expect(restoredAfterLoss(shared, id, empty)).resolves.toBe("done");
      const restored = await currentOf(old.entity, at.reader);
      await shared().retireMemory({
        memory: replacing.memory,
        reader: at.reader,
        writer: at.writer,
        change: "undo",
      });

      expect({
        restored,
        undone: await currentOf(old.entity, at.reader),
      }).toStrictEqual({ restored: ["new"], undone: ["old"] });
    });
  });
});
