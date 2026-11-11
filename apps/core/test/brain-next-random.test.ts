import { brainOf, recallLimit } from "@grasp-os/brain-next/contract";
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
//   first, then as above. At most `recallLimit`, and nothing else in the
//   answer. A version replaced by a newer one is never in it.
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
// Questions stay under the store's limit of 16 words, so cutting a
// question short is not part of this specification.
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
 * Words no other scenario has: each root behind a prefix of its own, and
 * the stop words as they are. Lowercase ASCII letters and digits, which
 * search reads as they are: the brute-force answer compares tokens, never
 * folds or stems.
 */
const vocabulary = () => {
  const prefix = `r${crypto.randomUUID().slice(0, 8)}`;
  return (token: Token): string =>
    isStop(token)
      ? token.slice(stopPrefix.length)
      : `${prefix}${token.slice(0, 1)}${formEndings[Number(token.slice(1))] ?? ""}`;
};

/** Characters of the longest word: "r", eight of a UUID, its letter and ending. */
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
  const wordOf = vocabulary();
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

  /** Asks as `person` once; what went wrong, with what bears on it. */
  const ask = async (moment: string, person: number): Promise<string[]> => {
    // Mostly forms with a stop word now and then; sometimes stop words
    // alone.
    const asked = draws.chance(0.15)
      ? draws.tokens(3, 1)
      : draws.tokens(4, 0.35);
    // Sometimes in capitals: search reads a word whatever its case.
    const question = asked
      .map((token) =>
        draws.chance(0.2) ? wordOf(token).toUpperCase() : wordOf(token)
      )
      .join(" ");
    const answer = await recallAs(env, personId(person), question);
    const expected = expectedOf(planned, person, membership, asked);
    const problems = problemsOf({
      got: answer.chunks.map(({ source, version, text }) =>
        nameOf(source, version, text)
      ),
      expected: expected.map(({ name }) => name),
      answer,
      expectedAnswer: {
        chunks: expected.map(({ planned: source, version, position }) => ({
          source: source.source,
          version: version.version,
          text: paragraphOf(version, position, wordOf),
        })),
      },
    });
    if (problems.length === 0) {
      return [];
    }
    return [
      `${moment}, p${person} asks "${asked.join(" ")}":`,
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
    const groups = teamIds
      .filter((_, team) => membership.has(memberKey(person, team)))
      .map((id) => `team:${id}`);
    const { chunks } = await brainStore().searchVectors({
      model: vectorModel.name,
      vector: question,
      reader: { person: personId(person), groups },
      limit: vectorLimit,
    });
    const cosineOf = (chunk: ChunkRef): number =>
      (vectors.get(placeKey(chunk)) ?? []).reduce(
        (sum, value, index) => sum + value * (question[index] ?? 0),
        0
      ) / vectorDimensions;
    const expected = currentChunks()
      .filter(({ version }) => isAmong(version.readers, person, membership))
      .map(({ version, chunk }) => ({ version, chunk, score: cosineOf(chunk) }))
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          (addOrder.get(a.version) ?? 0) - (addOrder.get(b.version) ?? 0) ||
          a.chunk.position - b.chunk.position
      )
      .slice(0, vectorLimit);
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
