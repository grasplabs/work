import { recallLimit } from "@grasp-os/brain-next/contract";
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
  grepRecall,
  leaksOf,
  questionDigestOf,
  rankOf,
  setDigestOf,
  setProblems,
} from "./fixtures/brain-eval/set.ts";
import type { Returned } from "./fixtures/brain-eval/set.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// The Brain evaluation (GRA-1726), on request only: scripts/brain-eval.ts
// runs it and reports (`vp run brain:eval`). It puts the evaluation's
// company (fixtures/brain-eval/) into a fresh core: its people as members,
// its teams, and each source through core's own `addSource` with who may
// read it. Then it asks every question as its asker through core's
// `recallAs`, timing each recall, and asks the same of plain text search
// (`grepRecall` in fixtures/brain-eval/set.ts) over the same sources,
// with the same access. It prints
// what each returned, one JSON line per question (`BRAIN_EVAL_RESULT`),
// for the script to score; it fails only when the set is broken or the
// Brain returned something its asker may not read.

const { sources, questions, version } = brainEvalSet;

const idp = mockIdp();

const sourceOf = (key: string): BrainEvalSource | undefined =>
  sources.find((source) => source.key === key);

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
    // Each source as an upload named by its key in the set, so what recall
    // returns names it. One at a time, in the set's order, so "newer
    // first" breaks ties the same way in every run and in the baseline.
    for (const source of sources) {
      // oxlint-disable-next-line no-await-in-loop -- in order, see above
      await addSource(env, {
        source: { producer: "upload", id: source.key },
        change: source.key,
        text: source.text,
        readers: readersIn(source.readers, people, teamIds),
      });
    }

    console.log(
      `BRAIN_EVAL_RUN ${JSON.stringify({
        set: version,
        setDigest: await setDigestOf(brainEvalSet),
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
      // Recall returns chunks: the question's source is found when a chunk
      // of it holds the quote (`rankOf`), and the leak check reads every
      // chunk returned.
      const brain: Returned = {
        keys: recalled.chunks.map(({ source }) => source.id),
        texts: recalled.chunks.map(({ text }) => text),
      };
      const grep = grepRecall(sources, asker, question.question, recallLimit);
      const brainLeaks = leaksOf(sources, question, brain);
      if (brainLeaks.length > 0) {
        leaking.push(`${question.id}: ${brainLeaks.join(", ")}`);
      }
      const { expects } = question;
      console.log(
        `BRAIN_EVAL_RESULT ${JSON.stringify({
          id: question.id,
          // oxlint-disable-next-line no-await-in-loop -- one per question
          digest: await questionDigestOf(brainEvalSet, question),
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
          grep: { rank: rankOf(question, grep), returned: grep.keys.length },
        })}`
      );
    }
    expect(leaking).toStrictEqual([]);
  });
});
