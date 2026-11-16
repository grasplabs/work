// The catch-up of quotes (catch-up.ts; GRA-1915, the threat model is on
// the issue): what an add leaves unjudged is judged by the store's tick,
// and until then what a reader reads of it depends on nothing they can't
// read. Each case (a restore, an older release's version add and late
// add, new word rules, a migration that makes `memories` anew) is run on
// generated sequences against twins and the oracle (quote-twins.ts), and
// skipping its catch-up is shown to fail the oracle. Then the paging's
// recovery claims, each deterministic.
import type { Access, PersonReader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import type { BrainBucket } from "../src/bucket.ts";
import { catchUpDue, catchUpLimits, catchUpStep } from "../src/catch-up.ts";
import type { CatchUpLimits } from "../src/catch-up.ts";
import { reindexWords } from "../src/words.ts";
import { exportSettled, restoredAfterLoss } from "./export-reads.ts";
import {
  apply,
  generator,
  runAround,
  series,
  shared,
  tick,
  unique,
} from "./quote-twins.ts";
import type { Event, Reading, Side } from "./quote-twins.ts";
import { copyOf } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

/** The shared store before any test added to it: empty. */
let empty: Copy = { tables: [], others: [] };

/** `read` run in the shared store, on its SQL. */
const inStore = async <T>(
  read: (sql: SqlStorage, storage: DurableObjectStorage) => T
): Promise<T> =>
  await runInDurableObject(shared(), (_instance, state) =>
    read(state.storage.sql, state.storage)
  );

/** Ticks until the catch-up is done: at most 50 ticks. */
const caughtUp = async (): Promise<void> => {
  for (let ticks = 0; ticks < 50; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    if (!(await inStore((sql) => catchUpDue(sql)))) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick();
  }
  throw new Error("The catch-up was still due after 50 ticks");
};

/** Each side: the store as it is, and each twin with the groups it holds. */
const sidesOf = (
  real: Side,
  readings: readonly Reading[]
): { side: Side; places: readonly number[] | "all" }[] => [
  { side: real, places: "all" },
  ...readings.flatMap(({ twin, places }) =>
    twin === undefined ? [] : [{ side: twin, places }]
  ),
];

/** What a source's judging holds: its pointer's `judged_row`, and its in and out rows. */
const judgingOf = (sql: SqlStorage, source: string) => ({
  judged:
    sql
      .exec<{ judged_row: number | null }>(
        "SELECT judged_row FROM current_versions WHERE source = ?",
        source
      )
      .toArray()
      .at(0)?.judged_row ?? null,
  ins: sql
    .exec<{ memory: number }>(
      "SELECT memory FROM memory_ins WHERE source = ?",
      source
    )
    .toArray(),
  outs: sql
    .exec<{ memory: number; pair: string | null }>(
      "SELECT memory, pair FROM memory_outs WHERE source = ?",
      source
    )
    .toArray(),
});

/** `source`'s judging put back to `judging`, as a release that judges nothing left it. */
const putBackJudging = (
  sql: SqlStorage,
  source: string,
  judging: ReturnType<typeof judgingOf>
): void => {
  sql.exec("DELETE FROM memory_ins WHERE source = ?", source);
  sql.exec("DELETE FROM memory_outs WHERE source = ?", source);
  for (const { memory } of judging.ins) {
    sql.exec(
      "INSERT INTO memory_ins (memory, source) VALUES (?, ?)",
      memory,
      source
    );
  }
  for (const { memory, pair } of judging.outs) {
    sql.exec(
      "INSERT INTO memory_outs (memory, source, pair) VALUES (?, ?, ?)",
      memory,
      source,
      pair
    );
  }
  sql.exec(
    "UPDATE current_versions SET judged_row = ? WHERE source = ?",
    judging.judged,
    source
  );
};

/** One step of the catch-up, as the tick runs it, with `limits` and `bucket` (the store's when not given). */
const step = async (
  tickLimits: CatchUpLimits,
  bucket: (real: BrainBucket, sql: SqlStorage) => BrainBucket = (real) => real
) => {
  await runInDurableObject(shared(), async (_instance, state) => {
    // The shared store's part of the bucket is the whole of it.
    await catchUpStep(
      state.storage,
      bucket(env.BRAIN_OBJECTS, state.storage.sql),
      tickLimits
    );
  });
};

/** A tick's limits of one file read and `memories` memories, its other work unbounded. */
const limits = (memories: number): CatchUpLimits => ({
  looked: 1_000_000,
  reads: 1,
  memories,
  steps: 1_000_000_000,
  marked: 1_000_000,
});

/** `real` with its reads of objects going through `get`. */
const reading = (
  real: BrainBucket,
  get: (key: string) => Promise<Awaited<ReturnType<BrainBucket["get"]>>>
): BrainBucket => ({
  get,
  head: async (key) => await real.head(key),
  put: async (key, value, options) => await real.put(key, value, options),
  delete: async (keys) => {
    await real.delete(keys);
  },
  list: async (options) => await real.list(options),
});

type Disrupt = Parameters<typeof runAround>[2]["disrupt"];

/** The cases, each a change to the whole store after a series. */
const cases: Record<string, (groups: readonly string[]) => Disrupt> = {
  // Exported, the storage lost, the export restored: no in or out rows,
  // and no pointer judged.
  restore: () => async (_real, _readings, at) => {
    const { id } = await shared().startExport("test");
    if ((await exportSettled(shared, id)) !== "done") {
      throw new Error("The export didn't finish");
    }
    if ((await restoredAfterLoss(shared, id, empty)) !== "done") {
      throw new Error("The restore didn't finish");
    }
    return at;
  },
  // An older release's version add: the pointer moved, nothing judged.
  "an older release's version": (groups) => async (real, readings, at) => {
    for (const { side, places } of sidesOf(real, readings)) {
      // oxlint-disable-next-line no-await-in-loop -- one side at a time
      const before = await inStore((sql) => judgingOf(sql, side.source));
      // oxlint-disable-next-line no-await-in-loop -- one side at a time
      await apply(
        side,
        at,
        { kind: "version", group: 0, line: false },
        places,
        groups
      );
      if (side.current === at) {
        // oxlint-disable-next-line no-await-in-loop -- one side at a time
        await inStore((sql) => {
          putBackJudging(sql, side.source, before);
        });
      }
    }
    return at + 1;
  },
  // An older release's late add on the first version: no in or out row,
  // and the mark not moved past it.
  "an older release's late memory": (groups) => async (real, readings, at) => {
    for (const { side, places } of sidesOf(real, readings)) {
      // oxlint-disable-next-line no-await-in-loop -- one side at a time
      await apply(side, at, { kind: "late", on: 0 }, places, groups);
      const memory = side.memories.get(at)?.id;
      if (memory !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one side at a time
        await inStore((sql) => {
          const { row } = sql
            .exec<{ row: number }>(
              "SELECT row FROM memories WHERE id = ?",
              memory
            )
            .one();
          sql.exec("DELETE FROM memory_ins WHERE memory = ?", row);
          sql.exec("DELETE FROM memory_outs WHERE memory = ?", row);
          sql.exec(
            "UPDATE memory_judging SET through = min(through, ?) WHERE id = 1",
            row - 1
          );
        });
      }
    }
    return at + 1;
  },
  // An older release's late memory while a pass is under way: every
  // source unjudged, a page of two memories judged of each, then the late
  // memory on the first version (behind the place when the pass is past
  // that version).
  "an older release's late memory during an unfinished pass":
    (groups) => async (real, readings, at) => {
      const sides = sidesOf(real, readings);
      await inStore((sql) => {
        for (const { side } of sides) {
          sql.exec("DELETE FROM memory_ins WHERE source = ?", side.source);
          sql.exec("DELETE FROM memory_outs WHERE source = ?", side.source);
          sql.exec(
            "UPDATE current_versions SET judged_row = NULL WHERE source = ?",
            side.source
          );
        }
        sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
      });
      for (const _side of sides) {
        // oxlint-disable-next-line no-await-in-loop -- a page of each side, by turn
        await step(limits(2));
      }
      return (
        (await cases["an older release's late memory"]?.(groups)(
          real,
          readings,
          at
        )) ?? at
      );
    },
  // A release with new word rules: its rebuild's first batch.
  "new word rules": () => async (_real, _readings, at) => {
    await inStore((sql, storage) => {
      sql.exec(
        "UPDATE word_index SET version = 0, target = 0, cursor = 0, memory_cursor = 0 WHERE id = 1"
      );
      storage.transactionSync(() => {
        reindexWords(sql);
      });
    });
    return at;
  },
  // A migration that makes `memories` anew: the cascade takes every in and
  // out row, and the migration clears `judged_row` (schema.ts).
  "memories made anew": () => async (_real, _readings, at) => {
    await inStore((sql) => {
      sql.exec("DELETE FROM memory_ins");
      sql.exec("DELETE FROM memory_outs");
      sql.exec("UPDATE current_versions SET judged_row = NULL");
    });
    return at;
  },
};

/** A series fit for `name`: no erasure held for a restore (its export leaves out what one hides), at least two versions. */
const seriesFor = (name: string, random: () => number): Event[] => {
  const events = series(random).filter(
    (event) => name !== "restore" || event.kind !== "hold"
  );
  return [
    ...events,
    { kind: "version", group: Math.floor(random() * 3), line: false },
  ];
};

describe("the catch-up against twins and the oracle", () => {
  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it.each(Object.keys(cases))(
    "answers every subset of three groups as its twin before the catch-up and as its twin and the oracle after it: %s",
    async (name) => {
      const groups = [unique("ga"), unique("gb"), unique("gc")];
      const disrupt = cases[name]?.(groups);
      if (disrupt === undefined) {
        throw new Error("No such case");
      }
      const before: string[] = [];
      const after: string[] = [];
      for (const seed of [4242, 99, 7]) {
        const random = generator(seed);
        for (let index = 0; index < 2; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one case at a time
          const found = await runAround(groups, seriesFor(name, random), {
            disrupt,
            settle: caughtUp,
            // A restore's own ticks, and the pages a pass under way took,
            // catch up some sources before others.
            compareBefore:
              name !== "restore" &&
              name !==
                "an older release's late memory during an unfinished pass",
          });
          before.push(...found.before);
          after.push(...found.after);
        }
      }

      expect({ before, after }).toStrictEqual({ before: [], after: [] });
    },
    300_000
  );

  it("answers as the twins and the oracle when an older release adds a late memory behind an unfinished pass", async () => {
    // One memory on the first version, two on the second: a page of two
    // leaves the place on the second, behind it the late memory on the first.
    const groups = [unique("ga"), unique("gb"), unique("gc")];
    const { before, after } = await runAround(
      groups,
      [
        { kind: "version", group: 0, line: true },
        { kind: "version", group: 0, line: true },
        { kind: "late", on: 1 },
        { kind: "late", on: 1 },
        { kind: "version", group: 0, line: false },
      ],
      {
        disrupt:
          cases["an older release's late memory during an unfinished pass"]?.(
            groups
          ) ??
          (async (_real, _readings, at) => {
            await Promise.resolve();
            return at;
          }),
        settle: caughtUp,
        // The pass took its pages of each side at a turn of its own.
        compareBefore: false,
      }
    );

    expect({ before, after }).toStrictEqual({ before: [], after: [] });
  }, 120_000);

  it("fails the oracle in every case when its catch-up is skipped, and when the mark is set past a late memory", async () => {
    const groups = [unique("ga")];
    // The first version says the line, the second doesn't: the first
    // memory, and a late one on the first version, are out.
    const events: Event[] = [
      { kind: "version", group: 0, line: true },
      { kind: "version", group: 0, line: false },
      { kind: "late", on: 0 },
    ];
    const skipped: Record<string, boolean> = {};
    for (const [name, disrupt] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const { after } = await runAround(groups, events, {
        disrupt: disrupt(groups),
        settle: async () => {
          await Promise.resolve();
        },
        compareBefore: false,
      });
      skipped[name] = after.some((line) => line.includes(" oracle: "));
    }
    const late = cases["an older release's late memory"];
    const { after: markPast } = await runAround(groups, events, {
      disrupt: async (real, readings, at) => {
        const count = (await late?.(groups)(real, readings, at)) ?? at;
        // The mutant: the mark set past it, as a first write without a gap check would.
        await inStore((sql) => {
          sql.exec(
            `INSERT INTO memory_judging (id, through)
            VALUES (1, (SELECT max(row) FROM memories))
            ON CONFLICT (id) DO UPDATE SET through = excluded.through`
          );
        });
        return count;
      },
      settle: caughtUp,
      compareBefore: false,
    });

    expect({
      skipped,
      markPast: markPast.some((line) => line.includes(" oracle: ")),
    }).toStrictEqual({
      skipped: Object.fromEntries(
        Object.keys(cases).map((name) => [name, true])
      ),
      markPast: true,
    });
  }, 300_000);
});

/** A source of `count` memories quoting what its first version says and its second doesn't: its key and readers. */
const outSource = async (count: number, prefix = "doc") => {
  const group = unique("g");
  const access: Access = { kind: "audience", group };
  const source = unique(prefix);
  const lines = Array.from(
    { length: count },
    (_, at) => `${source} line ${at} holds ${unique("w")}`
  );
  const { version } = await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text: lines.join(". "),
    access,
  });
  await shared().addMemories({
    change: crypto.randomUUID(),
    access,
    entities: [{ key: "c", kind: "customer", names: [`${source} Group`] }],
    memories: lines.map((quote, at) => ({
      about: "c",
      type: "fact" as const,
      statement: `${source} says ${at}.`,
      speaker: { kind: "outside" as const },
      basis: { kind: "source" as const, source, version, quote },
    })),
  });
  await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text: `${source} said nothing of it.`,
    access,
  });
  const reader: PersonReader = { person: unique("p"), groups: [group] };
  return { source, reader };
};

/** How many of `source`'s memories `reader` reads as ended. */
const endedOf = async (
  source: string,
  reader: PersonReader
): Promise<number> => {
  const found = await shared().findEntities({
    reader,
    name: `${source} Group`,
  });
  const entity = found.entities[0]?.id;
  if (entity === undefined) {
    return -1;
  }
  const { memories } = await shared().readMemories({
    entity,
    reader,
    history: true,
  });
  return memories.filter(({ endedAt }) => endedAt !== null).length;
};

/**
 * Every source's catch-up finished, then `sources`' judging forgotten, as
 * a restore leaves it: so only they wait for a turn.
 */
const unjudge = async (...sources: string[]): Promise<void> => {
  await caughtUp();
  await inStore((sql) => {
    for (const source of sources) {
      sql.exec("DELETE FROM memory_ins WHERE source = ?", source);
      sql.exec("DELETE FROM memory_outs WHERE source = ?", source);
      sql.exec(
        "UPDATE current_versions SET judged_row = NULL WHERE source = ?",
        source
      );
    }
  });
};

describe("the catch-up's pages", () => {
  it("judges a source a page at a time, each memory once, and shows nothing judged until its last page", async () => {
    const { source, reader } = await outSource(7);
    await unjudge(source);
    const seen: { ended: number; rows: number }[] = [];
    for (let page = 0; page < 3; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a page at a time
      await step(limits(3));
      seen.push({
        // oxlint-disable-next-line no-await-in-loop -- a page at a time
        ended: await endedOf(source, reader),
        // oxlint-disable-next-line no-await-in-loop -- a page at a time
        rows: await inStore((sql) => judgingOf(sql, source).outs.length),
      });
    }

    expect(seen).toStrictEqual([
      { ended: 0, rows: 3 },
      { ended: 0, rows: 6 },
      { ended: 7, rows: 7 },
    ]);
  });

  it("goes on where a page cut off left it, redoing and skipping nothing", async () => {
    const { source, reader } = await outSource(5);
    await unjudge(source);
    await step(limits(2));
    // The next page cut off as it writes its second memory.
    const third = await inStore(
      (sql) =>
        sql
          .exec<{ row: number }>(
            "SELECT row FROM memories WHERE source = ? ORDER BY version, row LIMIT 1 OFFSET 3",
            source
          )
          .one().row
    );
    await inStore((sql) => {
      sql.exec(
        `CREATE TRIGGER test_cut BEFORE INSERT ON memory_outs
        WHEN NEW.memory = ${third} BEGIN SELECT RAISE(ABORT, 'cut'); END`
      );
    });
    const cut = await step(limits(2)).then(
      () => "went on",
      () => "cut"
    );
    const afterCut = await inStore((sql) => judgingOf(sql, source).outs.length);
    await inStore((sql) => {
      sql.exec("DROP TRIGGER test_cut");
    });
    await step(limits(2));
    await step(limits(2));

    expect({
      cut,
      afterCut,
      ended: await endedOf(source, reader),
      rows: await inStore((sql) => judgingOf(sql, source).outs.length),
    }).toStrictEqual({ cut: "cut", afterCut: 2, ended: 5, rows: 5 });
  });

  it("gives every unjudged source its turn though one's file can't be read", async () => {
    // The failing one first by key, and the turns starting from the first.
    const failing = await outSource(2, "aaa");
    const other = await outSource(2, "zzz");
    await unjudge(failing.source, other.source);
    await inStore((sql) => {
      sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
    });
    const failingFile = await inStore(
      (sql) =>
        sql
          .exec<{ file: string }>(
            `SELECT source_versions.file AS file FROM current_versions
          JOIN source_versions ON source_versions.row = current_versions.version_row
          WHERE current_versions.source = ?`,
            failing.source
          )
          .one().file
    );
    const broken = (real: BrainBucket): BrainBucket =>
      reading(real, async (key) => {
        if (key.includes(failingFile)) {
          throw new Error("The bucket is unreachable");
        }
        return await real.get(key);
      });
    const outcomes: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a turn at a time
      const outcome = await step(limits(100), broken).then(
        () => "ok",
        () => "failed"
      );
      outcomes.push(outcome);
    }

    expect({
      // Its turn failed, then the next went to the other source.
      firstTwo: outcomes.slice(0, 2),
      other: await endedOf(other.source, other.reader),
      failing: await endedOf(failing.source, failing.reader),
    }).toStrictEqual({ firstTwo: ["failed", "ok"], other: 2, failing: 0 });
  });

  it("writes nothing when the source's pointer moves while its file is read", async () => {
    const { source, reader } = await outSource(3);
    await unjudge(source);
    const landing = (real: BrainBucket, sql: SqlStorage): BrainBucket =>
      reading(real, async (key) => {
        const object = await real.get(key);
        // The pointer moved meanwhile: to the first version, so it is
        // no longer the version whose file this is.
        sql.exec(
          `UPDATE current_versions SET version_row = (
            SELECT min(row) FROM source_versions WHERE source = ?1
          ) WHERE source = ?1`,
          source
        );
        return object;
      });
    await step(limits(100), landing);

    expect({
      rows: await inStore((sql) => judgingOf(sql, source).outs.length),
      ended: await endedOf(source, reader),
    }).toStrictEqual({ rows: 0, ended: 0 });
  });

  it("lets go of a source's place with its pointer when the source is erased", async () => {
    const { source } = await outSource(4);
    await unjudge(source);
    await step(limits(2));
    const placed = await inStore(
      (sql) =>
        sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM memory_judging_places WHERE source = ?",
            source
          )
          .one().count
    );
    await shared().eraseSource({ source, reason: "deleted" });
    for (let ticks = 0; ticks < 5; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the tick deletes what the erasure hid
      await tick();
    }

    expect({
      placed,
      left: await inStore(
        (sql) =>
          sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM memory_judging_places WHERE source = ?",
              source
            )
            .one().count
      ),
    }).toStrictEqual({ placed: 1, left: 0 });
  });

  it("moves the mark on with each add only past what was judged, and never sets it where there is none", async () => {
    await inStore((sql) => {
      sql.exec("DELETE FROM memory_judging");
    });
    const { source } = await outSource(1);
    const none = await inStore(
      (sql) => sql.exec("SELECT 1 FROM memory_judging").toArray().length
    );
    await caughtUp();
    const last = async () =>
      await inStore((sql) => ({
        through: sql
          .exec<{ through: number }>(
            "SELECT through FROM memory_judging WHERE id = 1"
          )
          .one().through,
        last: sql
          .exec<{ row: number }>("SELECT max(row) AS row FROM memories")
          .one().row,
      }));
    const scanned = await last();
    // An older release's add: a memory with no judgment, the mark not moved.
    await inStore((sql) => {
      sql.exec(
        `INSERT INTO memories (id, entity, type, statement, quote, source, version,
          subject, lineage, lineage_order, speaker, learned_at, readers, one_value)
        SELECT ?, entity, type, statement, quote, source, version, subject,
          lineage, lineage_order, speaker, learned_at, readers, one_value
        FROM memories WHERE source = ? LIMIT 1`,
        crypto.randomUUID(),
        source
      );
    });
    await outSource(1);
    const behind = await last();

    expect({
      none,
      atLast: scanned.through === scanned.last,
      behind: behind.through < behind.last,
    }).toStrictEqual({ none: 0, atLast: true, behind: true });
  });
});

/** A source with `texts` as its versions, and memories quoting `quotes` on the version of each index: its key, readers and version numbers. */
const versioned = async (
  texts: readonly string[],
  quotesOn: ReadonlyMap<number, readonly string[]>
) => {
  const group = unique("g");
  const access: Access = { kind: "audience", group };
  const source = unique("doc");
  const versions: number[] = [];
  for (const [at, text] of texts.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- a version at a time
    const { version } = await shared().addSource({
      source,
      change: crypto.randomUUID(),
      text,
      access,
    });
    versions.push(version);
    const quotes = quotesOn.get(at) ?? [];
    if (quotes.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- a version at a time
      await shared().addMemories({
        change: crypto.randomUUID(),
        access,
        entities: [{ key: "c", kind: "customer", names: [`${source} Group`] }],
        memories: quotes.map((quote, index) => ({
          about: "c",
          type: "fact" as const,
          statement: `${source} says ${at} ${index}.`,
          speaker: { kind: "outside" as const },
          basis: { kind: "source" as const, source, version, quote },
        })),
      });
    }
  }
  const reader: PersonReader = { person: unique("p"), groups: [group] };
  return { source, reader, versions };
};

/** An older release's late memory on `version` of `source`: a copy of one there, no in or out row, the mark not moved. */
const olderLateMemory = async (source: string, version: number) =>
  await inStore((sql) => {
    const id = crypto.randomUUID();
    sql.exec(
      `INSERT INTO memories (id, entity, type, statement, quote, source, version,
        subject, lineage, lineage_order, speaker, learned_at, readers, one_value)
      SELECT ?, entity, type, statement || ' late', quote, source, version, subject,
        lineage, lineage_order, speaker, learned_at, readers, one_value
      FROM memories WHERE source = ? AND version = ? ORDER BY row LIMIT 1`,
      id,
      source,
      version
    );
    return sql
      .exec<{ row: number }>("SELECT row FROM memories WHERE id = ?", id)
      .one().row;
  });

/** Every table and text column in the shared store holding `key` as a value. */
const holding = async (key: string): Promise<string[]> =>
  await inStore((sql) =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'"
      )
      .toArray()
      .flatMap(({ name }) =>
        sql
          .exec<{ name: string; type: string }>(`PRAGMA table_info("${name}")`)
          .toArray()
          .filter(({ type }) => type.toLowerCase() === "text")
          .filter(
            (column) =>
              sql
                .exec(
                  `SELECT 1 FROM "${name}" WHERE "${column.name}" = ? LIMIT 1`,
                  key
                )
                .toArray().length > 0
          )
          .map((column) => `${name}.${column.name}`)
      )
  );

const lines = [
  "Alpha one two",
  "Bravo three four",
  "Charlie five six",
  "Delta seven eight",
];

describe("what the catch-up leaves behind it", () => {
  it("judges a late memory an older release added behind an unfinished pass's place", async () => {
    const { source, reader, versions } = await versioned(
      [lines.join(". "), `${lines.join(". ")}. More.`, "Nothing of it."],
      new Map([
        [0, lines],
        [1, lines],
      ])
    );
    await unjudge(source);
    await inStore((sql) => {
      sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
    });
    // A page of five: four on the first version, one on the second.
    await step(limits(5));
    const late = await olderLateMemory(source, versions[0] ?? 0);
    await caughtUp();

    expect({
      ended: await endedOf(source, reader),
      lateOut: await inStore(
        (sql) =>
          sql.exec("SELECT 1 FROM memory_outs WHERE memory = ?", late).toArray()
            .length
      ),
    }).toStrictEqual({ ended: 9, lateOut: 1 });
  });

  it("holds no source's key once the source whose turn it was is erased, nor a turn once nothing is left", async () => {
    const { source } = await outSource(2);
    await unjudge(source);
    await inStore((sql) => {
      sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
    });
    await step(limits(1));
    const turn = async () =>
      await inStore(
        (sql) =>
          sql
            .exec<{ turn: string | null }>(
              "SELECT turn FROM memory_judging WHERE id = 1"
            )
            .one().turn
      );
    const served = await turn();
    await shared().eraseSource({ source, reason: "deleted" });
    for (let ticks = 0; ticks < 5; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the tick deletes what the erasure hid
      await tick();
    }
    const other = await outSource(1);
    await unjudge(other.source);
    await caughtUp();

    expect({
      served: served === source,
      holding: await holding(source),
      left: await turn(),
    }).toStrictEqual({ served: true, holding: [], left: null });
  });

  it("reads no file of a source with nothing on a version before its current one", async () => {
    await caughtUp();
    const group = unique("g");
    const singles: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      const source = unique(`aaa${String(index).padStart(3, "0")}`);
      // oxlint-disable-next-line no-await-in-loop -- a source at a time
      await shared().addSource({
        source,
        change: crypto.randomUUID(),
        text: `Single version ${index}.`,
        access: { kind: "audience", group },
      });
      singles.push(source);
    }
    const out = await outSource(4, "zzz");
    await unjudge(...singles, out.source);
    await inStore((sql) => {
      sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
    });
    const reads: string[] = [];
    await step(catchUpLimits, (real) =>
      reading(real, async (key) => {
        reads.push(key);
        return await real.get(key);
      })
    );

    expect({
      reads: reads.length,
      ended: await endedOf(out.source, out.reader),
      due: await inStore((sql) => catchUpDue(sql)),
    }).toStrictEqual({ reads: 1, ended: 4, due: false });
  });

  it("starts an unfinished pass over when the word rules change", async () => {
    const { source, reader } = await outSource(4);
    await unjudge(source);
    await inStore((sql) => {
      sql.exec("UPDATE memory_judging SET turn = NULL WHERE id = 1");
    });
    await step(limits(2));
    const places = async () =>
      await inStore(
        (sql) =>
          sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM memory_judging_places WHERE source = ?",
              source
            )
            .one().count
      );
    const before = await places();
    await inStore((sql, storage) => {
      sql.exec(
        "UPDATE word_index SET version = 0, target = 0, cursor = 0, memory_cursor = 0 WHERE id = 1"
      );
      storage.transactionSync(() => {
        reindexWords(sql);
      });
    });
    const after = await places();
    await caughtUp();

    expect({
      before,
      after,
      ended: await endedOf(source, reader),
    }).toStrictEqual({ before: 1, after: 0, ended: 4 });
  });
});
