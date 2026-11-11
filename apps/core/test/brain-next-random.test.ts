import { brainOf, recallLimit } from "@grasp-os/brain-next/contract";
import type { Brain, Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { seededRandom } from "./brain-scoring.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The random permission test (GRA-1722). From a seed: teams, sources with
// random words and readers, and changes in who is in which team between
// rounds of recalls, all through core, with membership in core's own
// records. Every recall is checked against a brute-force answer written
// here, apart from the store's SQL:
//
// - every result is a source the reader may read and that holds one of
//   the question's words;
// - none is missing because hidden ones took its place: the reader gets
//   as many as they may read, up to the limit;
// - hidden sources change nothing: the sources the reader may read, added
//   again alone under words of their own, give the same results in the
//   same order.
//
// A failure names its seed, what to run to see it again, and only what
// bears on it: the round, the reader's teams, the question, the changes
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

/** Most sources a round adds. */
const addedPerRound = 12;

/** Questions each person asks each round. */
const questionsPerRound = 2;

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

/** A source as the brute-force answer knows it. */
interface Planned {
  /** Its name in a failure: `s<index>`. */
  index: number;
  /** Its words, by letter. */
  words: string[];
  readers: Readers;
  /**
   * The length of its text, which no other source of the scenario has:
   * its words, then filler up to it. So the order the contract states
   * (more of the question's words, then shorter) leaves no ties for the
   * time it was added to break, which a copy added later can't repeat.
   */
  length: number;
}

/**
 * Words no other scenario or copy has: each letter behind a prefix of its
 * own, all of one length, so a copy's texts are as long as the
 * original's. Lowercase ASCII letters and digits, which search reads as
 * they are: the brute-force answer compares letters, never folds.
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

const describeSource = ({ index, words, readers, length }: Planned): string => {
  let whose = "no known readers";
  if (readers.kind === "owner") {
    whose = `p${readers.person}'s own`;
  } else if (readers.kind === "team") {
    whose = `team t${readers.team}`;
  }
  return `s${index} "${words.join(" ")}" (${whose}, ${length} characters)`;
};

const names = (indexes: readonly number[]): string =>
  `[${indexes.map((index) => `s${index}`).join(", ")}]`;

/** The store, by its contract: for the copies only a control reader reads. */
const store = (): Brain => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** What one recall broke of the three rules, if anything. */
const problemsOf = ({
  got,
  allowed,
  alone,
}: {
  got: readonly number[];
  allowed: readonly number[];
  alone: readonly number[];
}): string[] => {
  const problems: string[] = [];
  const outside = got.filter((index) => !allowed.includes(index));
  if (outside.length > 0) {
    problems.push(
      `got ${names(outside)}, which the reader may not read or which hold none of its words`
    );
  }
  if (got.length !== Math.min(allowed.length, recallLimit)) {
    problems.push(
      `got ${names(got)}, but may read ${names(allowed)} (at most ${recallLimit})`
    );
  }
  if (JSON.stringify(got) !== JSON.stringify(alone)) {
    problems.push(
      `got ${names(got)}, but ${names(alone)} with no hidden sources`
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
  /** Each planned source's ID in the store, by index. */
  const ids: string[] = [];
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

  /** Adds this round's sources through core, in order. */
  const addSources = async (round: number): Promise<void> => {
    const adding = (round === 0 ? 1 : 0) + draws.below(addedPerRound);
    for (let added = 0; added < adding; added += 1) {
      const readers = drawReaders(draws, teamIds.length);
      const [length = 0] = lengths.splice(draws.below(lengths.length), 1);
      const source: Planned = {
        index: planned.length,
        words: draws.letters(mostWordsPerSource),
        readers,
        length,
      };
      // oxlint-disable-next-line no-await-in-loop -- in order, as planned
      const { id } = await addSource(env, {
        text: textOf(source, wordOf),
        readers: asCore(readers),
      });
      planned.push(source);
      ids.push(id);
    }
  };

  /**
   * What `person` may read now, added again alone, in the same order,
   * under words no other source holds, for a reader nobody else is.
   */
  const controlFor = async (person: number) => {
    const controlWord = vocabulary();
    const reader: Reader = {
      person: `control-${crypto.randomUUID()}`,
      groups: [],
    };
    const indexOf = new Map<string, number>();
    for (const source of planned) {
      if (mayRead(source, person, membership)) {
        // oxlint-disable-next-line no-await-in-loop -- in the same order
        const { id } = await store().addSource({
          text: textOf(source, controlWord),
          access: { kind: "owner", person: reader.person },
        });
        indexOf.set(id, source.index);
      }
    }
    return async (asked: readonly string[]): Promise<number[]> => {
      const { sources } = await store().recall({
        question: asked.map(controlWord).join(" "),
        reader,
      });
      return sources.map(({ id }) => indexOf.get(id) ?? -1);
    };
  };

  /** Asks as `person`; what went wrong, with what bears on it. */
  const ask = async (
    round: number,
    person: number,
    alone: (asked: readonly string[]) => Promise<number[]>
  ): Promise<string[]> => {
    const asked = draws.letters(3);
    // Sometimes in capitals: search reads a word whatever its case.
    const question = asked
      .map((letter) =>
        draws.chance(0.2) ? wordOf(letter).toUpperCase() : wordOf(letter)
      )
      .join(" ");
    const { sources } = await recallAs(env, personId(person), question);
    const problems = problemsOf({
      got: sources.map(({ id }) => ids.indexOf(id)),
      allowed: planned
        .filter(
          (source) =>
            mayRead(source, person, membership) && holds(source, asked)
        )
        .map(({ index }) => index),
      alone: await alone(asked),
    });
    if (problems.length === 0) {
      return [];
    }
    const inTeams = [...membership]
      .filter((key) => key.startsWith(`${person}:`))
      .map((key) => `t${key.slice(key.indexOf(":") + 1)}`);
    return [
      `round ${round}, p${person} (in ${inTeams.join(", ") || "no team"}) asks "${asked.join(" ")}":`,
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
        // oxlint-disable-next-line no-await-in-loop -- one reader at a time
        const alone = await controlFor(person);
        for (let question = 0; question < questionsPerRound; question += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one recall at a time
          const problems = await ask(round, person, alone);
          if (problems.length > 0) {
            return problems;
          }
        }
      }
      for (let change = 1 + draws.below(2); change > 0; change -= 1) {
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        await toggle(draws.below(peopleCount), draws.below(teamIds.length));
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
