import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { teamsOf } from "./auth/identity.ts";
import { audiencesRead } from "./connection-audiences.ts";
import { connectionOwnersOf } from "./connections.ts";
import { readsOnly } from "./tool-classes.ts";

// What every agent a person asks in their own chat reads with no request
// and no grant (GRA-2203, Nick: "connections are part of the brain"): the
// person's own connections (their mailbox, their drive), and a shared
// connection whose audience holds them now (GRA-2219: "thats perfect, as
// long as it audited"). The plans and the threat models are on the
// issues. In order, what holds:
//
// - Only in a turn whose answer reaches its person alone: their own chat
//   or direct message, a turn they started (`AgentScope.ownChat`, the
//   turn's `personal`). A chat others share, a turn nobody started, an App
//   and a workflow keep their grants.
// - Only a connection that is active and the person's own, or shared with
//   an audience that holds them now: everyone, or a team they are in, as
//   an admin chose it for what is kept of it in the Brain
//   (connection-audiences.ts; none while it is erased or closed). Only a
//   tool whose class is a read (`readsOnly`): one nobody classed is no
//   read. Connect refuses anyone else's personal connection itself
//   (`connect.not_owner`).
// - Signed read-only (bindings.ts `signedUngrantedRead`): connect refuses
//   any side effect of it, whatever a tool's class says. Every class the
//   company turned off for the person, and every app the agent lacks,
//   still refuses it (`requireToolClassOn`). A write needs a grant, as
//   ever, and is held for the person.
// - Everything after the call is a grant's: the chat marked before an
//   answer of the person's own is handed over (private-reads.ts), the
//   read pinned with the run (`ungrantedRead`), kept in the Brain
//   (connection-capture.ts), and audited by connect.

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
 * Whether `owner` is a connection `personId` reads with no grant, as far
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
 * The connection `connectionId`, active, that the person `onBehalfOf`
 * reads with no grant (`readsWithoutGrant`), when the tool `action` of it
 * only reads. Refused as a connection there isn't otherwise
 * (`connect.connection_not_found`), saying nothing of one they may not
 * read.
 */
export const ungrantedReadConnection = async (
  env: Env,
  authority: Authority,
  connectionId: string,
  action: string
): Promise<ConnectionOwner> => {
  const [[owner], shared] = await Promise.all([
    connectionOwnersOf(env, [connectionId]),
    sharedFor(env, authority.onBehalfOf),
  ]);
  if (
    authority.subject.type !== "agent" ||
    owner === undefined ||
    !readsWithoutGrant(owner, authority.onBehalfOf, shared) ||
    owner.status !== "active" ||
    !readsOnly(owner, action)
  ) {
    throw connectErrors.create("connect.connection_not_found");
  }
  return owner;
};

// The prefix as #2501 first wrote it: a pin already kept means the same.
const ungrantedReadPrefix = "own-connection-read:";

/**
 * The source a read of connection `connectionId` with no grant is recorded
 * as: readable while the person still reads it so, and it is not
 * disconnected (`ungrantedReadOf`, history-access.ts).
 */
export const ungrantedRead = (connectionId: string): string =>
  `${ungrantedReadPrefix}${connectionId}`;

/** The connection a source recorded by `ungrantedRead` names, if it is one. */
export const ungrantedReadOf = (source: string): string | undefined =>
  source.startsWith(ungrantedReadPrefix)
    ? source.slice(ungrantedReadPrefix.length)
    : undefined;
