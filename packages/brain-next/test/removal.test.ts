// Removal (removal.ts, GRA-1877): a source taken out of use for good with
// its history kept. From its threat model on the issue: once removed,
// nothing of it, or drawn from it, is found, listed or read by any
// reader, exactly as a source no one added; its rows stay; its key is
// closed, a retry of an earlier change and an add whose file was being
// written as it was removed included, and nothing new is drawn from it;
// an export holds it removed and a restore brings it back so; an erasure
// after takes it for good.
import { removedSource } from "@grasp-os/brain-next/contract";
import type {
  Access,
  PersonReader,
  SourceVersionRef,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { exportSettled, restoredAfterLoss, tick } from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

/** A word no other test's sources hold, without a digit. */
const word = (): string =>
  `w${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 10)}`;

/** Waits until `open` says so, at most 10 s. */
const until = async (open: () => boolean, what: string): Promise<void> => {
  for (let look = 0; !open(); look += 1) {
    if (look === 500) {
      throw new Error(`Waited 10 s for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until it opens
    await scheduler.wait(20);
  }
};

/** What `call` answered, or its error's message. */
const outcome = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await call();
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * A team's source with two versions, a memory drawn from each about a
 * customer only it names, its readers and words: what each test removes.
 */
const teamSource = async () => {
  const group = `team:${crypto.randomUUID()}`;
  const access: Access = { kind: "audience", group };
  const reader: PersonReader = { person: crypto.randomUUID(), groups: [group] };
  const source = `test:${crypto.randomUUID()}`;
  const [first, second, customer] = [word(), word(), word()];
  const changes = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, text] of [first, second].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- versions in order
    await shared().addSource({
      source,
      change: changes[index] ?? "",
      text: `Minutes ${text}`,
      access,
    });
  }
  const drawn = await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities: [{ key: "c", kind: "customer", names: [`Client ${customer}`] }],
    memories: [1, 2].map((version) => ({
      about: "c",
      type: "fact" as const,
      statement: `Client ${customer} signed ${version}`,
      speaker: { kind: "system" as const },
      basis: { kind: "source" as const, source, version, quote: "Minutes" },
    })),
  });
  return {
    access,
    reader,
    source,
    changes,
    words: [first, second, customer],
    entity: drawn.entities.c ?? "",
  };
};

/**
 * Every read `reader` makes of `source`, its words and the customer
 * `entity` drawn from it: each read's answer, the source's key and the
 * entity's id named alike, so a source no one added answers the same.
 */
const readsOf = async (
  {
    source,
    words,
    entity,
  }: { source: string; words: string[]; entity: string },
  reader: PersonReader
): Promise<string> => {
  const question = words.join(" ");
  const answers = {
    versions: await Promise.all(
      [1, 2].map(
        async (version) =>
          await shared().readVersion({ source, version, reader })
      )
    ),
    current: await shared().readCurrent({ sources: [source], reader }),
    history: await shared().listVersions({ source, reader }),
    readable: await shared().readableVersions({
      versions: [1, 2].map((version) => ({ source, version })),
      reader,
    }),
    listed: await shared().listSources({ reader, prefixes: [source] }),
    recalled: await shared().recall({
      question,
      reader,
      budget: { tokens: 2000 },
    }),
    memories: await shared().readMemories({ entity, reader, history: true }),
    names: await shared().readEntityNames({ entity, reader }),
    byName: await shared().findEntities({
      reader,
      name: `Client ${words[2]}`,
    }),
  };
  return JSON.stringify(answers)
    .replaceAll(source, "<source>")
    .replaceAll(entity, "<entity>")
    .replaceAll(/"at":\d+/gu, '"at":0');
};

/** How many rows of `source`'s the store keeps, of its versions and memories. */
const rowsOf = async (source: string) =>
  await runInDurableObject(shared(), (_store, state) =>
    state.storage.sql
      .exec<{ versions: number; memories: number; removed: number }>(
        `SELECT
          (SELECT count(*) FROM source_versions WHERE source = ?1) AS versions,
          (SELECT count(*) FROM memories WHERE source = ?1) AS memories,
          (SELECT count(*) FROM removed_sources WHERE source = ?1) AS removed`,
        source
      )
      .one()
  );

describe("removing a source and keeping its history", () => {
  /** The shared store before any test of this file added to it. */
  let empty: Copy;

  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it("answers every read of a removed source, its history and what was drawn from it as one no one added, and keeps its rows", async () => {
    const removing = await teamSource();
    const missing = {
      source: `test:${crypto.randomUUID()}`,
      words: removing.words,
      entity: crypto.randomUUID(),
    };
    const before = await readsOf(removing, removing.reader);
    const overviewBefore = await shared().workOverview();
    await shared().removeSources({ sources: [removing.source] });
    await shared().removeSources({ sources: [removing.source] });
    await tick(shared());
    const overviewAfter = await shared().workOverview();

    expect({
      // Before, it was read: none of this holds by chance.
      before: before === (await readsOf(missing, removing.reader)),
      after: await readsOf(removing, removing.reader),
      key: await shared().keyState(removing.source),
      rows: await rowsOf(removing.source),
      // A removal is no anomaly: no source without a current version more.
      withoutCurrent:
        overviewAfter.sourcesWithoutCurrent -
        overviewBefore.sourcesWithoutCurrent,
    }).toStrictEqual({
      before: false,
      after: await readsOf(missing, removing.reader),
      key: "held",
      rows: { versions: 2, memories: 2, removed: 1 },
      withoutCurrent: 0,
    });
  });

  it("answers each of mixed keys removed in one call as it answers that key removed alone", async () => {
    /**
     * One of each kind of key: one no one added, one removed before, one
     * erased before, one in use, which the call names twice.
     */
    const kinds = async () => {
      const removedBefore = await teamSource();
      await shared().removeSources({ sources: [removedBefore.source] });
      const erasedBefore = await teamSource();
      await shared().eraseSource({
        source: erasedBefore.source,
        reason: "deleted",
      });
      return {
        unknown: `test:${crypto.randomUUID()}`,
        removed: removedBefore.source,
        erased: erasedBefore.source,
        live: await teamSource(),
      };
    };
    /** What the store has of each key of `keys`, and reads of the one in use. */
    const stateOf = async (keys: Awaited<ReturnType<typeof kinds>>) => {
      const named = {
        unknown: keys.unknown,
        removed: keys.removed,
        erased: keys.erased,
        live: keys.live.source,
      };
      const each: Record<string, unknown> = {};
      for (const [kind, source] of Object.entries(named)) {
        each[kind] = {
          // oxlint-disable-next-line no-await-in-loop -- one key after another
          key: await shared().keyState(source),
          // oxlint-disable-next-line no-await-in-loop -- one key after another
          rows: await rowsOf(source),
        };
      }
      // Its own words named alike, so each set's answer is comparable.
      let liveReads = await readsOf(keys.live, keys.live.reader);
      for (const [index, said] of keys.live.words.entries()) {
        liveReads = liveReads.replaceAll(said, `<word ${index}>`);
      }
      return { ...each, liveReads };
    };
    const [together, alone] = [await kinds(), await kinds()];

    const answered = await outcome(async () => {
      await shared().removeSources({
        sources: [
          together.unknown,
          together.removed,
          together.erased,
          together.live.source,
          together.live.source,
        ],
      });
    });
    for (const source of [
      alone.unknown,
      alone.removed,
      alone.erased,
      alone.live.source,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one key a call
      await shared().removeSources({ sources: [source] });
    }
    await tick(shared());

    expect({ answered, state: await stateOf(together) }).toStrictEqual({
      answered: undefined,
      state: await stateOf(alone),
    });
  });

  it("refuses every add to a removed key, a retry of an earlier change and an add whose file was being written as it was removed included, and draws nothing from it", async () => {
    const removing = await teamSource();
    const { source, access } = removing;
    // A new add's file write, held until released.
    const write = { held: false, released: false };
    await runInDurableObject(shared(), (instance) => {
      const real = env.BRAIN_OBJECTS;
      Reflect.set(instance, "env", {
        ...env,
        BRAIN_OBJECTS: {
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
            write.held = true;
            await until(() => write.released, "the test to release the write");
            Reflect.set(instance, "env", env);
            return await real.put(key, value, options);
          },
        },
      });
    });
    const racing = outcome(
      async () =>
        await shared().addSource({
          source,
          change: crypto.randomUUID(),
          text: `Minutes ${word()}`,
          access,
        })
    );
    await until(() => write.held, "the add to write its file");
    await shared().removeSources({ sources: [source] });
    write.released = true;
    const raced = await racing;
    const added = async (change: string) =>
      await outcome(
        async () =>
          await shared().addSource({
            source,
            change,
            text: `Minutes ${removing.words[0]}`,
            access,
          })
      );
    const drawn = async (version: number) =>
      await outcome(
        async () =>
          await shared().addMemories({
            change: crypto.randomUUID(),
            access,
            entities: [{ key: "c", kind: "customer", names: ["Plain"] }],
            memories: [
              {
                about: "c",
                type: "fact",
                statement: "Plain",
                speaker: { kind: "system" },
                basis: { kind: "source", source, version, quote: "Minutes" },
              },
            ],
          })
      );
    const never = `test:${crypto.randomUUID()}`;
    const drawnFromNothing = await outcome(
      async () =>
        await shared().addMemories({
          change: crypto.randomUUID(),
          access,
          entities: [{ key: "c", kind: "customer", names: ["Plain"] }],
          memories: [
            {
              about: "c",
              type: "fact",
              statement: "Plain",
              speaker: { kind: "system" },
              basis: { kind: "source", source: never, version: 1, quote: "M" },
            },
          ],
        })
    );

    expect({
      raced,
      retried: await added(removing.changes[0] ?? ""),
      fresh: await added(crypto.randomUUID()),
      drawn: await drawn(1),
      rows: await rowsOf(source),
    }).toStrictEqual({
      raced: { refused: removedSource },
      retried: { refused: removedSource },
      fresh: { refused: removedSource },
      // Refused as a version the store doesn't hold.
      drawn: drawnFromNothing,
      rows: { versions: 2, memories: 2, removed: 1 },
    });
  });

  it("keeps a removed source and a writer's erasure apart through the company's export: the source comes back removed, its memories kept and hidden, the writer's memories stay erased, and erasing the source after takes its memories", async () => {
    await restore(shared(), empty);
    const removing = await teamSource();
    const writer = `writer-${crypto.randomUUID()}`;
    const said = word();
    // A writer's memory about the same customer, then that writer erased.
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: removing.access,
      entities: [{ key: "c", kind: "customer", id: removing.entity }],
      memories: [
        {
          about: "c",
          type: "fact",
          statement: `Client said ${said}`,
          speaker: { kind: "system" },
          basis: { kind: "writer", writer },
        },
      ],
    });
    const writerErased = await shared().eraseWriter({
      writer,
      reason: "deleted",
      change: crypto.randomUUID(),
    });
    await shared().removeSources({ sources: [removing.source] });
    await tick(shared());
    const { id } = await shared().startExport("test");
    const exported = await exportSettled(shared, id);
    const restored = await restoredAfterLoss(shared, id, empty);
    const writerMemories = async () =>
      await runInDurableObject(
        shared(),
        (_store, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM memories WHERE writer = ?",
              writer
            )
            .one().count
      );
    const afterRestore = {
      rows: await rowsOf(removing.source),
      writerMemories: await writerMemories(),
      memories: await shared().readMemories({
        entity: removing.entity,
        reader: removing.reader,
        history: true,
      }),
    };
    await shared().eraseSource({ source: removing.source, reason: "deleted" });
    await tick(shared());

    expect({
      writerErased: writerErased.memories,
      exported,
      restored,
      afterRestore: {
        ...afterRestore,
        memories: afterRestore.memories.memories.map(
          ({ statement }) => statement
        ),
      },
      erased: await rowsOf(removing.source),
    }).toStrictEqual({
      // The writer's one memory was there, and its erasure took it.
      writerErased: 1,
      exported: "done",
      restored: "done",
      afterRestore: {
        // Its versions, its memories and its mark, as before the export.
        rows: { versions: 2, memories: 2, removed: 1 },
        writerMemories: 0,
        // Read by no one: hidden as the removed source is.
        memories: [],
      },
      erased: { versions: 0, memories: 0, removed: 0 },
    });
  });

  it("brings a removed source back removed from the company's export, and erases it for good after", async () => {
    await restore(shared(), empty);
    const removing = await teamSource();
    const missing = {
      source: `test:${crypto.randomUUID()}`,
      words: removing.words,
      entity: crypto.randomUUID(),
    };
    await shared().removeSources({ sources: [removing.source] });
    const { id } = await shared().startExport("test");
    const exported = await exportSettled(shared, id);
    const restored = await restoredAfterLoss(shared, id, empty);
    const afterRestore = {
      reads: await readsOf(removing, removing.reader),
      key: await shared().keyState(removing.source),
      rows: await rowsOf(removing.source),
      added: await outcome(
        async () =>
          await shared().addSource({
            source: removing.source,
            change: crypto.randomUUID(),
            text: `Minutes ${word()}`,
            access: removing.access,
          })
      ),
    };
    await shared().eraseSource({ source: removing.source, reason: "deleted" });
    await tick(shared());
    const ref: SourceVersionRef = { source: removing.source, version: 1 };

    expect({
      exported,
      restored,
      afterRestore,
      erased: {
        key: await shared().keyState(removing.source),
        rows: await rowsOf(removing.source),
        readable: await shared().readableVersions({
          versions: [ref],
          reader: removing.reader,
        }),
      },
    }).toStrictEqual({
      exported: "done",
      restored: "done",
      afterRestore: {
        reads: await readsOf(missing, removing.reader),
        key: "held",
        // Every version and memory, the mark with them.
        rows: { versions: 2, memories: 2, removed: 1 },
        added: { refused: removedSource },
      },
      erased: {
        key: "erased",
        rows: { versions: 0, memories: 0, removed: 0 },
        readable: [],
      },
    });
  });
});
