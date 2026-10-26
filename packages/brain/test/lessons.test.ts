import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createBrain } from "../src/brain.ts";
import { brainErrors } from "../src/contract.ts";
import {
  consolidate,
  consolidationLimits,
  lessonsOf,
  retireLesson,
  consolidationJob,
  scopeKeyOf,
  scopesBehind,
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
      // Two of three failures left: retired by the erasure itself.
      job: { read: 0, patched: 0 },
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

  it("keeps nothing of a person a purge forgot while a job was reading their episodes", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    // The purge lands between the job's reads and its first write.
    let purged = false;
    const racing = new Proxy(env.BRAIN, {
      get: (target, property) => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!purged) {
              purged = true;
              await brain.db.batch(
                forgetPerson(brain.db, ann, brain.ports.clock())
              );
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    await consolidate(createBrain(racing, brain.ports), person(ann));
    const { results: marks } = await env.BRAIN.prepare(
      "SELECT scope_key FROM brain_consolidation_marks WHERE scope_key = ?"
    )
      .bind(scopeKeyOf(person(ann)))
      .all();
    const { results: versions } = await env.BRAIN.prepare(
      "SELECT lesson_id FROM brain_lesson_versions WHERE lesson_id IN (SELECT id FROM brain_lessons WHERE scope_id = ?)"
    )
      .bind(ann)
      .all();

    expect({
      purged,
      lessons: await lessonCount(brain, person(ann)),
      versions: versions.length,
      marks: marks.length,
    }).toStrictEqual({ purged: true, lessons: 0, versions: 0, marks: 0 });
  });

  it("retires a lesson in the batch that erases the last of its support, with no job after", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const failures = [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ];
    await recorded(brain, failures);
    await consolidate(brain, person(ann));

    await eraseOutcomes(
      brain,
      failures.map(({ evidenceId }) => evidenceId)
    );
    const [lesson] = await lessonsOf(brain, person(ann));

    expect({
      state: lesson?.state,
      retiredBy: lesson?.retiredBy,
    }).toStrictEqual({ state: "retired", retiredBy: "evidence" });
  });

  it("keeps a lesson an erasure retired while a job was patching it retired", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const first = [run(ann, "failed"), run(ann, "failed"), run(ann, "failed")];
    await recorded(brain, first);
    await consolidate(brain, person(ann));
    await recorded(brain, [run(ann, "failed")]);
    // The job reads four failures; two of the first go before it writes.
    let erased = false;
    const racing = new Proxy(env.BRAIN, {
      get: (target, property) => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!erased) {
              erased = true;
              await eraseOutcomes(
                brain,
                first.slice(0, 2).map(({ evidenceId }) => evidenceId)
              );
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    await consolidate(createBrain(racing, brain.ports), person(ann));
    const [lesson] = await lessonsOf(brain, person(ann));

    expect({
      erased,
      state: lesson?.state,
      retiredBy: lesson?.retiredBy,
      // Revision 2 is the erasure's retirement; nothing after it.
      revision: lesson?.revision,
    }).toStrictEqual({
      erased: true,
      state: "retired",
      retiredBy: "evidence",
      revision: 2,
    });
  });

  it("names a job by the work it has to do, so work after a finished job or a purge starts a new one", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    const first = await consolidationJob(brain, scope);
    await consolidate(brain, scope);
    const finished = await consolidationJob(brain, scope);
    await brain.db.batch(forgetPerson(brain.db, ann, brain.ports.clock()));
    // Work after the purge, by a person active again.
    await recorded(brain, [
      run(ann, "failed", {
        occurredAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);
    const afterPurge = await consolidationJob(brain, scope);

    expect({
      finishedIsNew: finished.id !== first.id,
      afterPurgeIsNew:
        afterPurge.id !== first.id && afterPurge.id !== finished.id,
    }).toStrictEqual({ finishedIsNew: true, afterPurgeIsNew: true });
  });

  it("reads a lesson's group before limiting it, so other versions' runs never crowd it out", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    // Many newer runs of the same task on another version.
    await recorded(
      brain,
      Array.from({ length: 400 }, () =>
        run(ann, "completed", {
          versionRefs: [{ kind: "app", id: "invoices", version: "4" }],
        })
      )
    );

    await consolidate(brain, scope);
    const lessons = await lessonsOf(brain, scope);
    const v3 = lessons.find(
      ({ versions }) =>
        versions
          .at(-1)
          ?.content.applicability.versions.includes("app:invoices@3") === true
    );

    expect(v3?.versions.at(-1)?.content.supporting.length).toBe(3);
  });

  it("answers a retirement that lost its race to a job as a conflict, the lesson as the job left it", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    await consolidate(brain, scope);
    await recorded(brain, [run(ann, "failed")]);
    const [lesson] = await lessonsOf(brain, scope);
    // The job lands between the retirement's read and its write.
    let raced = false;
    const racing = new Proxy(env.BRAIN, {
      get: (target, property) => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await consolidate(brain, scope);
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const answer = await outcome(
      retireLesson(
        createBrain(racing, brain.ports),
        { userId: ann, reads: [] },
        { lessonId: lesson?.id ?? "", expectedRevision: 1 }
      )
    );
    const [after] = await lessonsOf(brain, scope);

    expect({
      answer,
      state: after?.state,
      revision: after?.revision,
    }).toStrictEqual({
      answer: "brain.revision_conflict",
      state: "candidate",
      revision: 2,
    });
  });

  it("counts a reopened lesson against the scope's open candidates", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    const reopening = [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ];
    await recorded(brain, reopening);
    await consolidate(brain, scope);
    // Retired by its evidence going.
    await eraseOutcomes(
      brain,
      reopening.map(({ evidenceId }) => evidenceId)
    );
    // The scope fills up with open candidates.
    await recorded(
      brain,
      Array.from({ length: consolidationLimits.openPerScope }, (_, n) =>
        Array.from({ length: 3 }, () =>
          run(ann, "failed", { taskType: `workflow:app/full-${n}` })
        )
      ).flat()
    );
    for (let job = 0; job < 4; job += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one job after another
      await consolidate(brain, scope);
    }
    // New failures of the retired lesson's group.
    await recorded(brain, [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ]);
    await consolidate(brain, scope);
    const lessons = await lessonsOf(brain, scope);

    expect(lessons.filter(({ state }) => state === "candidate")).toHaveLength(
      consolidationLimits.openPerScope
    );
  });

  it("reads an episode recorded late, whatever its clock said, past the watermark", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    await recorded(brain, [run(ann, "failed"), run(ann, "failed")]);
    await consolidate(brain, scope);
    // Recorded after the job, by a host whose clock ran behind.
    const behind = createBrain(env.BRAIN, {
      ...brain.ports,
      clock: () => new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await recordOutcome(behind, run(ann, "failed"));

    const job = await consolidate(brain, scope);
    const [lesson] = await lessonsOf(brain, scope);

    expect({
      job,
      supporting: lesson?.versions.at(-1)?.content.supporting.length,
    }).toStrictEqual({
      job: { read: 1, patched: 1 },
      supporting: 3,
    });
  });

  it("keeps the links an erasure leaves in the revision that retires a lesson", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    const failures = [
      run(ann, "failed"),
      run(ann, "failed"),
      run(ann, "failed"),
    ];
    await recorded(brain, failures);
    await consolidate(brain, scope);

    await eraseOutcomes(brain, [failures[0]?.evidenceId ?? ""]);
    const [lesson] = await lessonsOf(brain, scope);
    const retired = lesson?.versions.find(({ revision }) => revision === 2);

    expect({
      state: lesson?.state,
      kept: retired?.evidence.map(({ episodeId }) => episodeId).toSorted(),
    }).toStrictEqual({
      state: "retired",
      kept: failures
        .slice(1)
        .map(({ eventId }) => eventId)
        .toSorted(),
    });
  });

  it("marks a scope due at once when an erasure leaves an open lesson with what it rests on changed, and sweeps only scopes due", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    const failures = Array.from({ length: 4 }, () => run(ann, "failed"));
    await recorded(brain, failures);
    await consolidate(brain, scope);
    const keyOf = (scopes: ConsolidationScope[]) =>
      scopes.some((each) => each.scopeId === ann);
    const idle = keyOf(await scopesBehind(brain, new Date(), 1000));

    await eraseOutcomes(brain, [failures[0]?.evidenceId ?? ""]);
    const due = keyOf(await scopesBehind(brain, new Date(), 1000));
    await consolidate(brain, scope);
    const [lesson] = await lessonsOf(brain, scope);
    const refreshed = keyOf(await scopesBehind(brain, new Date(), 1000));

    expect({
      idle,
      due,
      refreshed,
      text: lesson?.versions.at(-1)?.content.instruction,
    }).toStrictEqual({
      idle: false,
      due: true,
      refreshed: false,
      text: "workflow:invoices/tidy failed 3 of its last 3 finished runs on app:invoices@3.",
    });
  });

  it("never opens past the scope's cap when another job opens one meanwhile", async () => {
    const { brain } = testHost();
    const ann = `ann-${crypto.randomUUID()}`;
    const scope = person(ann);
    await recorded(
      brain,
      Array.from({ length: consolidationLimits.openPerScope - 1 }, (_, n) =>
        Array.from({ length: 3 }, () =>
          run(ann, "failed", { taskType: `workflow:app/held-${n}` })
        )
      ).flat()
    );
    for (let job = 0; job < 3; job += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one job after another
      await consolidate(brain, scope);
    }
    await recorded(
      brain,
      Array.from({ length: 3 }, () =>
        run(ann, "failed", { taskType: "workflow:app/new" })
      )
    );
    // Another job opens the scope's last free candidate just before this
    // one writes, after this one counted what was open.
    let overlapped = false;
    const racing = new Proxy(env.BRAIN, {
      get: (target, property) => {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!overlapped) {
              overlapped = true;
              const at = Date.now();
              await target
                .prepare(
                  "INSERT INTO brain_lessons (id, revision, scope, scope_id, group_key, kind, applicability, exclusions, instruction, evidence_status, state, retired_by, created_at, updated_at) VALUES (?, 1, 'person', ?, ?, 'failure_pattern', '{\"taskType\":\"other\",\"versions\":[]}', '[]', 'Other.', 'supported', 'candidate', NULL, ?, ?)"
                )
                .bind(crypto.randomUUID(), ann, crypto.randomUUID(), at, at)
                .run();
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    await consolidate(createBrain(racing, brain.ports), scope);
    const lessons = await lessonsOf(brain, scope);

    expect({
      overlapped,
      open: lessons.filter(({ state }) => state === "candidate").length,
    }).toStrictEqual({
      overlapped: true,
      open: consolidationLimits.openPerScope,
    });
  });
});
