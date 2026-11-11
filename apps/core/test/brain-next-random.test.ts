import { recallLimit } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { seededRandom } from "./brain-scoring.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The random permission test (GRA-1722). From a seed: teams, sources with
// random words and readers, new versions of them with other readers, other
// text or both, and changes in who is in which team between recalls, all
// through core, with membership in core's own records. Every recall must
// return exactly the answer a brute-force reading of the contract builds
// here, apart from the store's SQL and its folding: the chunks of current
// versions the reader may read that hold one of the question's words,
// those holding more of its distinct words first, then the shorter, at
// most `recallLimit`, and nothing else in the answer. A version replaced
// by a newer one is never in it, and its readers no longer count: a
// version that narrows a source's readers hides it from those taken off. So no result may be one
// the reader may not read, none may be missing because hidden ones took
// its place, hidden ones may not move the order, and no field may tell
// that hidden ones exist. A membership change counts from the very next
// recall: the person it changed asks at once.
//
// The brute-force answer is the specification of ranking, written once:
// the issues that change ranking (stemming, exact matches, vectors)
// change it here, on purpose. Every text here is far shorter than a chunk,
// so each version is one chunk, its whole text. Length is the chunk's
// characters; the texts here are ASCII, so code units agree. Every
// current version of a scenario has a length of its own, so no two
// readable chunks tie; what decides between ties (the newer version, then
// the source's key, then the chunk's place in its version) is out of its
// reach, and so is a leak that shows only in how ties fall. Questions stay under the store's limit of 16 words, so
// cutting a question short, and taking out words that fold alike, are not
// part of this specification.
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
const addedPerRound = 12;

/** Most questions each person asks each round: 1 to this many. */
const mostQuestionsPerRound = 3;

/** Most words a source holds, before its filler. */
const mostWordsPerSource = 4;

/** What a scenario's words end in: few, so sources share words. */
const letters = ["a", "b", "c", "d"] as const;

/** The draws a scenario is made of, from its seed. */
const drawsOf = (seed: number) => {
  const next = seededRandom(seed);
  const below = (bound: number): number => Math.floor(next() * bound);
  return {
    below,
    chance: (probability: number): boolean => next() < probability,
    letters: (most: number): string[] =>
      Array.from(
        { length: 1 + below(most) },
        () => letters[below(letters.length)] ?? "a"
      ),
  };
};
type Draws = ReturnType<typeof drawsOf>;

/** Who may read a planned source: indexes into the people and teams. */
type Readers =
  | { kind: "owner"; person: number }
  | { kind: "team"; team: number }
  | { kind: "none" };

/** A source as the brute-force answer knows it: its current version. */
interface Planned {
  /** Its name in a failure: `s<index>`. */
  index: number;
  /** The source, as its producer names it. */
  source: SourceRef;
  /** Its current version, from 1. */
  version: number;
  /** Its current version's words, by letter. */
  words: string[];
  /** Who may read its current version. */
  readers: Readers;
  /**
   * The length of its current text, which no other current version of
   * the scenario has: its words, then filler up to it, so no two tie.
   */
  length: number;
}

/**
 * Words no other scenario has: each letter behind a prefix of its own.
 * Lowercase ASCII letters and digits, which search reads as they are: the
 * brute-force answer compares letters, never folds.
 */
const vocabulary = () => {
  const prefix = `r${crypto.randomUUID().slice(0, 8)}`;
  return (letter: string): string => `${prefix}${letter}`;
};

/** Characters of a word: "r", eight of a UUID, and its letter. */
const wordLength = 10;

/** Characters the longest list of words takes, with a space after it. */
const mostWords = mostWordsPerSource * (wordLength + 1);

const textOf = (
  planned: Planned,
  wordOf: (letter: string) => string
): string => {
  const words = `${planned.words.map(wordOf).join(" ")} `;
  return words.padEnd(planned.length, "q");
};

/** Who is in which team: `person:team` for each pair. */
type Membership = Set<string>;

const memberKey = (person: number, team: number): string => `${person}:${team}`;

/** Whether `person` may read `planned`: the brute-force answer. */
const mayRead = (
  planned: Planned,
  person: number,
  membership: Membership
): boolean => {
  const { readers } = planned;
  if (readers.kind === "owner") {
    return readers.person === person;
  }
  if (readers.kind === "team") {
    return membership.has(memberKey(person, readers.team));
  }
  return false;
};

/** Whether `planned` holds one of the asked letters' words. */
const holds = (planned: Planned, asked: readonly string[]): boolean =>
  asked.some((letter) => planned.words.includes(letter));

/** Draws who may read a source: mostly a person or a team, sometimes nobody. */
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

const describeSource = ({
  index,
  version,
  words,
  readers,
  length,
}: Planned): string => {
  let whose = "no known readers";
  if (readers.kind === "owner") {
    whose = `p${readers.person}'s own`;
  } else if (readers.kind === "team") {
    whose = `team t${readers.team}`;
  }
  return `s${index} v${version} "${words.join(" ")}" (${whose}, ${length} characters)`;
};

const names = (indexes: readonly number[]): string =>
  `[${indexes.map((index) => `s${index}`).join(", ")}]`;

/**
 * What `person` may read of the current versions holding one of `asked`'s
 * words, each one chunk, best first, as the contract states it: more of
 * the question's distinct words, then shorter, at most `recallLimit`.
 */
const expectedOf = (
  planned: readonly Planned[],
  person: number,
  membership: Membership,
  asked: readonly string[]
): Planned[] => {
  const distinct = [...new Set(asked)];
  const scoreOf = ({ words }: Planned): number =>
    distinct.filter((letter) => words.includes(letter)).length;
  return planned
    .filter(
      (source) => mayRead(source, person, membership) && holds(source, asked)
    )
    .toSorted((a, b) => scoreOf(b) - scoreOf(a) || a.length - b.length)
    .slice(0, recallLimit);
};

/** What one recall broke, if anything: by source, then the whole answer. */
const problemsOf = ({
  got,
  expected,
  answer,
  expectedAnswer,
}: {
  got: readonly number[];
  expected: readonly number[];
  answer: unknown;
  expectedAnswer: unknown;
}): string[] => {
  const problems: string[] = [];
  const outside = got.filter((index) => !expected.includes(index));
  if (outside.length > 0) {
    problems.push(
      `got ${names(outside)}, which the reader may not read, which hold none of its words, or which come past the limit`
    );
  }
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    problems.push(`got ${names(got)}, but expected ${names(expected)}`);
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
  const lengths = Array.from(
    { length: rounds * addedPerRound },
    (_, index) => mostWords + 1 + index
  );
  const planned: Planned[] = [];
  const personId = (person: number): string => people[person] ?? "";
  const teamId = (team: number): string => teamIds[team] ?? "";
  /** Who may read a planned source, as core names them. */
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

  /** A length no current version has: the old one is freed for none. */
  const newLength = (): number => {
    const [length = 0] = lengths.splice(draws.below(lengths.length), 1);
    return length;
  };

  /** Adds `version` through core, as its source's newest. */
  const addVersion = async (version: Planned): Promise<void> => {
    const added = await addSource(env, {
      source: version.source,
      change: crypto.randomUUID(),
      text: textOf(version, wordOf),
      readers: asCore(version.readers),
    });
    if (added.version !== version.version) {
      throw new Error(
        `s${version.index} was added as v${added.version}, not v${version.version}`
      );
    }
  };

  /**
   * Adds this round's sources and new versions through core, in order: a
   * new version has other readers, other text, or both (other text is
   * always another length, so no two current versions tie).
   */
  const addSources = async (round: number): Promise<void> => {
    const adding = (round === 0 ? 1 : 0) + draws.below(addedPerRound);
    for (let added = 0; added < adding; added += 1) {
      const known = planned.length > 0 && draws.chance(0.4);
      const before = known ? planned[draws.below(planned.length)] : undefined;
      let version: Planned;
      if (before === undefined) {
        version = {
          index: planned.length,
          source: { producer: "upload", id: crypto.randomUUID() },
          version: 1,
          words: draws.letters(mostWordsPerSource),
          readers: drawReaders(draws, teamIds.length),
          length: newLength(),
        };
      } else {
        const change = draws.below(3);
        version = {
          ...before,
          version: before.version + 1,
          ...(change === 1
            ? {}
            : { readers: drawReaders(draws, teamIds.length) }),
          ...(change === 0
            ? {}
            : {
                words: draws.letters(mostWordsPerSource),
                length: newLength(),
              }),
        };
        // The same readers drawn again, the text kept: no change at all,
        // which the Brain rightly doesn't make a version. Change the text.
        if (
          version.length === before.length &&
          JSON.stringify(version.readers) === JSON.stringify(before.readers)
        ) {
          version.words = draws.letters(mostWordsPerSource);
          version.length = newLength();
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, as planned
      await addVersion(version);
      planned[version.index] = version;
    }
  };

  /** Asks as `person` once; what went wrong, with what bears on it. */
  const ask = async (moment: string, person: number): Promise<string[]> => {
    const asked = draws.letters(3);
    // Sometimes in capitals: search reads a word whatever its case.
    const question = asked
      .map((letter) =>
        draws.chance(0.2) ? wordOf(letter).toUpperCase() : wordOf(letter)
      )
      .join(" ");
    const answer = await recallAs(env, personId(person), question);
    const expected = expectedOf(planned, person, membership, asked);
    const problems = problemsOf({
      got: answer.chunks.map(({ source }) =>
        planned.findIndex((known) => known.source.id === source.id)
      ),
      expected: expected.map(({ index }) => index),
      answer,
      expectedAnswer: {
        chunks: expected.map((version) => ({
          source: version.source,
          version: version.version,
          text: textOf(version, wordOf),
        })),
      },
    });
    if (problems.length === 0) {
      return [];
    }
    const inTeams = [...membership]
      .filter((key) => key.startsWith(`${person}:`))
      .map((key) => `t${key.slice(key.indexOf(":") + 1)}`);
    return [
      `${moment}, p${person} (in ${inTeams.join(", ") || "no team"}) asks "${asked.join(" ")}":`,
      ...problems,
      `membership: ${history.join("; ") || "nobody in a team"}`,
      `sources holding its words: ${planned
        .filter((source) => holds(source, asked))
        .map(describeSource)
        .join("; ")}`,
    ];
  };

  /** Runs every round; the first thing that went wrong, if anything. */
  const run = async (): Promise<string[]> => {
    await start();
    for (let round = 0; round < rounds; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- round after round
      await addSources(round);
      for (let person = 0; person < peopleCount; person += 1) {
        const questions = 1 + draws.below(mostQuestionsPerRound);
        for (let question = 0; question < questions; question += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one recall at a time
          const problems = await ask(`round ${round}`, person);
          if (problems.length > 0) {
            return problems;
          }
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
  const people: string[] = [];

  /**
   * The people every seed shares, signed in by the first seed's test (the
   * identity provider answers inside a test only).
   */
  const signedInPeople = async (): Promise<string[]> => {
    while (people.length < peopleCount) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      const { userId } = await signedInWithRole(idp, "user");
      people.push(userId);
    }
    return people;
  };

  it.for(seeds)(
    "returns only what the reader may read, uncrowded and in the same order, for seed %i",
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
