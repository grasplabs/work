import { exactCandidatesMax, recallLimit } from "./contract.ts";
import type {
  FoundBy,
  FoundMemory,
  FoundPassage,
  Finding,
  OrderedPassage,
  Pack,
} from "./contract.ts";
import { exactsOf, foundIn } from "./exact.ts";
import { byBytes, byNearness } from "./order.ts";
import { fuse, packOf } from "./pack.ts";
import type { Entry } from "./pack.ts";
import { sequenceOf, termsOf } from "./words.ts";

// A recall's pack from what one store or several found (`Finding`, each a
// store's `find`): the stores a reader may read from are searched apart,
// and their lists are merged here into the lists one store holding all of
// them would have found, then fused and packed (pack.ts) as recall.ts
// specifies. A store's own `recall` is this over that store alone.
//
// Why merging is exact: every way orders a passage by what it holds itself
// (recall.ts: never BM25, no count over other rows), so the order is a
// total order over passages, whatever store holds them, and the first N of
// all stores together are among the first N of each. Per way:
//
// - Words: the passages the question's telling words find, by how many of
//   them, of its stop words and of its telling words as written each
//   holds, then shorter, newer, by source and place; the first
//   `recallLimit` of all. Then, when those are fewer, as many of the
//   passages only its stop words find as are missing: a store asked for
//   them when its own were fewer, and asked for at least as many as all
//   together are missing. Which telling words were found is what any
//   store found.
// - Exact: for each part, a store gives its first `exactCandidatesMax`
//   candidates in the statement's order (held as a phrase in the word
//   index first, then shorter, newer, by source and place), and says when
//   it had more (`capped`). The first `exactCandidatesMax` of all are
//   among those; a part is capped when a store capped it or all together
//   give more. Only then is each candidate checked to hold the part as
//   written, and each part's list ordered by the merged words list's
//   rank, as one store does.
// - Meaning: each store's nearest, by cosine, merged by cosine. One store
//   re-scores the `rescoreCandidates` codes nearest by Hamming distance
//   (vectors.ts), so two stores re-score up to twice as many: a passage
//   one store holding both would have passed over may come in, nearer
//   than one it would have kept; never one less near. With at most that
//   many codes in all, it is the same.
//
// Ties between stores go to the store given first (`findings`' order), so
// the order is total even for a source held twice. A chunk's row is its
// store's; here it is made unique over all stores.

/** A passage of the store `store` (its index in `findings`). */
type Of<T extends FoundPassage> = T & { store: number };

/** After a way's counts: shorter, newer, by source and place, then store. */
const byPassage = (a: Of<OrderedPassage>, b: Of<OrderedPassage>): number =>
  a.length - b.length ||
  b.addedAt - a.addedAt ||
  byBytes(a.source, b.source) ||
  a.position - b.position ||
  a.store - b.store;

/** Every store's `pick` of its finding, tagged with its store, its row made unique. */
const allOf = <T extends FoundPassage>(
  findings: readonly Finding[],
  pick: (finding: Finding) => readonly T[]
): Of<T>[] =>
  findings.flatMap((finding, store) =>
    pick(finding).map((passage) => ({
      ...passage,
      row: passage.row * findings.length + store,
      store,
    }))
  );

/** `passage` as an entry of a way's list (pack.ts), found by `how`. */
const foundAs = (
  { row, source, version, position, text }: FoundPassage,
  how: FoundBy
): Entry => ({
  kind: "passage",
  key: `passage ${row}`,
  passage: { row, source, version, position, text, found: how },
});

/** The words way's list, best first, and the telling terms it found. */
const byWords = (
  findings: readonly Finding[]
): { found: Entry[]; terms: Set<number> } => {
  const telling = allOf(findings, ({ words }) => words)
    .toSorted(
      (a, b) =>
        b.words - a.words ||
        b.stops - a.stops ||
        b.exact - a.exact ||
        byPassage(a, b)
    )
    .slice(0, recallLimit);
  const stops = allOf(findings, ({ stopWords }) => stopWords)
    .toSorted((a, b) => b.stops - a.stops || byPassage(a, b))
    .slice(0, recallLimit - telling.length);
  return {
    found: [
      ...telling.map((passage) => foundAs(passage, "words")),
      ...stops.map((passage) => foundAs(passage, "stop words")),
    ],
    terms: new Set(findings.flatMap(({ terms }) => terms)),
  };
};

/**
 * The exact way's lists, one per part, the parts it found and those it
 * capped, its lists in the words way's order (`byWordsRank`).
 */
const byExact = (
  findings: readonly Finding[],
  exacts: ReturnType<typeof exactsOf>,
  byWordsRank: ReadonlyMap<number, number>
): { lists: Entry[][]; parts: Set<number>; capped: Set<number> } => {
  const candidates = allOf(findings, ({ exact }) => exact);
  const capped = new Set(findings.flatMap((finding) => finding.capped));
  // Each part's first `exactCandidatesMax` of all stores, as one store's
  // statement ranks them.
  const among = new Map<number, number[]>();
  for (const [part] of exacts.entries()) {
    const ranked = candidates
      .filter(({ parts }) => parts.includes(part))
      .toSorted(
        (a, b) =>
          Number(b.nearParts.includes(part)) -
            Number(a.nearParts.includes(part)) || byPassage(a, b)
      );
    if (ranked.length > exactCandidatesMax) {
      capped.add(part);
    }
    for (const { row } of ranked.slice(0, exactCandidatesMax)) {
      among.set(row, [...(among.get(row) ?? []), part]);
    }
  }
  const held = candidates.map((candidate) => ({
    candidate,
    parts: new Set(
      foundIn(
        sequenceOf(candidate.text),
        exacts,
        among.get(candidate.row) ?? []
      )
    ),
  }));
  const rankOf = ({ row }: FoundPassage): number =>
    byWordsRank.get(row) ?? recallLimit;
  const lists = exacts.map((_, part) =>
    held
      .filter(({ parts }) => parts.has(part))
      .map(({ candidate }) => candidate)
      .toSorted((a, b) => rankOf(a) - rankOf(b) || byPassage(a, b))
      .slice(0, recallLimit)
      .map((passage) => foundAs(passage, "exact"))
  );
  return {
    lists,
    parts: new Set(
      lists.flatMap((list, part) => (list.length > 0 ? [part] : []))
    ),
    capped,
  };
};

/** The meaning way's list: the nearest of all stores, by cosine. */
const byMeaning = (findings: readonly Finding[]): Entry[] =>
  allOf(findings, ({ meaning }) => meaning)
    .toSorted((a, b) => byNearness(a, b) || a.store - b.store)
    .slice(0, recallLimit)
    .map((passage) => foundAs(passage, "meaning"));

/** A memory of the store `store`, as merged. */
type MemoryOf = FoundMemory & { store: number };

/** A memory's key in the fused lists: its store's and its id. */
const memoryKeyOf = ({ store, id }: MemoryOf): string =>
  `memory ${store} ${id}`;

/** After a way's own order: confirmed first, then newer, then by store and row. */
const byMemory = (a: MemoryOf, b: MemoryOf): number =>
  Number(a.confirmed === null) - Number(b.confirmed === null) ||
  b.learnedAt.getTime() - a.learnedAt.getTime() ||
  a.store - b.store ||
  b.row - a.row;

/**
 * The memory ways' lists, merged over the stores as one store's
 * statements order them (memories.ts, recall-memories.ts): by words, more
 * of the question's telling words first, then more as written; along
 * entities, the nearest step first; each then as `byMemory`, the first
 * `recallLimit` of all. A contested memory carries the other sides its
 * store found (an entity is one store's: sides are never across stores).
 */
const memoriesOf = (
  findings: readonly Finding[]
): { words: Entry[]; entities: Entry[] } => {
  const tagged = (pick: (memories: Finding["memories"]) => FoundMemory[]) =>
    findings.flatMap((finding, store) =>
      pick(finding.memories).map((memory) => ({ ...memory, store }))
    );
  const all = [
    ...tagged(({ words }) => words),
    ...tagged(({ entities }) => entities),
    ...tagged(({ rivals }) => rivals),
  ];
  const rivalsOf = (memory: MemoryOf) =>
    memory.contested
      ? all
          .filter(
            (other) =>
              other.store === memory.store &&
              other.id !== memory.id &&
              other.contested &&
              other.about === memory.about &&
              other.attribute === memory.attribute
          )
          .filter(
            (other, index, list) =>
              list.findIndex(({ id }) => id === other.id) === index
          )
          .map((other) => ({ key: memoryKeyOf(other), memory: other }))
      : [];
  const entryOf = (memory: MemoryOf, found: "words" | "entities"): Entry => ({
    kind: "memory",
    key: memoryKeyOf(memory),
    memory,
    found,
    rivals: rivalsOf(memory),
  });
  return {
    words: tagged(({ words }) => words)
      .toSorted(
        (a, b) => b.words - a.words || b.exact - a.exact || byMemory(a, b)
      )
      .slice(0, recallLimit)
      .map((memory) => entryOf(memory, "words")),
    entities: tagged(({ entities }) => entities)
      .toSorted((a, b) => a.step - b.step || byMemory(a, b))
      .slice(0, recallLimit)
      .map((memory) => entryOf(memory, "entities")),
  };
};

/**
 * The pack for `question` within `budget` tokens from what `findings` (one
 * per store, each `find` of the same request) found: the stores' lists
 * merged per way, fused by rank (the exact parts' first on a tie, in the
 * question's order, then words, then meaning) and packed, with the parts
 * of the question no store found by words or exact: its exact parts, but
 * those capped, then its telling words, but those of its IDs. The same
 * pack, for one finding, as recall.ts has always made.
 */
export const packAcross = (
  question: string,
  budget: number,
  findings: readonly Finding[]
): Pack => {
  const exacts = exactsOf(question);
  const terms = termsOf(question);
  // An ID stands for its words: none is said not found apart.
  const standing = new Set(
    exacts.filter(({ kind }) => kind === "id").flatMap(({ words }) => words)
  );
  const words = byWords(findings);
  const exact = byExact(
    findings,
    exacts,
    new Map(
      words.found.flatMap((entry, rank) =>
        entry.kind === "passage" ? [[entry.passage.row, rank]] : []
      )
    )
  );
  const notFound = [
    ...exacts
      .filter((_, index) => !exact.parts.has(index) && !exact.capped.has(index))
      .map(({ asked: part }) => part),
    ...terms.telling
      .filter(
        ({ word }, index) => !words.terms.has(index) && !standing.has(word)
      )
      .map(({ word }) => word),
  ];
  const memories = memoriesOf(findings);
  return packOf(
    fuse([
      ...exact.lists,
      words.found,
      memories.words,
      memories.entities,
      byMeaning(findings),
    ]),
    { terms: terms.telling, exacts },
    budget,
    notFound
  );
};
