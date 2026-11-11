import { recallLimit } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { organizationId } from "../src/auth/auth.ts";
import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders } from "../src/brain-next.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import {
  brainEvalPeople,
  brainEvalTeamNames,
  brainEvalTeams,
} from "./fixtures/brain-eval/company.ts";
import type {
  BrainEvalPerson,
  BrainEvalQuestion,
  BrainEvalReaders,
  BrainEvalSource,
  BrainEvalTeam,
} from "./fixtures/brain-eval/company.ts";
import {
  askerOf,
  brainEvalSet,
  mayRead,
  setProblems,
} from "./fixtures/brain-eval/set.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// The Brain evaluation (GRA-1726), on request only: scripts/brain-eval.ts
// runs it and reports (`vp run brain:eval`). It puts the evaluation's
// company (fixtures/brain-eval/) into a fresh core: its people as members,
// its teams, and each source through core's own `addSource` with who may
// read it. Then it asks every question as its asker through core's
// `recallAs`, timing each recall, and asks the same of plain text search
// (`grepRecall`) over the same sources, with the same access. It prints
// what each returned, one JSON line per question (`BRAIN_EVAL_RESULT`),
// for the script to score; it fails only when the set is broken or the
// Brain returned something its asker may not read.

const { sources, questions, version } = brainEvalSet;

const idp = mockIdp();

/** What a recall returned, best first: source keys and their text. */
interface Returned {
  keys: (string | undefined)[];
  texts: string[];
}

/** A question's words, as `grep -i` would look for them: lowercased, no more. */
const grepWords = (question: string): string[] => [
  ...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu)),
];

/**
 * Plain text search, the baseline: each source `asker` may read, scored by
 * how many of the question's words its raw text holds anywhere, as a
 * case-blind substring; then shorter first, then newer first, as the
 * Brain breaks ties. No folding, no stemming, no index.
 */
const grepRecall = (asker: BrainEvalPerson, question: string): Returned => {
  const words = grepWords(question);
  const ranked = sources
    .map((source, order) => {
      const text = source.text.toLowerCase();
      const score = words.filter((word) => text.includes(word)).length;
      return { source, order, score };
    })
    .filter(({ source, score }) => score > 0 && mayRead(asker, source))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.source.text.length - b.source.text.length ||
        b.order - a.order
    )
    .slice(0, recallLimit);
  return {
    keys: ranked.map(({ source }) => source.key),
    texts: ranked.map(({ source }) => source.text),
  };
};

/** 1-based rank of the question's source among what was returned. */
const rankOf = (question: BrainEvalQuestion, returned: Returned) => {
  const { expects } = question;
  if (expects.kind !== "answer") {
    return null;
  }
  const index = returned.keys.findIndex(
    (key, at) =>
      key === expects.source &&
      (returned.texts[at] ?? "").includes(expects.quote)
  );
  return index === -1 ? null : index + 1;
};

/**
 * What was returned that the asker may not read, or that tells them a
 * hidden answer: each as `unreadable:<key>`, `unknown` or
 * `secret:<text>`.
 */
const leaksOf = (question: BrainEvalQuestion, returned: Returned) => {
  const asker = askerOf(question);
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const { expects } = question;
  const secrets = expects.kind === "hidden" ? expects.secrets : [];
  return [
    ...returned.keys.flatMap((key) => {
      const source = key === undefined ? undefined : byKey.get(key);
      if (source === undefined) {
        return ["unknown"];
      }
      return mayRead(asker, source) ? [] : [`unreadable:${source.key}`];
    }),
    ...secrets
      .filter((secret) => returned.texts.some((text) => text.includes(secret)))
      .map((secret) => `secret:${secret}`),
  ];
};

const sourceOf = (key: string): BrainEvalSource | undefined =>
  sources.find((source) => source.key === key);

/** A question's digest: it and the source it asks for, as they are now. */
const digestOf = async (question: BrainEvalQuestion): Promise<string> => {
  const { expects } = question;
  const source = expects.kind === "absent" ? null : sourceOf(expects.source);
  const digest = await sha256Hex(JSON.stringify({ question, source }));
  return digest.slice(0, 16);
};

const sourceLanguageOf = (question: BrainEvalQuestion) => {
  const { expects } = question;
  return expects.kind === "absent"
    ? null
    : (sourceOf(expects.source)?.language ?? null);
};

/** `key`'s ID in core, as the run set it up. */
const idIn = <Key extends string>(
  ids: ReadonlyMap<Key, string>,
  key: Key
): string => {
  const id = ids.get(key);
  if (id === undefined) {
    throw new Error(`${key} is not set up`);
  }
  return id;
};

/** The company's people as members of core's organization: each one's user ID. */
const signUpPeople = async (): Promise<Map<BrainEvalPerson, string>> =>
  new Map(
    await Promise.all(
      brainEvalPeople.map(async (person) => {
        const { userId } = await signedInWithRole(idp, "user");
        return [person, userId] as const;
      })
    )
  );

/** The company's teams in core, with their members: each team's ID. */
const setUpTeams = async (
  people: ReadonlyMap<BrainEvalPerson, string>
): Promise<Map<BrainEvalTeam, string>> => {
  const db = drizzle(env.DB);
  return new Map(
    await Promise.all(
      brainEvalTeamNames.map(async (team) => {
        const id = crypto.randomUUID();
        await db
          .insert(teams)
          .values({ id, name: team, organizationId, createdAt: new Date() });
        await db.insert(teamMembers).values(
          brainEvalTeams[team].map((person) => ({
            id: crypto.randomUUID(),
            teamId: id,
            userId: idIn(people, person),
            createdAt: new Date(),
          }))
        );
        return [team, id] as const;
      })
    )
  );
};

const readersIn = (
  readers: BrainEvalReaders,
  people: ReadonlyMap<BrainEvalPerson, string>,
  teamIds: ReadonlyMap<BrainEvalTeam, string>
): SourceReaders => {
  if (readers === "nobody") {
    return { kind: "none" };
  }
  return "owner" in readers
    ? { kind: "owner", personId: idIn(people, readers.owner) }
    : { kind: "team", teamId: idIn(teamIds, readers.team) };
};

describe("the Brain evaluation", () => {
  it("asks every question of the Brain and of plain text search, and nothing reaches an asker who may not read it", async () => {
    expect(setProblems(sources, questions)).toStrictEqual([]);

    const people = await signUpPeople();
    const teamIds = await setUpTeams(people);
    const keyOfId = new Map<string, string>();
    // One at a time, in the set's order, so "newer first" breaks ties the
    // same way in every run and in the baseline.
    for (const source of sources) {
      // oxlint-disable-next-line no-await-in-loop -- in order, see above
      const { id } = await addSource(env, {
        text: source.text,
        readers: readersIn(source.readers, people, teamIds),
      });
      keyOfId.set(id, source.key);
    }

    console.log(
      `BRAIN_EVAL_RUN ${JSON.stringify({
        set: version,
        setDigest: await sha256Hex(JSON.stringify(brainEvalSet)),
        sources: sources.length,
        questions: questions.length,
        recallLimit,
      })}`
    );

    const leaking: string[] = [];
    for (const question of questions) {
      const asker = askerOf(question);
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- timed one at a time
      const recalled = await recallAs(
        env,
        idIn(people, asker),
        question.question
      );
      const ms = performance.now() - started;
      const brain: Returned = {
        keys: recalled.sources.map(({ id }) => keyOfId.get(id)),
        texts: recalled.sources.map(({ text }) => text),
      };
      const grep = grepRecall(asker, question.question);
      const brainLeaks = leaksOf(question, brain);
      if (brainLeaks.length > 0) {
        leaking.push(`${question.id}: ${brainLeaks.join(", ")}`);
      }
      const { expects } = question;
      console.log(
        `BRAIN_EVAL_RESULT ${JSON.stringify({
          id: question.id,
          // oxlint-disable-next-line no-await-in-loop -- one per question
          digest: await digestOf(question),
          language: question.language,
          sourceLanguage: sourceLanguageOf(question),
          expects: expects.kind,
          way: expects.kind === "answer" ? expects.way : null,
          brain: {
            rank: rankOf(question, brain),
            returned: brain.keys.length,
            leaks: brainLeaks,
            ms,
          },
          grep: {
            rank: rankOf(question, grep),
            returned: grep.keys.length,
            leaks: leaksOf(question, grep),
          },
        })}`
      );
    }
    expect(leaking).toStrictEqual([]);
  });
});
