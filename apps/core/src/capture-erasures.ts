import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { connectionOwnersMax } from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";

import { auditLog } from "./audit-log.ts";
import type { AuditLogEnv } from "./audit-log.ts";
import { uuidFromHash } from "./audit-outbox.ts";
import { eraseCaptures } from "./brain-next-origins.ts";
import { keepsReadsOf } from "./connection-capture-key.ts";

// A disconnected connection's captures (GRA-1827; the threat model and
// the decisions are on the issue). Connect records each disconnect that
// stopped a connection (`connection.disconnect`, outcome `ok`) in the same
// write as the stop. Core drains that event from connect's outbox, and
// before the event leaves it (audit-outbox.ts, `required`) every capture
// the Brain kept through that connection is erased from its person's own
// store. So the erasure follows every disconnect that stopped a
// connection: the person's own, an admin's removal of them, their
// erasure. A drain that couldn't erase keeps the event, and the next
// drain erases again; core's disconnect also erases straight away
// (connections.ts), and this erase is then a repeat, which changes
// nothing and answers what the first one erased.

/** A disconnect whose connection's captures were erased, and how many. */
export interface CapturesErased {
  /** Connect's `connection.disconnect` event that asked for it. */
  disconnect: AuditEvent;
  connectionId: string;
  /** How many sources the erasure covered. */
  sources: number;
}

/**
 * Who owns each of the connections `ids`, from connect, a page at a time;
 * one connect doesn't know is left out.
 */
const ownersOf = async (
  env: Pick<Env, "CONNECT">,
  ids: readonly string[]
): Promise<ConnectionOwner[]> => {
  const pages: string[][] = [];
  for (let start = 0; start < ids.length; start += connectionOwnersMax) {
    pages.push(ids.slice(start, start + connectionOwnersMax));
  }
  const owners = await Promise.all(
    pages.map(async (page) => await env.CONNECT.connectionOwners(page))
  );
  return owners.flat();
};

/** The connection a disconnect that stopped it names, if `event` is one. */
const stoppedConnectionOf = (event: AuditEvent): string | undefined =>
  event.action === "connection.disconnect" &&
  event.detail.outcome === "ok" &&
  event.target?.type === "connection"
    ? event.target.id
    : undefined;

/**
 * Erases the captures of each connection a disconnect among `events`
 * stopped, where the Brain keeps reads through it for its owner
 * (`keepsReadsOf`): every other connection has none to erase. Each on its
 * own: what one erased is answered, and how many failed. One the Brain
 * refuses as invalid (an id it could never have kept a capture under)
 * holds none: it is logged and not tried again, so it never holds the
 * drain up for good. Throws only when connect couldn't say whose the
 * connections are.
 */
const eraseEach = async (
  env: Pick<Env, "CONNECT" | "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  events: readonly AuditEvent[]
): Promise<{ erased: CapturesErased[]; failed: number }> => {
  const stopped = events.flatMap((disconnect) => {
    const connectionId = stoppedConnectionOf(disconnect);
    return connectionId === undefined ? [] : [{ disconnect, connectionId }];
  });
  if (stopped.length === 0) {
    return { erased: [], failed: 0 };
  }
  const listed = await ownersOf(env, [
    ...new Set(stopped.map(({ connectionId }) => connectionId)),
  ]);
  const owners = new Map(listed.map((owner) => [owner.id, owner]));
  const due = stopped.flatMap(({ disconnect, connectionId }) => {
    const owner = owners.get(connectionId);
    const personId = owner?.ownerUserId;
    return owner === undefined ||
      personId === null ||
      personId === undefined ||
      !keepsReadsOf(owner, personId)
      ? []
      : [{ disconnect, connectionId, personId }];
  });
  const settled = await Promise.allSettled(
    due.map(
      async ({
        disconnect,
        connectionId,
        personId,
      }): Promise<CapturesErased | undefined> => {
        try {
          return {
            disconnect,
            connectionId,
            sources: await eraseCaptures(env, personId, connectionId),
          };
        } catch (error) {
          if (brainSourceErrors.codeOf(error) !== "brain.request_invalid") {
            throw error;
          }
          log.error("brain.capture.erase_refused", { connectionId });
          return undefined;
        }
      }
    )
  );
  return {
    erased: settled.flatMap((each) =>
      each.status === "fulfilled" && each.value !== undefined
        ? [each.value]
        : []
    ),
    failed: settled.filter(({ status }) => status === "rejected").length,
  };
};

/**
 * The event that records the erasure of a disconnected connection's
 * captures: by whoever disconnected it, at the disconnect's moment, with
 * an ID made from the disconnect's, so a drain that erases again (a repeat
 * answers the same count) makes the same event, which the log keeps once.
 */
const erasedEvent = async ({
  disconnect,
  connectionId,
  sources,
}: CapturesErased): Promise<AuditEvent> => ({
  ...createAuditEvent(
    {
      actor: disconnect.actor,
      action: "brain.capture.erased",
      target: { type: "connection", id: connectionId },
      detail: { sources },
    },
    "core"
  ),
  id: uuidFromHash(
    await sha256Hex(JSON.stringify(["brain.capture.erased", disconnect.id]))
  ),
  at: disconnect.at,
});

/**
 * What must be done with connect's events before they leave its outbox
 * (audit-outbox.ts `required`, given by audit-drains.ts): the captures of
 * every connection a disconnect among them stopped erased, and each
 * erasure recorded (`brain.capture.erased`, ids and how many). Throws
 * once, with how many could not be erased, after the rest were recorded:
 * the drain then keeps the batch in the outbox, and the next erases again.
 */
export const eraseCapturesOfDisconnects = async (
  env: AuditLogEnv &
    Pick<Env, "CONNECT" | "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  events: readonly AuditEvent[]
): Promise<void> => {
  const { erased, failed } = await eraseEach(env, events);
  if (erased.length > 0) {
    const result = await auditLog(env).append(
      await Promise.all(erased.map(erasedEvent))
    );
    if (result.conflicts > 0) {
      log.error("brain.capture.erased_conflict", {
        conflicts: result.conflicts,
      });
    }
  }
  if (failed > 0) {
    // One error a drain, naming no store: the drain logs it as failed.
    throw new Error(
      `The captures of ${failed} disconnected connections are not erased yet`
    );
  }
};
