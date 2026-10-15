import { heldBindingSchema } from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectResult,
  UnknownOutcomeOrigin,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { workContextSchema } from "@grasp-os/shared/permissions";
import type { CodeSubject } from "@grasp-os/shared/permissions";
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { idempotentCalls } from "./db/schema.ts";

// Side effects happen once per idempotency key. The first call claims the
// key before it calls out; its answer (a result, or the tool's error) is
// stored under the key, and a repeat gets that answer without calling out
// again. A call that fails after it may have reached the server spends the
// key: nobody can tell whether the effect happened, so a repeat is refused
// rather than risk doing it twice. Only a native connector that says it
// did nothing (`notPerformedMetaKey`) frees the key again.
//
// A step journal replays; it doesn't make a remote effect happen once
// (spec 14.3, 44). Between a provider taking a write and connect storing
// its answer there is a window nobody can close, so connect never claims
// more than it knows. Threat model for that window, and how each is
// closed:
// - The provider takes the write and its answer is lost (a dropped
//   connection, a timeout, the egress withholding it): the key is spent,
//   every repeat is `connect.outcome_unknown`, and nothing is sent again.
// - The provider answers the write with a server error (5xx), which may
//   come after it acted: the connector kit says the outcome is unknown
//   (`outcomeUnknownMetaKey`), and connect spends the key the same way.
//   The error is never kept as the answer: a stored failure would tell
//   every repeat the action failed, and code that read that as "nothing
//   was sent" could send it again under a fresh key.
// - A Composio tool that may act answers with an error. Composio runs it
//   remotely and can report a provider's 5xx or timeout after the provider
//   acted, and nothing in its answer proves the provider refused first
//   (policy.ts `uncertainFailure`, GRA-539): every such error spends the
//   key as unknown, an input the provider rejected outright included.
//   Recorded answers can narrow this later; until then, when in doubt,
//   unknown. A tool the admin marked read-only keeps its error as the
//   failure. What the tool said is logged (redacted, cut short) under the
//   call's ID, for whoever looks into it; it is never replayed or audited.
// - The provider takes the write, and its answer can't be read (not what
//   the connector expects, past the size limit): it went through, but what
//   it made can't be told, so the same.
// - A tool's code fails in a way it didn't foresee: its write is its last
//   request, so the failure may have come after it, and the kit says the
//   outcome is unknown. Only a refusal the tool made itself, or a 4xx the
//   provider answered before acting, is the action's failure.
// - Connect stores the answer and its audit events in one batch, and that
//   batch fails: the effect happened, unrecorded; the key is spent.
// - A server lies. A tool result saying it did nothing
//   (`notPerformedMetaKey`) is believed only of a native connector, whose
//   code is reviewed. Saying the outcome is unknown is believed of any
//   server: it can only stop a repeat, and it wins over "did nothing" in
//   the same result. How a request failed is never taken as proof that
//   it didn't run: a remote server's HTTP 401 or 403, or a JSON-RPC
//   error, may be a provider's refusal passed on after the tool acted, so
//   once the key is claimed every failed request spends it (mcp.ts
//   `McpError`). A key or session the server refuses costs nothing: connect
//   lists a Composio server's tools before it claims the key, so that
//   refusal comes first, with the key never taken.
// - A call is cancelled, fenced or its permission revoked after it was
//   sent: what it did stays recorded as it ended (done, failed or
//   unknown), never as undone; a later call needs a capability core signs
//   only while the caller may still act.
//
// Recovery (spec 14.3): a call of unknown outcome may be taken up again,
// under its key, when its native action says how (`recovery`): `repeat`
// sends it again, because it can't take effect twice under its effect key;
// `find` looks its effect up by the key first. Composio and other remote
// servers never recover, and never see an effect key. Threat model, and
// how each is closed:
// - A recovery races the call it recovers, still out: it waits until the
//   call's last claim is past the claim timeout (`recoveryWaitMs`); a
//   call gives up within 30 seconds, and the egress closes with it.
// - Two recoveries race each other: each retakes the key only if its row
//   is still as read (state, last claim, input), in one statement, so one
//   goes out and the other is `connect.call_in_progress`.
// - A recovery with other input under the key: `replay` refuses it
//   (`connect.idempotency_conflict`) before anything else.
// - A caller who may no longer act (a revoked permission, an inactive
//   connection, another person's): recovery runs only inside a call, after
//   the capability core signed for this call now is verified and every
//   check of the call itself has passed again; a call its person must
//   confirm is never recovered, which would hold it anew.
// - A lookup reaches further than the call: it runs in the connector's
//   isolate, through the egress, on the action's own declared routes
//   (a GET the manifest must declare), bound to the call's resource.
// - A lookup says "not there" while it is: only a native connector's word
//   is taken, its `find` returns null only when certain, and the call has
//   been out of reach for the claim timeout. Only that null says "absent"
//   (`effectAbsentMetaKey`): a lookup that failed, a throttled GET's "did
//   nothing" included, is a plain failure, and the call stays unknown. Any
//   error or doubt spends the key again, with a new claim time, so the next
//   recovery waits anew. A lookup that can't be sure (a sent email whose
//   copy may be elsewhere) isn't declared at all.
// - Another connector release recovers a call: it may tag, find or repeat
//   differently (one that didn't tag yet would look for a tag that isn't
//   there, and send), so only the build that claimed the key recovers its
//   call (`connector_version`: name, version and a hash of the bundled
//   code, so a change nobody bumped the version for counts too).
// - A recovery's send the provider turns away (did nothing) starts the
//   horizon afresh: it leaves the call unknown instead of freeing the key,
//   so the horizon still counts from the first claim.
// - A call writes to the key after another took it over (a late answer,
//   freeing or spending it): every write of a call to its key requires the
//   claim time it set, and after an "absent" lookup the call claims anew,
//   while it still holds the key, right before it sends.
// - A row from before claim times were kept (`claimed_at` 0) passes for
//   stale: a claim is as recent as its first claim at least.
// - A repeat undoes what people did since (a label they removed): no
//   recovery past `recoveryHorizonMs` from the first claim. Within it, a
//   repeated label change can still undo a person's relabel: accepted.
// - An effect key gives the caller away, or crosses calls: it hashes the
//   call's whole scope, so it differs between any two calls and names
//   nobody (`effectKeyOf`).

// Resolution by a person (spec 14.3): a call of unknown outcome is an
// open obligation of the person it acted for, who may say what became of
// it once they looked (outcomes.ts). Threat model, and how each is closed:
// - Someone else resolves it (another person, staff, an App or agent):
//   connect resolves only with the capability core signs from the
//   person's own session, for exactly this call, naming the person the
//   call acted for, and marked as a resolution (`resolves`); no other call
//   path takes such a capability, and a resolution takes no other.
// - A caller whose permission is gone frees its key: core signs the
//   resolution only after checking the call's permission and context
//   again, as for confirming a held action, and refuses otherwise,
//   recorded.
// - A resolution races a recovery, or another resolution: it applies only
//   while the row is still as read (state, last claim, input) and still of
//   unknown outcome, in one statement with its audit event, and takes a
//   claim time of its own, so a recovery that read the row before can't
//   retake it, and of two resolutions one is recorded.
// - "It didn't happen" lets the call go twice: the key is freed for one
//   send of the same input (`freed`), which a call takes only by turning
//   that row back to running in one statement (`claim`), so of calls
//   racing for it one goes out; another input under the key is refused.
// - "It happened" is taken as an answer: the key stays spent for good,
//   every repeat is `connect.resolved_done`, with no output, never a send.
// - A cancelled run or one that ended: the obligation stays, as the effect
//   may have happened; only the run's wait goes. Nothing ever records that
//   an effect was undone.

/**
 * How long a claim holds before connect stops waiting for its call: well
 * past the longest an MCP request may take. A claim older than this was
 * left by a call that died mid-way, so its outcome is unknown.
 */
const claimTimeoutMs = 5 * 60 * 1000;

/**
 * How long stored answers are kept. A workflow retries a step within this.
 * After it the answer is dropped, but the key stays used for good: a repeat
 * is refused, never run again.
 */
const retentionMs = 30 * 24 * 60 * 60 * 1000;

/** Whose key it is, and for which call: never the key alone. */
export interface IdempotencyScope {
  subject: CodeSubject;
  onBehalfOf: string;
  connectionId: string;
  action: string;
  idempotencyKey: string;
  /** The one resource the call is for; null for the whole connection. */
  resource: string | null;
}

/**
 * Largest output kept for a repeat, in bytes. A larger one goes back to the
 * first call in full, and a repeat is refused as for an expired answer.
 */
const maxStoredOutputBytes = 128 * 1024;

export type Row = typeof idempotentCalls.$inferSelect;

/**
 * How long after its first claim a call of unknown outcome may still be
 * recovered (`recoveryWaitMs`). Past it, it stays unknown: a state written
 * again a day later may undo what people changed since, and an effect
 * looked up then may have been redone by hand.
 */
export const recoveryHorizonMs = 24 * 60 * 60 * 1000;

/** An earlier call's answer: its result, or the tool's error. */
export interface StoredAnswer {
  result: ConnectResult;
  /** The tool reported an error; `result` holds what it said. */
  failed: boolean;
}

const provenanceSchema = z.array(z.string());

const subjectColumns = (subject: CodeSubject) =>
  subject.type === "app"
    ? { subjectType: subject.type, subjectId: subject.appId }
    : { subjectType: subject.type, subjectId: subject.agentId };

const keyOf = (scope: IdempotencyScope) => {
  const { subjectType, subjectId } = subjectColumns(scope.subject);
  return and(
    eq(idempotentCalls.subjectType, subjectType),
    eq(idempotentCalls.subjectId, subjectId),
    eq(idempotentCalls.onBehalfOf, scope.onBehalfOf),
    eq(idempotentCalls.connectionId, scope.connectionId),
    eq(idempotentCalls.action, scope.action),
    eq(idempotentCalls.idempotencyKey, scope.idempotencyKey)
  );
};

/** The key of the stored row `row`, as a condition. */
export const rowKey = (row: Row) =>
  and(
    eq(idempotentCalls.subjectType, row.subjectType),
    eq(idempotentCalls.subjectId, row.subjectId),
    eq(idempotentCalls.onBehalfOf, row.onBehalfOf),
    eq(idempotentCalls.connectionId, row.connectionId),
    eq(idempotentCalls.action, row.action),
    eq(idempotentCalls.idempotencyKey, row.idempotencyKey)
  );

/**
 * What a call keeps under its key while it may be of unknown outcome: its
 * exact input and where it came from, both as JSON (`input`, `origin`).
 */
export interface Kept {
  input: string;
  origin: string;
}

/** Where a call came from, as connect keeps it (`Kept.origin`). */
const storedOriginSchema = z.strictObject({
  mode: z.enum(["interactive", "workflow"]),
  appVersion: z.int().positive().nullable(),
  permissionId: z.string().min(1),
  context: workContextSchema,
  /** Its context had read restricted data: every side effect of it waits. */
  restricted: z.boolean(),
  /**
   * The App's approved resource binding the call came through, if it
   * did: core checks it would still serve the call before it signs a
   * resolution, as for confirming a held call.
   */
  binding: heldBindingSchema.optional(),
});

/** What a call whose capability says `claims` keeps under its key. */
export const keptOf = (claims: CapabilityClaims, input: Json): Kept => ({
  input: JSON.stringify(input),
  origin: JSON.stringify({
    mode: claims.authority.mode,
    appVersion: claims.authority.appVersion ?? null,
    permissionId: claims.origin.permissionId,
    context: claims.origin.context,
    restricted: claims.restricted,
    ...(claims.origin.binding === undefined
      ? {}
      : { binding: claims.origin.binding }),
  } satisfies z.input<typeof storedOriginSchema>),
});

/**
 * Where the call `row` records came from, as kept, or null when nothing
 * readable is: such a call can't be resolved.
 */
export const originOf = (
  row: Row
): (UnknownOutcomeOrigin & { restricted: boolean }) | null => {
  if (row.origin === null) {
    return null;
  }
  try {
    return storedOriginSchema.parse(JSON.parse(row.origin));
  } catch {
    return null;
  }
};

/** SHA-256 over the call's resource and input, in canonical JSON. */
export const hashCall = async (
  resource: string | null,
  input: Json
): Promise<string> => await sha256Hex(canonicalJson({ resource, input }));

/**
 * When the key was last claimed: its last claim, and never before its
 * first, so a row whose `claimed_at` was never set (0) isn't stale at once.
 */
const lastClaimOf = (row: Row): number =>
  Math.max(row.claimedAt.getTime(), row.createdAt.getTime());

/**
 * Whether the call `row` records is of unknown outcome now: spent, or
 * claimed by a call past the claim timeout, which died mid-way.
 */
export const isUnknown = (row: Row, now: number): boolean =>
  row.state === "unknown" ||
  (row.state === "running" && now - lastClaimOf(row) >= claimTimeoutMs);

/** `isUnknown`, as a condition on stored rows. */
export const unknownNow = (now: number) =>
  or(
    eq(idempotentCalls.state, "unknown"),
    and(
      eq(idempotentCalls.state, "running"),
      sql`max(${idempotentCalls.claimedAt}, ${idempotentCalls.createdAt}) <= ${now - claimTimeoutMs}`
    )
  );

/** What a stored row means for a repeat of the call: its answer, or why not. */
export const replay = (
  row: Row,
  inputHash: string,
  now: number
): StoredAnswer => {
  if (row.inputHash !== inputHash) {
    throw connectErrors.create("connect.idempotency_conflict");
  }
  // Its person said it happened: no answer, and never sent again.
  if (row.state === "resolved") {
    throw connectErrors.create("connect.resolved_done");
  }
  // Its person said it didn't: a call takes the key again (`claim`).
  if (row.state === "freed") {
    throw connectErrors.create("connect.resolved_not_done");
  }
  if (row.state === "declined") {
    throw connectErrors.create("connect.declined", {
      reason: row.output ?? "declined",
    });
  }
  const answered = row.state === "done" || row.state === "failed";
  const expired = now - row.createdAt.getTime() > retentionMs;
  if (answered && (expired || row.output === null)) {
    // It ran, but its answer isn't kept: never run it again.
    throw connectErrors.create("connect.answer_not_kept");
  }
  if (answered && row.output !== null) {
    return {
      result: {
        output: row.output,
        provenance: provenanceSchema.parse(JSON.parse(row.provenance ?? "[]")),
      },
      failed: row.state === "failed",
    };
  }
  if (row.state === "running" && now - lastClaimOf(row) < claimTimeoutMs) {
    throw connectErrors.create("connect.call_in_progress");
  }
  throw connectErrors.create("connect.outcome_unknown");
};

/**
 * How long until the call `row` records may be recovered, in milliseconds:
 * 0 now, null never. Only a call of unknown outcome (spent, or a claim
 * past its timeout) is, and only within the horizon of its first claim.
 * Its last claim must be past the claim timeout, so a recovery never runs
 * while that claim's call may still be out: connect's MCP client and
 * egress give up on a call within 30 seconds, far inside it.
 */
export const recoveryWaitMs = (row: Row, now: number): number | null => {
  if (row.state !== "unknown" && row.state !== "running") {
    return null;
  }
  if (now - row.createdAt.getTime() > recoveryHorizonMs) {
    return null;
  }
  return Math.max(0, lastClaimOf(row) + claimTimeoutMs - now);
};

/**
 * The effect key of the call `scope` names (`effectKeyMetaKey`): a SHA-256
 * over its whole scope, so it is the same for every attempt of one call,
 * differs between any two, and gives away neither the caller's key nor
 * who called.
 */
export const effectKeyOf = async (scope: IdempotencyScope): Promise<string> => {
  const { subjectType, subjectId } = subjectColumns(scope.subject);
  return await sha256Hex(
    canonicalJson([
      "grasp-os/effect",
      subjectType,
      subjectId,
      scope.onBehalfOf,
      scope.connectionId,
      scope.action,
      scope.resource,
      scope.idempotencyKey,
    ])
  );
};

/** The output as kept for repeats: itself, or nothing when too large. */
const retainable = (output: string): string | null =>
  new TextEncoder().encode(output).byteLength <= maxStoredOutputBytes
    ? output
    : null;

/** Set once a call is answered from an earlier call's stored row. */
export interface Repeat {
  replayed?: boolean;
}

/** A claim time after `after`: never the same instant as the claim before. */
const claimTime = (after: number): Date =>
  new Date(Math.max(Date.now(), after + 1));

/** The idempotency store for one key: see the module comment. */
export const idempotencyStore = (
  database: D1Database,
  scope: IdempotencyScope,
  inputHash: string
) => {
  const db = drizzle(database);
  const key = keyOf(scope);

  const find = async (): Promise<Row | undefined> =>
    await db.select().from(idempotentCalls).where(key).get();

  // The claim this call holds, by the time it set: whatever it then writes
  // to the key (its answer, freeing or spending it) applies only while the
  // key is still claimed by it, so a call a recovery took the key from
  // since, late, can't overwrite the newer claim.
  let mine: Date | undefined;
  const held = () =>
    and(
      key,
      eq(idempotentCalls.state, "running"),
      mine === undefined ? undefined : eq(idempotentCalls.claimedAt, mine)
    );

  return {
    /** The stored row of an earlier call with this key, as it is. */
    find,

    /**
     * The stored answer of an earlier call with this key, if there was one.
     * `seen.replayed` says the call was answered (or refused) as a repeat,
     * so its audit event isn't counted as a send.
     */
    replay: async (seen: Repeat = {}): Promise<StoredAnswer | undefined> => {
      const row = await find();
      // Freed by its person for one more send: a first call, as far as
      // this one is concerned, which `claim` takes over.
      if (
        row === undefined ||
        (row.state === "freed" && row.inputHash === inputHash)
      ) {
        return undefined;
      }
      seen.replayed = true;
      return replay(row, inputHash, Date.now());
    },

    /**
     * The answer the row `row` of this key records, read already, as
     * `replay` gives it.
     */
    replayRow: (row: Row, seen: Repeat = {}): StoredAnswer => {
      seen.replayed = true;
      return replay(row, inputHash, Date.now());
    },

    /**
     * Claims the key for a call about to go out: undefined once claimed. If
     * another call claimed it first, answers as a repeat of that call
     * (`seen.replayed`).
     */
    claim: async (
      seen: Repeat = {},
      connectorVersion: string | null = null,
      kept: Kept | null = null
    ): Promise<StoredAnswer | undefined> => {
      const now = Date.now();
      const [claimed] = await db.batch([
        db
          .insert(idempotentCalls)
          .values({
            ...subjectColumns(scope.subject),
            onBehalfOf: scope.onBehalfOf,
            connectionId: scope.connectionId,
            action: scope.action,
            idempotencyKey: scope.idempotencyKey,
            resource: scope.resource,
            inputHash,
            state: "running",
            createdAt: new Date(now),
            claimedAt: new Date(now),
            connectorVersion,
            input: kept?.input ?? null,
            origin: kept?.origin ?? null,
          })
          .onConflictDoNothing()
          .returning({ state: idempotentCalls.state }),
        // Expired answers are dropped; the index on created_at keeps it
        // cheap. Their keys stay used: their effect happened.
        db
          .update(idempotentCalls)
          .set({ output: null, provenance: null })
          .where(
            and(
              lt(idempotentCalls.createdAt, new Date(now - retentionMs)),
              inArray(idempotentCalls.state, ["done", "failed"]),
              isNotNull(idempotentCalls.output)
            )
          ),
        // So is the input a call of unknown outcome kept for its person,
        // whoever made it: its obligation stays, listed without it.
        db
          .update(idempotentCalls)
          .set({ input: null })
          .where(
            and(
              lt(idempotentCalls.createdAt, new Date(now - retentionMs)),
              isNotNull(idempotentCalls.input)
            )
          ),
      ]);
      if (claimed.length > 0) {
        mine = new Date(now);
        return undefined;
      }
      // Freed by its person for one more send of this input: taken in one
      // statement, so of calls racing for it one goes out. A first send
      // again: its horizon, retention and connector build start afresh,
      // under a claim later than the resolution's.
      const [retaken] = await db
        .update(idempotentCalls)
        .set({
          state: "running",
          createdAt: new Date(now),
          claimedAt: sql`max(${now}, ${idempotentCalls.claimedAt} + 1)`,
          connectorVersion,
          input: kept?.input ?? null,
          origin: kept?.origin ?? null,
        })
        .where(
          and(
            key,
            eq(idempotentCalls.state, "freed"),
            eq(idempotentCalls.inputHash, inputHash)
          )
        )
        .returning({ claimedAt: idempotentCalls.claimedAt });
      if (retaken !== undefined) {
        mine = retaken.claimedAt;
        return undefined;
      }
      const row = await find();
      if (row !== undefined) {
        seen.replayed = true;
      }
      const earlier =
        row === undefined ? undefined : replay(row, inputHash, now);
      if (earlier === undefined) {
        // Claimed and released again in between: that call did nothing.
        throw connectErrors.create("connect.call_in_progress");
      }
      return earlier;
    },

    /**
     * Claims the key again for a recovery of the call `row` records, as it
     * was read: only if it still is (the same state and last claim, the
     * same input), so of two recoveries racing, one goes out and the other
     * is `connect.call_in_progress`. The first claim's time stays, for the
     * horizon.
     */
    retake: async (row: Row): Promise<void> => {
      const at = claimTime(row.claimedAt.getTime());
      const retaken = await db
        .update(idempotentCalls)
        .set({ state: "running", claimedAt: at })
        .where(
          and(
            key,
            eq(idempotentCalls.state, row.state),
            eq(idempotentCalls.claimedAt, row.claimedAt),
            eq(idempotentCalls.inputHash, inputHash)
          )
        )
        .returning({ state: idempotentCalls.state });
      if (retaken.length === 0) {
        throw connectErrors.create("connect.call_in_progress");
      }
      mine = at;
    },

    /**
     * Records on the row that recovering its call needs its person to
     * confirm it now (a call of a restricted context): `recoverableNow`
     * then reads it as never recoverable.
     */
    requireConfirmation: async (): Promise<void> => {
      await db
        .update(idempotentCalls)
        .set({
          origin: sql`json_set(${idempotentCalls.origin}, '$.restricted', json('true'))`,
        })
        .where(and(key, isNotNull(idempotentCalls.origin)));
    },

    /**
     * Claims the key anew, right before the call goes out after a lookup
     * found its effect absent: only while this call still holds it, so a
     * lookup that ran long can't send under a claim another took since.
     * Refused, the call stays unknown, and nothing is written.
     */
    restamp: async (): Promise<void> => {
      if (mine === undefined) {
        throw connectErrors.create("connect.outcome_unknown");
      }
      const at = claimTime(mine.getTime());
      const restamped = await db
        .update(idempotentCalls)
        .set({ claimedAt: at })
        .where(held())
        .returning({ state: idempotentCalls.state });
      if (restamped.length === 0) {
        throw connectErrors.create("connect.outcome_unknown");
      }
      mine = at;
    },

    /**
     * The statement that stores the answer of the call this key was claimed
     * for, to run in one batch with the call's audit events.
     */
    completion: ({ result, failed }: StoredAnswer): BatchItem<"sqlite"> =>
      db
        .update(idempotentCalls)
        .set({
          state: failed ? "failed" : "done",
          output: retainable(result.output),
          provenance: JSON.stringify(result.provenance),
          // Answered: nobody resolves it, so nothing of its input stays.
          input: null,
          origin: null,
        })
        .where(held()),

    /** Frees the key: the call is known not to have had its effect. */
    release: async (): Promise<void> => {
      await db.delete(idempotentCalls).where(held());
    },

    /** Spends the key: the call may or may not have had its effect. */
    spend: async (): Promise<void> => {
      await db.update(idempotentCalls).set({ state: "unknown" }).where(held());
    },
  };
};

/**
 * Resolves the call of unknown outcome `row` records, as read, by its
 * person's word: the condition it applies under (still as read, and still
 * of unknown outcome), for its audit event to be recorded under the same,
 * and the write. "It happened" keeps the key spent for good, answering
 * `connect.resolved_done`; "it didn't" frees it for one send of the same
 * input (`freed`). Either takes a claim time of its own, so a recovery
 * that read the row before can't retake it, and drops what was kept of
 * the call. "It didn't" applies only while the call's input is kept.
 */
export const resolution = (
  database: D1Database,
  row: Row,
  choice: "happened" | "not_happened",
  now: number
) => {
  const db = drizzle(database);
  const where = and(
    rowKey(row),
    eq(idempotentCalls.state, row.state),
    eq(idempotentCalls.claimedAt, row.claimedAt),
    eq(idempotentCalls.inputHash, row.inputHash),
    unknownNow(now),
    // "It didn't" only while what was sent is still kept for its person
    // to read: retention may drop it between the read and this write.
    choice === "not_happened" ? isNotNull(idempotentCalls.input) : undefined
  );
  if (where === undefined) {
    throw new Error("Expected a condition");
  }
  return {
    where,
    write: db
      .update(idempotentCalls)
      .set({
        state: choice === "happened" ? "resolved" : "freed",
        claimedAt: claimTime(row.claimedAt.getTime()),
        output: null,
        provenance: null,
        input: null,
        origin: null,
      })
      .where(where),
  };
};
