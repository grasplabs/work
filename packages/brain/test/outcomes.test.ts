import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainErrors } from "../src/contract.ts";
import {
  eraseOutcomes,
  outcomeCursors,
  outcomesFor,
  forgetPersonOutcomes,
  outcomesOf,
  recordOutcome,
} from "../src/outcomes.ts";
import type { TaskOutcome } from "../src/outcomes.ts";
import { testHost } from "./host.ts";

// The Brain's host-only runtime API for settled task outcomes, on its own.
// The ways it could fail its host, tried below:
// 1. A delivery made again (a crash, a lost reply) becomes a second event,
//    or a late delivery moves its source's cursor back.
// 2. Evaluation, test or learning-job work is kept as experience, so a
//    learning job could feed on its own output.
// 3. An erased execution record leaves its events behind.
// 4. An event carries more than identifiers: a field the host never meant.
// 5. A shared session's event reaches someone outside its audience: one
//    who was never in it, or one the host no longer counts in it.
// 6. A delivery made again after a personal purge brings back what the
//    purge erased: the person's own event, or their place in a shared one.
// 7. A reader in many shared chats can't read their events at all.

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/**
 * The actions of the audit events stored in the outbox about `id`: those
 * the Brain's batches kept, not every one they made.
 */
const outboxed = async (id: string): Promise<string[]> => {
  const { results } = await env.BRAIN.prepare(
    "SELECT event FROM audit_outbox WHERE instr(event, ?) > 0 ORDER BY rowid"
  )
    .bind(id)
    .all<{ event: string }>();
  return results.map(({ event }) => {
    const parsed: unknown = JSON.parse(event);
    return typeof parsed === "object" && parsed !== null && "action" in parsed
      ? String(parsed.action)
      : "";
  });
};

/** A settled run's outcome, as a host records it. */
const settled = (overrides: Partial<TaskOutcome> = {}): TaskOutcome => {
  const run = crypto.randomUUID();
  return {
    eventId: `workflow.run:${run}`,
    source: `test.${crypto.randomUUID()}`,
    sourceSeq: 1,
    purpose: "production",
    ownerId: "ann",
    scope: "person",
    taskType: "workflow:app/tidy",
    execution: "completed",
    result: "unknown",
    evidenceId: run,
    evidenceRefs: [{ kind: "workflow_run", id: run }],
    versionRefs: [{ kind: "app", id: "app", version: "3" }],
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
};

describe("task outcomes", () => {
  it("keep one event however often it is delivered, and a cursor that only grows", async () => {
    const { brain } = testHost();
    const first = settled({ sourceSeq: 7 });
    const later = settled({ source: first.source, sourceSeq: 9 });

    const receipts = [
      await recordOutcome(brain, first),
      await recordOutcome(brain, later),
      // The first again, after the later one: late, and a duplicate.
      await recordOutcome(brain, first),
    ];

    const recorded = await outcomesOf(brain, first.evidenceId);
    const cursors = await outcomeCursors(brain);

    expect({
      recorded: receipts.map((receipt) => receipt.recorded),
      events: recorded.map(({ eventId, execution, result }) => ({
        eventId,
        execution,
        result,
      })),
      cursor: cursors.find(({ source }) => source === first.source),
      audited: await outboxed(first.eventId),
    }).toStrictEqual({
      recorded: [true, true, false],
      events: [
        { eventId: first.eventId, execution: "completed", result: "unknown" },
      ],
      cursor: { source: first.source, seq: 9 },
      audited: ["knowledge.episode.recorded"],
    });
  });

  it("refuse anything but production work, and anything but identifiers", async () => {
    const { brain } = testHost();
    const purposes = await Promise.all(
      ["evaluation", "test", "shadow", "learning"].map(
        async (purpose) =>
          await outcome(recordOutcome(brain, { ...settled(), purpose }))
      )
    );
    const withText = await outcome(
      recordOutcome(brain, { ...settled(), answer: "The invoice was paid." })
    );
    const noEvidence = await outcome(
      recordOutcome(brain, settled({ evidenceRefs: [] }))
    );

    expect({ purposes, withText, noEvidence }).toStrictEqual({
      purposes: [
        "brain.invalid",
        "brain.invalid",
        "brain.invalid",
        "brain.invalid",
      ],
      withText: "brain.invalid",
      noEvidence: "brain.invalid",
    });
  });

  it("go with the execution record they rest on, and only those", async () => {
    const { brain } = testHost();
    const erased = settled();
    const kept = settled();
    await recordOutcome(brain, erased);
    await recordOutcome(brain, kept);

    const counts = [
      await eraseOutcomes(brain, [erased.evidenceId]),
      // Again, as after a crash: nothing left, nothing recorded.
      await eraseOutcomes(brain, [erased.evidenceId]),
    ];

    expect({
      counts,
      erased: await outcomesOf(brain, erased.evidenceId),
      kept: await outcomesOf(brain, kept.evidenceId),
      audited: await outboxed(erased.evidenceId),
    }).toStrictEqual({
      counts: [1, 0],
      erased: [],
      kept: [expect.objectContaining({ evidenceId: kept.evidenceId })],
      // Its recording, then its erasure, each once.
      audited: ["knowledge.episode.recorded", "knowledge.episode.erased"],
    });
  });

  it("reach a shared session's members only while the host counts them in it", async () => {
    const { brain } = testHost();
    const chat = crypto.randomUUID();
    const shared = settled({
      scope: "session",
      audience: { id: chat, members: ["ann", "ben"] },
    });
    await recordOutcome(brain, shared);
    /** Whether `userId`, in `audiences` now, reaches the shared event. */
    const reaches = async (userId: string, audiences: string[]) => {
      const events = await outcomesFor(brain, { userId, reads: [], audiences });
      return events.some(({ eventId }) => eventId === shared.eventId);
    };

    expect({
      ann: await reaches("ann", [chat]),
      ben: await reaches("ben", [chat]),
      // In the chat now, but not when it settled.
      cas: await reaches("cas", [chat]),
      // A member when it settled, no longer counted in it.
      benLeft: await reaches("ben", []),
      noAudience: await outcome(
        recordOutcome(brain, settled({ scope: "session" }))
      ),
      personWithAudience: await outcome(
        recordOutcome(
          brain,
          settled({ audience: { id: chat, members: ["ann"] } })
        )
      ),
    }).toStrictEqual({
      ann: true,
      ben: true,
      cas: false,
      benLeft: false,
      noAudience: "brain.invalid",
      personWithAudience: "brain.invalid",
    });
  });

  it("never brings back what a personal purge erased when a delivery is made again", async () => {
    const { brain } = testHost();
    const chat = crypto.randomUUID();
    const before = new Date(Date.now() - 60_000).toISOString();
    const own = settled({ ownerId: "ben", occurredAt: before });
    const shared = settled({
      scope: "session",
      audience: { id: chat, members: ["ann", "ben"] },
      occurredAt: before,
    });
    await recordOutcome(brain, own);
    await recordOutcome(brain, shared);
    const reaches = async (userId: string, eventId: string) => {
      const events = await outcomesFor(brain, {
        userId,
        reads: [],
        audiences: [chat],
      });
      return events.some((event) => event.eventId === eventId);
    };

    await brain.db.batch(forgetPersonOutcomes(brain.db, "ben"));
    // Each delivered again, as after a lost reply or a restart.
    const again = [
      await recordOutcome(brain, own),
      await recordOutcome(brain, shared),
    ];
    // Ben's work after the purge is his again.
    const after = settled({
      scope: "session",
      audience: { id: chat, members: ["ann", "ben"] },
    });
    await recordOutcome(brain, after);

    expect({
      recordedAgain: again.map(({ recorded }) => recorded),
      own: await reaches("ben", own.eventId),
      sharedForBen: await reaches("ben", shared.eventId),
      sharedForAnn: await reaches("ann", shared.eventId),
      after: await reaches("ben", after.eventId),
    }).toStrictEqual({
      recordedAgain: [false, false],
      own: false,
      sharedForBen: false,
      sharedForAnn: true,
      after: true,
    });
  });

  it("reads the events of a reader in more shared chats than one statement could bind", async () => {
    const { brain } = testHost();
    const chats = Array.from({ length: 150 }, () => crypto.randomUUID());
    const last = chats.at(-1) ?? "";
    const shared = settled({
      scope: "session",
      audience: { id: last, members: ["ann"] },
    });
    await recordOutcome(brain, shared);

    const events = await outcomesFor(brain, {
      userId: "ann",
      reads: [],
      audiences: chats,
    });

    expect(events.map(({ eventId }) => eventId)).toContain(shared.eventId);
  });
});
