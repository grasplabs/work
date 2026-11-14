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
import type { Held } from "./audit-outbox.ts";
import { eraseCaptures } from "./brain-next-origins.ts";
import { mayHoldCapturesOf } from "./connection-capture-key.ts";

// A disconnected connection's captures (GRA-1827; the threat model and
// the decisions are on the issue). Connect records each disconnect that
// stopped a connection (`connection.disconnect`, outcome `ok`) in the same
// write as the stop. Core drains that event from connect's outbox, and
// before the event leaves it (audit-outbox.ts, `required`) every capture
// the Brain kept through that connection is erased from its person's own
// store. So the erasure follows every disconnect that stopped a
// connection: the person's own, an admin's removal of them, their
// erasure. Core's disconnect also erases straight away (connections.ts);
// this erase is then a repeat, which changes nothing and answers what the
// first one erased.
//
// A disconnect whose erasure fails is held: it alone stays in connect's
// outbox, to be erased by the next drain, while every other event settles
// and the drain goes on with the rows after it (audit-outbox.ts). So a
// person's store that stays out of reach keeps their own erasure waiting,
// not anyone else's events, up to the drain's own limit (`drain` there). One the Brain could never have kept
// a capture under (an id it refuses) has none to erase: it settles, and
// is logged once.

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

/** Why a disconnect holds no capture to erase, if it can't. */
const unkeyable = (connectionId: string): boolean =>
  connectionId === "" || connectionId.includes("/");

/**
 * Erases the captures of each connection a disconnect among `events`
 * stopped, when it is its owner's own native connection
 * (`mayHoldCapturesOf`): no other connection holds any. Each on its own:
 * what each erased is answered, and the disconnects that failed, which
 * the caller holds. One the Brain could never have kept a capture under
 * (an id with "/", or one it refuses as invalid) holds none: it is
 * logged and passed, so it never holds the drain up. Throws only when
 * connect couldn't say whose the connections are.
 */
const eraseEach = async (
  env: Pick<Env, "CONNECT" | "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  events: readonly AuditEvent[]
): Promise<{ erased: CapturesErased[]; failed: Held }> => {
  const stopped = events.flatMap((disconnect) => {
    const connectionId = stoppedConnectionOf(disconnect);
    return connectionId === undefined ? [] : [{ disconnect, connectionId }];
  });
  if (stopped.length === 0) {
    return { erased: [], failed: { ids: [], errors: [] } };
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
      !mayHoldCapturesOf(owner, personId)
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
        if (unkeyable(connectionId)) {
          log.error("brain.capture.erase_refused", { connectionId });
          return undefined;
        }
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
    failed: {
      ids: due.flatMap(({ disconnect }, index) =>
        settled[index]?.status === "rejected" ? [disconnect.id] : []
      ),
      // Each error's name alone: its message could carry what it was about.
      errors: [
        ...new Set(
          settled.flatMap((each) =>
            each.status === "rejected"
              ? [each.reason instanceof Error ? each.reason.name : "unknown"]
              : []
          )
        ),
      ],
    },
  };
};

/**
 * The event that records the erasure of a disconnected connection's
 * captures: by whoever disconnected it, at the disconnect's moment, with
 * an ID made from the disconnect's, so a drain that erases again makes the
 * same event, which the log keeps once: a repeat answers the count the
 * erasure recorded. If the person's store changes between two erasures of
 * one disconnect, the second answers otherwise:
 * - their store erased whole between two drains: it answers none;
 * - their store restored from an older copy between two drains: its
 *   replay records what it hides then.
 * In both the log keeps the first event and records
 * `audit.conflicting_duplicate`, and the drain logs
 * `brain.capture.erased_conflict`, once: the disconnect settles with it.
 * - Erased by core's disconnect straight away (connections.ts), then their
 *   store erased whole before the first drain: the drain's erasure
 *   answers none, so no `brain.capture.erased` is written at all; their
 *   erasure's own event covers the store.
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
 * erasure that erased something recorded (`brain.capture.erased`, ids and
 * how many). A disconnect of a connection with nothing kept leaves
 * connect's own event alone. Answers the disconnects it could not erase
 * yet, which the drain holds for the next, with the names of the errors
 * that stopped them, which the drain logs once.
 */
export const eraseCapturesOfDisconnects = async (
  env: AuditLogEnv &
    Pick<Env, "CONNECT" | "BRAIN_STORE" | "DURABLE_OBJECT_JURISDICTION">,
  events: readonly AuditEvent[]
): Promise<Held> => {
  const { erased, failed } = await eraseEach(env, events);
  const recorded = erased.filter(({ sources }) => sources > 0);
  if (recorded.length > 0) {
    const result = await auditLog(env).append(
      await Promise.all(recorded.map(erasedEvent))
    );
    if (result.conflicts > 0) {
      log.error("brain.capture.erased_conflict", {
        conflicts: result.conflicts,
      });
    }
  }
  return failed;
};
