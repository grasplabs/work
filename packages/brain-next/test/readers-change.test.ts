import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { filesPrefix } from "../src/files.ts";

// A source given other readers (store.ts `changeReaders`, GRA-1761): a new
// version with the current text, so what a producer narrows or takes away
// holds for everything the Brain answers at once, and the producer never
// reads back the text it takes away. Through the shared store's own calls.

const store = () => env.BRAIN_STORE.getByName("brain");

const unique = (): string => crypto.randomUUID();

/** Someone in `group` alone. */
const inGroup = (group: string): Reader => ({
  person: unique(),
  groups: [group],
});

/** The text `reader` gets as `source`'s current version, if any. */
const currentOf = async (
  source: string,
  reader: Reader
): Promise<string | null> => {
  const [current] = await store().readCurrent({ sources: [source], reader });
  return current?.text ?? null;
};

/** What `reader` gets of `source`: its current text, and its first version's. */
const readsOf = async (source: string, reader: Reader) => {
  const [current] = await store().readCurrent({ sources: [source], reader });
  const first = await store().readVersion({ source, version: 1, reader });
  return { current: current?.text ?? null, first: first?.text ?? null };
};

/** A source added for `access` with `text`: its key. */
const added = async (access: Access, text: string): Promise<string> => {
  const source = `test:${unique()}`;
  await store().addSource({ source, change: unique(), text, access });
  return source;
};

/**
 * Has the shared store read its bucket through one that holds the first
 * read of a version's file until the test releases it: an add can then
 * land while `changeReaders` reads the text. Undone by `restore`.
 */
const holdFirstRead = async () => {
  const real = env.BRAIN_OBJECTS;
  const released = Promise.withResolvers<boolean>();
  const reading = Promise.withResolvers<boolean>();
  let held = false;
  const bucket: Pick<R2Bucket, "get" | "head" | "put" | "delete" | "list"> = {
    get: async (key: string) => {
      if (!held && key.startsWith(filesPrefix)) {
        held = true;
        const object = await real.get(key);
        reading.resolve(true);
        await released.promise;
        return object;
      }
      return await real.get(key);
    },
    head: async (key: string) => await real.head(key),
    put: async (key, value, options) => await real.put(key, value, options),
    delete: async (keys) => {
      await real.delete(keys);
    },
    list: async (options) => await real.list(options),
  };
  await runInDurableObject(store(), (instance) => {
    Reflect.set(instance, "env", { ...env, BRAIN_OBJECTS: bucket });
  });
  return {
    reading: reading.promise,
    release: () => {
      released.resolve(true);
    },
    restore: async () => {
      await runInDurableObject(store(), (instance) => {
        Reflect.set(instance, "env", env);
      });
    },
  };
};

describe("giving a source other readers", () => {
  it("takes it from those taken off at once, its history included, and keeps its text for the rest", async () => {
    const [kept, taken] = [`group:${unique()}`, `group:${unique()}`];
    const source = await added(
      { kind: "readers", groups: [kept, taken] },
      "Quarterly plan for the warehouse"
    );

    const changed = await store().changeReaders({
      source,
      change: unique(),
      access: { kind: "readers", groups: [kept] },
    });

    expect({
      changed,
      kept: await readsOf(source, inGroup(kept)),
      taken: await readsOf(source, inGroup(taken)),
    }).toStrictEqual({
      changed: { source, version: 2 },
      kept: {
        current: "Quarterly plan for the warehouse",
        first: "Quarterly plan for the warehouse",
      },
      taken: { current: null, first: null },
    });
  });

  it("answers a repeat with the version it made, refuses that change with other readers, and writes nothing for readers it has", async () => {
    const [one, two] = [`group:${unique()}`, `group:${unique()}`];
    const source = await added(
      { kind: "readers", groups: [one, two] },
      "Supplier contract"
    );
    const change = unique();
    const narrowed: Access = { kind: "readers", groups: [one] };
    const first = await store().changeReaders({
      source,
      change,
      access: narrowed,
    });
    // A later version, then the first change again: the version it made.
    await store().addSource({
      source,
      change: unique(),
      text: "Supplier contract, signed",
      access: narrowed,
    });
    const again = await store().changeReaders({
      source,
      change,
      access: narrowed,
    });
    const otherReaders = await store()
      .changeReaders({ source, change, access: { kind: "none" } })
      .then(
        () => "changed",
        (error: unknown) => (error instanceof Error ? error.message : "")
      );
    const same = await store().changeReaders({
      source,
      change: unique(),
      access: narrowed,
    });

    expect({
      first,
      again,
      otherReaders,
      same,
      never: await store().changeReaders({
        source: `test:${unique()}`,
        change: unique(),
        access: narrowed,
      }),
      current: await currentOf(source, inGroup(one)),
    }).toStrictEqual({
      first: { source, version: 2 },
      again: { source, version: 2 },
      otherReaders:
        "The Brain refused it: this change was added before with other text or readers",
      same: { source, version: 3 },
      never: null,
      current: "Supplier contract, signed",
    });
  });

  it("never undoes an add that lands while it reads the text", async () => {
    const [one, two] = [`group:${unique()}`, `group:${unique()}`];
    const both: Access = { kind: "readers", groups: [one, two] };
    const source = await added(both, "Draft offer");
    const hold = await holdFirstRead();
    try {
      const changing = store().changeReaders({
        source,
        change: unique(),
        access: { kind: "readers", groups: [one] },
      });
      await hold.reading;
      await store().addSource({
        source,
        change: unique(),
        text: "Final offer",
        access: both,
      });
      hold.release();

      expect({
        changed: await changing,
        one: await currentOf(source, inGroup(one)),
        two: await currentOf(source, inGroup(two)),
      }).toStrictEqual({
        changed: { source, version: 3 },
        one: "Final offer",
        two: null,
      });
    } finally {
      hold.release();
      await hold.restore();
    }
  });

  it("is refused for one person alone in the shared store, as an add is", async () => {
    const source = await added(
      { kind: "audience", group: `group:${unique()}` },
      "Team notes"
    );

    await expect(
      store()
        .changeReaders({
          source,
          change: unique(),
          access: { kind: "owner", person: unique() },
        })
        .then(
          () => "changed",
          (error: unknown) => (error instanceof Error ? error.message : "")
        )
    ).resolves.toBe(
      "The Brain refused it: what only one person may read is kept in that person's own store"
    );
  });

  it("keeps a list of 250 readers, each of whom reads it", async () => {
    const groups = Array.from({ length: 250 }, () => `group:${unique()}`);
    const source = await added(
      { kind: "readers", groups },
      "Company handbook for every reader"
    );

    expect({
      first: await currentOf(source, inGroup(groups[0] ?? "")),
      last: await currentOf(source, inGroup(groups.at(-1) ?? "")),
      outsider: await currentOf(source, inGroup(`group:${unique()}`)),
    }).toStrictEqual({
      first: "Company handbook for every reader",
      last: "Company handbook for every reader",
      outsider: null,
    });
  });

  it("refuses an older list once a newer one confirmed the readers it has", async () => {
    const [alice, bob] = [`group:${unique()}`, `group:${unique()}`];
    const source = `test:${unique()}`;
    await store().addSource({
      source,
      change: unique(),
      text: "Board pack",
      access: { kind: "readers", groups: [alice] },
      readAt: 1,
    });
    // Read again at 3: Alice alone, as before.
    const confirmed = await store().changeReaders({
      source,
      change: unique(),
      access: { kind: "readers", groups: [alice] },
      readAt: 3,
    });
    // Read at 2, arriving late: Alice and Bob.
    const late = await store().changeReaders({
      source,
      change: unique(),
      access: { kind: "readers", groups: [alice, bob] },
      readAt: 2,
    });

    expect({
      confirmed,
      late,
      bob: await currentOf(source, inGroup(bob)),
    }).toStrictEqual({
      confirmed: { source, version: 1 },
      late: { source, version: 1, newer: true },
      bob: null,
    });
  });

  it("takes a newer narrowing over an older widening, whichever arrives first", async () => {
    const [alice, bob] = [`group:${unique()}`, `group:${unique()}`];
    const both: Access = { kind: "readers", groups: [alice, bob] };
    const narrowed: Access = { kind: "readers", groups: [alice] };
    const inOrder = `test:${unique()}`;
    const reversed = `test:${unique()}`;
    for (const source of [inOrder, reversed]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await store().addSource({
        source,
        change: unique(),
        text: "Pricing sheet",
        access: narrowed,
        readAt: 1,
      });
    }
    // The widening read at 2, then the narrowing read at 3.
    await store().changeReaders({
      source: inOrder,
      change: unique(),
      access: both,
      readAt: 2,
    });
    await store().changeReaders({
      source: inOrder,
      change: unique(),
      access: narrowed,
      readAt: 3,
    });
    // The narrowing first, then the widening arriving late.
    await store().changeReaders({
      source: reversed,
      change: unique(),
      access: narrowed,
      readAt: 3,
    });
    const late = await store().changeReaders({
      source: reversed,
      change: unique(),
      access: both,
      readAt: 2,
    });

    expect({
      late: late?.newer ?? false,
      inOrder: await currentOf(inOrder, inGroup(bob)),
      reversed: await currentOf(reversed, inGroup(bob)),
      alice: await currentOf(reversed, inGroup(alice)),
    }).toStrictEqual({
      late: true,
      inOrder: null,
      reversed: null,
      alice: "Pricing sheet",
    });
  });
});
