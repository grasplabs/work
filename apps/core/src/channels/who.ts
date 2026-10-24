import type { DirectoryPerson } from "@grasp-os/shared/directory";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { activeMember } from "../auth/auth.ts";
import {
  directoryProviderId,
  providerIds,
  signInConfig,
} from "../auth/config.ts";
import { accounts } from "../db/core/schema.ts";
import { entraDirectoryOf } from "../onboarding/directory.ts";
import { mayComeIn } from "../onboarding/gate.ts";
import { personOnChannel } from "./accounts.ts";

// Who is writing on a chat platform, by the id the platform verified and
// nothing else: never a display name, an email or a phone number, which
// anyone can set to someone else's (threat model R15).
//
// - Teams: by the sender's Entra object id (`from.aadObjectId`), which the
//   person's own Microsoft sign-in to Grasp kept in `accounts.oid`, or the
//   organization's directory did before they ever signed in
//   (auth/directory-members.ts). Only the client's own Entra sign-in and
//   directory count: a Grasp staff account (another tenant's) is never
//   matched.
// - Every other platform: by the account the person linked to Grasp
//   (channels/accounts.ts).

/** Who wrote a message, as far as Grasp knows them. */
export type Writer =
  /**
   * An active member of the organization: their user id, and whether only
   * the directory knows them, as they never signed in.
   */
  | { kind: "member"; userId: string; fromDirectory: boolean }
  /** Someone Grasp knew who is no longer a member. */
  | { kind: "removed" }
  /** Someone Grasp doesn't know on this platform. */
  | { kind: "unknown" };

/** The Teams sender whose Entra object id is `oid`. */
const teamsWriter = async (env: Env, oid: string): Promise<Writer> => {
  const signedIn = sql`${accounts.providerId} = ${providerIds.entra}`;
  const [row] = await drizzle(env.DB)
    .select({
      userId: accounts.userId,
      active: sql<number>`${activeMember(accounts.userId)}`,
      signedIn: sql<number>`${signedIn}`,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.oid, oid),
        inArray(accounts.providerId, [providerIds.entra, directoryProviderId])
      )
    )
    .orderBy(sql`${activeMember(accounts.userId)} DESC`, sql`${signedIn} DESC`)
    .limit(1);
  if (row === undefined) {
    return { kind: "unknown" };
  }
  return row.active === 1
    ? { kind: "member", userId: row.userId, fromDirectory: row.signedIn !== 1 }
    : { kind: "removed" };
};

/**
 * The person the organization's Microsoft directory holds under the Entra
 * object id `oid`: none when it holds nobody by it, or only a guest or a
 * disabled account; when no directory of the client's own tenant is
 * connected; or while the company is onboarding and lets only its admins
 * in. Undefined when the directory can't be read just now.
 */
export const inDirectory = async (
  env: Env,
  oid: string
): Promise<DirectoryPerson | null | undefined> => {
  const config = signInConfig(env);
  if (config === undefined || !(await mayComeIn(env, config))) {
    return null;
  }
  try {
    const connection = await entraDirectoryOf(env);
    if (connection === undefined) {
      return null;
    }
    const { tenant, person } = await env.CONNECT.lookUpInDirectory({
      connectionId: connection.id,
      id: oid,
    });
    return tenant.toLowerCase() === connection.tenant.toLowerCase()
      ? person
      : null;
  } catch (error) {
    log.warn("channel.directory_unread", errorFields(error));
    return undefined;
  }
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
  return userId === null
    ? { kind: "unknown" }
    : { kind: "member", userId, fromDirectory: false };
};
