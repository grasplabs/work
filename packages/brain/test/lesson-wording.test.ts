import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { lessonLineage } from "../src/lesson-reads.ts";
import {
  consolidate,
  lessonsOf,
  runConsolidation,
  wordingClaimMs,
  wordingMaxLength,
  wordingsPerJob,
  wordLessons,
} from "../src/lessons.ts";
import { eraseOutcomes, recordOutcome } from "../src/outcomes.ts";
import type { TaskOutcome } from "../src/outcomes.ts";
import { testHost } from "./host.ts";

// A model's wording of a lesson (GRA-301, slice 3; the threat model is on
// the issue), against a host whose model is faked. Tried below: the model
// being given more than the lesson holds; a revision worded twice; a
// spent budget failing the lesson or being asked again; a wording that
// escapes its cap or carries control characters; and a wording shown
// where the lesson's text is hidden.

let clock = Date.now() - 24 * 60 * 60 * 1000;

const named = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** A failed run of `taskType` by `ownerId`, in `audience` when given. */
const failed = (
  ownerId: string,
  taskType = "workflow:invoices/tidy",
  audience?: { id: string; members: string[] }
): TaskOutcome => {
  const id = crypto.randomUUID();
  clock += 1000;
  return {
    eventId: `test:${id}`,
    source: "test.lesson-wording",
    sourceSeq: 1,
    purpose: "production",
    ownerId,
    ...(audience === undefined
      ? { scope: "person" as const }
      : { scope: "session" as const, audience }),
    taskType,
    execution: "failed",
    result: "failure",
    evidenceId: id,
    evidenceRefs: [{ kind: "workflow_run", id }],
    versionRefs: [{ kind: "app", id: "invoices", version: "3" }],
    occurredAt: new Date(clock).toISOString(),
  };
};

/** Records three failures of `taskType` for `ownerId`, and consolidates. */
const lessonFor = async (
  brain: ReturnType<typeof testHost>["brain"],
  ownerId: string,
  taskType?: string
) => {
  for (let n = 0; n < 3; n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- in order
    await recordOutcome(brain, failed(ownerId, taskType));
  }
  await consolidate(brain, { scope: "person", scopeId: ownerId });
};

/** Claims lesson `lessonId`'s current revision for job `token`, now. */
const claim = async (lessonId: string, token: string) =>
  await env.BRAIN.prepare(
    "UPDATE brain_lesson_versions SET wording_state = 'claimed', wording_claim = ?, wording_claimed_at = ? WHERE lesson_id = ?"
  )
    .bind(token, Date.now(), lessonId)
    .run();

/** The current version's wording and state, as stored. */
const stored = async (lessonId: string) =>
  await env.BRAIN.prepare(
    "SELECT wording, wording_state AS state FROM brain_lesson_versions WHERE lesson_id = ? ORDER BY revision DESC LIMIT 1"
  )
    .bind(lessonId)
    .first<{ wording: string | null; state: string | null }>();

describe("wording lessons", () => {
  it("gives the model what the lesson holds and nothing more, and keeps one capped line beside the lesson's text", async () => {
    const answer = `Invoices\u0000 kept\nfailing ${"x".repeat(wordingMaxLength)}`;
    const { brain, worded } = testHost(undefined, { answer });
    const ann = named("ann");
    await lessonFor(brain, ann);
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });

    const count = await wordLessons(brain, { scope: "person", scopeId: ann });
    const kept = await stored(lesson?.id ?? "");

    expect({
      count,
      facts: worded,
      names: JSON.stringify(worded).includes(ann),
      length: kept?.wording?.length,
      // oxlint-disable-next-line no-control-regex -- control characters on purpose
      controls: /[\u0000-\u001F]/u.test(kept?.wording ?? ""),
      state: kept?.state,
      text: lesson?.versions.at(-1)?.content.instruction,
    }).toStrictEqual({
      count: 1,
      facts: [
        {
          taskType: "workflow:invoices/tidy",
          versions: ["app:invoices@3"],
          failures: 3,
          completions: 0,
          evidenceStatus: "supported",
          instruction:
            "workflow:invoices/tidy failed 3 of its last 3 finished runs on app:invoices@3.",
        },
      ],
      names: false,
      length: wordingMaxLength,
      controls: false,
      state: "written",
      text: "workflow:invoices/tidy failed 3 of its last 3 finished runs on app:invoices@3.",
    });
  });

  it("keeps no control or format characters in a wording", async () => {
    // A right-to-left override, a zero-width joiner and a C1 next-line.
    const answer = "Invoices \u202Ekept\u200D failing\u0085 lately.";
    const { brain } = testHost(undefined, { answer });
    const ann = named("ann");
    await lessonFor(brain, ann);
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });

    await wordLessons(brain, { scope: "person", scopeId: ann });
    const kept = await stored(lesson?.id ?? "");

    expect(kept?.wording).toBe("Invoices  kept  failing  lately.");
  });

  it("words a revision once, however often the job is made again", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    await lessonFor(brain, ann);

    await wordLessons(brain, { scope: "person", scopeId: ann });
    await wordLessons(brain, { scope: "person", scopeId: ann });

    expect(worded).toHaveLength(1);
  });

  it("keeps the lesson's text when the budget is spent, and doesn't ask again for that revision", async () => {
    const { brain, worded } = testHost(undefined, {
      refuse: "brain.budget_exceeded",
    });
    const ann = named("ann");
    await lessonFor(brain, ann);
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });

    const count = await wordLessons(brain, { scope: "person", scopeId: ann });
    await wordLessons(brain, { scope: "person", scopeId: ann });
    const [after] = await lessonsOf(brain, { scope: "person", scopeId: ann });

    expect({
      count,
      asked: worded.length,
      kept: await stored(lesson?.id ?? ""),
      state: after?.state,
      revision: after?.revision,
    }).toStrictEqual({
      count: 0,
      asked: 1,
      kept: { wording: null, state: "refused" },
      state: "candidate",
      revision: 1,
    });
  });

  it("asks for a bounded number of wordings a job", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    for (let n = 0; n < wordingsPerJob + 2; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one task at a time
      await lessonFor(brain, ann, `workflow:app/task-${n}`);
    }

    const first = await wordLessons(brain, { scope: "person", scopeId: ann });
    const second = await wordLessons(brain, { scope: "person", scopeId: ann });

    expect({ first, second, asked: worded.length }).toStrictEqual({
      first: wordingsPerJob,
      second: 2,
      asked: wordingsPerJob + 2,
    });
  });

  it("words every lesson a job patched, a bounded pass at a time", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    for (let n = 0; n < wordingsPerJob + 2; n += 1) {
      for (let m = 0; m < 3; m += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await recordOutcome(brain, failed(ann, `workflow:app/job-${n}`));
      }
    }
    const steps: string[] = [];

    await runConsolidation(
      brain,
      { scope: "person", scopeId: ann },
      {
        do: async (name, _config, fn) => {
          steps.push(name);
          return await fn();
        },
      }
    );

    expect({ steps, asked: worded.length }).toStrictEqual({
      steps: ["consolidate", "word-claim", "word-0", "word-1"],
      asked: wordingsPerJob + 2,
    });
  });

  it("words every lesson a job patched though one's wording fails", async () => {
    const { brain, worded } = testHost(undefined, {
      failsFor: ({ taskType }) => taskType === "workflow:app/job-0",
    });
    const ann = named("ann");
    for (let n = 0; n < wordingsPerJob + 2; n += 1) {
      for (let m = 0; m < 3; m += 1) {
        // oxlint-disable-next-line no-await-in-loop -- in order
        await recordOutcome(brain, failed(ann, `workflow:app/job-${n}`));
      }
    }

    await runConsolidation(
      brain,
      { scope: "person", scopeId: ann },
      { do: async (_name, _config, fn) => await fn() }
    );
    const lessons = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const states = await Promise.all(
      lessons.map(async ({ id }) => {
        const kept = await stored(id);
        return kept?.state ?? null;
      })
    );

    expect({
      asked: worded.length,
      written: states.filter((state) => state === "written").length,
      failed: states.filter((state) => state === "failed").length,
      unworded: states.filter((state) => state === null).length,
    }).toStrictEqual({
      asked: wordingsPerJob + 2,
      written: wordingsPerJob + 1,
      failed: 1,
      unworded: 0,
    });
  });

  it("asks for a revision's wording once, though two jobs word its scope at once, and again only once a claim's lease is over", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one task at a time
      await lessonFor(brain, ann, `workflow:app/twice-${n}`);
    }
    const scope = { scope: "person" as const, scopeId: ann };

    const [one, other] = await Promise.all([
      wordLessons(brain, scope),
      wordLessons(brain, scope),
    ]);
    const askedAtOnce = worded.length;
    // A pass that died holding a claim: past its lease, the next words it.
    const [lesson] = await lessonsOf(brain, scope);
    await env.BRAIN.prepare(
      "UPDATE brain_lesson_versions SET wording = NULL, wording_state = 'claimed', wording_claimed_at = ? WHERE lesson_id = ?"
    )
      .bind(Date.now() - wordingClaimMs - 1000, lesson?.id ?? "")
      .run();
    const reclaimed = await wordLessons(brain, scope);

    expect({
      worded: one + other,
      askedAtOnce,
      reclaimed,
      asked: worded.length,
    }).toStrictEqual({
      worded: 3,
      askedAtOnce: 3,
      reclaimed: 1,
      asked: 4,
    });
  });

  it("words on a job's retry what its failed attempt claimed, though another job's claim holds", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    await lessonFor(brain, ann, "workflow:app/retried");
    await lessonFor(brain, ann, "workflow:app/elsewhere");
    const lessons = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const [retried, elsewhere] = lessons;
    // Its first attempt claimed one and failed before saving; another job,
    // still running, holds the other.
    await claim(retried?.id ?? "", "this-job");
    await claim(elsewhere?.id ?? "", "another-job");

    // The retry: its durable step answers the token it kept.
    await runConsolidation(
      brain,
      { scope: "person", scopeId: ann },
      {
        do: async (name, _config, fn) =>
          name === "word-claim" ? "this-job" : await fn(),
      }
    );

    const retriedKept = await stored(retried?.id ?? "");
    const elsewhereKept = await stored(elsewhere?.id ?? "");
    expect({
      retried: retriedKept?.state,
      elsewhere: elsewhereKept?.state,
      asked: worded.length,
    }).toStrictEqual({
      retried: "written",
      elsewhere: "claimed",
      asked: 1,
    });
  });

  it("asks nothing for a revision whose evidence an erasure cut short of what its text says", async () => {
    const { brain, worded } = testHost();
    const ann = named("ann");
    await lessonFor(brain, ann);
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });
    // One of its episodes erased, its revision not yet patched again.
    await env.BRAIN.prepare(
      "DELETE FROM brain_lesson_evidence WHERE rowid = (SELECT rowid FROM brain_lesson_evidence WHERE lesson_id = ? LIMIT 1)"
    )
      .bind(lesson?.id ?? "")
      .run();

    const count = await wordLessons(brain, { scope: "person", scopeId: ann });

    expect({
      count,
      asked: worded.length,
      kept: await stored(lesson?.id ?? ""),
    }).toStrictEqual({
      count: 0,
      asked: 0,
      kept: { wording: null, state: null },
    });
  });

  it("hides a version's wording wherever its text is hidden", async () => {
    const { brain } = testHost(undefined, { answer: "Turns kept failing." });
    const chat = named("chat");
    const ann = named("ann");
    const cas = named("cas");
    const alone = [
      failed(ann, "chat.turn", { id: chat, members: [ann] }),
      failed(ann, "chat.turn", { id: chat, members: [ann] }),
    ];
    for (const each of [
      ...alone,
      ...Array.from({ length: 4 }, () =>
        failed(ann, "chat.turn", { id: chat, members: [ann, cas] })
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, each);
    }
    const scope = { scope: "session" as const, scopeId: chat };
    await consolidate(brain, scope);
    await wordLessons(brain, scope);
    await eraseOutcomes(
      brain,
      alone.map(({ evidenceId }) => evidenceId)
    );
    await consolidate(brain, scope);
    await wordLessons(brain, scope);
    const [lesson] = await lessonsOf(brain, scope);
    const lineage = await lessonLineage(
      brain,
      { userId: cas, reads: [], audiences: [chat] },
      { lessonId: lesson?.id ?? "" }
    );
    const of = (revision: number) =>
      lineage.versions.find((each) => each.revision === revision);

    expect({
      current: of(2)?.wording,
      first: { text: of(1)?.instruction, wording: of(1)?.wording },
    }).toStrictEqual({
      current: "Turns kept failing.",
      first: { text: null, wording: null },
    });
  });
});
