import {
  brainOf,
  recallBudgetMax,
  recallLimit,
} from "@grasp-os/brain-next/contract";
import type { ChunkRef, FoundChunk } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, readSourceVersionAs, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { seededRandom } from "./brain-scoring.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The random permission test (GRA-1722). From a seed: teams, sources with
// random words and readers, new versions of them with other readers, other
// text or both, and changes in who is in which team between recalls, all
// through core, with membership in core's own records. Every recall must
// return exactly the answer a brute-force reading of the contract builds
// here, apart from the store's SQL and its folding; and once a round,
// every version of every source, read as history by every person, must
// be exactly what the contract says. So no result may be one the reader
// may not read, none may be missing because hidden or superseded ones
// took its place, they may not move the order, and no field may tell
// that they exist. A membership change counts from the very next recall:
// the person it changed asks at once.
//
// The brute-force answers are the specification, written once; the
// issues that change ranking (stemming, exact matches, vectors) change it
// here, on purpose:
//
// - Recall (GRA-1725): a question's words are its telling words and its
//   stop words; a question of stop words alone is all telling. The chunks
//   of current versions the reader may read that hold one of its telling
//   words in any of its forms come first: those holding more of its
//   distinct telling words, then more of its stop words, then more of its
//   telling words in the very form asked, then the shorter, then (in one
//   version) the earlier in it. When they are fewer than `recallLimit`,
//   the readable chunks holding only its stop words follow: more of them
//   first, then as above. At most `recallLimit`. A version replaced by a
//   newer one is never in it.
// - Exact (GRA-1728): the words of roots a and b hold a digit, so they are
//   IDs (those of c and d are letters alone); the words way asks them too. For each, in the
//   question's order, a list: the chunks of current versions the reader
//   may read that hold it as written, in the words list's order, then the
//   shorter; at most `recallLimit`.
//   No question here has a quoted phrase.
// - The pack (GRA-1728): the ID lists and the words list fused by
//   reciprocal rank (1 / (60 + rank), summed; ties to the better rank,
//   then to the list given first), each chunk whole at the largest budget,
//   found "exact" when an ID list holds it, else by its words or its
//   stop words alone. Not found: the IDs no readable current chunk holds,
//   as written, then the telling words none holds in any form, folded,
//   but the IDs' own. Never cut short.
// - By meaning (GRA-1769): half the questions are asked of the store with
//   a vector of their own too, for the scenario's model. Its list, given
//   after the words list: the chunks a vector search returns (below), at
//   most `recallLimit`; a chunk it alone holds is found "meaning". It
//   changes nothing of what is not found.
// - History: a version, whole, to a person among its readers and among
//   the current version's readers, with the teams they are in now; to
//   anyone else exactly what a source no one added answers (null).
// - Vectors: every chunk of a current version holds a vector of its own,
//   put through the store as the queue will; a search returns the chunks
//   of current versions the reader may read, nearest the question by
//   cosine, ties to the chunk added first, at most `vectorLimit`, each
//   with its cosine. The vectors are +1 and -1 alone with a centre of
//   zeros, where the store's 1-bit order is the cosine's and its 8-bit
//   codes are whole, so the answer is exact however many it re-scores.
//
// Words: forms and stop words are exercised on purpose, without asking
// the store's stemmer what they are. Each scenario has four roots, one per
// letter, each written in three forms built on Dutch and English endings
// ("<prefix><letter>kamp", "…kamps", "…kampen"): forms of one root by
// construction, which the five stemmers reduce alike and never to another
// root's (checked over thousands of prefixes when the vocabulary was
// chosen). And a few real stop words of the five languages, which no
// other word matches. So the answer here compares roots and forms by the
// plan, never by stemming.
//
// Chunks: a version is one paragraph, shorter than a chunk, or several
// paragraphs each too long to share a chunk with another (over half the
// chunk target of 1,200 characters, under the most of 2,000), so each is
// a chunk of its own, in order. Length is a chunk's characters; the texts
// are ASCII, so code units agree. Every paragraph of every version has a
// length of its own, so no two chunks tie on length and an order keyed on
// anything shared by a version's chunks shows. What decides between
// chunks that tie (the newer version, the source's key, the place) is out
// of its reach, and so is a leak that shows only in how those ties fall.
// Not part of this specification, and so out of its reach: cutting a
// question short (questions stay under the store's limit of 16 words);
// words over 64 characters, matched only as written; accented words and
// the stems of a word as written (every word here is plain ASCII); and
// ties on length (no two chunks share one).
//
// People are signed in for each seed, so the stop words every scenario
// shares never find another seed's sources.
//
// There are enough sources that a reader often has more matches than a
// recall returns, with hidden and superseded ones among them, so the cut
// is part of every answer it can be.
//
// A failure names its seed, what to run to see it again, and only what
// bears on it: the moment, the reader's teams, the question, the changes
// in membership so far and the sources holding its words. CI runs the
// first `defaultSeeds`; vite.brain-random.config.ts as many as asked.
//
// The seeded generator is the repository's own (brain-scoring.ts), not a
// property-testing library: the catalog has none, and a library's
// shrinking would rerun a failure hundreds of times against a store that
// keeps what earlier runs added, at dozens of calls into workerd each.

const idp = mockIdp();

/** Seeds CI runs on every change. */
const defaultSeeds = 20;

/** Which seeds to run: CI's, or a run's own (vite.brain-random.config.ts). */
const { from, count } = z
  .object({ from: z.number().int(), count: z.number().int().positive() })
  .default({ from: 1, count: defaultSeeds })
  .parse(testBinding("BRAIN_RANDOM"));

const seeds = Array.from({ length: count }, (_, index) => from + index);

/** People in every scenario, signed in once. */
const peopleCount = 3;

/** Rounds of adding sources, recalling and changing membership. */
const rounds = 3;

/** Most sources and versions a round adds. */
const addedPerRound = 30;

/** Most questions each person asks each round: 1 to this many. */
const mostQuestionsPerRound = 3;

/** Most words a paragraph holds, before its filler. */
const mostWordsPerParagraph = 4;

/** Most paragraphs a long version has. */
const mostParagraphs = 3;

/**
 * The shortest a paragraph of a long version is: over half the chunk
 * target, so no two share a chunk.
 */
const longParagraph = 650;

/** Dimensions of the scenario's vectors: few, so the puts are cheap. */
const vectorDimensions = 64;

/** Most chunks a vector search returns here. */
const vectorLimit = 10;

/** The Brain's store, by its contract: the vector way has no core function yet. */
const brainStore = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A chunk's place, as a key. */
const placeKey = ({ source, version, position }: ChunkRef): string =>
  `${source} v${version} c${position}`;

/** A score as the comparison reads it: the store's and brute force's agree to this. */
const roundedScore = (score: number): number => Math.round(score * 1e9) / 1e9;

/** A scenario's roots, one per letter: few, so sources share words. */
const letters = ["a", "b", "c", "d"] as const;

/**
 * The endings of a root's three forms: Dutch and English endings the
 * stemmers take off alike, so the forms of one root match each other and
 * never another root's.
 */
const formEndings = ["kamp", "kamps", "kampen"] as const;

/**
 * Stop words of the five languages (Dutch, English, German, French,
 * Spanish), which no other word matches and none of which matches
 * another: few, so chunks share them.
 */
const stopWords = ["de", "het", "the", "und", "les", "los"] as const;

/**
 * A planned word: a root's form (`a1` is root a in its second form) or a
 * stop word (`~de`).
 */
type Token = string;

const stopPrefix = "~";

const isStop = (token: Token): boolean => token.startsWith(stopPrefix);

/** Whether a token's word is an ID: roots a and b (`vocabulary`). */
const isId = (token: Token): boolean =>
  !isStop(token) && (token.startsWith("a") || token.startsWith("b"));

/** A token's root: its letter, or the stop word itself. */
const rootOf = (token: Token): string =>
  isStop(token) ? token : token.slice(0, 1);

/** The draws a scenario is made of, from its seed. */
const drawsOf = (seed: number) => {
  const next = seededRandom(seed);
  const below = (bound: number): number => Math.floor(next() * bound);
  return {
    below,
    chance: (probability: number): boolean => next() < probability,
    /** 1 to `most` words: mostly forms of roots, a stop word in `stops` of them. */
    tokens: (most: number, stops: number): Token[] =>
      Array.from({ length: 1 + below(most) }, () =>
        next() < stops
          ? `${stopPrefix}${stopWords[below(stopWords.length)] ?? "de"}`
          : `${letters[below(letters.length)] ?? "a"}${below(formEndings.length)}`
      ),
  };
};
type Draws = ReturnType<typeof drawsOf>;

/** Who may read a planned version: indexes into the people and teams. */
type Readers =
  | { kind: "owner"; person: number }
  | { kind: "team"; team: number }
  | { kind: "none" };

/** A version as the brute-force answer knows it. */
interface Version {
  /** Its number, from 1. */
  version: number;
  /** Each paragraph's words, as planned: each paragraph is one chunk. */
  paragraphs: Token[][];
  readers: Readers;
  /**
   * The length of each of its paragraphs, which no other paragraph has:
   * the words, then filler up to it.
   */
  lengths: number[];
}

/** A source as the brute-force answer knows it: every version of it. */
interface Planned {
  /** Its name in a failure: `s<index>`. */
  index: number;
  /** The source, as its producer names it. */
  source: SourceRef;
  /** Its versions, oldest first: the last is current. */
  versions: Version[];
}

/** A source's current version. */
const currentOf = ({ versions }: Planned): Version => {
  const current = versions.at(-1);
  if (current === undefined) {
    throw new Error("A planned source has no version");
  }
  return current;
};

/**
 * Words no other scenario has: each root behind its seed's own prefix, and
 * the stop words as they are. Lowercase ASCII letters and digits, which
 * search reads as they are: the brute-force answer compares tokens, never
 * folds or stems.
 */
const vocabulary = (seed: number) => {
  // From the seed, so a failure that turns on the words comes back with it.
  const hex = Math.floor(seededRandom(seed)() * 2 ** 32)
    .toString(16)
    .padStart(8, "0");
  // Roots a and b with two digits, so their words are IDs (the exact way);
  // c and d of letters alone, each digit a consonant, so they are words.
  const idPrefix = `r11${hex.slice(2)}`;
  const wordPrefix = `r${hex.replaceAll(/\d/gu, (digit) => "ghjklmnpst".charAt(Number(digit)))}`;
  return (token: Token): string =>
    isStop(token)
      ? token.slice(stopPrefix.length)
      : `${isId(token) ? idPrefix : wordPrefix}${token.slice(0, 1)}${formEndings[Number(token.slice(1))] ?? ""}`;
};

/** Characters of the longest word: "r", eight hex digits, its letter and ending. */
const wordLength = 10 + Math.max(...formEndings.map(({ length }) => length));

/** Characters the longest list of words takes, with a space after it. */
const mostWords = mostWordsPerParagraph * (wordLength + 1);

/**
 * Characters the place of a paragraph takes in its text, with spaces: so
 * two paragraphs of the same words still read apart. No question asks
 * for it.
 */
const placeLength = 4;

/** One paragraph: its words, its place, then filler up to `length`. */
const paragraphText = (
  words: readonly Token[],
  position: number,
  length: number,
  wordOf: (token: Token) => string
): string => `${words.map(wordOf).join(" ")} p${position} `.padEnd(length, "q");

/** A paragraph of `version`'s text. */
const paragraphOf = (
  version: Version,
  position: number,
  wordOf: (token: Token) => string
): string =>
  paragraphText(
    version.paragraphs[position] ?? [],
    position,
    version.lengths[position] ?? 0,
    wordOf
  );

/** A version's text: its paragraphs, a blank line between. */
const textOf = (version: Version, wordOf: (token: Token) => string) =>
  version.paragraphs
    .map((_, position) => paragraphOf(version, position, wordOf))
    .join("\n\n");

/** Who is in which team: `person:team` for each pair. */
type Membership = Set<string>;

const memberKey = (person: number, team: number): string => `${person}:${team}`;

/** Whether `person` is among `readers`: the brute-force answer. */
const isAmong = (
  readers: Readers,
  person: number,
  membership: Membership
): boolean => {
  if (readers.kind === "owner") {
    return readers.person === person;
  }
  if (readers.kind === "team") {
    return membership.has(memberKey(person, readers.team));
  }
  return false;
};

/** Whether `words` hold one of the asked words, in any of its forms. */
const holds = (words: readonly Token[], asked: readonly Token[]): boolean =>
  asked.some((token) => words.some((word) => rootOf(word) === rootOf(token)));

/** Draws who may read a version: mostly a person or a team, sometimes nobody. */
const drawReaders = (draws: Draws, teamCount: number): Readers => {
  const roll = draws.below(20);
  if (roll < 9) {
    return { kind: "owner", person: draws.below(peopleCount) };
  }
  if (roll < 17) {
    return { kind: "team", team: draws.below(teamCount) };
  }
  return { kind: "none" };
};

const describeReaders = (readers: Readers): string => {
  if (readers.kind === "owner") {
    return `p${readers.person}'s own`;
  }
  if (readers.kind === "team") {
    return `team t${readers.team}`;
  }
  return "no known readers";
};

const describeSource = (planned: Planned): string =>
  `s${planned.index}: ${planned.versions
    .map(
      ({ version, paragraphs, readers, lengths }) =>
        `v${version} ${paragraphs
          .map(
            (words, position) =>
              `"${words.join(" ")}" (${lengths[position] ?? 0})`
          )
          .join(" / ")} (${describeReaders(readers)})`
    )
    .join("; ")}`;

/** A chunk the brute-force answer expects, and its name in a failure. */
interface ExpectedChunk {
  name: string;
  planned: Planned;
  version: Version;
  position: number;
  length: number;
  /** Distinct telling words it holds, in any form. */
  telling: number;
  /** Distinct stop words it holds. */
  stops: number;
  /** Distinct telling words it holds in the very form asked. */
  exact: number;
}

/**
 * What `person` may read of the current versions' chunks for `asked`,
 * best first, as the contract states it (above), at most `recallLimit`.
 */
const expectedOf = (
  planned: readonly Planned[],
  person: number,
  membership: Membership,
  asked: readonly Token[]
): ExpectedChunk[] => {
  const distinct = [...new Set(asked)];
  const askedStops = distinct.filter(isStop);
  const askedTelling = distinct.filter((token) => !isStop(token));
  // A question of stop words alone is all telling.
  const [telling, stops] =
    askedTelling.length > 0 ? [askedTelling, askedStops] : [askedStops, []];
  const readable = planned.flatMap((source) => {
    const version = currentOf(source);
    if (!isAmong(version.readers, person, membership)) {
      return [];
    }
    return version.paragraphs.map((words, position) => ({
      name: `s${source.index} v${version.version} c${position}`,
      planned: source,
      version,
      position,
      length: version.lengths[position] ?? 0,
      telling: telling.filter((token) => holds(words, [token])).length,
      stops: stops.filter((token) => words.includes(token)).length,
      exact: telling.filter((token) => words.includes(token)).length,
    }));
  });
  const first = readable
    .filter((chunk) => chunk.telling > 0)
    .toSorted(
      (a, b) =>
        b.telling - a.telling ||
        b.stops - a.stops ||
        b.exact - a.exact ||
        a.length - b.length ||
        a.position - b.position
    );
  const after =
    first.length < recallLimit
      ? readable
          .filter((chunk) => chunk.telling === 0 && chunk.stops > 0)
          .toSorted(
            (a, b) =>
              b.stops - a.stops ||
              a.length - b.length ||
              a.position - b.position
          )
      : [];
  return [...first, ...after].slice(0, recallLimit);
};

/** How the pack says a chunk was found. */
type FoundBy = "exact" | "words" | "stop words" | "meaning";

/** A chunk the pack expects, by the list or lists that hold it. */
interface Packed extends ExpectedChunk {
  found: FoundBy;
}

/**
 * For each of the question's IDs, a list: the chunks of current versions
 * `person` may read holding it as written, in the order of `byWords` (the
 * words list), then the shorter, at most `recallLimit`; and which IDs any
 * of them holds. The store breaks a tie on length by the newer version,
 * then the source, then the place; no two chunks here share a length, so
 * those never decide. Every part's candidates here are far fewer than the
 * store's cap, so the cap never cuts one.
 */
const exactOf = (
  planned: readonly Planned[],
  person: number,
  membership: Membership,
  ids: readonly Token[],
  byWords: readonly ExpectedChunk[]
): { lists: ExpectedChunk[][]; held: Set<Token> } => {
  const rankOf = (name: string): number => {
    const rank = byWords.findIndex((chunk) => chunk.name === name);
    return rank === -1 ? recallLimit : rank;
  };
  const held = new Set<Token>();
  const chunks = planned
    .flatMap((source) => {
      const version = currentOf(source);
      if (!isAmong(version.readers, person, membership)) {
        return [];
      }
      return version.paragraphs.map((words, position) => {
        const holding = ids.filter((id) => words.includes(id));
        for (const id of holding) {
          held.add(id);
        }
        return {
          name: `s${source.index} v${version.version} c${position}`,
          planned: source,
          version,
          position,
          length: version.lengths[position] ?? 0,
          telling: holding.length,
          stops: 0,
          exact: holding.length,
        };
      });
    })
    .filter(({ exact }) => exact > 0);
  // A list per ID, in the question's order.
  const lists = ids.map((id) =>
    chunks
      .filter(({ version, position }) =>
        (version.paragraphs[position] ?? []).includes(id)
      )
      .toSorted(
        (a, b) => rankOf(a.name) - rankOf(b.name) || a.length - b.length
      )
      .slice(0, recallLimit)
  );
  return { lists, held };
};

/** Reciprocal rank fusion's constant: the store's. */
const fusionK = 60;

/** `lists`, fused by reciprocal rank (the store's rule, above). */
const fused = (
  lists: readonly (readonly { chunk: ExpectedChunk; found: FoundBy }[])[]
): Packed[] => {
  const scored = new Map<
    string,
    { chunk: Packed; score: number; best: number; list: number }
  >();
  for (const [list, ranked] of lists.entries()) {
    for (const [index, { chunk, found }] of ranked.entries()) {
      const rank = index + 1;
      const known = scored.get(chunk.name);
      if (known === undefined) {
        scored.set(chunk.name, {
          chunk: { ...chunk, found },
          score: 1 / (fusionK + rank),
          best: rank,
          list,
        });
      } else {
        known.score += 1 / (fusionK + rank);
        if (rank < known.best) {
          known.best = rank;
          known.list = list;
        }
      }
    }
  }
  return [...scored.values()]
    .toSorted((a, b) => b.score - a.score || a.best - b.best || a.list - b.list)
    .map(({ chunk }) => chunk);
};

/**
 * The pack `person` gets for `asked`, written as the question wrote each
 * word (`written`): the fused chunks, and what was not found.
 */
const packOf = (
  planned: readonly Planned[],
  person: number,
  membership: Membership,
  asked: readonly Token[],
  written: (token: Token) => string,
  wordOf: (token: Token) => string,
  meant: readonly ExpectedChunk[]
): { chunks: Packed[]; notFound: string[] } => {
  // The IDs, each once, in the question's order: the words of roots a and
  // b.
  const ids = [...new Set(asked.filter(isId))];
  const byWords = expectedOf(planned, person, membership, asked);
  const exact = exactOf(planned, person, membership, ids, byWords);
  const chunks = fused([
    ...exact.lists.map((list) =>
      list.map((chunk) => ({ chunk, found: "exact" as const }))
    ),
    byWords.map((chunk) => ({
      chunk,
      found: chunk.telling > 0 ? ("words" as const) : ("stop words" as const),
    })),
    meant.map((chunk) => ({ chunk, found: "meaning" as const })),
  ]);
  const missing = ids.filter((id) => !exact.held.has(id));
  // The telling words, each once, in the question's order; a question of
  // stop words alone is all telling.
  const distinct = [...new Set(asked)];
  const telling = distinct.some((token) => !isStop(token))
    ? distinct.filter((token) => !isStop(token) && !isId(token))
    : distinct;
  const readable = planned.flatMap((source) => {
    const version = currentOf(source);
    return isAmong(version.readers, person, membership)
      ? version.paragraphs
      : [];
  });
  return {
    chunks,
    notFound: [
      ...missing.map(written),
      ...telling
        .filter((token) => !readable.some((words) => holds(words, [token])))
        .map(wordOf),
    ],
  };
};

/** What one recall broke, if anything: by chunk, then the whole answer. */
const problemsOf = ({
  got,
  expected,
  answer,
  expectedAnswer,
}: {
  got: readonly string[];
  expected: readonly string[];
  answer: unknown;
  expectedAnswer: unknown;
}): string[] => {
  const problems: string[] = [];
  const outside = got.filter((name) => !expected.includes(name));
  if (outside.length > 0) {
    problems.push(
      `got [${outside.join(", ")}], which the reader may not read, which are superseded, which hold none of its words, or which come past the limit`
    );
  }
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    problems.push(
      `got [${got.join(", ")}], but expected [${expected.join(", ")}]`
    );
  }
  if (
    problems.length === 0 &&
    JSON.stringify(answer) !== JSON.stringify(expectedAnswer)
  ) {
    problems.push(
      `answered ${JSON.stringify(answer)}, but expected exactly ${JSON.stringify(expectedAnswer)}`
    );
  }
  return problems;
};

/**
 * One seed's scenario, through core, with the brute-force answer beside
 * it: what it added, who is in which team, and what went wrong.
 */
const scenario = (people: readonly string[], seed: number) => {
  const draws = drawsOf(seed);
  const teamIds = Array.from({ length: 1 + draws.below(3) }, () =>
    crypto.randomUUID()
  );
  const membership: Membership = new Set();
  const history: string[] = [];
  const wordOf = vocabulary(seed);
  const versionsMost = rounds * addedPerRound;
  /** Lengths for one-paragraph versions, and for long ones: each used once. */
  const shortLengths = Array.from(
    { length: versionsMost },
    (_, index) => mostWords + placeLength + 1 + index
  );
  const longLengths = Array.from(
    { length: versionsMost * mostParagraphs },
    (_, index) => longParagraph + index
  );
  const planned: Planned[] = [];
  /** The order versions were added in, which the store's chunks keep. */
  const addOrder = new Map<Version, number>();
  const nextSign = seededRandom(seed * 7919 + 17);
  const signs = (): number[] =>
    Array.from({ length: vectorDimensions }, () => (nextSign() < 0.5 ? -1 : 1));
  /** Each chunk's vector, by its place. */
  const vectors = new Map<string, number[]>();
  const vectorModel = {
    name: `random-${crypto.randomUUID()}@1`,
    centre: Array.from({ length: vectorDimensions }, () => 0),
  };
  const personId = (person: number): string => people[person] ?? "";
  const teamId = (team: number): string => teamIds[team] ?? "";
  /** Who may read a planned version, as core names them. */
  const asCore = (readers: Readers): SourceReaders => {
    if (readers.kind === "owner") {
      return { kind: "owner", personId: personId(readers.person) };
    }
    if (readers.kind === "team") {
      return { kind: "team", teamId: teamId(readers.team) };
    }
    return readers;
  };

  /** Puts `person` in `team` or takes them out, in core's records. */
  const toggle = async (person: number, team: number): Promise<void> => {
    const key = memberKey(person, team);
    if (membership.has(key)) {
      membership.delete(key);
      await drizzle(env.DB)
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId(team)),
            eq(teamMembers.userId, personId(person))
          )
        );
      history.push(`p${person} left t${team}`);
      return;
    }
    membership.add(key);
    await drizzle(env.DB)
      .insert(teamMembers)
      .values({
        id: crypto.randomUUID(),
        teamId: teamId(team),
        userId: personId(person),
        createdAt: new Date(),
      });
    history.push(`p${person} joined t${team}`);
  };

  const start = async (): Promise<void> => {
    await drizzle(env.DB)
      .insert(teams)
      .values(
        teamIds.map((id) => ({
          id,
          name: `Team ${id}`,
          organizationId,
          createdAt: new Date(),
        }))
      );
    for (let person = 0; person < peopleCount; person += 1) {
      for (let team = 0; team < teamIds.length; team += 1) {
        if (draws.chance(0.5)) {
          // oxlint-disable-next-line no-await-in-loop -- one change at a time
          await toggle(person, team);
        }
      }
    }
  };

  /**
   * New text: one short paragraph mostly, sometimes several long ones,
   * each with words of its own and a length no paragraph had.
   */
  const drawText = (): Pick<Version, "paragraphs" | "lengths"> => {
    const long = draws.chance(0.25);
    const pool = long ? longLengths : shortLengths;
    const paragraphs = Array.from(
      { length: long ? 2 + draws.below(mostParagraphs - 1) : 1 },
      () => draws.tokens(mostWordsPerParagraph, 0.3)
    );
    const lengths = paragraphs.map(
      () => pool.splice(draws.below(pool.length), 1)[0] ?? 0
    );
    return { paragraphs, lengths };
  };

  /** Adds `version` of `source` through core, as its newest. */
  const addVersion = async (
    source: Planned,
    version: Version
  ): Promise<void> => {
    const added = await addSource(env, {
      source: source.source,
      change: crypto.randomUUID(),
      text: textOf(version, wordOf),
      readers: asCore(version.readers),
    });
    if (added.version !== version.version) {
      throw new Error(
        `s${source.index} was added as v${added.version}, not v${version.version}`
      );
    }
    addOrder.set(version, addOrder.size);
  };

  /** Each chunk of a current version, as the store names it. */
  const currentChunks = () =>
    planned.flatMap((source) => {
      const version = currentOf(source);
      return version.paragraphs.map((_, position) => ({
        planned: source,
        version,
        chunk: {
          source: `${source.source.producer}:${source.source.id}`,
          version: version.version,
          position,
        },
      }));
    });

  /** Puts a vector for each current chunk without one, as the queue will. */
  const putVectors = async (): Promise<void> => {
    const fresh = currentChunks()
      .filter(({ chunk }) => !vectors.has(placeKey(chunk)))
      .map(({ chunk }) => {
        const vector = signs();
        vectors.set(placeKey(chunk), vector);
        return { chunk, vector };
      });
    for (let first = 0; first < fresh.length; first += 256) {
      // oxlint-disable-next-line no-await-in-loop -- one put at a time
      await brainStore().putVectors({
        model: vectorModel,
        vectors: fresh.slice(first, first + 256),
      });
    }
  };

  /**
   * Adds this round's sources and new versions through core, in order: a
   * new version has other readers, other text, or both.
   */
  const addSources = async (round: number): Promise<void> => {
    const adding = (round === 0 ? 1 : 0) + draws.below(addedPerRound);
    for (let added = 0; added < adding; added += 1) {
      const known =
        planned.length > 0 && draws.chance(0.4)
          ? planned[draws.below(planned.length)]
          : undefined;
      const source: Planned = known ?? {
        index: planned.length,
        source: { producer: "upload", id: crypto.randomUUID() },
        versions: [],
      };
      const before = source.versions.at(-1);
      let version: Version;
      if (before === undefined) {
        version = {
          version: 1,
          readers: drawReaders(draws, teamIds.length),
          ...drawText(),
        };
      } else {
        const change = draws.below(3);
        version = {
          ...before,
          version: before.version + 1,
          ...(change === 1
            ? {}
            : { readers: drawReaders(draws, teamIds.length) }),
          ...(change === 0 ? {} : drawText()),
        };
        // The same readers drawn again, the text kept: no change at all,
        // which the Brain rightly doesn't make a version. Change the text.
        if (
          JSON.stringify(version.lengths) === JSON.stringify(before.lengths) &&
          JSON.stringify(version.readers) === JSON.stringify(before.readers)
        ) {
          version = { ...version, ...drawText() };
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, as planned
      await addVersion(source, version);
      source.versions.push(version);
      if (known === undefined) {
        planned.push(source);
      }
    }
  };

  /** A chunk an answer returned, by its name in the plan. */
  const nameOf = (source: SourceRef, version: number, text: string): string => {
    const found = planned.find((known) => known.source.id === source.id);
    const asPlanned = found?.versions.find((v) => v.version === version);
    const position =
      asPlanned === undefined
        ? -1
        : asPlanned.paragraphs.findIndex(
            (_, index) => paragraphOf(asPlanned, index, wordOf) === text
          );
    return `s${found?.index ?? "?"} v${version} c${position < 0 ? "?" : position}`;
  };

  /** What bears on a failure as `person`. */
  const context = (person: number): string[] => {
    const inTeams = [...membership]
      .filter((key) => key.startsWith(`${person}:`))
      .map((key) => `t${key.slice(key.indexOf(":") + 1)}`);
    return [
      `p${person} is in ${inTeams.join(", ") || "no team"}`,
      `membership: ${history.join("; ") || "nobody in a team"}`,
    ];
  };

  /** `person`'s teams, as core names its groups. */
  const groupsOf = (person: number): string[] =>
    teamIds
      .filter((_, team) => membership.has(memberKey(person, team)))
      .map((id) => `team:${id}`);

  /**
   * The current chunks `person` may read nearest `question`, by cosine,
   * ties to the chunk added first, at most `limit`, each with its cosine.
   */
  const nearest = (person: number, question: number[], limit: number) => {
    const cosineOf = (chunk: ChunkRef): number =>
      (vectors.get(placeKey(chunk)) ?? []).reduce(
        (sum, value, index) => sum + value * (question[index] ?? 0),
        0
      ) / vectorDimensions;
    return currentChunks()
      .filter(({ version }) => isAmong(version.readers, person, membership))
      .map((each) => ({ ...each, score: cosineOf(each.chunk) }))
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          (addOrder.get(a.version) ?? 0) - (addOrder.get(b.version) ?? 0) ||
          a.chunk.position - b.chunk.position
      )
      .slice(0, limit);
  };

  /**
   * What `person` recalls for `question`, through core, or, by meaning
   * too (`vector`), of the store, as core would ask it with a model: its
   * items citing sources as core names them.
   */
  const recallOf = async (
    person: number,
    question: string,
    vector: number[] | undefined
  ) => {
    if (vector === undefined) {
      return await recallAs(env, personId(person), {
        question,
        budget: { tokens: recallBudgetMax },
      });
    }
    const at = vectorModel.name.lastIndexOf("@");
    const pack = await brainStore().recall({
      question,
      reader: { person: personId(person), groups: groupsOf(person) },
      budget: { tokens: recallBudgetMax },
      meaning: {
        model: {
          name: vectorModel.name.slice(0, at),
          build: vectorModel.name.slice(at + 1),
        },
        vector,
      },
    });
    return {
      ...pack,
      // Each source as the plan names it; one the plan doesn't know as
      // none, which the comparison shows.
      items: pack.items.map((item) => ({
        ...item,
        source: planned.find(
          ({ source }) => `${source.producer}:${source.id}` === item.source
        )?.source ?? { producer: "upload" as const, id: item.source },
      })),
    };
  };

  /** Asks as `person` once; what went wrong, with what bears on it. */
  const ask = async (moment: string, person: number): Promise<string[]> => {
    // Mostly forms with a stop word now and then; sometimes stop words
    // alone.
    const asked = draws.chance(0.15)
      ? draws.tokens(3, 1)
      : draws.tokens(4, 0.35);
    // Sometimes in capitals: search reads a word whatever its case.
    const writtenAs = asked.map((token) =>
      draws.chance(0.2) ? wordOf(token).toUpperCase() : wordOf(token)
    );
    const question = writtenAs.join(" ");
    const vector = draws.chance(0.5) ? signs() : undefined;
    const answer = await recallOf(person, question, vector);
    const meant =
      vector === undefined
        ? []
        : nearest(person, vector, recallLimit).map(
            ({ planned: source, version, chunk }) => ({
              name: `s${source.index} v${version.version} c${chunk.position}`,
              planned: source,
              version,
              position: chunk.position,
              length: version.lengths[chunk.position] ?? 0,
              telling: 0,
              stops: 0,
              exact: 0,
            })
          );
    // Each word as the question first wrote it.
    const written = (token: Token): string =>
      writtenAs[asked.indexOf(token)] ?? wordOf(token);
    const expected = packOf(
      planned,
      person,
      membership,
      asked,
      written,
      wordOf,
      meant
    );
    const problems = problemsOf({
      got: answer.items.map(({ source, version, text }) =>
        nameOf(source, version, text)
      ),
      expected: expected.chunks.map(({ name }) => name),
      answer,
      expectedAnswer: {
        items: expected.chunks.map(
          ({ planned: source, version, position, found }) => ({
            source: source.source,
            version: version.version,
            position,
            text: paragraphOf(version, position, wordOf),
            whole: true,
            found,
          })
        ),
        // No memories in these scenarios: those are tested at random in
        // the store (packages/brain-next entities-recall.test.ts).
        memories: [],
        contested: [],
        notFound: expected.notFound,
        truncated: false,
      },
    });
    if (problems.length === 0) {
      return [];
    }
    return [
      `${moment}, p${person} asks "${asked.join(" ")}"${vector === undefined ? "" : ` by meaning too, nearest [${meant.map(({ name }) => name).join(", ")}]`}:`,
      ...problems,
      ...context(person),
      `sources holding its words: ${planned
        .filter((source) =>
          source.versions.some(({ paragraphs }) =>
            paragraphs.some((words) => holds(words, asked))
          )
        )
        .map(describeSource)
        .join("; ")}`,
    ];
  };

  /**
   * Reads every version of every source as `person`, as history; what
   * went wrong. A version is theirs only while they are among its readers
   * and its source's current readers; otherwise it answers as a source no
   * one added: null.
   */
  const readHistory = async (
    moment: string,
    person: number
  ): Promise<string[]> => {
    const reads = planned.flatMap((source) =>
      source.versions.map((version) => ({ source, version }))
    );
    const answers = await Promise.all(
      reads.map(
        async ({ source, version }) =>
          await readSourceVersionAs(env, personId(person), {
            source: source.source,
            version: version.version,
          })
      )
    );
    const missing = await readSourceVersionAs(env, personId(person), {
      source: { producer: "upload", id: crypto.randomUUID() },
      version: 1,
    });
    const problems = reads.flatMap(({ source, version }, index) => {
      const readable =
        isAmong(version.readers, person, membership) &&
        isAmong(currentOf(source).readers, person, membership);
      const got = answers[index] ?? null;
      const expected = readable
        ? {
            source: source.source,
            version: version.version,
            text: textOf(version, wordOf),
          }
        : missing;
      const seen =
        got === null
          ? null
          : { source: got.source, version: got.version, text: got.text };
      return JSON.stringify(seen) === JSON.stringify(expected)
        ? []
        : [
            `s${source.index} v${version.version} read as ${readable ? "readable" : "not readable"}, but answered ${JSON.stringify(seen)}: ${describeSource(source)}`,
          ];
    });
    return problems.length === 0
      ? []
      : [
          `${moment}, p${person} reads history:`,
          ...problems,
          ...context(person),
        ];
  };

  /**
   * Searches by a vector as `person` once; what went wrong. The answer:
   * the current chunks they may read, by cosine, ties to the chunk added
   * first, at most `vectorLimit`, each with its cosine.
   */
  const askVectors = async (
    moment: string,
    person: number
  ): Promise<string[]> => {
    const question = signs();
    const { chunks } = await brainStore().searchVectors({
      model: vectorModel.name,
      vector: question,
      reader: { person: personId(person), groups: groupsOf(person) },
      limit: vectorLimit,
    });
    const expected = nearest(person, question, vectorLimit);
    const described = (found: FoundChunk): string =>
      `${placeKey(found)} ${roundedScore(found.score)}`;
    const got = chunks.map(described);
    const wanted = expected.map(({ chunk, score }) =>
      described({ ...chunk, score })
    );
    return JSON.stringify(got) === JSON.stringify(wanted)
      ? []
      : [
          `${moment}, p${person} searches by a vector:`,
          `got [${got.join(", ")}], but expected [${wanted.join(", ")}]`,
          ...context(person),
        ];
  };

  /** Runs every round; the first thing that went wrong, if anything. */
  const run = async (): Promise<string[]> => {
    await start();
    for (let round = 0; round < rounds; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- round after round
      await addSources(round);
      // oxlint-disable-next-line no-await-in-loop -- round after round
      await putVectors();
      for (let person = 0; person < peopleCount; person += 1) {
        const questions = 1 + draws.below(mostQuestionsPerRound);
        for (let question = 0; question < questions; question += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one recall at a time
          const problems = await ask(`round ${round}`, person);
          if (problems.length > 0) {
            return problems;
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        const historyProblems = await readHistory(`round ${round}`, person);
        if (historyProblems.length > 0) {
          return historyProblems;
        }
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        const vectorProblems = await askVectors(`round ${round}`, person);
        if (vectorProblems.length > 0) {
          return vectorProblems;
        }
      }
      for (let change = 1 + draws.below(2); change > 0; change -= 1) {
        const person = draws.below(peopleCount);
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        await toggle(person, draws.below(teamIds.length));
        // The very next recall counts the change.
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        const problems = await ask(
          `round ${round}, just after "${history.at(-1) ?? ""}"`,
          person
        );
        if (problems.length > 0) {
          return problems;
        }
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        const vectorProblems = await askVectors(
          `round ${round}, just after "${history.at(-1) ?? ""}"`,
          person
        );
        if (vectorProblems.length > 0) {
          return vectorProblems;
        }
      }
    }
    return [];
  };

  /** Takes the people out of this scenario's teams, so seeds don't add up. */
  const end = async (): Promise<void> => {
    await drizzle(env.DB)
      .delete(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds));
  };

  return { run, end };
};

describe("recall, against a brute-force answer", { timeout: 60_000 }, () => {
  /**
   * The seed's own people, signed in in its test (the identity provider
   * answers inside a test only): another seed's sources are never theirs,
   * whatever stop words they share.
   */
  const signedInPeople = async (): Promise<string[]> => {
    const people: string[] = [];
    while (people.length < peopleCount) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      const { userId } = await signedInWithRole(idp, "user");
      people.push(userId);
    }
    return people;
  };

  it.for(seeds)(
    "returns only what the reader may read, uncrowded and in the same order, and history to its readers only, for seed %i",
    async (seed) => {
      const { run, end } = scenario(await signedInPeople(), seed);
      let problems: string[] = [];
      try {
        problems = await run();
      } finally {
        await end();
      }

      expect(
        problems,
        `seed ${seed}; again with BRAIN_RANDOM_FROM=${seed} BRAIN_RANDOM_SEEDS=1 vp -C apps/core test -c vite.brain-random.config.ts`
      ).toStrictEqual([]);
    }
  );
});
