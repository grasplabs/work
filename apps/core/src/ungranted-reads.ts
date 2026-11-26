import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { connectionReadOf } from "./agent-scope.ts";
import { teamsOf } from "./auth/identity.ts";
import { offeredToChat } from "./chat-connections.ts";
import type { OutsideRead } from "./code-mode.ts";
import { audiencesRead } from "./connection-audiences.ts";
import { connectionOwnersOf } from "./connections.ts";
import { readsOnly } from "./tool-classes.ts";

// What the chat's agent uses with no request and no grant (GRA-2203,
// GRA-2219, GRA-2322; the plans and the threat models are on the issues).
// Only a person's own chat has connections, in a turn they asked or one a
// schedule or an event woke: a chat others share gets no
// `env.connections` (agent-apis.ts `sharedApis`). In order, what holds:
//
// - A person's own personal connection (their mailbox, their drive): only
//   in a turn of their own chat they asked there and then
//   (`AgentScope.ownChat`, the caller's to hold), and only a tool whose
//   class is a read (`readsOnly`: one nobody classed is no read), signed
//   read-only, so connect refuses any side effect of it. A write needs
//   their own grant on a card in the chat, as ever. Connect refuses anyone
//   else's personal connection itself (`connect.not_owner`).
// - A shared connection: any of its tools, while its one audience
//   (connection-audiences.ts) holds the person: everyone, or a team they
//   are in. There is no grant per chat: the audience an admin chose is the
//   only thing that lets anyone use it. A write is held for the person to
//   confirm (connect holds every side effect of the chat's agent), and its
//   confirmation is signed again by this same rule (decided-calls.ts), so
//   narrowing the audience stops it. A grant to the agent on a shared
//   connection (an admin's for a company agent, or one given in a chat
//   before) holds only within the same audience
//   (`requireAudienceOfGrant`): it never widens it.
// - Either way, only a connection that is active; every class the company
//   turned off for the person, and every app the agent lacks, still
//   refuses it (`requireToolClassOn`); and everything after the call is a
//   grant's: the chat marked before an answer is handed over, unless the
//   connection is everyone's (private-reads.ts), the read pinned with the run
//   (`ungrantedRead`), kept in the Brain (connection-capture.ts), and
//   every call audited by connect with the agent and the person it acts
//   for.

/**
 * The shared connections whose audience holds `personId` now: everyone,
 * or a team they are in. One read of the audiences, as the Brain reads
 * them (`audiencesRead`: none of a connection being erased or closed), and
 * one of their teams.
 */
export const sharedFor = async (
  env: Env,
  personId: string
): Promise<ReadonlySet<string>> => {
  const [audiences, teams] = await Promise.all([
    audiencesRead(drizzle(env.DB)),
    teamsOf(env.DB, personId),
  ]);
  const theirs = new Set(teams.map(({ id }) => id));
  return new Set(
    audiences.flatMap(({ connectionId, teamId }) =>
      teamId === null || theirs.has(teamId) ? [connectionId] : []
    )
  );
};

/**
 * Whether `owner` is a connection `personId` uses with no grant, as far
 * as whose it is: their own, or shared with an audience in `shared`
 * (`sharedFor`). Its status is the caller's to judge.
 */
export const readsWithoutGrant = (
  owner: Pick<ConnectionOwner, "id" | "ownerUserId">,
  personId: string,
  shared: ReadonlySet<string>
): boolean =>
  owner.ownerUserId === personId ||
  (owner.ownerUserId === null && shared.has(owner.id));

/**
 * Refuses (`permission.denied`) a call of `action` the chat's agent makes
 * for the person `authority` acts for under a grant through the shared
 * connection `connectionId` unless its audience holds them (`sharedFor`):
 * no grant to the agent, everywhere or in a chat, widens the audience.
 */
export const requireAudienceOfGrant = async (
  env: Env,
  authority: Authority,
  connectionId: string,
  action: string
): Promise<void> => {
  const [[owner], shared] = await Promise.all([
    connectionOwnersOf(env, [connectionId]),
    sharedFor(env, authority.onBehalfOf),
  ]);
  // One connect doesn't know passes here: connect refuses it, as the
  // connection there isn't (`connect.connection_not_found`).
  if (owner?.ownerUserId === null && !shared.has(connectionId)) {
    throw permissionErrors.create("permission.denied", { action });
  }
};

/**
 * The connection `connectionId`, active, that the chat's agent may call
 * `action` of with no grant for the person `authority` acts for, and
 * whether that call may only read: their own personal one, when `action`
 * only reads; a shared one whose audience holds them (`sharedFor`), any
 * of its tools. Refused as one that needs connecting again
 * (`connect.connection_inactive`) when it waits for someone to sign in
 * again, and as a connection there isn't otherwise
 * (`connect.connection_not_found`), saying nothing of one they may not
 * use.
 */
export const ungrantedConnection = async (
  env: Env,
  authority: Authority,
  connectionId: string,
  action: string
): Promise<{ owner: ConnectionOwner; readOnly: boolean }> => {
  const [[owner], shared, offered] = await Promise.all([
    connectionOwnersOf(env, [connectionId]),
    sharedFor(env, authority.onBehalfOf),
    offeredToChat(env, { personId: authority.onBehalfOf }),
  ]);
  // Only one `list()` names: never an outside API or a connection whose
  // entry is hidden, though its ID is known, also as a held write is
  // confirmed.
  if (
    authority.subject.type !== "agent" ||
    owner === undefined ||
    !offered.some(({ id }) => id === connectionId) ||
    !readsWithoutGrant(owner, authority.onBehalfOf, shared)
  ) {
    throw connectErrors.create("connect.connection_not_found");
  }
  // One they use so that needs someone to sign in again (GRA-2227): said
  // as such, so the agent can tell them.
  if (owner.status === "needs_reauth") {
    throw connectErrors.create("connect.connection_inactive");
  }
  const personal = owner.ownerUserId !== null;
  if (owner.status !== "active" || (personal && !readsOnly(owner, action))) {
    throw connectErrors.create("connect.connection_not_found");
  }
  return { owner, readOnly: personal };
};

const ungrantedReadPrefix = "ungranted-read:";

/**
 * The source a call of connection `connectionId` with no grant is
 * recorded as: readable while the person still uses it so, and it is not
 * disconnected (`ungrantedReadOf`, history-access.ts).
 */
export const ungrantedRead = (connectionId: string): string =>
  `${ungrantedReadPrefix}${connectionId}`;

/** The connection a source recorded by `ungrantedRead` names, if it is one. */
export const ungrantedReadOf = (source: string): string | undefined =>
  source.startsWith(ungrantedReadPrefix)
    ? source.slice(ungrantedReadPrefix.length)
    : undefined;

/**
 * The outside system a run's source names, if it is a connection's read,
 * granted (`connectionRead`) or not (`ungrantedRead`): what a run's
 * result is marked with as text from outside (`describeRun`).
 */
export const outsideReadOf = (source: string): OutsideRead | undefined => {
  const granted = connectionReadOf(source);
  if (granted !== undefined) {
    return { connectionId: granted.connectionId, action: granted.action };
  }
  const connectionId = ungrantedReadOf(source);
  return connectionId === undefined
    ? undefined
    : { connectionId, action: null };
};
