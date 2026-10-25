import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainErrors } from "../src/contract.ts";
import {
  consolidate,
  consolidationLimits,
  lessonsOf,
  retireLesson,
  scopeKeyOf,
} from "../src/lessons.ts";
import type { ConsolidationScope, Lesson } from "../src/lessons.ts";
import { forgetPerson } from "../src/memories.ts";
import { eraseOutcomes, recordOutcome } from "../src/outcomes.ts";
import type { TaskOutcome } from "../src/outcomes.ts";
import { testHost } from "./host.ts";

// Consolidating a scope's verified episodes into lesson candidates
// (GRA-301; the design and its ways to fail are on the issue), on the
// Brain alone. Tried below:
// 1. A private episode shaping a lesson outside its scope.
// 2. A retried or cut-short job writing a patch twice, or a stale patch
//    overwriting a newer revision.
// 3. A lesson its owner retired coming back because the failures repeat.
// 4. A lesson outliving the episodes it rests on: erased, or purged with
//    their person.
// 5. Repeated rounds losing earlier evidence (E04): every failure and
//    every counterexample stays linked.
// 6. A job doing unbounded work.

/** The code `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

let clock = Date.now() - 24 * 60 * 60 * 1000;

/** A settled run of `taskType` by `ownerId`, as a host records it. */
const run = (
  ownerId: string,
  execution: "completed" | "failed",
  overrides: Partial<TaskOutcome> = {}
): TaskOutcome => {
  const id = crypto.randomUUID();
  clock += 1000;
  return {
    eventId: `workflow.run:${id}`,
    source: "test.lessons",
    sourceSeq: 1,
    purpose: "production",
    ownerId,
    scope: "person",
    taskType: "workflow:invoices/tidy",
    execution,
    result: execution === "failed" ? "failure" : "unknown",
    evidenceId: id,
    evidenceRefs: [{ kind: "workflow_run", id }],
    versionRefs: [{ kind: "app", id: "invoices", version: "3" }],
    occurredAt: new Date(clock).toISOString(),
    ...overrides,
  };
};

/** Records `outcomes` in order: their evidence IDs. */
const recorded = async (
  brain: ReturnType<typeof testHost>["brain"],
  outcomes: TaskOutcome[]
): Promise<string[]> => {
  for (const each of outcomes) {
    // oxlint-disable-next-line no-await-in-loop -- in the order they settled
    await recordOutcome(brain, each);
  }
  return outcomes.map(({ eventId }) => eventId);
};

/** Each lesson's revisions, as `[revision, supersedes, state-ish]`. */
const historyOf = (lesson: Lesson | undefined) =>
  lesson?.versions.map(({ revision, supersedes, content }) => ({
    revision,
    supersedes,
    status: content.evidenceStatus,
    supporting: content.supporting.length,
    contradicting: content.contradicting.length,
  }));

/** How many lessons `scope` holds. */
const lessonCount = async (
  brain: ReturnType<typeof testHost>["brain"],
  scope: ConsolidationScope
): Promise<number> => {
  const lessons = await lessonsOf(brain, scope);
  return lessons.length;
};

const person = (userId: string): ConsolidationScope => ({
  scope: "person",
  scopeId: userId,
});

describe("consolidating episodes into lesson candidates", () => {
  it("keeps a repeated failure as a candidate in exactly its episodes' scope, with what supports and contradicts it", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const ben = `ben-${crypto.randomUUID()}`;
    const failures = await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    const [completedRun] = await recorded(brain, [run(ann, "completed")]);
    // Ben's one failure of the same task: his, and too few anyway.
    await recorded(brain, [run(ben, "failed")]);

    const job = await consolidate(brain, person(ann));
    const [lesson] = await lessonsOf(brain, person(ann));
    const latest = lesson?.versions.at(-1);

    expect({
      job,
      lessons: await lessonCount(brain, person(ann)),
      bens: await lessonCount(brain, person(ben)),
      state: lesson?.state,
      applicability: latest?.content.applicability,
      instruction: latest?.content.instruction,
      status: latest?.content.evidenceStatus,
      supporting: latest?.content.supporting,
      contradicting: latest?.content.contradicting,
    }).toStrictEqual({
      job: { read: 4, patched: 1 },
      lessons: 1,
      bens: 0,
      state: "candidate",
      applicability: {
        taskType: "workflow:invoices/tidy",
        versions: ["app:invoices@3"],
      },
      instruction:
        "workflow:invoices/tidy failed 3 of its last 4 finished runs on app:invoices@3.",
      status: "contested",
      supporting: failures.toSorted(),
      contradicting: [completedRun],
    });
  });

  it("writes nothing twice when a job is made again, its watermark lost or not", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);

    const first = await consolidate(brain, person(ann));
    const again = await consolidate(brain, person(ann));
    // As though the job was cut short before it moved its watermark.
    await env.BRAIN.prepare(
      "DELETE FROM brain_consolidation_marks WHERE scope_key = ?"
    )
      .bind(scopeKeyOf(person(ann)))
      .run();
    const replayed = await consolidate(brain, person(ann));
    const [lesson] = await lessonsOf(brain, person(ann));

    expect({
      first,
      again,
      replayed,
      history: historyOf(lesson),
    }).toStrictEqual({
      first: { read: 3, patched: 1 },
      again: { read: 0, patched: 0 },
      replayed: { read: 3, patched: 0 },
      history: [
        {
          revision: 1,
          supersedes: null,
          status: "supported",
          supporting: 3,
          contradicting: 0,
        },
      ],
    });
  });

  it("patches its last revision as evidence grows, keeping every version and every episode (E04)", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const early = await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    await consolidate(brain, person(ann));
    const later = await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    await consolidate(brain, person(ann));
    const [counter] = await recorded(brain, [run(ann, "completed")]);
    await consolidate(brain, person(ann));
    const [lesson] = await lessonsOf(brain, person(ann));
    const latest = lesson?.versions.at(-1);

    expect({
      history: historyOf(lesson),
      // The first failures are still there, three rounds on.
      supporting: latest?.content.supporting,
      contradicting: latest?.content.contradicting,
    }).toStrictEqual({
      history: [
        {
          revision: 1,
          supersedes: null,
          status: "supported",
          supporting: 3,
          contradicting: 0,
        },
        {
          revision: 2,
          supersedes: 1,
          status: "supported",
          supporting: 5,
          contradicting: 0,
        },
        {
          revision: 3,
          supersedes: 2,
          status: "contested",
          supporting: 5,
          contradicting: 1,
        },
      ],
      supporting: [...early, ...later].toSorted(),
      contradicting: [counter],
    });
  });

  it("keeps a lesson its owner retired retired, however often the failure repeats, and refuses a stale retirement", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const caller = { userId: ann, reads: [] };
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    await consolidate(brain, person(ann));
    const [lesson] = await lessonsOf(brain, person(ann));
    const lessonId = lesson?.id ?? "";

    const byOther = await outcome(
      retireLesson(
        brain,
        { userId: "someone-else", reads: [] },
        { lessonId, expectedRevision: 1 }
      )
    );
    const stale = await outcome(
      retireLesson(brain, caller, { lessonId, expectedRevision: 7 })
    );
    const retired = await outcome(
      retireLesson(brain, caller, { lessonId, expectedRevision: 1 })
    );
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    const job = await consolidate(brain, person(ann));
    const [after] = await lessonsOf(brain, person(ann));

    expect({
      byOther,
      stale,
      retired,
      job,
      state: after?.state,
      retiredBy: after?.retiredBy,
      revision: after?.revision,
    }).toStrictEqual({
      byOther: "brain.not_found",
      stale: "brain.revision_conflict",
      retired: "ok",
      job: { read: 3, patched: 0 },
      state: "retired",
      retiredBy: "owner",
      revision: 2,
    });
  });

  it("retires a lesson whose episodes were erased, and forgets a purged person's lessons", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const cas = `cas-${crypto.randomUUID()}`;
    const anns = [run(ann, "failed"), run(ann, "failed"), run(ann, "failed")];
    await recorded(brain, anns);
    await recorded(brain, [
      run(cas, "failed"),
      run(cas, "failed"),
      run(cas, "failed"),
    ]);
    await consolidate(brain, person(ann));
    await consolidate(brain, person(cas));

    await eraseOutcomes(
      brain,
      anns.slice(0, 1).map(({ evidenceId }) => evidenceId)
    );
    const job = await consolidate(brain, person(ann));
    const [annLesson] = await lessonsOf(brain, person(ann));
    await brain.db.batch(forgetPerson(brain.db, cas, brain.ports.clock()));
    const { results: stored } = await env.BRAIN.prepare(
      "SELECT content FROM brain_lesson_versions"
    ).all<{ content: string }>();

    expect({
      job,
      state: annLesson?.state,
      retiredBy: annLesson?.retiredBy,
      // The erased episode is no longer evidence of any revision.
      erasedStillEvidence: annLesson?.versions.some(({ evidence }) =>
        evidence.some(({ episodeId }) => episodeId === anns[0]?.eventId)
      ),
      // No version names an episode: evidence is kept apart from content.
      versionsNameEpisodes: stored.some(({ content }) =>
        anns.some(({ eventId }) => content.includes(eventId))
      ),
      cas: await lessonCount(brain, person(cas)),
    }).toStrictEqual({
      job: { read: 0, patched: 1 },
      state: "retired",
      retiredBy: "evidence",
      erasedStillEvidence: false,
      versionsNameEpisodes: false,
      cas: 0,
    });
  });

  it("does bounded work a job, and leaves the rest of a scope's episodes to the next", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const groups = consolidationLimits.patchesPerJob + 2;
    await recorded(
      brain,
      Array.from({ length: groups }, (_, n) =>
        Array.from({ length: consolidationLimits.minFailures }, () =>
          run(ann, "failed", { taskType: `workflow:app/task-${n}` })
        )
      ).flat()
    );

    const first = await consolidate(brain, person(ann));
    const second = await consolidate(brain, person(ann));

    expect({
      firstPatched: first.patched,
      secondPatched: second.patched,
      lessons: await lessonCount(brain, person(ann)),
    }).toStrictEqual({
      firstPatched: consolidationLimits.patchesPerJob,
      secondPatched: 2,
      lessons: groups,
    });
  });
});
