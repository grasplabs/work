import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { lessonLineage } from "../src/lesson-reads.ts";
import {
  consolidate,
  lessonsOf,
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
