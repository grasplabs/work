import type {
  Access,
  ChunkRef,
  FoundChunk,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// The vector way of the Brain's store (GRA-1766), through the store's
// contract: codes are put for chunks of current versions, packed in
// blocks of 1,024 with the newest in a tail, and searched by an exact
// scan with the access check inside it. From the threat model on the
// issue: a search returns exactly the nearest chunks the reader may read,
// as brute force over those alone does; codes the reader may not read,
// packed or in the tail, change nothing of what they find; nobody finds a
// source nobody is known to read; a change in membership holds from the
// next search; a new version's codes replace the old ones' at once, and a
// late put brings nothing back; a repack drops removed codes for good;
// codes of two models or builds are never compared; and a put or a
// repack that breaks half-way leaves the store as it was.
//
// Vectors here are made of +1 and -1 alone, with a centre of zeros: their
// codes are then exact (the 1-bit Hamming distance orders them as their
// cosine does, and the 8-bit code holds them whole), so brute force over
// the full vectors is the answer the scan must give, ties to the chunk
// added first.

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

/** Random +1 and -1, from a seed of their own, so runs repeat. */
const randomSigns = (() => {
  let state = 0x9e_37_79_b9;
  return (): number[] =>
    Array.from({ length: dimensions }, () => {
      // oxlint-disable-next-line no-bitwise -- xorshift
      state ^= state << 13;
      // oxlint-disable-next-line no-bitwise -- xorshift
      state ^= state >>> 17;
      // oxlint-disable-next-line no-bitwise -- xorshift
      state ^= state << 5;
      // oxlint-disable-next-line no-bitwise -- the lowest bit
      return (state & 1) === 0 ? -1 : 1;
    });
})();

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

/** Repacks one block holding removed codes: true when more are left. */
const repack = async (): Promise<boolean> => await store().repackVectors();

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
});
