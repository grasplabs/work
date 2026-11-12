import type {
  Access,
  ChunkRef,
  FoundChunk,
  Reader,
} from "@grasp-os/brain-next/contract";
import {
  defineWork,
  enqueueWork,
  repackPerTick,
} from "@grasp-os/brain-next/work";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { brainWorkOverview, workBrain } from "../src/brain-next.ts";
import { noProducers } from "./no-producers.ts";

// The vector way of the Brain's store (GRA-1766), through the store's
// contract: codes are put for chunks of current versions, packed in
// blocks of 1,024 with the newest in a tail, and searched by an exact
// 1-bit scan, the nearest candidates re-scored, with the access check
// inside it. From the threat model on the issue: a search finds the
// nearest chunks the reader may read, as brute force over those alone
// does; codes the reader may not read, packed or in the tail, change
// nothing of what they find, whatever the vectors; nobody finds a source
// nobody is known to read; a change in membership holds from the next
// search; a new version's codes replace the old ones' at once, and a late
// put brings nothing back; a repack drops removed codes for good; codes
// of two models or builds are never compared; and a put or a repack that
// breaks half-way leaves the store as it was.
//
// Most vectors here are made of +1 and -1 alone, with a centre of zeros:
// their codes are then exact (the 1-bit Hamming distance orders them as
// their cosine does, and the 8-bit code holds them whole), so brute force
// over the full vectors is the answer the scan must give, ties to the
// chunk added first, however many it re-scores. Others are real-valued,
// with a centre of their own, where the re-scoring is what decides.

const dimensions = 384;

/** Most vectors a put takes. */
const perPut = 256;

/** Chunks in a block, and one tail more than that. */
const block = 1024;

/** A paragraph long enough to be a chunk of its own (chunks.ts). */
const paragraph = (index: number): string =>
  `Passage ${index}. ${"Lorem ipsum dolor sit amet. ".repeat(25)}`;

/** The one store. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** A source of `count` chunks that `access` may read, as version 1. */
const sourceOf = async (access: Access, count: number): Promise<ChunkRef[]> => {
  const source = `test:${crypto.randomUUID()}`;
  const { version } = await store().addSource({
    source,
    change: crypto.randomUUID(),
    text: Array.from({ length: count }, (_, index) => paragraph(index)).join(
      "\n\n"
    ),
    access,
  });
  return Array.from({ length: count }, (_, position) => ({
    source,
    version,
    position,
  }));
};

/** A random 32-bit word, from a seed of the tests' own, so runs repeat. */
const randomWord = (() => {
  let state = 0x9e_37_79_b9;
  return (): number => {
    // oxlint-disable-next-line no-bitwise -- xorshift
    state ^= state << 13;
    // oxlint-disable-next-line no-bitwise -- xorshift
    state ^= state >>> 17;
    // oxlint-disable-next-line no-bitwise -- xorshift
    state ^= state << 5;
    // oxlint-disable-next-line no-bitwise -- as unsigned
    return state >>> 0;
  };
})();

/** Random +1 and -1. */
const randomSigns = (): number[] =>
  Array.from({ length: dimensions }, () =>
    // oxlint-disable-next-line no-bitwise -- the lowest bit
    (randomWord() & 1) === 0 ? -1 : 1
  );

/** Random numbers from -1 to 1. */
const randomReals = (): number[] =>
  Array.from({ length: dimensions }, () => randomWord() / 2 ** 31 - 1);

/** `vector` with its first `flips` signs turned: nearer the fewer. */
const near = (vector: readonly number[], flips: number): number[] =>
  vector.map((value, index) => (index < flips ? -value : value));

/** A chunk and the vector it is put with. */
interface Coded {
  chunk: ChunkRef;
  vector: number[];
}

/** `chunks`, each with a vector of random signs. */
const randomly = (chunks: readonly ChunkRef[]): Coded[] =>
  chunks.map((chunk) => ({ chunk, vector: randomSigns() }));

/** A model of its own, with a centre of zeros. */
const newModel = () => ({
  name: `model-${crypto.randomUUID()}@build-1`,
  centre: Array.from({ length: dimensions }, () => 0),
});

type Model = ReturnType<typeof newModel>;

/** Puts `coded` for `model`, as many puts as it takes. */
const put = async (model: Model, coded: readonly Coded[]): Promise<void> => {
  for (let start = 0; start < coded.length; start += perPut) {
    // oxlint-disable-next-line no-await-in-loop -- one put at a time
    await store().putVectors({
      model,
      vectors: coded.slice(start, start + perPut),
    });
  }
};

/** What `reader` finds nearest `vector` with `model`. */
const search = async (
  model: Model,
  vector: number[],
  reader: Reader,
  limit = 20
): Promise<FoundChunk[]> => {
  const { chunks } = await store().searchVectors({
    model: model.name,
    vector,
    reader,
    limit,
  });
  return chunks;
};

const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

const cosine = (a: readonly number[], b: readonly number[]): number =>
  dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));

/**
 * The `limit` nearest of `allowed`, given in the order they were added, by
 * their cosine to `vector`: the answer, by brute force.
 */
const bruteForce = (
  vector: readonly number[],
  allowed: readonly Coded[],
  limit = 20
): FoundChunk[] =>
  allowed
    .map(({ chunk, vector: coded }, order) => ({
      found: { ...chunk, score: cosine(vector, coded) },
      order,
    }))
    .toSorted((a, b) => b.found.score - a.found.score || a.order - b.order)
    .slice(0, limit)
    .map(({ found }) => found);

/** Where a found chunk is, without its score. */
const placeOf = ({ source, version, position }: FoundChunk): ChunkRef => ({
  source,
  version,
  position,
});

/** `found` with scores rounded, to compare with brute force. */
const rounded = (found: readonly FoundChunk[]) =>
  found.map(({ score, ...chunk }) => ({
    ...chunk,
    score: Math.round(score * 1e9) / 1e9,
  }));

/** A group, a person or a principal of its own. */
const principal = (kind: string) => `${kind}-${crypto.randomUUID()}`;

const audience = (group: string): Access => ({ kind: "audience", group });

const owner = (person: string): Access => ({ kind: "owner", person });

/** The company's readers. */
const readers = {
  group: principal("group"),
  otherGroup: principal("group"),
  few: principal("person"),
  other: principal("person"),
};

/** The company's chunks, shared by the tests: each puts its own model's codes. */
interface Company {
  /** Two sources the group reads: two blocks and a tail. */
  shared: ChunkRef[];
  /** A few chunks only `few` reads. */
  own: ChunkRef[];
  /** A block and a tail only `other` reads. */
  others: ChunkRef[];
  /** Chunks another group reads. */
  otherGroups: ChunkRef[];
  /** Chunks nobody is known to read. */
  nobodys: ChunkRef[];
}

const company: Company = {
  shared: [],
  own: [],
  others: [],
  otherGroups: [],
  nobodys: [],
};

/** Most a test's setting up may take: adds of a thousand chunks. */
const setUpMs = 120_000;

/**
 * Codes for the company's chunks under a model of their own, nearest a
 * question of their own: a few chunks the group reads planted near it,
 * packed and in the tail, and every chunk the reader of a test may not
 * read put at the question itself, the nearest a code can be.
 */
const plant = async () => {
  const model = newModel();
  const question = randomSigns();
  const shared = randomly(company.shared);
  // Near ones in the first block, the second and the tail.
  for (const [rank, at] of [5, 1500, 2150, 700, 2199].entries()) {
    const coded = shared[at];
    if (coded !== undefined) {
      coded.vector = near(question, 3 + rank * 4);
    }
  }
  const own = randomly(company.own);
  const atQuestion = (chunks: readonly ChunkRef[]): Coded[] =>
    chunks.map((chunk) => ({ chunk, vector: [...question] }));
  await put(model, shared);
  await put(model, own);
  await put(model, atQuestion(company.others));
  await put(model, atQuestion(company.otherGroups));
  await put(model, atQuestion(company.nobodys));
  return { model, question, shared, own };
};

/** The chunk rows of `source`'s `version`, as the store holds them. */
const rowsOf = async (source: string, version: number): Promise<number[]> =>
  await runInDurableObject(store(), (_instance, state) =>
    state.storage.sql
      .exec<{ row: number }>(
        `SELECT chunks.row AS row FROM chunks
        JOIN source_versions ON source_versions.row = chunks.version_row
        WHERE source_versions.source = ? AND source_versions.version = ?`,
        source,
        version
      )
      .toArray()
      .map(({ row }) => row)
  );

/**
 * Every chunk row the store holds a vector code of, packed or not,
 * removed or not: what erasure must see gone.
 */
const codedRows = async (): Promise<Set<number>> =>
  await runInDurableObject(store(), (_instance, state) => {
    const rows = new Set<number>();
    for (const { chunks } of state.storage.sql.exec<{ chunks: ArrayBuffer }>(
      "SELECT chunks FROM vector_blocks"
    )) {
      for (const row of new Float64Array(chunks)) {
        rows.add(row);
      }
    }
    for (const { chunk } of state.storage.sql.exec<{ chunk: number }>(
      "SELECT chunk FROM vector_codes"
    )) {
      rows.add(chunk);
    }
    return rows;
  });

/** Adds a new version of `source` that `access` may read, of `count` chunks. */
const newVersionOf = async (
  source: string,
  access: Access,
  count: number
): Promise<ChunkRef[]> => {
  const { version } = await store().addSource({
    source,
    change: crypto.randomUUID(),
    text: Array.from(
      { length: count },
      (_, index) => `${paragraph(index)} Version two.`
    ).join("\n\n"),
    access,
  });
  return Array.from({ length: count }, (_, position) => ({
    source,
    version,
    position,
  }));
};

/** Breaks the store's SQL with `trigger` until the returned undo runs. */
const breakWith = async (name: string, trigger: string) => {
  await runInDurableObject(store(), (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER ${name} ${trigger} BEGIN SELECT RAISE(ABORT, 'Broken by the test'); END`
    );
  });
  return async () => {
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(`DROP TRIGGER ${name}`);
    });
  };
};

const broken = /Broken by the test/u;

/** Restarts the store, as a crash would: it wakes afresh on the next call. */
const restart = async (): Promise<void> => {
  await runInDurableObject(store(), (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch((error: unknown) => {
    if (
      !(error instanceof Error && /Restarted by the test/u.test(error.message))
    ) {
      throw error;
    }
  });
};

/** How many blocks hold removed codes, waiting for a repack. */
const markedBlocks = async (): Promise<number> =>
  await runInDurableObject(
    store(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ blocks: number }>(
          "SELECT count(DISTINCT block) AS blocks FROM vector_removed"
        )
        .one().blocks
  );

/** Runs of `tickWork`, the queue's work in a tick. */
const tickRuns = { count: 0 };

/** Work for the queue of a tick that also repacks: it counts its runs. */
const tickWork = defineWork({
  kind: `test.tick_${crypto.randomUUID().replaceAll("-", "")}`,
  payload: z.strictObject({}),
  run: async () => {
    await Promise.resolve();
    tickRuns.count += 1;
  },
});

/** Repacks one block holding removed codes: true when more are left. */
const repack = async (): Promise<boolean> => await store().repackVectors();

/** How many repacks it takes until no block holds removed codes. */
const repackCount = async (done = 0): Promise<number> =>
  (await repack()) ? await repackCount(done + 1) : done + 1;

/** Repacks until no block holds removed codes. */
const repackAll = async (): Promise<void> => {
  if (await repack()) {
    await repackAll();
  }
};

/**
 * A reader's block with removed codes in it: 600 codes of a first source
 * and 424 of a second, the second's other 176 in the tail, and then the
 * first replaced by a new version. What the reader finds is the second's.
 */
const withRemoved = async () => {
  const model = newModel();
  const question = randomSigns();
  const person = principal("person");
  const reader = { person, groups: [] };
  const first = randomly(await sourceOf(owner(person), 600));
  const second = randomly(await sourceOf(owner(person), 600));
  await put(model, first);
  await put(model, second);
  const source = first[0]?.chunk.source ?? "";
  const removed = await rowsOf(source, 1);
  await newVersionOf(source, owner(person), 1);
  const expected = rounded(bruteForce(question, second, 50));
  expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
    expected
  );
  const kept = await rowsOf(second[0]?.chunk.source ?? "", 1);
  return { model, question, reader, removed, kept, expected };
};

describe("the Brain's vector way", () => {
  beforeAll(async () => {
    company.shared = [
      ...(await sourceOf(audience(readers.group), 1100)),
      ...(await sourceOf(audience(readers.group), 1100)),
    ];
    company.own = await sourceOf(owner(readers.few), 5);
    company.others = await sourceOf(owner(readers.other), block + 76);
    company.otherGroups = await sourceOf(audience(readers.otherGroup), 40);
    company.nobodys = await sourceOf({ kind: "none" }, 40);
  }, setUpMs);

  it("finds exactly the nearest chunks a reader may read, as brute force does, when they may read few", async () => {
    const { model, question, own } = await plant();
    const found = await search(model, question, {
      person: readers.few,
      groups: [],
    });
    expect(found).toHaveLength(own.length);
    expect(rounded(found)).toStrictEqual(rounded(bruteForce(question, own)));
  });

  it("finds exactly the nearest chunks a reader may read, as brute force does, when they may read many, packed and in the tail", async () => {
    const { model, question, shared, own } = await plant();
    const reader = { person: principal("person"), groups: [readers.group] };
    const found = await search(model, question, reader, 50);
    expect(rounded(found)).toStrictEqual(
      rounded(bruteForce(question, shared, 50))
    );
    // As a person and through a group at once: what both may read.
    const both = await search(
      model,
      question,
      { person: readers.few, groups: [readers.group] },
      50
    );
    expect(rounded(both)).toStrictEqual(
      rounded(bruteForce(question, [...shared, ...own], 50))
    );
  });

  it("finds the same chunks, in the same order and with the same scores, whatever codes the reader may not read are stored, packed or in the tail", async () => {
    const model = newModel();
    const question = randomSigns();
    const reader = { person: principal("person"), groups: [readers.group] };
    await put(model, randomly(company.shared));
    const alone = await search(model, question, reader, 50);
    // At the question itself: they would come first if they were scored.
    const atQuestion = (chunks: readonly ChunkRef[]): Coded[] =>
      chunks.map((chunk) => ({ chunk, vector: [...question] }));
    await put(model, atQuestion(company.others));
    await put(model, atQuestion(company.otherGroups));
    await put(model, atQuestion(company.nobodys));
    await expect(search(model, question, reader, 50)).resolves.toStrictEqual(
      alone
    );
    // They are there for those who may read them.
    const theirs = await search(model, question, {
      person: readers.other,
      groups: [readers.otherGroup],
    });
    expect(theirs).toHaveLength(20);
    for (const { source, score } of theirs) {
      expect([
        company.others[0]?.source,
        company.otherGroups[0]?.source,
      ]).toContain(source);
      expect(score).toBeCloseTo(1, 9);
    }
  });

  it("finds a source nobody is known to read for nobody, and never takes a person for a group of the same name", async () => {
    const { model, question } = await plant();
    const everyone = {
      person: readers.other,
      groups: [readers.group, readers.otherGroup, readers.few, "none"],
    };
    const found = await search(model, question, everyone, 50);
    const nobodys = new Set(company.nobodys.map(({ source }) => source));
    expect(found.filter(({ source }) => nobodys.has(source))).toStrictEqual([]);
    // The group's name as a person, and the person's as a group.
    await expect(
      search(model, question, { person: readers.group, groups: [] })
    ).resolves.toStrictEqual([]);
    await expect(
      search(model, question, {
        person: principal("person"),
        groups: [readers.few],
      })
    ).resolves.toStrictEqual([]);
  });

  it("holds a change in a reader's groups from the next search", async () => {
    const { model, question, shared } = await plant();
    const person = principal("person");
    const inGroup = { person, groups: [readers.group] };
    const expected = rounded(bruteForce(question, shared));
    expect(rounded(await search(model, question, inGroup))).toStrictEqual(
      expected
    );
    await expect(
      search(model, question, { person, groups: [] })
    ).resolves.toStrictEqual([]);
    expect(rounded(await search(model, question, inGroup))).toStrictEqual(
      expected
    );
  });

  it("stops finding a version's chunks once a new version replaces it, packed or in the tail, and a late put brings none back", async () => {
    const model = newModel();
    const question = randomSigns();
    const person = principal("person");
    const access: Access = { kind: "owner", person };
    const reader = { person, groups: [] };
    const first = randomly(await sourceOf(access, block + 76));
    await put(model, first);
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      rounded(bruteForce(question, first, 50))
    );
    const source = first[0]?.chunk.source ?? "";
    const second = randomly(await newVersionOf(source, access, 3));
    await expect(search(model, question, reader, 50)).resolves.toStrictEqual(
      []
    );
    // The queue, late: codes of the version before, again.
    await put(model, first.slice(0, perPut));
    await put(model, first.slice(block));
    await expect(search(model, question, reader, 50)).resolves.toStrictEqual(
      []
    );
    await put(model, second);
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      rounded(bruteForce(question, second, 50))
    );
  });

  it("drops removed codes for good when it repacks, and finds the same as before", async () => {
    const { model, question, reader, removed, kept, expected } =
      await withRemoved();
    await repackAll();
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      expected
    );
    const coded = await codedRows();
    expect(removed.filter((row) => coded.has(row))).toStrictEqual([]);
    expect(kept.filter((row) => !coded.has(row))).toStrictEqual([]);
  });

  it("leaves everything as it was when a repack breaks half-way", async () => {
    const { model, question, reader, expected } = await withRemoved();
    const undo = await breakWith(
      "brain_test_no_block_deletes",
      "BEFORE DELETE ON vector_blocks"
    );
    await expect(repack()).rejects.toThrow(broken);
    await undo();
    await restart();
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      expected
    );
  });

  it("leaves nothing of a put that breaks while packing, and its retry lands once", async () => {
    const model = newModel();
    const question = randomSigns();
    const person = principal("person");
    const reader = { person, groups: [] };
    const coded = randomly(
      await sourceOf({ kind: "owner", person }, block + 76)
    );
    const before = coded.slice(0, 1000);
    await put(model, before);
    const undo = await breakWith(
      "brain_test_no_blocks",
      "BEFORE INSERT ON vector_blocks"
    );
    // This put fills a block, which breaks.
    await expect(put(model, coded.slice(1000))).rejects.toThrow(broken);
    await undo();
    await restart();
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      rounded(bruteForce(question, before, 50))
    );
    await put(model, coded.slice(1000));
    await put(model, coded);
    const found = await search(model, question, reader, 50);
    expect(rounded(found)).toStrictEqual(
      rounded(bruteForce(question, coded, 50))
    );
  });

  it("never compares codes of one model or build with another's", async () => {
    const first = newModel();
    const build = {
      ...first,
      name: `${first.name.replace("@build-1", "")}@build-2`,
    };
    const reader = { person: readers.few, groups: [] };
    const ofFirst = randomly(company.own);
    const ofBuild = randomly(company.own);
    await put(first, ofFirst);
    await put(build, ofBuild);
    // Asked with a vector the first build holds exactly.
    const question = ofFirst[0]?.vector ?? [];
    expect(rounded(await search(build, question, reader))).toStrictEqual(
      rounded(bruteForce(question, ofBuild))
    );
    expect(rounded(await search(first, question, reader))).toStrictEqual(
      rounded(bruteForce(question, ofFirst))
    );
    // A model with no codes finds nothing.
    await expect(search(newModel(), question, reader)).resolves.toStrictEqual(
      []
    );
    // A known name with another centre, or a question of other dimensions.
    await expect(
      put(
        { ...build, centre: build.centre.map(() => 0.5) },
        ofBuild.slice(0, 1)
      )
    ).rejects.toThrow(/another centre/u);
    await expect(
      search(build, question.slice(0, dimensions / 2), reader)
    ).rejects.toThrow(/dimensions/u);
  });

  it("drops a code a fault left in a reader's own group before ranking it, when its chunk is hidden or superseded", async () => {
    const model = newModel();
    const question = randomSigns();
    const reader = { person: readers.few, groups: [] };
    const own = randomly(company.own);
    const [first] = own;
    if (first === undefined) {
      throw new Error("No chunk");
    }
    first.vector = [...question];
    await put(model, own);
    // A chunk the reader may not read, and one of a superseded version
    // they could read.
    const [hidden] = await rowsOf(company.others[0]?.source ?? "", 1);
    const superseded = await sourceOf(owner(readers.few), 1);
    const supersededSource = superseded[0]?.source ?? "";
    await newVersionOf(supersededSource, owner(readers.few), 1);
    const [stale] = await rowsOf(supersededSource, 1);
    const [ownRow] = await rowsOf(first.chunk.source, first.chunk.version);
    // The fault: codes for both in the reader's own tail, at the question.
    await runInDurableObject(store(), (_instance, state) => {
      const { sql } = state.storage;
      for (const chunk of [hidden, stale]) {
        sql.exec(
          `INSERT INTO vector_codes (chunk, model, reader_set, bits, inverse_length, fine)
          SELECT ?, model, reader_set, bits, inverse_length, fine FROM vector_codes
          WHERE chunk = ? AND model = (SELECT id FROM vector_models WHERE name = ?)`,
          chunk,
          ownRow,
          model.name
        );
      }
    });
    expect(rounded(await search(model, question, reader))).toStrictEqual(
      rounded(bruteForce(question, own))
    );
  });

  it("scores a vector of unequal components 1 against itself, and one direction alike at every magnitude, ties to the older chunk", async () => {
    const model = newModel();
    const reader = { person: readers.few, groups: [] };
    // Components that don't round evenly to 8 bits: 1, 0.5 and the rest.
    const direction = randomReals().map((value, index) => {
      if (index === 0) {
        return 1;
      }
      return index === 1 ? 0.5 : value / 4;
    });
    const [first, second, ...rest] = company.own;
    if (first === undefined || second === undefined) {
      throw new Error("No chunks");
    }
    await put(model, [
      { chunk: first, vector: direction.map((value) => value * 3) },
      { chunk: second, vector: direction },
      ...rest.map((chunk) => ({ chunk, vector: randomReals() })),
    ]);
    const found = await search(model, direction, reader, 2);
    expect(found.map(placeOf)).toStrictEqual([first, second]);
    for (const { score } of found) {
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeCloseTo(1, 12);
    }
  });

  it("repacks one marked block a call, however many are marked", async () => {
    const model = newModel();
    const person = principal("person");
    // Three blocks, each of a replaced source's 600 codes and another's
    // 424.
    const replaced: string[] = [];
    for (let made = 0; made < 3; made += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      const gone = randomly(await sourceOf(owner(person), 600));
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      const kept = randomly(await sourceOf(owner(person), 424));
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      await put(model, [...gone, ...kept]);
      replaced.push(gone[0]?.chunk.source ?? "");
    }
    for (const source of replaced) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await newVersionOf(source, owner(person), 1);
    }
    const marked = await runInDurableObject(
      store(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ blocks: number }>(
            "SELECT count(DISTINCT block) AS blocks FROM vector_removed"
          )
          .one().blocks
    );
    expect(marked).toBeGreaterThanOrEqual(3);
    await expect(repackCount()).resolves.toBe(marked);
  });

  it("repacks at most its share of marked blocks a tick of core's clock, the rest the next, and runs the queue in the same tick", async () => {
    const model = newModel();
    const person = principal("person");
    // More marked blocks than a tick repacks: each of a replaced source's
    // 600 codes and another's 424.
    const replaced: string[] = [];
    for (let made = 0; made <= repackPerTick; made += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      const gone = randomly(await sourceOf(owner(person), 600));
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      const kept = randomly(await sourceOf(owner(person), 424));
      // oxlint-disable-next-line no-await-in-loop -- in order: one block each
      await put(model, [...gone, ...kept]);
      replaced.push(gone[0]?.chunk.source ?? "");
    }
    for (const source of replaced) {
      // oxlint-disable-next-line no-await-in-loop -- one version at a time
      await newVersionOf(source, owner(person), 1);
    }
    const before = await markedBlocks();
    await runInDurableObject(store(), (_store, state) => {
      enqueueWork(state.storage, tickWork, {
        key: `tick-${crypto.randomUUID()}`,
        payload: {},
        priority: "asked",
      });
    });
    const ranBefore = tickRuns.count;
    await workBrain(env, new Date(), noProducers);
    const afterOne = await markedBlocks();
    const ran = tickRuns.count - ranBefore;
    await workBrain(env, new Date(), noProducers);
    expect({
      enough: before > repackPerTick,
      // Two ticks reach every marked block, the test's own among them.
      fitsTwo: before <= 2 * repackPerTick,
      afterOne,
      ran,
      afterTwo: await markedBlocks(),
    }).toStrictEqual({
      enough: true,
      fitsTwo: true,
      afterOne: before - repackPerTick,
      ran: 1,
      afterTwo: 0,
    });
  });

  it("runs the queue in a tick whose repack fails, shows the failure, and clears it once a repack succeeds", async () => {
    const model = newModel();
    const person = principal("person");
    // A marked block of the test's own.
    const gone = randomly(await sourceOf(owner(person), 600));
    const kept = randomly(await sourceOf(owner(person), 424));
    await put(model, [...gone, ...kept]);
    await newVersionOf(gone[0]?.chunk.source ?? "", owner(person), 1);
    const before = await markedBlocks();
    await runInDurableObject(store(), (_store, state) => {
      enqueueWork(state.storage, tickWork, {
        key: `tick-${crypto.randomUUID()}`,
        payload: {},
        priority: "asked",
      });
    });
    const ranBefore = tickRuns.count;
    const undo = await breakWith(
      "brain_test_tick_no_block_deletes",
      "BEFORE DELETE ON vector_blocks"
    );
    const at = new Date();
    try {
      await workBrain(env, at, noProducers);
    } finally {
      await undo();
    }
    const ran = tickRuns.count - ranBefore;
    const markedWhileBroken = await markedBlocks();
    const whileBroken = await brainWorkOverview(env);
    await workBrain(env, new Date(), noProducers);
    const fixed = await brainWorkOverview(env);
    expect({
      ran,
      markedWhileBroken,
      failed: whileBroken.stepsFailed.repack,
      markedAfter: await markedBlocks(),
      cleared: fixed.stepsFailed.repack,
    }).toStrictEqual({
      ran: 1,
      markedWhileBroken: before,
      failed: { at, reason: "failed" },
      markedAfter: Math.max(0, before - repackPerTick),
      cleared: null,
    });
  });

  it("takes a centre of -0 as the same centre as one of 0", async () => {
    const model = newModel();
    const reader = { person: readers.few, groups: [] };
    const coded = randomly(company.own);
    const [first, ...rest] = coded;
    await put(model, first === undefined ? [] : [first]);
    await put({ ...model, centre: model.centre.map(() => -0) }, rest);
    const question = randomSigns();
    expect(rounded(await search(model, question, reader))).toStrictEqual(
      rounded(bruteForce(question, coded))
    );
  });

  it("keeps one code per chunk and model however often it is put", async () => {
    const model = newModel();
    const question = randomSigns();
    const reader = { person: readers.few, groups: [] };
    const coded = randomly(company.own);
    await put(model, coded);
    await put(model, coded);
    await put(model, randomly(company.own));
    expect(rounded(await search(model, question, reader, 50))).toStrictEqual(
      rounded(bruteForce(question, coded, 50))
    );
  });

  it("refuses vectors it can't code", async () => {
    const model = newModel();
    const [chunk] = company.own;
    if (chunk === undefined) {
      throw new Error("No chunk");
    }
    const zeros = model.centre.map(() => 0);
    for (const vector of [
      zeros,
      [...zeros.slice(1), Number.NaN],
      [...zeros.slice(1), Number.POSITIVE_INFINITY],
      [...zeros.slice(1), 1, 1],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await expect(put(model, [{ chunk, vector }])).rejects.toThrow(/refused/u);
    }
  });

  it("scores vectors of any finite size, stored and asked, as their direction alone", async () => {
    const model = newModel();
    const reader = { person: readers.few, groups: [] };
    const directions = randomly(company.own);
    // Tiny, smallest, huge and plain magnitudes of the same directions.
    const sizes = [1e-200, Number.MIN_VALUE, 1e200, 1e300, 1];
    await put(
      model,
      directions.map(({ chunk, vector }, index) => ({
        chunk,
        vector: vector.map((value) => value * (sizes[index] ?? 1)),
      }))
    );
    const question = randomSigns();
    const expected = rounded(bruteForce(question, directions));
    for (const size of [1e-200, 1e300]) {
      const asked = question.map((value) => value * size);
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const found = await search(model, asked, reader);
      expect(rounded(found)).toStrictEqual(expected);
      expect(
        found.every(({ score }) => score >= -1 && score <= 1)
      ).toBeTruthy();
    }
  });

  it("finds the nearest by cosine among real-valued vectors with a centre, when they are well inside the candidates", async () => {
    const model = {
      ...newModel(),
      centre: randomReals().map((value) => value / 10),
    };
    const reader = { person: principal("person"), groups: [readers.group] };
    const question = randomReals();
    const coded = company.shared.map((chunk) => ({
      chunk,
      vector: randomReals(),
    }));
    // Near ones, each a little farther, packed and in the tail.
    for (const [rank, at] of [5, 1500, 2150, 700, 2199].entries()) {
      const planted = coded[at];
      if (planted !== undefined) {
        planted.vector = question.map(
          (value) => value + (rank + 1) * 0.1 * (randomWord() / 2 ** 31 - 1)
        );
      }
    }
    await put(model, coded);
    const found = await search(model, question, reader, 5);
    const expected = bruteForce(question, coded, 5);
    expect(found.map(placeOf)).toStrictEqual(expected.map(placeOf));
    for (const [index, { score }] of found.entries()) {
      expect(score).toBeCloseTo(expected[index]?.score ?? 0, 2);
    }
  });

  it("finds the same chunks, in the same order and with the same scores, among real-valued vectors with a centre, whatever codes the reader may not read are stored", async () => {
    const model = {
      ...newModel(),
      centre: randomReals().map((value) => value / 10),
    };
    const reader = { person: principal("person"), groups: [readers.group] };
    const question = randomReals();
    await put(
      model,
      company.shared.map((chunk) => ({ chunk, vector: randomReals() }))
    );
    const alone = await search(model, question, reader, 50);
    const nearQuestion = (chunks: readonly ChunkRef[]): Coded[] =>
      chunks.map((chunk) => ({
        chunk,
        vector: question.map((value) => value + randomWord() / 2 ** 40),
      }));
    await put(model, nearQuestion(company.others));
    await put(model, nearQuestion(company.otherGroups));
    await put(model, nearQuestion(company.nobodys));
    await expect(search(model, question, reader, 50)).resolves.toStrictEqual(
      alone
    );
  });

  it("finds a new version with other readers for its readers alone, once its codes are put", async () => {
    const model = newModel();
    const question = randomSigns();
    const before = { person: principal("person"), groups: [] };
    const after = { person: principal("person"), groups: [] };
    const first = randomly(await sourceOf(owner(before.person), 3));
    await put(model, first);
    expect(rounded(await search(model, question, before))).toStrictEqual(
      rounded(bruteForce(question, first))
    );
    const source = first[0]?.chunk.source ?? "";
    const second = randomly(await newVersionOf(source, owner(after.person), 3));
    await expect(search(model, question, before)).resolves.toStrictEqual([]);
    await expect(search(model, question, after)).resolves.toStrictEqual([]);
    await put(model, second);
    expect(rounded(await search(model, question, after))).toStrictEqual(
      rounded(bruteForce(question, second))
    );
    await expect(search(model, question, before)).resolves.toStrictEqual([]);
  });

  it("deletes a block once every code in it is removed, without a repack", async () => {
    const model = newModel();
    const person = principal("person");
    // Exactly one block, and no tail.
    const coded = randomly(await sourceOf(owner(person), block));
    await put(model, coded);
    const source = coded[0]?.chunk.source ?? "";
    const removed = await rowsOf(source, 1);
    const packed = await codedRows();
    expect(removed.filter((row) => !packed.has(row))).toStrictEqual([]);
    await newVersionOf(source, owner(person), 1);
    const left = await codedRows();
    expect(removed.filter((row) => left.has(row))).toStrictEqual([]);
  });
});
