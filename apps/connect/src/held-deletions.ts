import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { idempotentCalls, pendingActions } from "./db/schema.ts";

/**
 * The writes that delete the held actions `still` selects, read as they
 * run, with their keys spent first as pending.ts `deletion` says when
 * `spentAs` says why they won't run: one held action's (`deletion`), or
 * every one on the connections of a connector a release moved to another
 * server (connector-providers.ts `prepareBuiltIn`), whose saved input must
 * never reach that server.
 */
export const heldDeletions = (env: Env, still: SQL, spentAs?: string) => {
  const db = drizzle(env.DB);
  const spend = db
    .insert(idempotentCalls)
    .select(
      db
        .select({
          subjectType: pendingActions.subjectType,
          subjectId: pendingActions.subjectId,
          onBehalfOf: pendingActions.onBehalfOf,
          connectionId: pendingActions.connectionId,
          action: pendingActions.action,
          idempotencyKey: pendingActions.idempotencyKey,
          inputHash: pendingActions.inputHash,
          state: sql<"declined">`'declined'`.as("state"),
          output: sql<string | null>`${spentAs ?? null}`.as("output"),
          provenance: sql<null>`NULL`.as("provenance"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          claimedAt: sql<Date>`${Date.now()}`.as("claimed_at"),
          connectorVersion: sql<null>`NULL`.as("connector_version"),
          resource: pendingActions.resource,
          // Never of unknown outcome: nothing of the call is kept.
          input: sql<null>`NULL`.as("input"),
          origin: sql<null>`NULL`.as("origin"),
          // Declined, never listed as of unknown outcome.
          listId: sql<string>`''`.as("list_id"),
        })
        .from(pendingActions)
        .where(
          and(
            still,
            or(
              eq(pendingActions.mode, "workflow"),
              sql`${pendingActions.idempotencyKey} = json_extract(${pendingActions.context}, '$.chatId') || ':' || ${pendingActions.id}`,
              // An App action's call through a resource binding, only when
              // its person declined it: its key is core's, derived from the
              // action's call, so the same call made again is told it was
              // declined, not asked again. A drop (its binding revoked or
              // stale, its connection gone, its person removed) leaves the
              // key free: the person declined nothing, and the same call
              // made again is decided afresh.
              spentAs === "declined"
                ? isNotNull(pendingActions.binding)
                : sql`0`
            )
          )
        )
    )
    // A key its person freed for one more send (it didn't happen), held
    // since: spent as this decision says, for that same input only, so
    // the call made again is told so rather than asked again.
    .onConflictDoUpdate({
      target: [
        idempotentCalls.subjectType,
        idempotentCalls.subjectId,
        idempotentCalls.onBehalfOf,
        idempotentCalls.connectionId,
        idempotentCalls.action,
        idempotentCalls.idempotencyKey,
      ],
      set: {
        state: sql`excluded.state`,
        output: sql`excluded.output`,
        claimedAt: sql`excluded.claimed_at`,
        input: null,
        origin: null,
      },
      setWhere: sql`${idempotentCalls.state} = 'freed' AND ${idempotentCalls.inputHash} = excluded.input_hash`,
    });
  const remove = db.delete(pendingActions).where(still);
  return spentAs === undefined ? [remove] : [spend, remove];
};
