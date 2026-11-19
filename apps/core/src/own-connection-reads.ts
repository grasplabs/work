import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";

import { connectionOwnersOf } from "./connections.ts";
import { readsOnly } from "./tool-classes.ts";

// A person's own connections (their mailbox, their drive), read by every
// agent they ask in their own chat with no request and no grant (GRA-2203,
// Nick: "connections are part of the brain"). The plan and the threat
// model are on the issue. In order, what holds:
//
// - Only in a turn whose answer reaches its person alone: their own chat
//   or direct message, a turn they started (`AgentScope.ownChat`, the
//   turn's `personal`). A chat others share, a turn nobody started, an App
//   and a workflow keep their grants.
// - Only their own connection, active, and only a tool whose class is a
//   read (`readsOnly`): one nobody classed is no read. Connect refuses
//   anyone else's personal connection itself (`connect.not_owner`).
// - Signed read-only (bindings.ts `signedOwnRead`): connect refuses any
//   side effect of it, whatever a tool's class says. Every class the
//   company turned off for the person, and every app the agent lacks,
//   still refuses it (`requireToolClassOn`). A write needs a grant, as
//   ever, and is held for the person.
// - Everything after the call is a grant's: the chat marked before the
//   answer is handed over (private-reads.ts), the read pinned with the run
//   (`ownConnectionRead`), kept in the person's own store
//   (connection-capture.ts), and audited by connect.

/**
 * The person `onBehalfOf`'s own connection `connectionId`, active, when
 * the tool `action` of it only reads: what a read with no grant may call.
 * Refused as a connection there isn't otherwise
 * (`connect.connection_not_found`), saying nothing of another person's.
 */
export const ownReadConnection = async (
  env: Env,
  authority: Authority,
  connectionId: string,
  action: string
): Promise<ConnectionOwner> => {
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  if (
    authority.subject.type !== "agent" ||
    owner === undefined ||
    owner.ownerUserId !== authority.onBehalfOf ||
    owner.status !== "active" ||
    !readsOnly(owner, action)
  ) {
    throw connectErrors.create("connect.connection_not_found");
  }
  return owner;
};

const ownConnectionReadPrefix = "own-connection-read:";

/**
 * The source a read of the person's own connection `connectionId` with no
 * grant is recorded as: readable while that connection is theirs and not
 * disconnected (`ownConnectionReadOf`, history-access.ts).
 */
export const ownConnectionRead = (connectionId: string): string =>
  `${ownConnectionReadPrefix}${connectionId}`;

/** The connection a source recorded by `ownConnectionRead` names, if it is one. */
export const ownConnectionReadOf = (source: string): string | undefined =>
  source.startsWith(ownConnectionReadPrefix)
    ? source.slice(ownConnectionReadPrefix.length)
    : undefined;
