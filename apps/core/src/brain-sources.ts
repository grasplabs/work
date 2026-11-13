import type { AuditEntry } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import {
  erasureBegun,
  handOverProducers,
  pendingHandOvers,
  removeHandOvers,
} from "./brain-hand-overs.ts";
import type { HandOverProducer } from "./brain-hand-overs.ts";
import { chatSource, chatTurnOf, runSource } from "./brain-next-origins.ts";
import { queueHandOvers } from "./brain-next.ts";
import type { Handed, Producers, SourceRef } from "./brain-next.ts";
import { workflowStartReceipts } from "./db/core/schema.ts";
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
// Brain closes the source's key. What is gone answers `gone`, and nothing
// is added.
//
// Each hand-over is audited without content: `brain.source.handover_started`
// before its text leaves core, then `brain.source.handed_over` with the
// Brain's version, or `brain.source.handover_refused` when it was refused
// for good (what it adds was erased, or its one reader's erasure began:
// brain-next.ts `handOver`). A chat's turn its producer finds it may no
// longer hand over ends in `brain.source.handover_skipped` with why
// (`HandOverSkip`), so its `chat.turn_noted` never stands alone. Like the
// other hand-over events, a skip is recorded once per attempt: an attempt
// whose skip was recorded but whose item failed to settle records it again
// on the next. A run
// that is gone records nothing (its noting events say only that it
// ended). Each attempt records its own. Each is added
// through core's `addSource`, which picks the store its readers belong in;
// nothing here assumes which.

const gone: Handed = { kind: "gone" };

/** How a run may end: only an ended run is handed over. */
const endedStatuses: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Run `id`, ended, as it ended: how, and what it returned or failed with. */
const runOfId = async (env: Env, id: string): Promise<Handed> => {
  const row = await runOf(env, id);
  if (row === undefined || !endedStatuses.has(row.status) || row.restricted) {
    return gone;
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
    return gone;
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
 * for an id it noted (brain-next-origins.ts), and how that source is read
 * as its records hold it now.
 */
const producers: Record<
  HandOverProducer,
  {
    source: (id: string) => SourceRef;
    read: (env: Env, id: string) => Promise<Handed>;
  }
> = {
  run: { source: runSource, read: runOfId },
  chat: {
    // The id as noted: its parts are read back when it is handed over.
    source: (id) => ({ producer: "chat", id }),
    read: chatTurnOfId,
  },
};

/** Whether `kind` is a producer's: a source of any other has nothing to hand over. */
const isProducer = (kind: string): kind is HandOverProducer =>
  Object.hasOwn(producers, kind);

/** `source` as its producer's records hold it now. */
const handedOf = async (env: Env, source: SourceRef): Promise<Handed> =>
  isProducer(source.producer)
    ? await producers[source.producer].read(env, source.id)
    : gone;

/** The target an audit event names a source by: as its producer's events do. */
const targetOf = (source: SourceRef): AuditEntry["target"] => ({
  type: isProducer(source.producer)
    ? handOverProducers[source.producer].target
    : source.producer,
  id: source.id,
});

/** Records `entry` in core's outbox now: throws when it can't. */
const record = async (env: Env, entry: AuditEntry): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [outboxed(db, entry)]);
};

/**
 * Core's producers, as the Brain's hand-overs reach them: each source read
 * from core's records now, its hand-over recorded before its text leaves
 * core and again once it ended. The clock gives them to the Brain's tick
 * (brain-next.ts `workBrain`).
 */
export const producersOf = (env: Env): Producers => ({
  read: async (source) => {
    const handed = await handedOf(env, source);
    // A noted source that is not handed over after all ends in why, so a
    // note never stands alone in the log (the chat's: GRA-1805).
    if (handed.kind === "gone" && handed.skipped !== undefined) {
      await record(env, {
        actor: { type: "system" },
        action: "brain.source.handover_skipped",
        target: targetOf(source),
        detail: { producer: source.producer, reason: handed.skipped },
      });
    }
    if (handed.kind === "source") {
      await record(env, {
        actor: { type: "system" },
        action: "brain.source.handover_started",
        target: targetOf(source),
        detail: { producer: source.producer },
      });
    }
    return handed;
  },
  settled: async (source, outcome) => {
    await record(
      env,
      outcome.kind === "added"
        ? {
            actor: { type: "system" },
            action: "brain.source.handed_over",
            target: targetOf(source),
            detail: { producer: source.producer, version: outcome.version },
          }
        : {
            actor: { type: "system" },
            action: "brain.source.handover_refused",
            target: targetOf(source),
            detail: { producer: source.producer, reason: outcome.reason },
          }
    );
  },
});

/** Intents one relay reads at a time, oldest first. */
const relayPage = 100;

/** Pages one relay takes before it leaves the rest for the next tick. */
const relayPagesMax = 10;

/**
 * Puts what core noted to hand over (brain-hand-overs.ts) on the Brain's
 * work queue (brain-next.ts `queueHandOvers`), the oldest first, then
 * removes what it put on, each only as noted when taken: one noted again
 * meanwhile stays, for the next relay. A page that fails stays noted, for
 * the next. A row whose producer core doesn't know (none registers it any
 * more) is removed unrelayed and counted in the log, so it holds up
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
    const sources = taken.flatMap(({ producer, sourceId }) =>
      isProducer(producer) ? [producers[producer].source(sourceId)] : []
    );
    if (sources.length < taken.length) {
      log.warn("brain.hand_over.unknown_producer", {
        count: taken.length - sources.length,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- one page after the other
    await queueHandOvers(env, sources);
    // oxlint-disable-next-line no-await-in-loop -- one page after the other
    await removeHandOvers(env, taken);
    if (taken.length < relayPage) {
      return;
    }
  }
};
