import { describe, expect, it } from "vite-plus/test";

import {
  lessonsOf,
  consolidate,
  retireLesson,
  wordLessons,
} from "../src/lessons.ts";
import type { Lesson } from "../src/lessons.ts";
import { recordOutcome } from "../src/outcomes.ts";
import type { TaskOutcome } from "../src/outcomes.ts";
import { testHost } from "./host.ts";

// E04 (GRA-301; the Brain design's "Implementation — E04"): does
// consolidation keep what a later task needs across repeated rounds and
// corrections? It compares the two ways a learning loop can consolidate:
//
// - incremental patches, as lessons.ts does: each round patches the
//   lesson's last revision from its evidence, every version kept, the text
//   of record built from identifiers and counts, and a model's wording
//   beside it, never instead of it;
// - full-summary replacement: each round, a model rewrites one summary of
//   everything from the summary before and the round's new events, within
//   a fixed length, as summary-based memories do.
//
// The model is mocked, and reproducibly so: the summarizer keeps the
// newest facts first and stops at its length budget, as a summary within
// a budget must. The fixture is a scripted sequence of rounds: failures on
// three versions, a completion that contests one of them, and the owner's
// correction (retiring a lesson), then more of the same failures after it.
// Required facts are scored after every round:
// 1. every version that failed is still named;
// 2. the first failure still counts (the oldest evidence survives);
// 3. a counterexample still marks its lesson as contested;
// 4. the owner's correction still holds after the failure repeats.

/** The longest summary the replacement summarizer keeps, in characters. */
const summaryBudget = 160;

let clock = Date.now() - 24 * 60 * 60 * 1000;

const named = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** A run of the fixture's task on `version`, by `ownerId`. */
const settled = (
  ownerId: string,
  version: string,
  execution: "failed" | "completed"
): TaskOutcome => {
  const id = crypto.randomUUID();
  clock += 1000;
  return {
    eventId: `e04:${id}`,
    source: "test.e04",
    sourceSeq: 1,
    purpose: "production",
    ownerId,
    scope: "person",
    taskType: "workflow:invoices/tidy",
    execution,
    result: execution === "failed" ? "failure" : "unknown",
    evidenceId: id,
    evidenceRefs: [{ kind: "workflow_run", id }],
    versionRefs: [{ kind: "app", id: "invoices", version }],
    occurredAt: new Date(clock).toISOString(),
  };
};

/** One round of the fixture: its events, and the owner's correction. */
interface Round {
  runs: { version: string; execution: "failed" | "completed" }[];
  /** Retire the lesson of this version, as its owner's correction. */
  correct?: string;
}

const fail = (version: string, times: number) =>
  Array.from({ length: times }, () => ({
    version,
    execution: "failed" as const,
  }));

const rounds: Round[] = [
  { runs: fail("1", 3) },
  { runs: fail("2", 3) },
  { runs: fail("3", 3) },
  { runs: [{ version: "1", execution: "completed" }] },
  { runs: fail("2", 2), correct: "2" },
  { runs: fail("2", 3) },
  { runs: fail("3", 2) },
  { runs: fail("1", 2) },
];

/** What a later task needs, as the fixture defines it, after `upTo` rounds. */
const required = (upTo: number) => {
  const seen = rounds.slice(0, upTo);
  const failed = new Set(
    seen.flatMap(({ runs }) =>
      runs
        .filter(({ execution }) => execution === "failed")
        .map(({ version }) => version)
    )
  );
  const contested = new Set(
    seen.flatMap(({ runs }) =>
      runs
        .filter(({ execution }) => execution === "completed")
        .map(({ version }) => version)
    )
  );
  const corrected = new Set(
    seen.flatMap(({ correct }) => (correct === undefined ? [] : [correct]))
  );
  return { failed, contested, corrected };
};

/** A score: required facts kept, of those there are. */
interface Score {
  kept: number;
  of: number;
}

/** What the incremental lessons keep of what is required after `upTo`. */
const scoreLessons = (
  lessons: readonly Lesson[],
  upTo: number,
  firstFailure: string
): Score => {
  const { failed, contested, corrected } = required(upTo);
  const ofVersion = (version: string) =>
    lessons.find(
      ({ versions }) =>
        versions
          .at(-1)
          ?.content.applicability.versions.includes(
            `app:invoices@${version}`
          ) === true
    );
  const checks = [
    // 1. Every version that failed is still named by a lesson.
    ...[...failed].map((version) => ofVersion(version) !== undefined),
    // 2. The first failure still counts as evidence: in its lesson's
    // latest revision, never only in an older one.
    lessons.some(
      ({ versions }) =>
        versions
          .at(-1)
          ?.evidence.some(({ episodeId }) => episodeId === firstFailure) ===
        true
    ),
    // 3. A counterexample still contests its lesson.
    ...[...contested].map(
      (version) =>
        ofVersion(version)?.versions.at(-1)?.content.evidenceStatus ===
        "contested"
    ),
    // 4. The owner's correction still holds.
    ...[...corrected].map((version) => ofVersion(version)?.state === "retired"),
  ];
  return { kept: checks.filter(Boolean).length, of: checks.length };
};

/**
 * The replacement summarizer, mocked: the facts of the summary before and
 * of the round's events, newest first, joined until the budget is spent.
 */
const summarize = (
  previous: readonly string[],
  round: Round,
  index: number
): string[] => {
  const facts = [
    ...(round.correct === undefined ? [] : [`owner retired v${round.correct}`]),
    ...round.runs.map(
      ({ version, execution }) => `round ${index + 1}: v${version} ${execution}`
    ),
  ];
  const kept: string[] = [];
  let length = 0;
  for (const fact of [...facts, ...previous]) {
    if (length + fact.length + 2 > summaryBudget) {
      break;
    }
    kept.push(fact);
    length += fact.length + 2;
  }
  return kept;
};

/** What the replacement summary keeps of what is required after `upTo`. */
const scoreSummary = (summary: readonly string[], upTo: number): Score => {
  const { failed, contested, corrected } = required(upTo);
  const text = summary.join("; ");
  const checks = [
    ...[...failed].map((version) => text.includes(`v${version} failed`)),
    text.includes("round 1: v1 failed"),
    ...[...contested].map((version) => text.includes(`v${version} completed`)),
    ...[...corrected].map((version) =>
      text.includes(`owner retired v${version}`)
    ),
  ];
  return { kept: checks.filter(Boolean).length, of: checks.length };
};

/** All rounds' scores, summed. */
const total = (scores: readonly Score[]): Score => ({
  kept: scores.reduce((sum, { kept }) => sum + kept, 0),
  of: scores.reduce((sum, { of }) => sum + of, 0),
});

/** The rounds after which a required fact was lost, from 1. */
const lost = (scores: readonly Score[]): number[] =>
  scores.flatMap(({ kept, of }, index) => (kept < of ? [index + 1] : []));

describe("E04: consolidation keeps what later tasks need across rounds and corrections", () => {
  it("keeps every required fact with incremental patches, where a full-summary rewrite within a budget loses some", async () => {
    const { brain } = testHost(undefined, {
      answer: "Tidying invoices keeps failing.",
    });
    const ann = named("ann");
    const scope = { scope: "person" as const, scopeId: ann };
    let summary: string[] = [];
    let firstFailure = "";
    const incremental: Score[] = [];
    const replacement: Score[] = [];
    for (const [index, round] of rounds.entries()) {
      for (const run of round.runs) {
        const outcome = settled(ann, run.version, run.execution);
        if (firstFailure === "" && run.execution === "failed") {
          firstFailure = outcome.eventId;
        }
        // oxlint-disable-next-line no-await-in-loop -- in the order they settle
        await recordOutcome(brain, outcome);
      }
      // oxlint-disable-next-line no-await-in-loop -- one round after another
      await consolidate(brain, scope);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await wordLessons(brain, scope);
      if (round.correct !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const lessons = await lessonsOf(brain, scope);
        const lesson = lessons.find(
          ({ versions }) =>
            versions
              .at(-1)
              ?.content.applicability.versions.includes(
                `app:invoices@${round.correct}`
              ) === true
        );
        // oxlint-disable-next-line no-await-in-loop -- as above
        await retireLesson(
          brain,
          { userId: ann, reads: [] },
          {
            lessonId: lesson?.id ?? "",
            expectedRevision: lesson?.revision ?? 0,
          }
        );
      }
      summary = summarize(summary, round, index);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const lessons = await lessonsOf(brain, scope);
      incremental.push(scoreLessons(lessons, index + 1, firstFailure));
      replacement.push(scoreSummary(summary, index + 1));
    }

    expect({
      incremental: total(incremental),
      incrementalLostIn: lost(incremental),
      replacementLostIn: lost(replacement),
      replacementKept: total(replacement),
    }).toStrictEqual({
      // Every required fact, after every round.
      incremental: { kept: 38, of: 38 },
      incrementalLostIn: [],
      // From round 4 on, the summary no longer holds the first failure,
      // and later the oldest versions and the correction.
      replacementLostIn: [4, 5, 6, 7, 8],
      replacementKept: { kept: 26, of: 38 },
    });
  });
});
