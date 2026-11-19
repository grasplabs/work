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
import { z } from "zod";

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

/** A memory's line of an export, as far as these tests read it. */
const memoryLineSchema = z.looseObject({
  kind: z.literal("memory"),
  id: z.string(),
  replaces: z
    .array(z.object({ memory: z.string(), undoneAt: z.int().nullable() }))
    .optional(),
});

/** Every line of the done export `id`'s parts, parsed. */
const linesOf = async (id: string): Promise<unknown[]> => {
  const status = await shared().exportStatus({ id });
  const lines: unknown[] = [];
  for (const file of status?.files ?? []) {
    if (file !== "manifest.json") {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      const body = await shared().exportFile({ id, file });
      lines.push(
        ...(body ?? "")
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line))
      );
    }
  }
  return lines;
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

/**
 * Holds every delete of memories back while `held`, so what an erasure
 * hides stays stored, hidden, as while its tick hasn't deleted it yet.
 */
const holdDeletes = async (held: boolean): Promise<void> => {
  await runInDurableObject(shared(), (_instance, state) => {
    state.storage.sql.exec(
      held
        ? `CREATE TRIGGER IF NOT EXISTS test_hold_deletes BEFORE DELETE ON memories BEGIN
            SELECT RAISE(ABORT, 'held by the test');
          END`
        : "DROP TRIGGER IF EXISTS test_hold_deletes"
    );
  });
};

/** A memory of the customer's in `person`'s word, which their erasure will hide; and one the reader sees. */
const inTheirWord = async (at: ReturnType<typeof setUp>, person: string) => {
  const theirs = await add(at, {
    ...requirement("theirs", at.writer),
    speaker: { kind: "internal", person },
  });
  const kept = await add(at, requirement("kept", at.writer), {
    entity: theirs.entity,
  });
  return { theirs, kept };
};

/** Erases `person` from the shared store, its deletes held: what it hides stays stored. */
const hiddenByErasure = async (person: string): Promise<void> => {
  await holdDeletes(true);
  try {
    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });
  } catch {
    // A delete the trigger held: what it hid stays hidden.
  }
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

  it("brings what a save replaced back once the save is undone, link by link along a chain", async () => {
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
        undo: true,
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

  it("refuses a replacement it may not make with the same answer whether or not an erasure would leave its memory out", async () => {
    /** An add drawn from a source, with a writer's memory about the person of `email` replacing nothing there is. */
    const asked = async (email: string) => {
      const at = setUp();
      const source = `test:${crypto.randomUUID()}`;
      await shared().addSource({
        source,
        change: crypto.randomUUID(),
        text: "drawn",
        access: at.access,
      });
      return await shared()
        .addMemories({
          change: crypto.randomUUID(),
          access: at.access,
          entities: [
            {
              key: "c",
              kind: "person",
              identifiers: [{ type: "email", value: email }],
            },
          ],
          memories: [
            {
              about: "c",
              type: "fact",
              statement: "Leads sales",
              speaker: { kind: "system" },
              basis: { kind: "writer", writer: at.writer },
              replaces: [crypto.randomUUID()],
            },
          ],
          extracted: { source, version: 1 },
        })
        .then(
          () => "added",
          (error: unknown) => (error instanceof Error ? error.message : "")
        );
    };
    const kept = `kept-${unique("p")}@example.test`;
    const erased = `erased-${unique("p")}@example.test`;
    await shared().erasePersonShared({
      person: unique("person"),
      identifiers: [{ type: "email", value: erased }],
      reason: "person_erased",
    });
    const answers = { kept: await asked(kept), erased: await asked(erased) };

    expect({
      same: answers.kept === answers.erased,
      refused: refusal.test(answers.kept),
    }).toStrictEqual({ same: true, refused: true });
  });

  it("refuses a replacement whose memory names its entity by a name, not by its id", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));

    // The same customer by name, as a later add would find it.
    await expect(
      add(at, requirement("new", at.writer, [old.memory]), {
        reader: at.reader,
      })
    ).rejects.toThrow(refusal);
  });

  it("refuses a replacement it may not make with the same answer whether or not its speaker was erased", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const erased = unique("person");
    await shared().erasePersonShared({
      person: erased,
      identifiers: [],
      reason: "person_erased",
    });
    const asked = async (person: string) =>
      await add(
        at,
        {
          ...requirement("new", at.writer, [crypto.randomUUID()]),
          speaker: { kind: "internal", person },
        },
        { entity: old.entity, reader: at.reader }
      ).then(
        () => "added",
        (error: unknown) => (error instanceof Error ? error.message : "")
      );
    const answers = {
      kept: await asked(unique("person")),
      erased: await asked(erased),
    };

    expect({
      same: answers.kept === answers.erased,
      refused: refusal.test(answers.kept),
    }).toStrictEqual({ same: true, refused: true });
  });

  it("writes no replacement of a memory an erasure leaves out of the add, and ends nothing", async () => {
    /** A drawn add whose memory about a customer, relating it to the person of `email`, replaces one there: what is current after. */
    const after = async (email: string) => {
      const at = setUp();
      const old = await add(at, requirement("old", at.writer));
      const source = `test:${crypto.randomUUID()}`;
      await shared().addSource({
        source,
        change: crypto.randomUUID(),
        text: "drawn",
        access: at.access,
      });
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: at.access,
        entities: [
          { key: "c", kind: "customer", id: old.entity },
          {
            key: "p",
            kind: "person",
            identifiers: [{ type: "email", value: email }],
          },
        ],
        memories: [
          {
            about: "c",
            attribute: "contact",
            object: "p",
            type: "fact",
            statement: "Their contact",
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: at.writer },
            replaces: [old.memory],
          },
        ],
        extracted: { source, version: 1 },
        reader: at.reader,
      });
      return await currentOf(old.entity, at.reader);
    };
    const erased = `erased-${unique("p")}@example.test`;
    await shared().erasePersonShared({
      person: unique("person"),
      identifiers: [{ type: "email", value: erased }],
      reason: "person_erased",
    });

    expect({
      kept: await after(`kept-${unique("p")}@example.test`),
      erased: await after(erased),
    }).toStrictEqual({ kept: ["Their contact"], erased: ["old"] });
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

  it("refuses to replace a memory of other readers, also one the add's reader may read", async () => {
    const at = setUp();
    const other = unique("g");
    const both = readerOf(unique("p"), at.group, other);
    const mine = await add(at, requirement("mine", at.writer));
    // The reader of the add may read it: only its readers differ.
    const elsewhere = await add(
      { ...at, access: audience(other) },
      requirement("elsewhere", at.writer),
      { entity: mine.entity, reader: both }
    );

    await expect(
      add(at, requirement("new", at.writer, [elsewhere.memory]), {
        entity: mine.entity,
        reader: both,
      })
    ).rejects.toThrow(refusal);
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

  it("reads as if a memory a person's erasure takes never was: what only it replaced is current again", async () => {
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

  it("brings back what an erased memory replaced, which still ends the one before it by its attribute, with no moment that one is current", async () => {
    const at = setUp();
    const person = unique("person");
    const status = (statement: string): NewMemory => ({
      ...requirement(statement, at.writer),
      attribute: "status",
    });
    const first = await add(at, status("first"));
    const options = { entity: first.entity, reader: at.reader };
    const second = await add(at, status("second"), options);
    await add(
      at,
      {
        ...requirement("theirs", at.writer, [second.memory]),
        speaker: { kind: "internal", person },
      },
      options
    );
    const before = await currentOf(first.entity, at.reader);
    await hiddenByErasure(person);
    let hidden: string[] = [];
    try {
      hidden = await currentOf(first.entity, at.reader);
    } finally {
      await holdDeletes(false);
    }
    await tick(shared());

    expect({
      before,
      hidden,
      deleted: await currentOf(first.entity, at.reader),
    }).toStrictEqual({
      before: ["theirs"],
      hidden: ["second"],
      deleted: ["second"],
    });
  });

  it("brings back, after an erasure, what another memory still replaced once that one's save is undone", async () => {
    const at = setUp();
    const person = unique("person");
    const old = await add(at, requirement("old", at.writer));
    const options = { entity: old.entity, reader: at.reader };
    await add(
      at,
      {
        ...requirement("theirs", at.writer, [old.memory]),
        speaker: { kind: "internal", person },
      },
      options
    );
    const other = await add(
      at,
      requirement("other", at.writer, [old.memory]),
      options
    );
    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });
    // Still ended by the other, not retired: undoing the other brings it back.
    await shared().retireMemory({
      memory: other.memory,
      reader: at.reader,
      writer: at.writer,
      change: "undo other",
      undo: true,
    });

    await expect(currentOf(old.entity, at.reader)).resolves.toStrictEqual([
      "old",
    ]);
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

  it("brings back what a save replaced whenever the save is undone, and never when anything is forgotten", async () => {
    const at = setUp();
    const retire = async (memory: string, undo: boolean) =>
      await shared().retireMemory({
        memory,
        reader: at.reader,
        writer: at.writer,
        change: `retire ${memory}`,
        ...(undo ? { undo } : {}),
      });
    /** A chain first ← second ← third: the ids of each. */
    const chain = async () => {
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
      return { first, second, third };
    };
    // The second forgotten while the third replaced it: history.
    const history = await chain();
    await retire(history.second.memory, false);
    // The third forgotten while current, then the second: forgetting.
    const forgotten = await chain();
    await retire(forgotten.third.memory, false);
    await retire(forgotten.second.memory, false);
    // The third's save undone, then the second's, now current.
    const undone = await chain();
    await retire(undone.third.memory, true);
    await retire(undone.second.memory, true);
    // The second's save undone while the third replaces it: still undone.
    const late = await chain();
    await retire(late.second.memory, true);

    expect({
      history: await currentOf(history.first.entity, at.reader),
      forgotten: await currentOf(forgotten.first.entity, at.reader),
      undone: await currentOf(undone.first.entity, at.reader),
      late: await currentOf(late.first.entity, at.reader),
    }).toStrictEqual({
      history: ["third"],
      forgotten: [],
      undone: ["first"],
      late: ["first", "third"],
    });
  });

  it("keeps what a memory replaced ended when that memory is forgotten after its attribute's next value ended it", async () => {
    const at = setUp();
    const status = (statement: string, replaces?: string[]): NewMemory => ({
      ...requirement(statement, at.writer, replaces),
      attribute: "status",
    });
    const asked = await add(at, requirement("asked", at.writer));
    const options = { entity: asked.entity, reader: at.reader };
    const first = await add(at, status("first", [asked.memory]), options);
    await add(at, status("second"), options);
    await shared().retireMemory({
      memory: first.memory,
      reader: at.reader,
      writer: at.writer,
      change: "forget first",
    });

    await expect(currentOf(asked.entity, at.reader)).resolves.toStrictEqual([
      "second",
    ]);
  });

  it("reads a late undo, then the erasure of what replaced the undone memory, as a store without that memory would", async () => {
    const at = setUp();
    const person = unique("person");
    const first = await add(at, requirement("first", at.writer));
    const options = { entity: first.entity, reader: at.reader };
    const second = await add(
      at,
      requirement("second", at.writer, [first.memory]),
      options
    );
    await add(
      at,
      {
        ...requirement("third", at.writer, [second.memory]),
        speaker: { kind: "internal", person },
      },
      options
    );
    await shared().retireMemory({
      memory: second.memory,
      reader: at.reader,
      writer: at.writer,
      change: "late undo",
      undo: true,
    });
    const undone = await readOf(first.entity, at.reader);
    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });
    const erased = await readOf(first.entity, at.reader);

    expect({
      undone: undone.current,
      erased: erased.current,
      secondRetired: erased.ended.second !== null,
    }).toStrictEqual({
      undone: ["first", "third"],
      erased: ["first"],
      secondRetired: true,
    });
  });

  it("keeps a chain history when the last is taken back after the middle was forgotten, until an erasure takes the middle", async () => {
    const at = setUp();
    const person = unique("person");
    const first = await add(at, requirement("first", at.writer));
    const options = { entity: first.entity, reader: at.reader };
    const second = await add(
      at,
      {
        ...requirement("second", at.writer, [first.memory]),
        speaker: { kind: "internal", person },
      },
      options
    );
    const third = await add(
      at,
      requirement("third", at.writer, [second.memory]),
      options
    );
    await shared().retireMemory({
      memory: second.memory,
      reader: at.reader,
      writer: at.writer,
      change: "forget second",
    });
    await shared().retireWritten({
      memory: third.memory,
      writer: at.writer,
      change: "taken back",
    });
    const takenBack = await currentOf(first.entity, at.reader);
    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });

    expect({
      takenBack,
      // As if the second never was: nothing replaced the first.
      erased: await currentOf(first.entity, at.reader),
    }).toStrictEqual({ takenBack: [], erased: ["first"] });
  });

  it("ends what it names from its start on, as a newer memory of one value ends the one before, also once it expires", async () => {
    const at = setUp();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const dated = {
      validFrom: new Date(now + day),
      validUntil: new Date(now + 2 * day),
    };
    const status = (statement: string): NewMemory => ({
      ...requirement(statement, at.writer),
      attribute: "status",
    });
    const before = await add(at, status("before"));
    await add(at, { ...status("after"), ...dated }, { entity: before.entity });
    const old = await add(at, requirement("old", at.writer));
    await add(
      at,
      { ...requirement("new", at.writer, [old.memory]), ...dated },
      { entity: old.entity, reader: at.reader }
    );
    /** What is current about `entity` at each moment: before, during and after the dates. */
    const over = async (entity: string) =>
      await Promise.all(
        [Date.now() + 1000, now + day + 1000, now + 3 * day].map(
          async (moment) => {
            const { memories } = await shared().readMemories({
              entity,
              reader: at.reader,
              asOf: new Date(moment),
            });
            return memories.map(({ statement }) => statement);
          }
        )
      );

    expect({
      oneValue: await over(before.entity),
      replaced: await over(old.entity),
    }).toStrictEqual({
      oneValue: [["before"], ["after"], []],
      replaced: [["old"], ["new"], []],
    });
  });

  it("undoes a save that was forgotten before, keeping its first retirement and its first undo", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const replacing = await add(
      at,
      requirement("new", at.writer, [old.memory]),
      {
        entity: old.entity,
        reader: at.reader,
      }
    );
    const retire = async (change: string, undo: boolean) =>
      await shared().retireMemory({
        memory: replacing.memory,
        reader: at.reader,
        writer: at.writer,
        change,
        ...(undo ? { undo } : {}),
      });
    const forgotten = await retire("forget", false);
    const forgottenRead = await currentOf(old.entity, at.reader);
    const undone = await retire("undo", true);
    // When the first undo had landed: the next read's moment.
    const { memories: atFirstUndo } = await shared().readMemories({
      entity: old.entity,
      reader: at.reader,
    });
    const firstUndoAt = new Date(Date.now());
    await retire("undo again", true);
    const { memories: asOfFirst } = await shared().readMemories({
      entity: old.entity,
      reader: at.reader,
      asOf: firstUndoAt,
    });

    expect({
      forgottenRead,
      undone,
      atFirstUndo: atFirstUndo.map(({ statement }) => statement),
      asOfFirst: asOfFirst.map(({ statement }) => statement),
    }).toStrictEqual({
      forgottenRead: [],
      // Told the retirement as recorded: the forget's.
      undone: forgotten,
      atFirstUndo: ["old"],
      // The second undo stamped nothing: the first's time stands.
      asOfFirst: ["old"],
    });
  });

  it("undoes a save whatever its dates, while a forget keeps to them", async () => {
    const at = setUp();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const saved = async (dates: Partial<NewMemory>) => {
      const old = await add(at, requirement("old", at.writer));
      const replacing = await add(
        at,
        { ...requirement("new", at.writer, [old.memory]), ...dates },
        { entity: old.entity, reader: at.reader }
      );
      return { old, replacing };
    };
    const retire = async (memory: string, undo: boolean) =>
      await shared().retireMemory({
        memory,
        reader: at.reader,
        writer: at.writer,
        change: `retire ${memory}`,
        ...(undo ? { undo } : {}),
      });
    /** What is current about `entity` now and the day after tomorrow. */
    const nowAndLater = async (entity: string) =>
      await Promise.all(
        [Date.now() + 1000, now + 2 * day + 1000].map(async (moment) => {
          const { memories } = await shared().readMemories({
            entity,
            reader: at.reader,
            asOf: new Date(moment),
          });
          return memories.map(({ statement }) => statement);
        })
      );
    const tomorrow = { validFrom: new Date(now + day) };
    const expired = {
      validFrom: new Date(now - 2 * day),
      validUntil: new Date(now - day),
    };
    const futureUndone = await saved(tomorrow);
    const expiredUndone = await saved(expired);
    const futureForgotten = await saved(tomorrow);
    const expiredForgotten = await saved(expired);
    const outcomes = {
      futureUndone:
        (await retire(futureUndone.replacing.memory, true)) !== null,
      expiredUndone:
        (await retire(expiredUndone.replacing.memory, true)) !== null,
      futureForgotten: await retire(futureForgotten.replacing.memory, false),
      expiredForgotten: await retire(expiredForgotten.replacing.memory, false),
    };

    expect({
      outcomes,
      futureUndone: await nowAndLater(futureUndone.old.entity),
      expiredUndone: await nowAndLater(expiredUndone.old.entity),
      futureForgotten: await nowAndLater(futureForgotten.old.entity),
      expiredForgotten: await nowAndLater(expiredForgotten.old.entity),
    }).toStrictEqual({
      outcomes: {
        futureUndone: true,
        expiredUndone: true,
        futureForgotten: null,
        expiredForgotten: null,
      },
      futureUndone: [["old"], ["old"]],
      expiredUndone: [["old"], ["old"]],
      // As on main: outside its dates, a forget retires nothing.
      futureForgotten: [["old"], ["new"]],
      expiredForgotten: [[], []],
    });
  });

  it("keeps reads of a moment before an undo as they were, the undo stamped once however often it is repeated", async () => {
    const at = setUp();
    const old = await add(at, requirement("old", at.writer));
    const replacing = await add(
      at,
      requirement("new", at.writer, [old.memory]),
      {
        entity: old.entity,
        reader: at.reader,
      }
    );
    const undo = async () =>
      await shared().retireMemory({
        memory: replacing.memory,
        reader: at.reader,
        writer: at.writer,
        change: "undo",
        undo: true,
      });
    const undone = await undo();
    const again = await undo();
    const at_ = undone?.retiredAt ?? new Date();
    const asOf = async (moment: Date) => {
      const { memories } = await shared().readMemories({
        entity: old.entity,
        reader: at.reader,
        asOf: moment,
      });
      return memories.map(({ statement }) => statement).toSorted();
    };

    expect({
      again: again?.retiredAt.getTime() === at_.getTime(),
      before: await asOf(new Date(at_.getTime() - 1)),
      after: await asOf(at_),
    }).toStrictEqual({ again: true, before: ["new"], after: ["old"] });
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

  it("refuses to replace a memory an erasure hides, before its tick deletes it", async () => {
    const at = setUp();
    const person = unique("person");
    const { theirs } = await inTheirWord(at, person);
    await hiddenByErasure(person);
    try {
      await expect(
        add(at, requirement("new", at.writer, [theirs.memory]), {
          entity: theirs.entity,
          reader: at.reader,
        })
      ).rejects.toThrow(refusal);
    } finally {
      await holdDeletes(false);
    }
  });

  describe("through an export", () => {
    it("names on a memory's line only what it replaced that the export holds", async () => {
      const at = setUp();
      const person = unique("person");
      const { theirs, kept } = await inTheirWord(at, person);
      const replacing = await add(
        at,
        requirement("new", at.writer, [theirs.memory, kept.memory]),
        { entity: theirs.entity, reader: at.reader }
      );
      await hiddenByErasure(person);
      let lines: unknown[] = [];
      try {
        const { id } = await shared().startExport("test");
        await expect(exportSettled(shared, id)).resolves.toBe("done");
        lines = await linesOf(id);
      } finally {
        await holdDeletes(false);
      }
      const memoryLines = lines.flatMap((line) => {
        const parsed = memoryLineSchema.safeParse(line);
        return parsed.success ? [parsed.data] : [];
      });
      const lineOf = (memory: string) =>
        memoryLines.find(({ id }) => id === memory);

      expect({
        theirs: lineOf(theirs.memory),
        replaces: lineOf(replacing.memory)?.replaces,
      }).toStrictEqual({
        theirs: undefined,
        replaces: [{ memory: kept.memory, undoneAt: null }],
      });
    });

    it("holds a replacement undone after the export started as standing, and one undone before with its time", async () => {
      const at = setUp();
      const old = await add(at, requirement("old", at.writer));
      const options = { entity: old.entity, reader: at.reader };
      const early = await add(
        at,
        requirement("early", at.writer, [old.memory]),
        options
      );
      const undoneEarly = await shared().retireMemory({
        memory: early.memory,
        reader: at.reader,
        writer: at.writer,
        change: "undo early",
        undo: true,
      });
      const late = await add(
        at,
        requirement("late", at.writer, [old.memory]),
        options
      );
      const { id } = await shared().startExport("test");
      // Undone once the export started, before its parts are written.
      await shared().retireMemory({
        memory: late.memory,
        reader: at.reader,
        writer: at.writer,
        change: "undo late",
        undo: true,
      });
      await expect(exportSettled(shared, id)).resolves.toBe("done");
      const lines = await linesOf(id);
      const memoryLines = lines.flatMap((line) => {
        const parsed = memoryLineSchema.safeParse(line);
        return parsed.success ? [parsed.data] : [];
      });
      const replacesOf = (memory: string) =>
        memoryLines.find((line) => line.id === memory)?.replaces;

      expect({
        early: replacesOf(early.memory),
        late: replacesOf(late.memory),
      }).toStrictEqual({
        early: [
          {
            memory: old.memory,
            undoneAt: undoneEarly?.retiredAt.getTime() ?? 0,
          },
        ],
        late: [{ memory: old.memory, undoneAt: null }],
      });
    });

    it("is restored with its undo, so what it replaced stays current", async () => {
      const at = setUp();
      const old = await add(at, requirement("old", at.writer));
      const replacing = await add(
        at,
        requirement("new", at.writer, [old.memory]),
        {
          entity: old.entity,
          reader: at.reader,
        }
      );
      await shared().retireMemory({
        memory: replacing.memory,
        reader: at.reader,
        writer: at.writer,
        change: "undo",
        undo: true,
      });
      const { id } = await shared().startExport("test");
      await expect(exportSettled(shared, id)).resolves.toBe("done");

      await expect(restoredAfterLoss(shared, id, empty)).resolves.toBe("done");
      await expect(currentOf(old.entity, at.reader)).resolves.toStrictEqual([
        "old",
      ]);
    });

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
        undo: true,
      });

      expect({
        restored,
        undone: await currentOf(old.entity, at.reader),
      }).toStrictEqual({ restored: ["new"], undone: ["old"] });
    });
  });
});
