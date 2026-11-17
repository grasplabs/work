// What a version of a source changed (contract.ts `readVersionChange`,
// memories.ts), through the store's own methods. The threat model is on
// GRA-1991. Every test has its own people, groups, sources and entities,
// so what other tests left in the shared store is hidden from it.
import type {
  Access,
  ChangedMemory,
  NewEntity,
  NewMemory,
  Reader,
  VersionChange,
  VersionChangeCursor,
} from "@grasp-os/brain-next/contract";
import { describe, expect, it } from "vite-plus/test";

import { audience, readerOf, shared, unique } from "./entity-helpers.ts";

/** A version of a source in the shared store, readable as `access` says. */
const addVersion = async (
  source: string,
  text: string,
  access: Access
): Promise<{ source: string; version: number }> =>
  await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access,
  });

/** A customer entity of an add, under `key`: the one at `id` when given. */
const customer = (
  key: string,
  name: string,
  extra: Partial<NewEntity> = {}
): NewEntity => ({ key, kind: "customer", names: [name], ...extra });

/** A memory about `about` drawn from `doc`, quoting `quote`. */
const drawn = (
  about: string,
  doc: { source: string; version: number },
  quote: string,
  statement: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "system" },
  basis: { kind: "source", ...doc, quote },
  ...extra,
});

/** Adds `memories` about `entities` to the shared store, readable as `access` says. */
const remember = async (
  access: Access,
  entities: NewEntity[],
  memories: NewMemory[]
) =>
  await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities,
    memories,
  });

/** Marks `version` fully extracted for `group`'s readers, as extraction marks its last piece. */
const markExtracted = async (
  version: { source: string; version: number },
  group: string
): Promise<void> => {
  await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(group),
    entities: [],
    memories: [],
    extracted: version,
  });
};

/** What a change came to for a reader, by statements and names, in no order of its own. */
interface Seen {
  added: string[];
  ended: string[];
  /** No longer in the source's text, nothing having replaced them. */
  out: string[];
  /** Each added memory that stands contested, with its rivals' statements. */
  contested: Record<string, string[]>;
  /** Each entity named, by its name, and whether this version made it seen. */
  entities: Record<string, boolean>;
  pages: number;
}

/** Every page of the change of `doc`, as `reader`, `limit` at a time; null when the store answers none. */
const pagesOf = async (
  doc: { source: string; version: number },
  reader: Reader,
  limit?: number
): Promise<VersionChange[] | null> => {
  const pages: VersionChange[] = [];
  let after: VersionChangeCursor | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page goes on from the one before
    const page = await shared().readVersionChange({
      ...doc,
      reader,
      ...(limit === undefined ? {} : { limit }),
      ...(after === undefined ? {} : { after }),
    });
    if (page === null) {
      return null;
    }
    pages.push(page);
    if (!page.more) {
      return pages;
    }
    after = page.next;
  }
};

/** `pages` as statements and names (`Seen`). */
const seenOf = (pages: readonly VersionChange[]): Seen => {
  const memories = pages.flatMap((page) => page.memories);
  const statements = (part: ChangedMemory["part"]) =>
    memories
      .filter((each) => each.part === part)
      .map(({ memory }) => memory.statement)
      .toSorted();
  return {
    added: statements("added"),
    ended: statements("ended"),
    out: statements("out"),
    contested: Object.fromEntries(
      memories
        .filter(({ part, memory }) => part === "added" && memory.contested)
        .map(({ memory, rivals }) => [
          memory.statement,
          rivals.map(({ statement }) => statement).toSorted(),
        ])
    ),
    entities: Object.fromEntries(
      pages
        .flatMap((page) => page.entities)
        .map(({ name, firstSeen }) => [name ?? "", firstSeen])
    ),
    pages: pages.length,
  };
};

/** The change of `doc` as `reader` sees it, every page read. */
const changeOf = async (
  doc: { source: string; version: number },
  reader: Reader,
  limit?: number
): Promise<Seen | null> => {
  const pages = await pagesOf(doc, reader, limit);
  return pages === null ? null : seenOf(pages);
};

/** `seen` with the entities' names `acme` and `globex` as "Acme" and "Globex": two worlds compared. */
const named = (seen: Seen | null, acme: string, globex: string) =>
  seen === null
    ? null
    : {
        ...seen,
        entities: Object.fromEntries(
          Object.entries(seen.entities).map(([name, first]) => [
            name.replace(acme, "Acme").replace(globex, "Globex"),
            first,
          ])
        ),
      };

/** `pages` without the moment each was read at, which every write moves. */
const withoutMoments = (pages: VersionChange[] | null) =>
  pages?.map(({ memories, entities, more, next }) => ({
    memories,
    entities,
    more,
    next: next === undefined ? undefined : { ...next, at: null },
  }));

const v1Text = "Acme is Active. Acme renews in March.";
const v2Text = "Acme is Churning. Acme renews in March. Globex signed.";

/**
 * A document of two versions for `group`, as a company's: the first says
 * Acme is active and renews in March; the second that Acme is churning,
 * which another source the group reads says otherwise (Paused), and that
 * Globex, an entity nothing named before, signed. The entities' ids, and
 * each version.
 */
const twoVersions = async (
  group: string,
  names: { acme?: string; globex?: string; globexId?: string } = {},
  reader?: Reader
) => {
  const acmeName = names.acme ?? unique("Acme");
  const globexName = names.globex ?? unique("Globex");
  const source = unique("doc");
  const first = await addVersion(source, v1Text, audience(group));
  const { entities } = await remember(
    audience(group),
    [customer("c", acmeName)],
    [
      drawn("c", first, "Acme is Active", "Acme is active", {
        attribute: "status",
        value: "Active",
      }),
      drawn("c", first, "Acme renews in March", "Acme renews in March"),
    ]
  );
  const acme = entities.c ?? "";
  const other = await addVersion(
    unique("call"),
    "Acme is Paused",
    audience(group)
  );
  await remember(
    audience(group),
    [customer("c", acmeName, { id: acme })],
    [
      drawn("c", other, "Acme is Paused", "Acme is paused", {
        attribute: "status",
        value: "Paused",
      }),
    ]
  );
  const second = await addVersion(source, v2Text, audience(group));
  const added = await shared().addMemories({
    change: crypto.randomUUID(),
    access: audience(group),
    ...(reader === undefined ? {} : { reader }),
    entities: [
      customer("c", acmeName, { id: acme }),
      customer(
        "g",
        globexName,
        names.globexId === undefined ? {} : { id: names.globexId }
      ),
    ],
    memories: [
      drawn("c", second, "Acme is Churning", "Acme is churning", {
        attribute: "status",
        value: "Churning",
      }),
      drawn("g", second, "Globex signed", "Globex signed"),
    ],
  });
  return {
    acme,
    globex: added.entities.g ?? "",
    acmeName,
    globexName,
    first,
    second,
    other,
  };
};

describe("what a version changed", () => {
  // Threat 3, 4, 5: the second version's change: what it added, the
  // earlier memory it replaced, the fact it made contested and with what,
  // and the entity it made seen.
  it("shows what a document's second version added, ended and made contested", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    const reader = readerOf(unique("reader"), group);

    await expect(changeOf(doc.second, reader)).resolves.toStrictEqual({
      added: ["Acme is churning", "Globex signed"],
      ended: ["Acme is active"],
      out: [],
      contested: { "Acme is churning": ["Acme is paused"] },
      entities: { [doc.acmeName]: false, [doc.globexName]: true },
      pages: 1,
    });
    // The first version's change, read now: what it added, history since
    // (a fact the second ended contests nothing), and Acme first seen.
    await expect(changeOf(doc.first, reader)).resolves.toStrictEqual({
      added: ["Acme is active", "Acme renews in March"],
      ended: [],
      out: [],
      contested: {},
      entities: { [doc.acmeName]: true },
      pages: 1,
    });
  });

  // A memory that left only because the text no longer says it is
  // credited to no version: it is listed with the current version alone,
  // as no longer in the document, and moves on with each new version.
  it("lists what the current version's text no longer says as no longer in it, and on no older version", async () => {
    const group = unique("group");
    const source = unique("doc");
    const acme = unique("Acme");
    const reader = readerOf(unique("reader"), group);
    const first = await addVersion(
      source,
      "Acme is Active. Acme renews in March.",
      audience(group)
    );
    await remember(
      audience(group),
      [customer("c", acme)],
      [drawn("c", first, "Acme renews in March", "Acme renews in March")]
    );
    const second = await addVersion(source, "Acme is Active.", audience(group));
    const whileCurrent = await changeOf(second, reader);
    const third = await addVersion(
      source,
      "Acme is Active. A small edit.",
      audience(group)
    );

    expect({
      whileCurrent,
      second: await changeOf(second, reader),
      third: await changeOf(third, reader),
    }).toStrictEqual({
      whileCurrent: {
        added: [],
        ended: [],
        out: ["Acme renews in March"],
        contested: {},
        entities: { [acme]: false },
        pages: 1,
      },
      second: {
        added: [],
        ended: [],
        out: [],
        contested: {},
        entities: {},
        pages: 1,
      },
      third: {
        added: [],
        ended: [],
        out: ["Acme renews in March"],
        contested: {},
        entities: { [acme]: false },
        pages: 1,
      },
    });
  });

  it("credits a replaced memory to the version whose memory replaced it, however its text changed after", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    // The second version's text dropped "Acme is Active" too, and its own
    // memory replaced it: that is the second version's, never "no longer
    // in the document"; and a third that drops the renewal lists that.
    const third = await addVersion(
      doc.second.source,
      "Acme is Churning. Globex signed.",
      audience(group)
    );
    const reader = readerOf(unique("reader"), group);

    const [second, last] = await Promise.all([
      changeOf(doc.second, reader),
      changeOf(third, reader),
    ]);
    expect({
      second: { ended: second?.ended, out: second?.out },
      third: { ended: last?.ended, out: last?.out },
    }).toStrictEqual({
      second: { ended: ["Acme is active"], out: [] },
      third: { ended: [], out: ["Acme renews in March"] },
    });
  });

  it("ends every earlier memory with a version marked fully extracted", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(group),
      entities: [],
      memories: [],
      extracted: doc.second,
    });
    const reader = readerOf(unique("reader"), group);

    const seen = await changeOf(doc.second, reader);
    expect(seen?.ended).toStrictEqual([
      "Acme is active",
      "Acme renews in March",
    ]);
  });

  /**
   * A document of three versions, each marked fully extracted as
   * extraction marks its last piece: the first with a memory; the second's
   * mark for `secondFor`'s readers. The third, as `reader` sees its change.
   */
  const marked = async (group: string, secondFor: string, reader: Reader) => {
    const source = unique("doc");
    const text = "Acme renews in March.";
    const first = await addVersion(source, text, audience(group));
    await remember(
      audience(group),
      [customer("c", "Acme")],
      [drawn("c", first, "Acme renews in March", "Acme renews in March")]
    );
    const second = await addVersion(source, `${text} Second.`, audience(group));
    await markExtracted(second, secondFor);
    const third = await addVersion(source, `${text} Third.`, audience(group));
    await markExtracted(third, group);
    return {
      second: await changeOf(second, reader),
      third: await changeOf(third, reader),
    };
  };

  // A mark ends every earlier memory; the first mark the reader may read
  // that did is the one credited, and one they may not read is as absent.
  it("credits an earlier memory to the first mark the reader sees that ended it", async () => {
    const group = unique("group");
    const reader = readerOf(unique("reader"), group);
    const [seen, hidden] = await Promise.all([
      marked(group, group, reader),
      marked(group, unique("hidden"), reader),
    ]);

    expect({
      seen: [seen.second?.ended, seen.third?.ended],
      hidden: [hidden.second?.ended, hidden.third?.ended],
    }).toStrictEqual({
      seen: [["Acme renews in March"], []],
      hidden: [[], ["Acme renews in March"]],
    });
  });

  // A mark is a cutoff only for what it ended before this version did: an
  // earlier version marked fully extracted after this version's own memory
  // replaced something takes none of that from this version.
  it("keeps what this version replaced when an earlier version is marked fully extracted after it", async () => {
    const group = unique("group");
    const source = unique("doc");
    const reader = readerOf(unique("reader"), group);
    const text = "Acme is Active. Acme is Churning.";
    const first = await addVersion(source, text, audience(group));
    const { entities } = await remember(
      audience(group),
      [customer("c", "Acme")],
      [
        drawn("c", first, "Acme is Active", "Acme is active", {
          attribute: "status",
          value: "Active",
        }),
      ]
    );
    const second = await addVersion(source, `${text} Second.`, audience(group));
    const third = await addVersion(source, `${text} Third.`, audience(group));
    await remember(
      audience(group),
      [customer("c", "Acme", { id: entities.c ?? "" })],
      [
        drawn("c", third, "Acme is Churning", "Acme is churning", {
          attribute: "status",
          value: "Churning",
        }),
      ]
    );
    await markExtracted(second, group);

    const [replacedBySecond, replacedByThird] = await Promise.all([
      changeOf(second, reader),
      changeOf(third, reader),
    ]);
    expect({
      second: replacedBySecond?.ended,
      third: replacedByThird?.ended,
    }).toStrictEqual({ second: [], third: ["Acme is active"] });
  });

  // Threat 10: paged by the store's paging, nothing repeated or skipped.
  it("pages through what a version changed, one memory at a time", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    const reader = readerOf(unique("reader"), group);

    const whole = await changeOf(doc.second, reader);
    const paged = await changeOf(doc.second, reader, 1);
    expect(paged).toStrictEqual({ ...whole, pages: 3 });
    const pages = (await pagesOf(doc.second, reader, 1)) ?? [];
    const ids = pages.flatMap(({ memories }) =>
      memories.map(({ memory }) => memory.id)
    );
    expect(new Set(ids).size).toBe(ids.length);
    // What it added comes before what it ended.
    expect(
      pages.flatMap(({ memories }) => memories.map(({ part }) => part))
    ).toStrictEqual(["added", "added", "ended"]);
  });
});

describe("who reads what a version changed", () => {
  // Threat 1: a version they may not read answers as one nobody added.
  it("answers a version the reader may not read as one nobody added", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    const stranger = readerOf(unique("stranger"), unique("elsewhere"));

    await expect(changeOf(doc.second, stranger)).resolves.toBeNull();
    await expect(
      changeOf({ source: unique("nothing"), version: 1 }, stranger)
    ).resolves.toBeNull();
    await expect(
      changeOf({ ...doc.second, version: 9 }, readerOf("r", group))
    ).resolves.toBeNull();
  });

  // Threat 2, 3, 4, 5: the twin. A reader of only part of a document's
  // change gets what a store without the rest would give them: the same
  // items, rivals, entities, counts and pages. The rest is hidden memories
  // of the same version (another group's), one that would end an earlier
  // memory and one that would contest one, another group's earlier
  // mention of the entity the version made seen, and another group's
  // rival.
  it("gives a reader of part of a change exactly what a store without the rest gives", async () => {
    const group = unique("group");
    const hidden = unique("hidden");
    const plain = await twoVersions(group);
    const acmeName = unique("Acme");
    const globexName = unique("Globex");
    // Another group mentions Globex before the version does, by a source
    // of its own; the version's add, made for someone in both groups,
    // names that entity.
    const theirs = await addVersion(
      unique("theirs"),
      "Globex is a lead",
      audience(hidden)
    );
    const early = await remember(
      audience(hidden),
      [customer("g", globexName)],
      [drawn("g", theirs, "Globex is a lead", "Globex is a lead")]
    );
    const marked = await twoVersions(
      group,
      { acme: acmeName, globex: globexName, globexId: early.entities.g ?? "" },
      readerOf(unique("writer"), group, hidden)
    );
    expect(marked.globex).toBe(early.entities.g);
    const ofVersion = (key: string, name: string, id: string): NewEntity =>
      customer(key, name, { id });
    // Memories of the second version only `hidden` may read: one that
    // restates the first version's renewal (which would end it), and one
    // of another status (which would end the visible one and contest).
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(hidden),
      entities: [ofVersion("c", acmeName, marked.acme)],
      reader: readerOf(unique("writer"), hidden, group),
      memories: [
        drawn(
          "c",
          marked.second,
          "Acme renews in March",
          "Acme renews in March"
        ),
        drawn("c", marked.second, "Acme is Churning", "Acme is gone", {
          attribute: "status",
          value: "Gone",
        }),
      ],
    });
    // A rival only `hidden` may read.
    const call = await addVersion(
      unique("call"),
      "Acme is Closed",
      audience(hidden)
    );
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(hidden),
      entities: [ofVersion("c", acmeName, marked.acme)],
      reader: readerOf(unique("writer"), hidden, group),
      memories: [
        drawn("c", call, "Acme is Closed", "Acme is closed", {
          attribute: "status",
          value: "Closed",
        }),
      ],
    });
    const reader = readerOf(unique("reader"), group);

    for (const limit of [undefined, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- one reading at a time
      const [twin, partial] = await Promise.all([
        changeOf(plain.second, reader, limit),
        changeOf(marked.second, reader, limit),
      ]);
      expect(named(partial, acmeName, globexName)).toStrictEqual(
        named(twin, plain.acmeName, plain.globexName)
      );
    }
    // Who may read all of it sees the rest.
    const both = readerOf(unique("both"), group, hidden);
    const whole = await changeOf(marked.second, both);
    expect(whole?.added).toContain("Acme is gone");
    expect(whole?.entities[globexName]).toBeFalsy();
  });

  /**
   * A document whose first version says Acme is active, and whose version
   * `endsIn` says Acme is churning, which replaces it; each text keeps
   * every quote, so nothing leaves the text. With `hidden`, a memory only
   * that group may read says Acme is gone first: in a middle version only
   * it may read (`"middle"`), or in the same version, learned before the
   * churn (`"same"`). The version that replaces it, as `reader` sees its
   * change.
   */
  const replacedWith = async (
    group: string,
    hidden: { group: string; where: "middle" | "same" } | undefined,
    reader: Reader
  ) => {
    const source = unique("doc");
    const first = await addVersion(source, "Acme is Active.", audience(group));
    const { entities } = await remember(
      audience(group),
      [customer("c", "Acme")],
      [
        drawn("c", first, "Acme is Active", "Acme is active", {
          attribute: "status",
          value: "Active",
        }),
      ]
    );
    const acme = entities.c ?? "";
    const gone = async (doc: { source: string; version: number }) => {
      if (hidden === undefined) {
        return;
      }
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: audience(hidden.group),
        reader: readerOf(unique("writer"), hidden.group, group),
        entities: [customer("c", "Acme", { id: acme })],
        memories: [
          drawn("c", doc, "Acme is Gone", "Acme is gone", {
            attribute: "status",
            value: "Gone",
          }),
        ],
      });
    };
    if (hidden?.where === "middle") {
      await gone(
        await addVersion(
          source,
          "Acme is Active. Acme is Gone.",
          audience(hidden.group)
        )
      );
    }
    const last = await addVersion(
      source,
      "Acme is Active. Acme is Gone. Acme is Churning.",
      audience(group)
    );
    if (hidden?.where === "same") {
      await gone(last);
    }
    await remember(
      audience(group),
      [customer("c", "Acme", { id: acme })],
      [
        drawn("c", last, "Acme is Churning", "Acme is churning", {
          attribute: "status",
          value: "Churning",
        }),
      ]
    );
    return { seen: await changeOf(last, reader), acme };
  };

  // Threat 3: what ended a memory first, and what the reader may not read,
  // decide nothing: a hidden memory that ended it earlier, of a version
  // they may not read in between or of the same version, is as absent.
  it.each(["middle", "same"] as const)(
    "credits the replacement a reader sees, as without a hidden memory that ended it first (%s version)",
    async (where) => {
      const group = unique("group");
      const reader = readerOf(unique("reader"), group);
      const [partial, twin] = await Promise.all([
        replacedWith(group, { group: unique("hidden"), where }, reader),
        replacedWith(group, undefined, reader),
      ]);
      const history = async (entity: string) => {
        const { memories } = await shared().readMemories({
          entity,
          reader,
          history: true,
        });
        return memories.map(({ statement, endedAt }) => [
          statement,
          endedAt === null,
        ]);
      };

      expect({
        seen: partial.seen,
        history: await history(partial.acme),
      }).toStrictEqual({
        seen: twin.seen,
        history: await history(twin.acme),
      });
      expect(twin.seen?.ended).toStrictEqual(["Acme is active"]);
    }
  );

  it("adds nothing to a reader's answer when hidden memories come after it was read", async () => {
    const group = unique("group");
    const hidden = unique("hidden");
    const doc = await twoVersions(group);
    const reader = readerOf(unique("reader"), group);
    const before = withoutMoments(await pagesOf(doc.second, reader, 1));
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: audience(hidden),
      entities: [customer("c", "Acme", { id: doc.acme })],
      reader: readerOf(unique("writer"), hidden, group),
      memories: [
        drawn("c", doc.second, "Acme is Churning", "Acme is leaving", {
          attribute: "status",
          value: "Leaving",
        }),
        drawn("c", doc.first, "Acme renews in March", "Acme renews in May"),
      ],
    });

    expect(withoutMoments(await pagesOf(doc.second, reader, 1))).toStrictEqual(
      before
    );
  });
});

describe("what an erasure took from a version's change", () => {
  it("answers none once the document is erased", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    const reader = readerOf(unique("reader"), group);
    await shared().eraseSource({
      source: doc.second.source,
      reason: "deleted",
    });

    await expect(changeOf(doc.second, reader)).resolves.toBeNull();
    await expect(changeOf(doc.first, reader)).resolves.toBeNull();
  });

  it("drops a rival from another source once that source is erased", async () => {
    const group = unique("group");
    const doc = await twoVersions(group);
    const reader = readerOf(unique("reader"), group);
    await shared().eraseSource({ source: doc.other.source, reason: "deleted" });

    const seen = await changeOf(doc.second, reader);
    expect(seen?.contested).toStrictEqual({});
    expect(seen?.added).toStrictEqual(["Acme is churning", "Globex signed"]);
  });

  it("drops what was in an erased person's word, and what it ended and contested", async () => {
    const group = unique("group");
    const person = unique("person");
    const doc = await twoVersions(group);
    const third = await addVersion(
      doc.second.source,
      `${v2Text} Anna says Acme is Paused.`,
      audience(group)
    );
    await remember(
      audience(group),
      [customer("c", doc.acmeName, { id: doc.acme })],
      [
        drawn("c", third, "Acme is Paused", "Anna says Acme is paused", {
          attribute: "status",
          value: "Paused",
          speaker: { kind: "internal", person },
        }),
      ]
    );
    const reader = readerOf(unique("reader"), group);
    const before = await changeOf(third, reader);
    expect(before?.added).toStrictEqual(["Anna says Acme is paused"]);
    expect(before?.ended).toStrictEqual(["Acme is churning"]);

    await shared().erasePersonShared({
      person,
      identifiers: [],
      reason: "person_erased",
    });

    const after = await changeOf(third, reader);
    expect(after).toStrictEqual({
      added: [],
      ended: [],
      out: [],
      contested: {},
      entities: {},
      pages: 1,
    });
    // The second version's churn is current, and contested, again.
    const second = await changeOf(doc.second, reader);
    expect(second?.contested).toStrictEqual({
      "Acme is churning": ["Acme is paused"],
    });
  });

  it("drops a writer's rival once the writer is erased", async () => {
    const group = unique("group");
    const writer = unique("writer");
    const doc = await twoVersions(group);
    await shared().eraseSource({ source: doc.other.source, reason: "deleted" });
    await remember(
      audience(group),
      [customer("c", doc.acmeName, { id: doc.acme })],
      [
        {
          about: "c",
          type: "fact",
          statement: "Acme is on hold",
          speaker: { kind: "system" },
          basis: { kind: "writer", writer },
          attribute: "status",
          value: "On hold",
        },
      ]
    );
    const reader = readerOf(unique("reader"), group);
    const before = await changeOf(doc.second, reader);
    expect(before?.contested).toStrictEqual({
      "Acme is churning": ["Acme is on hold"],
    });

    await shared().eraseWriter({ writer, reason: "deleted", change: "reset" });

    const after = await changeOf(doc.second, reader);
    expect(after?.contested).toStrictEqual({});
  });
});
