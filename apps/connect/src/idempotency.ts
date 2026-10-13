import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectResult } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionSubject } from "@grasp-os/shared/permissions";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { idempotentCalls } from "./db/schema.ts";

// Side effects happen once per idempotency key. The first call claims the
// key before it calls out; its answer (a result, or the tool's error) is
// stored under the key, and a repeat gets that answer without calling out
// again. A call that fails after it may have reached the server spends the
// key: nobody can tell whether the effect happened, so a repeat is refused
// rather than risk doing it twice. Only a server that turned the call away
// (401, 403, a JSON-RPC parse error or no such method), or a native
// connector that says it did nothing (`notPerformedMetaKey`), frees the
// key again.
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
//   For a native connector the error is never kept as the answer: a stored
//   failure would tell every repeat the action failed, and code that read
//   that as "nothing was sent" could send it again under a fresh key. A
//   Composio or other remote tool's error result is still kept as the
//   action's failure (`failed`), even when it acted first, unless the tool
//   itself says the outcome is unknown: telling those apart is GRA-539.
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
//   the same result. But a call any server turned away at the transport
//   (HTTP 401 or 403, a JSON-RPC parse error or no such method) frees the
//   key, a remote server's included: one that acted and then answered 401
//   would have its effect run again on a repeat. Closing that for remote
//   servers is GRA-539.
// - A call is cancelled, fenced or its permission revoked after it was
//   sent: what it did stays recorded as it ended (done, failed or
//   unknown), never as undone; a later call needs a capability core signs
//   only while the caller may still act.

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
  subject: PermissionSubject;
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

type Row = typeof idempotentCalls.$inferSelect;

/** An earlier call's answer: its result, or the tool's error. */
export interface StoredAnswer {
  result: ConnectResult;
  /** The tool reported an error; `result` holds what it said. */
  failed: boolean;
}

const provenanceSchema = z.array(z.string());

const subjectColumns = (subject: PermissionSubject) =>
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

/** SHA-256 over the call's resource and input, in canonical JSON. */
export const hashCall = async (
  resource: string | null,
  input: Json
): Promise<string> => await sha256Hex(canonicalJson({ resource, input }));

/** What a stored row means for a repeat of the call: its answer, or why not. */
export const replay = (
  row: Row,
  inputHash: string,
  now: number
): StoredAnswer => {
  if (row.inputHash !== inputHash) {
    throw connectErrors.create("connect.idempotency_conflict");
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
  if (
    row.state === "running" &&
    now - row.createdAt.getTime() < claimTimeoutMs
  ) {
    throw connectErrors.create("connect.call_in_progress");
  }
  throw connectErrors.create("connect.outcome_unknown");
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
      if (row === undefined) {
        return undefined;
      }
      seen.replayed = true;
      return replay(row, inputHash, Date.now());
    },

    /**
     * Claims the key for a call about to go out: undefined once claimed. If
     * another call claimed it first, answers as a repeat of that call
     * (`seen.replayed`).
     */
    claim: async (seen: Repeat = {}): Promise<StoredAnswer | undefined> => {
      const now = Date.now();
      const [, claimed] = await db.batch([
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
          })
          .onConflictDoNothing()
          .returning({ state: idempotentCalls.state }),
      ]);
      if (claimed.length > 0) {
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
        })
        .where(and(key, eq(idempotentCalls.state, "running"))),

    /** Frees the key: the call is known not to have had its effect. */
    release: async (): Promise<void> => {
      await db
        .delete(idempotentCalls)
        .where(and(key, eq(idempotentCalls.state, "running")));
    },

    /** Spends the key: the call may or may not have had its effect. */
    spend: async (): Promise<void> => {
      await db
        .update(idempotentCalls)
        .set({ state: "unknown" })
        .where(and(key, eq(idempotentCalls.state, "running")));
    },
  };
};
