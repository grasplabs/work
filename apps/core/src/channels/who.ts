import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { activeMember } from "../auth/auth.ts";
import { providerIds } from "../auth/config.ts";
import { accounts } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { personOnChannel } from "./accounts.ts";

// Who is writing on a chat platform, by the id the platform verified and
// nothing else: never a display name, an email or a phone number, which
// anyone can set to someone else's (threat model R15).
//
// - Teams: by the sender's Entra object id (`from.aadObjectId`), which the
//   person's own Microsoft sign-in to Grasp kept in `accounts.oid`. Only
//   the client's own Entra sign-in counts: a Grasp staff account (another
//   tenant's) is never matched.
// - Every other platform: by the account the person linked to Grasp
//   (channels/accounts.ts).

/** Who wrote a message, as far as Grasp knows them. */
export type Writer =
  /** An active member of the organization: their user id. */
  | { kind: "member"; userId: string }
  /** Someone Grasp knew who is no longer a member. */
  | { kind: "removed" }
  /** Someone Grasp doesn't know on this platform. */
  | { kind: "unknown" };

/** The Teams sender whose Entra object id is `oid`. */
const teamsWriter = async (env: Env, oid: string): Promise<Writer> => {
  const [row] = await drizzle(env.DB)
    .select({
      userId: accounts.userId,
      active: sql<number>`${activeMember(accounts.userId)}`,
    })
    .from(accounts)
    .where(
      and(eq(accounts.oid, oid), eq(accounts.providerId, providerIds.entra))
    )
    .orderBy(sql`${activeMember(accounts.userId)} DESC`)
    .limit(1);
  if (row === undefined) {
    return { kind: "unknown" };
  }
  return row.active === 1
    ? { kind: "member", userId: row.userId }
    : { kind: "removed" };
};

/**
 * Who `senderId` is on `platform`: on Teams the sender's Entra object id,
 * elsewhere the platform's own verified sender id.
 */
export const writerOf = async (
  env: Env,
  platform: string,
  senderId: string
): Promise<Writer> => {
  if (platform === "teams") {
    return await teamsWriter(env, senderId);
  }
  const userId = await personOnChannel(env, platform, senderId);
  return userId === null ? { kind: "unknown" } : { kind: "member", userId };
};

/**
 * The organization's active members among the Teams users whose Entra
 * object ids are `oids`, by object id: their user ids. Anyone else (no
 * longer a member, or unknown to Grasp) isn't in it.
 */
export const teamsMembers = async (
  env: Env,
  oids: readonly string[]
): Promise<Map<string, string>> => {
  if (oids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ oid: accounts.oid, userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        inList(accounts.oid, oids),
        eq(accounts.providerId, providerIds.entra),
        activeMember(accounts.userId)
      )
    );
  return new Map(
    rows.flatMap(({ oid, userId }) => (oid === null ? [] : [[oid, userId]]))
  );
};
