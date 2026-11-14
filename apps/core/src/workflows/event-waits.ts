import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, gt, lte, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
  uuidFromHash,
} from "../audit-outbox.ts";
import {
  eventSources,
  eventWaits,
  keptEventKeys,
  keptEventTakes,
  keptEvents,
  workflowBindingApprovals,
} from "../db/core/schema.ts";
import { inList, statementsWithin } from "../db/d1.ts";
import { resolveCatalogKeys } from "../workflow-catalog.ts";
import { isMatchKey, matchHashOf } from "./event-matches.ts";
import type { MatchKey } from "./event-matches.ts";
import { callingRunOf } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { admitRunEvent, notStartedYet } from "./run-events.ts";

// Event waits on an event source's events (GRA-1560): a workflow's `wait`
// with `match` (@grasp-os/workflow-schema's format) takes the first event
// of its types from the source its event binding's approval names whose
// data has, at the match's field, the value the wait's enter step
// recorded. Core matches, never the isolate: the run's code only records
// a value; which event a run takes is decided here, by equality of hashes
// in core's own database, and handed to the run's inbox through
// `admitRunEvent`, as every event is. Every event of a source some
// approval names is kept, for a day, so a run that reaches its wait after
// the event came still takes it: each run whose wait matches it takes it
// once, as each run waiting when it came does. Threat model, written
// before the code, and how each is closed:
//
// - One run's event reaching another. An event reaches a run only by a
//   match: the SHA-256 of the field and the value, which the wait's enter
//   step recorded (held to the build's sealed template and to a text,
//   number or boolean, sealed-run.ts) and which core computes again from
//   the event's own data. A wait without a match takes no source's event
//   (publication refuses one on such a type: workflow-resources.ts), so
//   no event goes to whichever run waits first. A run takes only events
//   of the source its binding's approval names (`target.source`, frozen
//   at its start), through that binding, as a type its contract takes
//   from a source (`ingress: "webhook"`), its data checked against that
//   type's contract. A matched event carries its match as an engine
//   attribute (`graspmatch`), and the run's wait takes only an event
//   with that attribute, so a match for one wait is never taken by
//   another wait of the same run on the same binding. Every run waiting
//   on the same match gets the event: each is a run that asked for it.
// - A kept event taken by the wrong run, by two, or by one run alone that
//   others needed. A kept event is taken by each run whose wait matches
//   it exactly (its data's value, source and type), the same fan-out as an
//   event handed live: one run never takes from another what it needed
//   (two workflows waiting on one order, a loop on a broad match). Each
//   run takes it at most once (`kept_event_takes`, by event and run), and
//   each wait takes at most one event (by run and step), whether handed
//   live or taken kept, recorded in one conditional insert. Taking it is a
//   step the engine journals (host.ts, `listen`), so a replay of a wait
//   takes nothing again, and a try of its step again after a failure
//   finds the one it took, never another. One its run can't take (its
//   contract refuses the data, its approval went, its inbox is full) is
//   let go for that run's next wait, the refusal audited, and the wait
//   goes on to the next kept event of its match, never the same one
//   again, at most `claimTries`.
// - A delivery and a wait passing each other. A delivery keeps its event
//   before it looks for waits, and a wait registers before it looks for
//   kept events, so whichever comes second finds the other; both handing
//   it is the same event in the run's inbox, under the same key.
// - A wait taking an event after it ended. Each wait's row is deleted as
//   it ends, and past its deadline matches nothing; an event for a run
//   that ended takes nothing (`admitRunEvent` refuses it, audited), and
//   that run's rows go.
// - Replays and retries. A delivery's ID is its source and `webhook-id`
//   (source-events.ts): each run gets it under a key of that ID and its
//   match, so the same delivery again is the same event in its inbox; a
//   kept event's ID is the same ID, so it is kept once, and a wait that
//   took it live and a claim are the same event.
// - The source deleted, or a grant revoked, while events are kept.
//   Deleting a source makes its kept events taken by nothing at once (a
//   claim and each handing read the source live), and the clock deletes
//   them, in bounded batches (`sweepEventWaits`). A wait asks for its binding's authority before it
//   is reached (sealed-run.ts, `eventWait`), and every admission reads it
//   again, so a revoked approval takes nothing kept; the event stays kept
//   for another run, until it expires.
// - Floods. Only a signed delivery reaches here. A source keeps at most
//   `keptPerSource` events at once, counted in the statement that keeps
//   one; past it an event isn't kept (runs waiting then still get it),
//   logged and audited once a day for the source. An event is kept only
//   when some active approval names its source, so a source nobody waits
//   on keeps nothing. Each event is
//   indexed by at most `maxLeaves` values. Each run's inbox bounds what
//   one sender fills of it (`source:<id>`), as for any sender.
// - The secret rotated, revoked or the source deleted mid-delivery. An
//   event is kept, and handed to any run, only while the secret it was
//   checked with is still the source's (`also`), read again just before
//   each run is handed it, as a trigger's start is; one that no longer
//   holds is refused whole (`stale`, 401), handing nothing. A kept event
//   is handed only while its source is live, read again just before; a
//   deleted source's kept events are taken by nothing from then on and
//   deleted on the clock.
// - A retry carrying another event. A delivery's ID is kept with its type
//   and data as they first came (canonical JSON); one sent again under the
//   same ID with another type or data is refused whole (`conflict`, 409),
//   handing nothing and adding nothing to what the kept one is matched
//   by, whose keys come only from its own data.
// - Privacy. A kept event holds an outside system's data, which may name
//   people: it is kept at most `keptWindowMs` (a day), for every run that
//   may yet wait for it, then deleted on the clock with its data, keys and
//   takes (`sweepEventWaits`, audited by source and count), in bounded
//   batches until none is left past its day or its source, within a time
//   budget a run; every row not yet deleted counts toward its source's
//   cap, so a backlog never lets a source keep more. It names no person core could find it by, so erasing one
//   relies on that day (person-erasure-inventory.ts). Its keys are
//   hashes. Nothing of it is logged or audited but
//   its delivery's hash, its source and its type.

/** How long an event is kept for a wait reached after it came: a day. */
export const keptWindowMs = 24 * 60 * 60 * 1000;

/**
 * The most events one source keeps at once: a busy shop's or payment
 * provider's day, each at most 64 KiB (a few KiB as such senders write
 * them).
 */
export const keptPerSource = 5000;

/** The most values of an event's data it may be matched by. */
const maxLeaves = 256;

/** How deep into an event's data its values are indexed. */
const maxLeafDepth = 8;

/** An event a source took (source-events.ts): its type and data. */
export interface SourceEvent {
  readonly source: string;
  /**
   * Its key: the hash of the source and its `webhook-id`, the same for
   * every retry of it.
   */
  readonly same: string;
  readonly type: string;
  readonly data: Json;
}

/** The URI an event source's events say they are from. */
export const sourceUriOf = (source: string): string =>
  `urn:grasp:event-source:${source}`;

/** Who sends an event source's events, for its share of a run's inbox. */
const senderOf = (source: string): string => `source:${source}`;

/** `key` as a JSON Pointer's reference token (RFC 6901). */
const tokenOf = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * The values `data` may be matched by, each with its JSON Pointer: every
 * text, number or boolean (`isMatchKey`) at most `maxLeafDepth` deep, the
 * first `maxLeaves` in document order.
 */
const leavesOf = (data: Json): [string, MatchKey][] => {
  const leaves: [string, MatchKey][] = [];
  const visit = (node: Json, pointer: string, depth: number): void => {
    if (leaves.length >= maxLeaves) {
      return;
    }
    if (isMatchKey(node)) {
      if (pointer !== "") {
        leaves.push([pointer, node]);
      }
      return;
    }
    if (depth >= maxLeafDepth || node === null || typeof node !== "object") {
      return;
    }
    const entries: [string, Json][] = Array.isArray(node)
      ? node.map((item: Json, index) => [String(index), item])
      : Object.entries(node).flatMap(([key, item]): [string, Json][] =>
          item === undefined ? [] : [[key, item]]
        );
    for (const [key, item] of entries) {
      visit(item, `${pointer}/${tokenOf(key)}`, depth + 1);
    }
  };
  visit(data, "", 0);
  return leaves;
};

/** The match hashes of `data`'s values (`leavesOf`), each once. */
const hashesOf = async (data: Json): Promise<string[]> => [
  ...new Set(
    await Promise.all(
      leavesOf(data).map(async ([field, key]) => await matchHashOf(field, key))
    )
  ),
];

/**
 * The types the contract a binding pinned (by its fingerprint) takes from
 * a webhook source.
 */
export const sourcedTypesOf = async (
  env: Env,
  binding: { contractId: string; fingerprint: string }
): Promise<string[]> => {
  const contracts = await resolveCatalogKeys(env, [binding.contractId]);
  const contract = contracts.get(binding.contractId);
  if (contract?.fingerprint !== binding.fingerprint) {
    return [];
  }
  return Object.entries(contract.contract.events ?? {}).flatMap(
    ([type, event]) => (event.ingress === "webhook" ? [type] : [])
  );
};

/**
 * Audits `action` once for `key` on `target` (the same delivery or day
 * again records nothing more), with `detail`.
 */
const auditedOnce = async (
  env: Env,
  action: string,
  key: string,
  target: { type: string; id: string },
  detail: Readonly<Record<string, AuditDetailValue>>
): Promise<void> => {
  const event = auditEventSchema.parse({
    id: uuidFromHash(
      await sha256Hex(`${action}:${target.type}:${target.id}:${key}`)
    ),
    at: new Date().toISOString(),
    source: "core",
    actor: { type: "system" },
    action,
    target,
    detail,
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
};

/** Why a waiting run didn't take an event of its match. */
type Refusal =
  | "run_ended"
  | "source_mismatch"
  | "event_denied"
  | "event_invalid"
  | "event_refused";

/** The refusals for good of `admitRunEvent`, by code. */
const refusals: Readonly<Record<string, Refusal>> = {
  "workflow.run_ended": "run_ended",
  "workflow.run_unavailable": "run_ended",
  "workflow.event_denied": "event_denied",
  "workflow.event_invalid": "event_invalid",
  "workflow.event_conflict": "event_invalid",
  "workflow.event_refused": "event_refused",
};

/** The refusal a code of `admitRunEvent`'s is, if it is one for good. */
const refusalOf = (error: unknown): Refusal | undefined => {
  const code = workflowResourceErrors.codeOf(error) ?? "";
  const reason = z
    .object({ details: z.object({ reason: z.string() }) })
    .safeParse(error).data?.details.reason;
  // A run whose start isn't confirmed yet may take it later.
  return reason === notStartedYet ? undefined : refusals[code];
};

/** A run's wait, as an event is handed to it. */
interface Waiting {
  readonly workflowId: string;
  readonly runId: string;
  readonly step: string;
  readonly binding: string;
  readonly matchHash: string;
}

/** An event, as a wait takes it: a delivery's or a kept one's. */
interface Taken {
  /** Its delivery's ID: the source and its `webhook-id`, hashed. */
  readonly same: string;
  readonly source: string;
  readonly type: string;
  readonly data: Json;
}

/** Whether `condition` (SQL) holds now. */
const holds = async (env: Env, condition: SQL): Promise<boolean> => {
  const { held } = await drizzle(env.DB).get<{ held: number }>(
    sql`SELECT ${condition} AS held`
  );
  return held === 1;
};

/** That source `id` is live, as SQL: what a kept event is handed by. */
const sourceLiveSql = (id: string | SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM ${eventSources}
    WHERE ${eventSources.id} = ${id} AND ${eventSources.deletedAt} IS NULL)`;

/**
 * Hands `event` to `wait`'s run (`run`, as it calls now), through its
 * binding, keyed by the delivery and the match, carrying the match, only
 * while `valid` holds (its source's checks, read again just before):
 * what came of it, `stale` handing nothing when `valid` no longer holds.
 * A refusal for good is audited, once per delivery and run.
 */
const handed = async (
  env: Env,
  run: CallingRun | undefined,
  wait: Waiting,
  event: Taken,
  valid: SQL
): Promise<"taken" | Refusal | "retry" | "stale"> => {
  let refusal: Refusal | undefined;
  const binding = run?.bindings.get(wait.binding);
  if (!(await holds(env, valid))) {
    return "stale";
  }
  if (run === undefined) {
    refusal = "run_ended";
  } else if (
    binding?.target.kind !== "event" ||
    binding.target.source !== event.source
  ) {
    // Its approval names another source, or none: never this one's.
    refusal = "source_mismatch";
  } else {
    try {
      await admitRunEvent(env, {
        workflowId: wait.workflowId,
        runId: wait.runId,
        binding: wait.binding,
        type: event.type,
        data: event.data,
        key: `${event.same}:${wait.matchHash}`,
        source: sourceUriOf(event.source),
        sender: senderOf(event.source),
        match: wait.matchHash,
      });
      return "taken";
    } catch (error) {
      refusal = refusalOf(error);
      if (refusal === undefined) {
        log.error("workflow.event_wait_failed", {
          run: wait.runId,
          ...errorFields(error),
        });
        return "retry";
      }
    }
  }
  if (refusal === "run_ended") {
    await drizzle(env.DB)
      .delete(eventWaits)
      .where(eq(eventWaits.runId, wait.runId));
  }
  await auditedOnce(
    env,
    "workflow.webhook.wait_refused",
    event.same,
    { type: "workflow_run", id: wait.runId },
    {
      workflow: wait.workflowId,
      binding: wait.binding,
      source: event.source,
      event: event.type,
      delivery: event.same,
      reason: refusal,
    }
  );
  return refusal;
};

/**
 * Keeps `event` (`hashes`, its values' match hashes) for waits reached
 * later: only while `also` holds (the secret it was checked with still
 * its source's), some active approval names its source, and the source
 * holds fewer than `keptPerSource` (expired ones not yet deleted
 * included), all in the statement that keeps it. The same delivery again
 * is kept once, and its keys are added only while what is kept under its
 * ID is this very event: `conflict` when it is another type or data,
 * otherwise whether it is kept now.
 */
const kept = async (
  env: Env,
  event: SourceEvent,
  hashes: readonly string[],
  also: SQL
): Promise<"kept" | "unkept" | "conflict"> => {
  const data = canonicalJson(event.data);
  const db = drizzle(env.DB);
  const now = Date.now();
  const used = sql`EXISTS (SELECT 1 FROM ${workflowBindingApprovals}
    WHERE ${workflowBindingApprovals.status} = 'active'
      AND ${workflowBindingApprovals.kind} = 'event'
      AND json_extract(${workflowBindingApprovals.target}, '$.source') = ${event.source})`;
  const room = sql`(SELECT COUNT(*) FROM ${keptEvents}
    WHERE ${keptEvents.sourceId} = ${event.source}) < ${keptPerSource}`;
  const same = sql`EXISTS (SELECT 1 FROM ${keptEvents}
    WHERE ${keptEvents.id} = ${event.same}
      AND ${keptEvents.eventType} = ${event.type}
      AND ${keptEvents.data} = ${data})`;
  await db.batch([
    db
      .insert(keptEvents)
      .select(
        sql`SELECT ${event.same}, ${event.source}, ${event.type},
          ${data}, ${now}, ${now + keptWindowMs}
          WHERE ${also} AND ${used} AND ${room}`
      )
      .onConflictDoNothing(),
    db
      .insert(keptEventKeys)
      .select(
        sql`SELECT ${event.same}, value FROM json_each(${JSON.stringify(hashes)})
          WHERE ${same}`
      )
      .onConflictDoNothing(),
  ]);
  const row = await db
    .select({ type: keptEvents.eventType, data: keptEvents.data })
    .from(keptEvents)
    .where(eq(keptEvents.id, event.same))
    .get();
  if (row === undefined) {
    return "unkept";
  }
  return row.type === event.type && row.data === data ? "kept" : "conflict";
};

/**
 * Audits, once a day for source `source`, that it keeps as many events
 * as it may, if it does: an event that came then wasn't kept.
 */
const auditedIfFull = async (env: Env, source: string): Promise<void> => {
  const { count } = await drizzle(env.DB).get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM ${keptEvents}
      WHERE ${keptEvents.sourceId} = ${source}`
  );
  if (count < keptPerSource) {
    return;
  }
  await auditedOnce(
    env,
    "workflow.webhook.kept_full",
    new Date().toISOString().slice(0, 10),
    { type: "event_source", id: source },
    { kept: count }
  );
};

/**
 * Records that `wait` takes kept event `eventId`, if its run took it at no
 * other wait and the wait took no other event: whether this wait has it
 * (now, or from a try before).
 */
const takes = async (
  env: Env,
  eventId: string,
  wait: { runId: string; step: string }
): Promise<boolean> => {
  const db = drizzle(env.DB);
  await db
    .insert(keptEventTakes)
    .values({
      eventId,
      runId: wait.runId,
      step: wait.step,
      takenAt: new Date(),
    })
    .onConflictDoNothing();
  const take = await db
    .select({ step: keptEventTakes.step })
    .from(keptEventTakes)
    .where(
      and(
        eq(keptEventTakes.eventId, eventId),
        eq(keptEventTakes.runId, wait.runId)
      )
    )
    .get();
  return take?.step === wait.step;
};

/** Lets `runId` take kept event `eventId` at a later wait: it couldn't now. */
const letGo = async (
  env: Env,
  eventId: string,
  runId: string
): Promise<void> => {
  await drizzle(env.DB)
    .delete(keptEventTakes)
    .where(
      and(eq(keptEventTakes.eventId, eventId), eq(keptEventTakes.runId, runId))
    );
};

/**
 * Hands an event a source took (source-events.ts) to every run waiting
 * on a match its data has, from that source and of its type, each by its
 * own match, once a run, each only while `also` holds (the secret it was
 * checked with still its source's). It is kept first (`kept`), for waits
 * reached later, so a wait registering meanwhile finds it either way.
 * What came of it: `stale` when `also` no longer holds and `conflict`
 * when its ID was kept with another event, both handing nothing; `retry`
 * when a run's wait may take it later (core failing), so its sender tries
 * again.
 */
export const routeSourceEvent = async (
  env: Env,
  event: SourceEvent,
  also: SQL
): Promise<"taken" | "kept" | "unkept" | "retry" | "stale" | "conflict"> => {
  if (!(await holds(env, also))) {
    return "stale";
  }
  const hashes = await hashesOf(event.data);
  if (hashes.length === 0) {
    // Nothing in it a match could name.
    return "unkept";
  }
  const keeping = await kept(env, event, hashes, also);
  if (keeping === "conflict") {
    log.warn("workflow.event_conflict", {
      source: event.source,
      delivery: event.same,
    });
    return "conflict";
  }
  const keeps = keeping === "kept";
  if (!keeps) {
    log.warn("workflow.event_unkept", {
      source: event.source,
      delivery: event.same,
    });
    await auditedIfFull(env, event.source);
  }
  const db = drizzle(env.DB);
  const waits = await db
    .select()
    .from(eventWaits)
    .where(
      and(
        eq(eventWaits.sourceId, event.source),
        eq(eventWaits.eventType, event.type),
        inList(eventWaits.matchHash, hashes),
        gt(eventWaits.expiresAt, new Date())
      )
    )
    .orderBy(asc(eventWaits.runId), asc(eventWaits.step));
  const outcomes: string[] = [];
  for (const wait of waits) {
    // A run takes a kept event once, and a wait one event.
    // oxlint-disable-next-line no-await-in-loop -- one run after another, few
    if (keeps && !(await takes(env, event.same, wait))) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const run = await callingRunOf(env, wait.workflowId, wait.runId);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const outcome = await handed(env, run, wait, event, also);
    if (keeps && outcome !== "taken" && outcome !== "retry") {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await letGo(env, event.same, wait.runId);
    }
    if (outcome === "stale") {
      // Its secret changed under it: it is handed to no run more.
      return "stale";
    }
    outcomes.push(outcome);
  }
  if (outcomes.includes("retry")) {
    return "retry";
  }
  if (outcomes.includes("taken")) {
    return "taken";
  }
  return keeps ? "kept" : "unkept";
};

/** A wait for an event source's event by a match, as its run reaches it. */
export interface MatchWait {
  readonly run: CallingRun;
  /** Its engine step's name. */
  readonly step: string;
  readonly binding: string;
  readonly types: readonly string[];
  readonly matchHash: string;
}

/** A kept event a wait took, as `claimKept` answers it. */
type Claimed = typeof keptEvents.$inferSelect;

/** The most kept events one wait tries, past those its run refuses. */
const claimTries = 8;

/**
 * The kept event `wait` takes (`source`'s, of one of `types`, matching its
 * hash, one its run took at no other wait), recorded in one conditional
 * insert (`kept_event_takes`): the one it took already if it did (a try
 * of its step again, or handed live), so it takes at most one; none when
 * there is none. Other runs take it all the same.
 */
const claimKept = async (
  env: Env,
  wait: MatchWait,
  source: string,
  types: readonly string[],
  /** Kept events this wait's run refused already: never taken again. */
  refused: readonly string[] = []
): Promise<Claimed | undefined> => {
  const db = drizzle(env.DB);
  const { runId } = wait.run;
  const now = Date.now();
  await db
    .insert(keptEventTakes)
    .select(
      sql`SELECT event.id, ${runId}, ${wait.step}, ${now}
        FROM ${keptEvents} AS event
        JOIN ${keptEventKeys} AS keyed ON keyed.event_id = event.id
        WHERE event.source_id = ${source}
          AND ${inList(sql`event.event_type`, types)}
          AND keyed.match_hash = ${wait.matchHash}
          AND event.expires_at > ${now}
          AND NOT ${inList(sql`event.id`, refused)}
          AND ${sourceLiveSql(source)}
          AND NOT EXISTS (SELECT 1 FROM ${keptEventTakes} AS taken
            WHERE taken.event_id = event.id AND taken.run_id = ${runId})
        ORDER BY event.received_at, event.id
        LIMIT 1`
    )
    .onConflictDoNothing();
  const [claimed] = await db
    .select({ event: keptEvents })
    .from(keptEventTakes)
    .innerJoin(keptEvents, eq(keptEvents.id, keptEventTakes.eventId))
    .where(
      and(eq(keptEventTakes.runId, runId), eq(keptEventTakes.step, wait.step))
    )
    .limit(1);
  return claimed?.event;
};

/**
 * Reaches `wait` (until `until`, its deadline): registers it for the
 * events of its match (`event_waits`), then takes the oldest kept event
 * of its match its run hasn't taken, if any (`claimKept`), and hands it to
 * its run. A kept event its run refuses for good is let go for its next
 * wait. Refused
 * (`workflow.event_denied`) when the run's binding names no source. The
 * host runs it as a step it journals, so a replay reaches nothing again.
 */
export const enterMatchWait = async (
  env: Env,
  wait: MatchWait,
  until: number
): Promise<void> => {
  const frozen = wait.run.bindings.get(wait.binding);
  const source =
    frozen?.kind === "event" && frozen.target.kind === "event"
      ? frozen.target.source
      : undefined;
  if (frozen === undefined || source === undefined) {
    throw workflowResourceErrors.create("workflow.event_denied");
  }
  const sourced = new Set(await sourcedTypesOf(env, frozen));
  const types = wait.types.filter((type) => sourced.has(type));
  if (types.length === 0) {
    throw workflowResourceErrors.create("workflow.event_denied");
  }
  const db = drizzle(env.DB);
  const expiresAt = new Date(until);
  const [first, ...rest] = statementsWithin(types, (part) =>
    db
      .insert(eventWaits)
      .values(
        part.map((eventType) => ({
          runId: wait.run.runId,
          step: wait.step,
          eventType,
          workflowId: wait.run.workflowId,
          binding: wait.binding,
          sourceId: source,
          matchHash: wait.matchHash,
          expiresAt,
        }))
      )
      .onConflictDoUpdate({
        target: [eventWaits.runId, eventWaits.step, eventWaits.eventType],
        set: { sourceId: source, matchHash: wait.matchHash, expiresAt },
      })
  );
  // `types` is never empty (above): one batch, so the wait is entered for
  // all its types or none.
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
  const refused: string[] = [];
  for (let attempt = 0; attempt < claimTries; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one kept event after another
    const claimed = await claimKept(env, wait, source, types, refused);
    if (claimed === undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const outcome = await handed(
      env,
      wait.run,
      {
        workflowId: wait.run.workflowId,
        runId: wait.run.runId,
        step: wait.step,
        binding: wait.binding,
        matchHash: wait.matchHash,
      },
      {
        same: claimed.id,
        source: claimed.sourceId,
        type: claimed.eventType,
        data: z.json().parse(JSON.parse(claimed.data)),
      },
      sourceLiveSql(claimed.sourceId)
    );
    if (outcome === "retry") {
      throw new Error(`Run ${wait.run.runId} couldn't take its kept event now`);
    }
    if (outcome === "taken") {
      return;
    }
    // One its run can't take now is let go, for its next wait, and this
    // wait goes on to the next kept event of its match.
    // oxlint-disable-next-line no-await-in-loop -- as above
    await letGo(env, claimed.id, wait.run.runId);
    if (outcome === "stale" || outcome === "run_ended") {
      // Its source went, or its run did: nothing kept is handed now.
      return;
    }
    refused.push(claimed.id);
  }
};

/** Ends wait `step` of run `runId`: it takes no event of its match more. */
export const leaveMatchWait = async (
  env: Env,
  runId: string,
  step: string
): Promise<void> => {
  await drizzle(env.DB)
    .delete(eventWaits)
    .where(and(eq(eventWaits.runId, runId), eq(eventWaits.step, step)));
};

/**
 * The most kept events one statement of the sweep deletes, with their keys
 * (each at most `maxLeaves`) and takes: within what one D1 statement does.
 */
const sweptPerBatch = 100;

/** The most waits one statement of the sweep deletes. */
const waitsPerBatch = 500;

/** How long one clock run sweeps for, at most. */
const sweepBudgetMs = 5000;

/**
 * Deletes one batch of kept events past their day or of a deleted source
 * (`sweptPerBatch`), with their keys and takes, audited: how many it
 * deleted.
 */
const sweptBatch = async (env: Env, now: Date): Promise<number> => {
  const db = drizzle(env.DB);
  const expired = await db
    .select({
      id: keptEvents.id,
      sourceId: keptEvents.sourceId,
      taken: sql<number>`EXISTS (SELECT 1 FROM ${keptEventTakes}
        WHERE ${keptEventTakes.eventId} = ${keptEvents.id})`,
    })
    .from(keptEvents)
    .where(
      or(
        lte(keptEvents.expiresAt, now),
        not(sourceLiveSql(sql`${keptEvents.sourceId}`))
      )
    )
    .orderBy(asc(keptEvents.expiresAt))
    .limit(sweptPerBatch);
  if (expired.length === 0) {
    return 0;
  }
  const ids = expired.map(({ id }) => id);
  await db.batch([
    db.delete(keptEventTakes).where(inList(keptEventTakes.eventId, ids)),
    db.delete(keptEventKeys).where(inList(keptEventKeys.eventId, ids)),
    db.delete(keptEvents).where(inList(keptEvents.id, ids)),
  ]);
  const untaken = new Map<string, number>();
  for (const { sourceId, taken } of expired) {
    if (taken === 0) {
      untaken.set(sourceId, (untaken.get(sourceId) ?? 0) + 1);
    }
  }
  await Promise.all(
    [...untaken].map(async ([source, events]) => {
      await auditedOnce(
        env,
        "workflow.webhook.kept_expired",
        `${now.toISOString()}:${ids[0] ?? ""}`,
        { type: "event_source", id: source },
        { events }
      );
    })
  );
  return expired.length;
};

/**
 * On the clock: deletes the kept events past their day or of a deleted
 * source, with their data, keys and takes, and the waits past their
 * deadline, in bounded batches until none is left or `budgetMs` is
 * spent, so the sweep keeps up with what sources send. Kept events no
 * run took are audited by source with how many
 * (`workflow.webhook.kept_expired`).
 */
export const sweepEventWaits = async (
  env: Env,
  now = new Date(),
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const db = drizzle(env.DB);
  const until = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    const waits = await db.run(
      sql`DELETE FROM ${eventWaits} WHERE rowid IN (SELECT rowid FROM ${eventWaits}
        WHERE ${eventWaits.expiresAt} <= ${now.getTime()} LIMIT ${waitsPerBatch})`
    );
    if (waits.meta.changes < waitsPerBatch || Date.now() >= until) {
      break;
    }
  }
  while (Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    const swept = await sweptBatch(env, now);
    if (swept < sweptPerBatch) {
      return;
    }
  }
};
