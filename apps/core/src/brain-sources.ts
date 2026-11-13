import type { AuditEntry } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxedWhere } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import {
  endedHandOver,
  erasureBegun,
  handOverProducers,
  openNoting,
  pendingHandOvers,
  settleRelay,
  stillOpen,
} from "./brain-hand-overs.ts";
import type { HandOverProducer, TakenHandOver } from "./brain-hand-overs.ts";
import {
  chatSource,
  chatsOf,
  chatTurnOf,
  runSource,
} from "./brain-next-origins.ts";
import { queueHandOvers } from "./brain-next.ts";
import type {
  Handed,
  HandOverAttempt,
  HandOverOutcome,
  Producers,
  SourceRef,
} from "./brain-next.ts";
import { brainHandOvers, workflowStartReceipts } from "./db/core/schema.ts";
import { workspace } from "./durable-objects.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { resultOf, runOf } from "./workflows/resource-runs.ts";
import { detailsRemoved } from "./workflows/retention.ts";
import { evidenceOf } from "./workflows/run-evidence.ts";

// What core hands over to the new Brain (GRA-1727), each source with who
// may read it, read from core's own records when the Brain's work queue
// runs its hand-over (brain-next.ts `workBrain`), never from what a caller
// said or what waited in a queue. Each producer registers its source's
// key and how it is read here (`producers`), and the audit events that
// note it in brain-hand-overs.ts:
//
// - An independent workflow run that ended (`run:<id>`): once, change
//   `end`, how it ended and what it returned (or its failure's code), for
//   the person it acted for alone; nothing from a run started in
//   restricted mode, or whose details are past their retention. A run
//   reads only what its person may read, so its person never reads more
//   through the Brain than the run read for them. Core shows a run's raw
//   result only while that person still holds the workflow's user role;
//   the Brain's copy has no such check, so they keep recalling it after
//   they lose the workflow (accepted for now: GRA-1829). A run that
//   recalled from the Brain (its recall evidence, run-evidence.ts) hands
//   over only how it ended, never what it returned: the Brain never holds
//   a second copy of what it recalled, which would outlive that source
//   being narrowed or erased (GRA-1731).
//
// - A turn of a person's own chat (`chat:<person>/<chat>/<answer>`), in
//   their own store alone, in its chat's group (brain-next-origins.ts):
//   once, change `answer`: what they asked, their words alone. Never what
//   was answered: an answer can quote anything its prompt held (a step's
//   result, an earlier turn's, the recall, instruction files, memories,
//   skills), and its copy here would outlive that being erased or the
//   person losing it, until GRA-1855 gives an answer a record of what it
//   used. Only while the chat is still theirs, in Grasp's
//   own app, shared with no one, not restricted and not being deleted, as
//   their Workspace holds it now (workspace.ts `turnForBrain`); a turn
//   nobody asked for there and then is never noted. Deleting the chat
//   erases them all in one call before its rows go (`eraseChat`).
//
// Nothing for a person whose erasure has begun (core's `personErasures`):
// a reader answers `erased`, with the readers it would have named, and the
// Brain closes the source's key. What is gone answers `gone`, with why
// (`HandOverSkip`, a fixed set), and nothing is added.
//
// Each hand-over is audited without content, ids only, the same for every
// producer (brain-next.ts `handOver`): `brain.source.handover_started`
// before its text leaves core, then exactly one outcome:
// `brain.source.handed_over` with the Brain's version,
// `brain.source.handover_refused` when it was refused for good (what it
// adds was erased, or its one reader's erasure began), or
// `brain.source.handover_skipped` with why it is not handed over after
// all. So a noting event never stands alone in the log. The outcome is
// written here, in the same batch that ends the noted hand-over
// (brain-hand-overs.ts), and only while it is open as the attempt read it
// before reading its source: an attempt tried again after its answer was
// lost, or after it failed past its outcome (closing a key), records
// nothing more, and one whose noting was replaced by a newer leaves its
// outcome to the newer's. A start is recorded by each attempt whose text
// leaves core, also only while its noted hand-over is open. Each is added
// through core's `addSource`, which picks the store its readers belong in;
// nothing here assumes which.

/** How a run may end: only an ended run is handed over. */
const endedStatuses: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Run `id`, ended, as it ended: how, and what it returned or failed with. */
const runOfId = async (env: Env, id: string): Promise<Handed> => {
  const row = await runOf(env, id);
  if (row === undefined) {
    return { kind: "gone", skipped: "deleted" };
  }
  if (!endedStatuses.has(row.status)) {
    // Only a run's end notes it, and an ended run never runs again: tried
    // again by the queue's rules, never read as gone.
    throw new Error("The run has not ended: handed over later");
  }
  if (row.restricted) {
    return { kind: "gone", skipped: "restricted" };
  }
  const readers = { kind: "owner", personId: row.principalId } as const;
  if (await erasureBegun(env, row.principalId)) {
    return { kind: "erased", readers };
  }
  const receipt = await drizzle(env.DB)
    .select({ detailsRemovedAt: workflowStartReceipts.detailsRemovedAt })
    .from(workflowStartReceipts)
    .where(eq(workflowStartReceipts.id, row.id))
    .get();
  if (
    detailsRemoved({
      endedAt: row.endedAt,
      detailsRemovedAt: receipt?.detailsRemovedAt ?? null,
    })
  ) {
    return { kind: "gone", skipped: "past_retention" };
  }
  const [{ result, error }, recalled] = await Promise.all([
    resultOf(env, row),
    evidenceOf(env, row.id),
  ]);
  const returned = recalled.length > 0 ? undefined : result;
  // How it ended, and a failure by its code alone, which the run's row
  // keeps: the same text whether the engine still answers or not.
  const ending = [
    `Workflow run ${row.status}.`,
    ...(error?.code === undefined || error.code === null
      ? []
      : [`Failed: ${error.code}`]),
  ];
  return {
    kind: "source",
    change: "end",
    text: [
      ...ending,
      ...(returned === undefined ? [] : [JSON.stringify(returned)]),
    ].join("\n\n"),
    // Never a cut part of a result, which would read as half a document.
    whenTooLarge: [...ending, "Its result was too large to keep."].join("\n\n"),
    readers,
  };
};

/** Turn `id` of a person's own chat, as their Workspace holds it now. */
const chatTurnOfId = async (env: Env, id: string): Promise<Handed> => {
  const turn = chatTurnOf(id);
  if (turn === undefined) {
    return { kind: "gone", skipped: "deleted" };
  }
  const { personId, chatId, answerId } = turn;
  const readers = { kind: "owner", personId } as const;
  if (await erasureBegun(env, personId)) {
    return { kind: "erased", readers };
  }
  if ((await memberRole(env.DB, personId)) === undefined) {
    return { kind: "gone", skipped: "not_a_member" };
  }
  const said = await workspace(env, personalWorkspaceId(personId)).turnForBrain(
    chatId,
    personId,
    answerId
  );
  if (said.kind === "deleting") {
    // Neither kept nor gone yet: a throw, so the queue tries it again by
    // its own rules (later, and parked after too many), and it ends as
    // the deletion did: skipped as `deleted`, or handed over.
    throw new Error("The chat is being deleted: handed over later");
  }
  if (said.kind === "skipped") {
    return { kind: "gone", skipped: said.reason };
  }
  return {
    kind: "source",
    change: "answer",
    text: said.question,
    whenTooLarge: "A question asked in a chat, too large to keep.",
    readers,
    group: chatSource(personId, chatId),
  };
};

/**
 * Every producer (brain-hand-overs.ts `handOverProducers`): its source
 * for an id it noted (brain-next-origins.ts), how that source is read as
 * its records hold it now, and what the ids of its sources that name a
 * person start with (`ofPerson`), for that person's erasure
 * (`endHandOversOf`): null when its ids name nobody.
 */
const producers: Record<
  HandOverProducer,
  {
    source: (id: string) => SourceRef;
    read: (env: Env, id: string) => Promise<Handed>;
    ofPerson: ((personId: string) => string) | null;
  }
> = {
  // A run's id is its own: the person it acted for is its row's.
  run: { source: runSource, read: runOfId, ofPerson: null },
  chat: {
    // The id as noted: its parts are read back when it is handed over.
    source: (id) => ({ producer: "chat", id }),
    read: chatTurnOfId,
    ofPerson: chatsOf,
  },
};

/** Whether `kind` is a producer's: a source of any other has nothing to hand over. */
const isProducer = (kind: string): kind is HandOverProducer =>
  Object.hasOwn(producers, kind);

/** The target an audit event names a source by: as its producer's events do. */
const targetOf = (
  source: SourceRef & { producer: HandOverProducer }
): AuditEntry["target"] => ({
  type: handOverProducers[source.producer].target,
  id: source.id,
});

/** The audit action each way a hand-over ends is recorded by. */
const outcomeActions = {
  added: "brain.source.handed_over",
  refused: "brain.source.handover_refused",
  skipped: "brain.source.handover_skipped",
} as const satisfies Record<HandOverOutcome["kind"], string>;

/** The audit entry of `outcome` for `source`: ids, a version or a reason. */
const outcomeEntry = (
  source: SourceRef & { producer: HandOverProducer },
  outcome: HandOverOutcome
): AuditEntry => ({
  actor: { type: "system" },
  action: outcomeActions[outcome.kind],
  target: targetOf(source),
  detail:
    outcome.kind === "added"
      ? { producer: source.producer, version: outcome.version }
      : { producer: source.producer, reason: outcome.reason },
});

/** The ending statements of `taken`, as `outcome`, as an attempt writes them. */
const ending = (
  db: DrizzleD1Database,
  taken: TakenHandOver & { producer: HandOverProducer },
  outcome: HandOverOutcome
) =>
  [
    outboxedWhere(
      db,
      outcomeEntry({ producer: taken.producer, id: taken.sourceId }, outcome),
      stillOpen(taken)
    ),
    endedHandOver(db, taken),
  ] as const;

/** An attempt with nothing open to end: it records nothing. */
const nothingOpen = (handed: Handed): HandOverAttempt => ({
  handed,
  started: async () => await Promise.resolve(false),
  ended: async () => {
    await Promise.resolve();
  },
});

/**
 * Core's producers, as the Brain's hand-overs reach them: each attempt
 * reads the noted hand-over it may end, then the source from core's
 * records now, and records, in core's outbox, its start before its text
 * leaves core and its one outcome, each only while that noted hand-over
 * is still open as it read it (brain-hand-overs.ts). The clock gives them
 * to the Brain's tick (brain-next.ts `workBrain`).
 */
export const producersOf = (env: Env): Producers => ({
  attempt: async (source) => {
    const { producer, id } = source;
    if (!isProducer(producer)) {
      // None noted it (the relay drops what no producer registers).
      return nothingOpen({ kind: "gone", skipped: "deleted" });
    }
    const known = { producer, id };
    // Before the source: a noting made after this read stays open, and
    // its own item reads the source again.
    const noting = await openNoting(env, { producer, sourceId: id });
    const handed = await producers[producer].read(env, id);
    if (noting === undefined) {
      return nothingOpen(handed);
    }
    const taken = { producer, sourceId: id, noting };
    const db = drizzle(env.DB);
    return {
      handed,
      started: async () => {
        const [stored] = await auditedBatch(env, db, [
          outboxedWhere(
            db,
            {
              actor: { type: "system" },
              action: "brain.source.handover_started",
              target: targetOf(known),
              detail: { producer },
            },
            stillOpen(taken)
          ),
        ]);
        return stored.meta.changes > 0;
      },
      ended: async (outcome) => {
        await auditedBatch(env, db, ending(db, taken, outcome));
      },
    };
  },
});

/**
 * Ends every hand-over still open whose source's id names `personId`
 * (each producer's `ofPerson`: their chats' turns) as refused `erased`,
 * each with its one outcome, as an attempt would: for their erasure
 * (person-erasure.ts), once the Brain erased what was theirs, so no noting
 * keeps their id after it, also one whose item the queue parked for good.
 * Such an item, if it runs later, finds nothing open and closes its key.
 * A noting made after this one ran is ended by its own attempt, as
 * `erased`. Safe to repeat.
 */
export const endHandOversOf = async (
  env: Env,
  personId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  for (const producer of Object.keys(producers).filter(isProducer)) {
    const { ofPerson } = producers[producer];
    if (ofPerson === null) {
      continue;
    }
    const start = ofPerson(personId);
    // oxlint-disable-next-line no-await-in-loop -- one producer at a time
    const open = await db
      .select({
        sourceId: brainHandOvers.sourceId,
        noting: brainHandOvers.noting,
      })
      .from(brainHandOvers)
      .where(
        and(
          eq(brainHandOvers.producer, producer),
          sql`substr(${brainHandOvers.sourceId}, 1, ${start.length}) = ${start}`
        )
      );
    for (const { sourceId, noting } of open) {
      // oxlint-disable-next-line no-await-in-loop -- one hand-over at a time
      await auditedBatch(
        env,
        db,
        ending(
          db,
          { producer, sourceId, noting },
          {
            kind: "refused",
            reason: "erased",
          }
        )
      );
    }
  }
};

/** Intents one relay reads at a time, oldest first. */
const relayPage = 100;

/** Pages one relay takes before it leaves the rest for the next tick. */
const relayPagesMax = 10;

/**
 * Puts what core noted to hand over (brain-hand-overs.ts) on the Brain's
 * work queue (brain-next.ts `queueHandOvers`), the oldest first, then
 * marks what it put on as relayed, each only as noted when taken: one
 * noted anew meanwhile stays, for the next relay. A page that fails stays
 * noted, for the next. A row whose producer core doesn't know (none
 * registers it any more), or whose id the Brain can't key, never will be
 * handed over: removed unrelayed and counted in the log, so it holds up
 * nothing. Only keys go: what is added is what its producer answers when
 * the item runs. The clock runs it.
 */
export const relayHandOvers = async (env: Env): Promise<void> => {
  for (let page = 0; page < relayPagesMax; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after the other, oldest first
    const taken = await pendingHandOvers(env, relayPage);
    if (taken.length === 0) {
      return;
    }
    const known = taken.flatMap((each) =>
      isProducer(each.producer)
        ? [
            {
              taken: each,
              source: producers[each.producer].source(each.sourceId),
            },
          ]
        : []
    );
    if (known.length < taken.length) {
      log.warn("brain.hand_over.unknown_producer", {
        count: taken.length - known.length,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- one page after the other
    const leftOut = await queueHandOvers(
      env,
      known.map(({ source }) => source)
    );
    const unkeyable = new Set(leftOut);
    const relayed = known.flatMap(({ taken: each, source }) =>
      unkeyable.has(source) ? [] : [each]
    );
    // oxlint-disable-next-line no-await-in-loop -- one page after the other
    await settleRelay(
      env,
      relayed,
      taken.filter((each) => !relayed.includes(each))
    );
    if (taken.length < relayPage) {
      return;
    }
  }
};
