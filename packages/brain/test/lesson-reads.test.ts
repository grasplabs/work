import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainErrors } from "../src/contract.ts";
import {
  lessonLineage,
  lessonsFor,
  lessonsRetire,
} from "../src/lesson-reads.ts";
import { consolidate, lessonsOf } from "../src/lessons.ts";
import { eraseOutcomes, recordOutcome } from "../src/outcomes.ts";
import type { TaskOutcome } from "../src/outcomes.ts";
import { testHost } from "./host.ts";
import type { Caller } from "./host.ts";

// Lessons as a person inspects and corrects them (GRA-301, slice 2; the
// threat model is on the issue). Tried below: a person lesson reaching
// anyone but its owner; a session lesson reaching someone who joined
// later, missed some of its turns, or left; an older version showing
// what its reader wasn't part of; and a correction by someone who may not
// see the lesson.

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

/** A failed run or turn of `ownerId`'s, in `audience` when given. */
const failed = (
  ownerId: string,
  audience?: { id: string; members: string[] }
): TaskOutcome => {
  const id = crypto.randomUUID();
  clock += 1000;
  return {
    eventId: `test:${id}`,
    source: "test.lesson-reads",
    sourceSeq: 1,
    purpose: "production",
    ownerId,
    ...(audience === undefined
      ? { scope: "person" as const }
      : { scope: "session" as const, audience }),
    taskType: "chat.turn",
    execution: "failed",
    result: "failure",
    evidenceId: id,
    evidenceRefs: [{ kind: "chat_turn", id }],
    versionRefs: [],
    occurredAt: new Date(clock).toISOString(),
  };
};

const named = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** A caller, in `audiences` now. */
const as = (userId: string, audiences: string[] = []): Caller => ({
  userId,
  reads: [],
  audiences,
});

/** The IDs of the lessons `caller` lists. */
const listed = async (
  brain: ReturnType<typeof testHost>["brain"],
  caller: Caller
): Promise<string[]> => {
  const lessons = await lessonsFor(brain, caller);
  return lessons.map(({ id }) => id);
};

describe("inspecting lessons", () => {
  it("shows a person's lesson to them alone", async () => {
    const { brain } = testHost();
    const ann = named("ann");
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann));
    }
    await consolidate(brain, { scope: "person", scopeId: ann });
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const lessonId = lesson?.id ?? "";

    expect({
      ann: await listed(brain, as(ann)),
      ben: await listed(brain, as(named("ben"))),
      annLineage: await outcome(lessonLineage(brain, as(ann), { lessonId })),
      benLineage: await outcome(
        lessonLineage(brain, as(named("ben")), { lessonId })
      ),
    }).toStrictEqual({
      ann: [lessonId],
      ben: [],
      annLineage: "ok",
      benLineage: "brain.not_found",
    });
  });

  it("shows a shared chat's lesson only to someone in it now who was there for every turn it rests on", async () => {
    const { brain } = testHost();
    const chat = named("chat");
    const ann = named("ann");
    const ben = named("ben");
    const cas = named("cas");
    const dan = named("dan");
    // Cas joined for the last turn only.
    await recordOutcome(brain, failed(ann, { id: chat, members: [ann, ben] }));
    await recordOutcome(brain, failed(ann, { id: chat, members: [ann, ben] }));
    await recordOutcome(
      brain,
      failed(ann, { id: chat, members: [ann, ben, cas] })
    );
    await consolidate(brain, { scope: "session", scopeId: chat });
    const [lesson] = await lessonsOf(brain, {
      scope: "session",
      scopeId: chat,
    });
    const lessonId = lesson?.id ?? "";
    const sees = async (caller: Caller) =>
      await outcome(lessonLineage(brain, caller, { lessonId }));

    expect({
      ann: await sees(as(ann, [chat])),
      ben: await sees(as(ben, [chat])),
      // In the chat now, but not for every turn.
      cas: await sees(as(cas, [chat])),
      // There for every turn, but no longer counted in it.
      benLeft: await sees(as(ben)),
      dan: await sees(as(dan, [chat])),
      benLists: await listed(brain, as(ben, [chat])),
      casLists: await listed(brain, as(cas, [chat])),
    }).toStrictEqual({
      ann: "ok",
      ben: "ok",
      cas: "brain.not_found",
      benLeft: "brain.not_found",
      dan: "brain.not_found",
      benLists: [lessonId],
      casLists: [],
    });
  });

  it("shows of an older version only the turns its reader was part of, and not its text when there were others", async () => {
    const { brain } = testHost();
    const chat = named("chat");
    const ann = named("ann");
    const ben = named("ben");
    const both = { id: chat, members: [ann, ben] };
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann, both));
    }
    await consolidate(brain, { scope: "session", scopeId: chat });
    await recordOutcome(brain, failed(ann, both));
    await consolidate(brain, { scope: "session", scopeId: chat });
    const [lesson] = await lessonsOf(brain, {
      scope: "session",
      scopeId: chat,
    });
    const lessonId = lesson?.id ?? "";
    // A turn Ben wasn't part of, among the first version's evidence.
    const annsOwn = failed(ann, { id: chat, members: [ann] });
    await recordOutcome(brain, annsOwn);
    await env.BRAIN.prepare(
      "INSERT INTO brain_lesson_evidence (lesson_id, revision, episode_id, role) VALUES (?, 1, ?, 'supporting')"
    )
      .bind(lessonId, annsOwn.eventId)
      .run();

    const forBen = await lessonLineage(brain, as(ben, [chat]), { lessonId });
    const forAnn = await lessonLineage(brain, as(ann, [chat]), { lessonId });
    const versionOf = (lineage: typeof forBen, revision: number) => {
      const found = lineage.versions.find((each) => each.revision === revision);
      return {
        text: found?.instruction !== null,
        episodes: found?.episodes.length,
        hidden: found?.episodes.some(
          ({ episodeId }) => episodeId === annsOwn.eventId
        ),
      };
    };

    expect({
      ben: {
        current: versionOf(forBen, 2),
        first: versionOf(forBen, 1),
        names: JSON.stringify(forBen).includes(annsOwn.eventId),
      },
      annFirst: versionOf(forAnn, 1),
    }).toStrictEqual({
      ben: {
        current: { text: true, episodes: 4, hidden: false },
        // Its link stays; not its text, nor the turn he wasn't in.
        first: { text: false, episodes: 3, hidden: false },
        names: false,
      },
      // Ann was in all four, but the version was written from three: one
      // it doesn't know of hides its text from everyone.
      annFirst: { text: false, episodes: 4, hidden: true },
    });
  });

  it("lets someone retire only a lesson they may see, at its revision", async () => {
    const { brain } = testHost();
    const ann = named("ann");
    const ben = named("ben");
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann));
    }
    await consolidate(brain, { scope: "person", scopeId: ann });
    const [lesson] = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const lessonId = lesson?.id ?? "";

    expect({
      byBen: await outcome(
        lessonsRetire(brain, as(ben), { lessonId, expectedRevision: 1 })
      ),
      stale: await outcome(
        lessonsRetire(brain, as(ann), { lessonId, expectedRevision: 5 })
      ),
      byAnn: await outcome(
        lessonsRetire(brain, as(ann), { lessonId, expectedRevision: 1 })
      ),
    }).toStrictEqual({
      byBen: "brain.not_found",
      stale: "brain.revision_conflict",
      byAnn: "ok",
    });
  });

  it("never lets a lesson its reader may see stand in for another they may not, to read or retire", async () => {
    const { brain } = testHost();
    const chat = named("chat");
    const ann = named("ann");
    const ben = named("ben");
    // A: a shared chat's lesson Ben was there for. B: Ann's own.
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(
        brain,
        failed(ann, { id: chat, members: [ann, ben] })
      );
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann));
    }
    await consolidate(brain, { scope: "session", scopeId: chat });
    await consolidate(brain, { scope: "person", scopeId: ann });
    const [shared] = await lessonsOf(brain, {
      scope: "session",
      scopeId: chat,
    });
    const [own] = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const lessonId = own?.id ?? "";
    const ben_ = as(ben, [chat]);
    const lineage = await outcome(lessonLineage(brain, ben_, { lessonId }));
    const retire = await outcome(
      lessonsRetire(brain, ben_, { lessonId, expectedRevision: 1 })
    );
    const annLists = await listed(brain, as(ann));

    expect({
      seesShared: await listed(brain, ben_),
      lineage,
      retire,
      stillAnns: annLists.includes(lessonId),
    }).toStrictEqual({
      seesShared: [shared?.id],
      lineage: "brain.not_found",
      retire: "brain.not_found",
      stillAnns: true,
    });
  });

  it("hides a shared lesson, and its older versions' text, once turns some reader wasn't part of are erased", async () => {
    const { brain } = testHost();
    const chat = named("chat");
    const ann = named("ann");
    const cas = named("cas");
    // Two turns Ann had alone, then four with Cas.
    const alone = [
      failed(ann, { id: chat, members: [ann] }),
      failed(ann, { id: chat, members: [ann] }),
    ];
    for (const each of [
      ...alone,
      ...Array.from({ length: 4 }, () =>
        failed(ann, { id: chat, members: [ann, cas] })
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, each);
    }
    const scope = { scope: "session" as const, scopeId: chat };
    await consolidate(brain, scope);
    const [lesson] = await lessonsOf(brain, scope);
    const lessonId = lesson?.id ?? "";
    const casBefore = await listed(brain, as(cas, [chat]));

    await eraseOutcomes(
      brain,
      alone.map(({ evidenceId }) => evidenceId)
    );
    const afterErase = {
      cas: await listed(brain, as(cas, [chat])),
      ann: await outcome(lessonLineage(brain, as(ann, [chat]), { lessonId })),
    };
    // The next job writes a revision from the four turns left.
    await consolidate(brain, scope);
    const forCas = await lessonLineage(brain, as(cas, [chat]), { lessonId });
    const textOf = (revision: number) =>
      forCas.versions.find((each) => each.revision === revision)?.instruction;

    expect({
      casBefore,
      afterErase,
      current: forCas.lesson.instruction,
      first: textOf(1) ?? null,
    }).toStrictEqual({
      casBefore: [],
      // Its text counts turns Cas wasn't in: nobody sees it until the next
      // revision, which rests on what is left.
      afterErase: { cas: [], ann: "brain.not_found" },
      current:
        "chat.turn failed 4 of its last 4 finished runs on its current versions.",
      first: null,
    });
  });

  it("records who retired a lesson: its owner for their own, an admin for a shared one", async () => {
    const { brain } = testHost();
    const ann = named("ann");
    const chat = named("chat");
    for (let n = 0; n < 3; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann));
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, failed(ann, { id: chat, members: [ann] }));
    }
    await consolidate(brain, { scope: "person", scopeId: ann });
    await consolidate(brain, { scope: "session", scopeId: chat });
    const [own] = await lessonsOf(brain, { scope: "person", scopeId: ann });
    const [shared] = await lessonsOf(brain, {
      scope: "session",
      scopeId: chat,
    });

    await lessonsRetire(brain, as(ann), {
      lessonId: own?.id ?? "",
      expectedRevision: 1,
    });
    await lessonsRetire(brain, as(ann, [chat]), {
      lessonId: shared?.id ?? "",
      expectedRevision: 1,
    });
    const [ownAfter] = await lessonsOf(brain, {
      scope: "person",
      scopeId: ann,
    });
    const [sharedAfter] = await lessonsOf(brain, {
      scope: "session",
      scopeId: chat,
    });
    const { results } = await env.BRAIN.prepare(
      "SELECT event FROM audit_outbox WHERE instr(event, 'brain.lesson.retired') > 0 AND instr(event, ?) > 0"
    )
      .bind(ann)
      .all<{ event: string }>();

    expect({
      own: ownAfter?.retiredBy,
      shared: sharedAfter?.retiredBy,
      // Both attributed to Ann, never to the Brain itself.
      attributed: results.length,
    }).toStrictEqual({ own: "owner", shared: "admin", attributed: 2 });
  });

  it("keeps a shared lesson hidden when it is retired for lack of evidence after an erasure", async () => {
    const { brain } = testHost();
    const chat = named("chat");
    const ann = named("ann");
    const cas = named("cas");
    const alone = [
      failed(ann, { id: chat, members: [ann] }),
      failed(ann, { id: chat, members: [ann] }),
    ];
    for (const each of [
      ...alone,
      ...Array.from({ length: 4 }, () =>
        failed(ann, { id: chat, members: [ann, cas] })
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, each);
    }
    const scope = { scope: "session" as const, scopeId: chat };
    await consolidate(brain, scope);
    await eraseOutcomes(
      brain,
      alone.map(({ evidenceId }) => evidenceId)
    );
    // A hundred runs that completed: the group's newest hold no failure,
    // so consolidation retires the lesson, carrying its text forward.
    for (let n = 0; n < 100; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await recordOutcome(brain, {
        ...failed(ann, { id: chat, members: [ann, cas] }),
        execution: "completed",
        result: "unknown",
      });
    }
    await consolidate(brain, scope);
    const [lesson] = await lessonsOf(brain, scope);

    expect({
      state: lesson?.state,
      cas: await listed(brain, as(cas, [chat])),
      casLineage: await outcome(
        lessonLineage(brain, as(cas, [chat]), { lessonId: lesson?.id ?? "" })
      ),
    }).toStrictEqual({
      state: "retired",
      cas: [],
      casLineage: "brain.not_found",
    });
  });
});
