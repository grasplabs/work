import { maxChangeBytes } from "@grasp-os/connector-kit/manifest";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import type { ConnectCall } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Connection } from "./connections.ts";
import { callChanges } from "./db/schema.ts";
import { ownerErased } from "./erased-people.ts";
import type { McpToolResult } from "./mcp.ts";

// The old and new values of what a side effect changed (an Excel row's
// cells), kept for audit: the audit log holds identifiers only, never a
// call's input or output, so the values are kept here and the log holds
// their hash, in the call's own event. Only a native connector's are
// taken: its code is ours and reviewed, and says what it changed after
// reading it; whatever a Composio server says of itself is never kept as
// the record of a change.

const changeSchema = z.strictObject({ before: z.json(), after: z.json() });

/** What a write changed, as connect keeps it. */
export type CallChange = z.infer<typeof changeSchema>;

/**
 * What a native connector's result says it changed, if it says; a result
 * of any other server says nothing. One that doesn't read as a change, or
 * is past `maxChangeBytes`, can't be kept: an error, so the call's answer
 * isn't kept without it.
 */
export const changeOf = (
  connection: Pick<Connection, "serverKind">,
  result: Pick<McpToolResult, "change">
): CallChange | undefined => {
  if (connection.serverKind !== "native" || result.change === undefined) {
    return undefined;
  }
  const parsed = changeSchema.safeParse(result.change);
  if (
    !parsed.success ||
    new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
      maxChangeBytes
  ) {
    throw new Error("The connector's change isn't one connect can keep");
  }
  return parsed.data;
};

/**
 * Keeping `change`, the change a call made, if it made one: the row to
 * store (`writes`), in one batch with the call's answer and events, and
 * the hash its event carries.
 */
export const keptChange = async (
  env: Env,
  claims: Pick<CapabilityClaims, "jti"> & {
    authority: Pick<CapabilityClaims["authority"], "onBehalfOf">;
  },
  call: Pick<ConnectCall, "connectionId" | "action" | "resource">,
  change: CallChange | undefined
): Promise<{ hash?: string; writes: BatchItem<"sqlite">[] }> => {
  if (change === undefined) {
    return { writes: [] };
  }
  const text = JSON.stringify(change);
  const hash = await sha256Hex(text);
  return {
    hash,
    writes: [
      // Never for a connection whose owner's erasure began: a call still
      // under way as it did keeps nothing of theirs after it.
      drizzle(env.DB)
        .insert(callChanges)
        .select(
          sql`SELECT ${crypto.randomUUID()}, ${claims.jti}, ${call.connectionId},
            ${call.action}, ${call.resource ?? null},
            ${claims.authority.onBehalfOf}, ${text}, ${hash}, ${Date.now()}
            WHERE NOT ${ownerErased(call.connectionId)}`
        ),
    ],
  };
};
