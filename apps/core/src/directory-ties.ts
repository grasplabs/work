import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import type { DirectoryProvider } from "@grasp-os/shared/directory";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { directoryProviderId, providerIds } from "./auth/config.ts";
import { memberNotRemoved } from "./auth/membership-sql.ts";
import { accounts, directoryPeople } from "./db/core/schema.ts";
import { entraSubject } from "./erased-people.ts";

// Who of the directory's people is which member (GRA-2056): the one rule
// that ties them, by the provider's ID and the tenant a verified sign-in
// named, never an address; used by the daily read (directory-people.ts)
// for every row, by sign-in (auth.ts) for the person signing in, and by
// erasure (person-erasure.ts) to find a person's rows. Apart from the
// read, which reaches connect, so sign-in imports none of it.

/**
 * A directory the daily read keeps the people of, and how a sign-in names
 * one of them: a second provider is one more of these.
 */
export interface DirectoryKind {
  provider: DirectoryProvider;
  /** The sign-in provider (auth/config.ts) whose accounts name its people. */
  signInProvider: string;
  /**
   * The provider of the accounts the directory itself made its people
   * members under, before they signed in (auth/directory-members.ts): the
   * same ID, and the tenant it was read in, until their first sign-in
   * takes the member over (auth.ts `adoptDirectoryMember`).
   */
  madeProvider: string;
  /**
   * The column of an account holding the provider's ID of its person, as
   * the provider gave it: a sign-in's, which ties them, or another of
   * theirs that carries the same ID (one the directory made from a Teams
   * message), which only their erasure reads. Compared lower case, as the
   * directory's rows keep IDs, by the index on it with `lower()`
   * (`accounts_provider_oid_lower_idx`): no other comparison of it changes.
   */
  signedInAs: SQLiteColumn;
  /** The subject erasure keeps of a person with provider ID `id` (erased-people.ts). */
  subjectOf: (id: string) => string;
  /** The tenant the deployment signs people in from, which alone its directory may be. */
  tenantIn: (config: SignInConfig) => string | undefined;
}

/**
 * Microsoft Entra: its object ID, which Graph answers as the user's `id`
 * and Entra's ID tokens as `oid`, in the tenant (`tid`).
 */
const entra: DirectoryKind = {
  provider: "microsoft-directory",
  signInProvider: providerIds.entra,
  madeProvider: directoryProviderId,
  signedInAs: accounts.oid,
  subjectOf: entraSubject,
  tenantIn: (config) => config.entra?.tenantId,
};

/** The directories read daily. Google's waits on proof that its sign-in `sub` is its directory's user ID. */
export const directoryKinds: readonly DirectoryKind[] = [entra];

/**
 * That an account is one naming a person of `kind`, as SQL: their sign-in,
 * or the account the directory made them a member under before they
 * signed in. Either carries the provider's ID, sought by
 * `accounts_provider_oid_lower_idx`.
 */
export const namingAccount = (kind: DirectoryKind): SQL =>
  inArray(accounts.providerId, [kind.signInProvider, kind.madeProvider]);

/**
 * The member tied to the row being written (both sides compared through
 * `lower()`: the row's ID is lower case already, and so written, SQLite
 * seeks the account by `accounts_provider_oid_lower_idx` rather than
 * scanning the provider's accounts): the one whose account of `kind`
 * (`namingAccount`) names the row's ID in the row's tenant, while they are
 * a member. The tenant is the one a verified sign-in named, or the one the
 * directory read the person in as it made their account. One account per
 * sign-in subject, and none made by the directory where any account names
 * the ID already, so at most one member; the lowest user ID if ever two.
 */
const tiedMember = (kind: DirectoryKind): SQL => sql`(
  SELECT ${accounts.userId} FROM ${accounts}
  WHERE ${namingAccount(kind)}
    AND lower(${kind.signedInAs}) = lower(${directoryPeople.accountId})
    AND lower(${accounts.verifiedTenant}) = ${directoryPeople.tenant}
    AND ${memberNotRemoved(accounts.userId)}
  ORDER BY ${accounts.userId}
  LIMIT 1
)`;

/**
 * Ties the rows of `kind` that `scope` holds for to their member, as
 * `tiedMember` finds them now: the one rule, at the read for every row and
 * at sign-in for that person's.
 */
export const tieDirectoryPeople = (
  db: DrizzleD1Database,
  kind: DirectoryKind,
  scope: SQL
) =>
  db
    .update(directoryPeople)
    .set({ userId: tiedMember(kind) })
    .where(and(eq(directoryPeople.provider, kind.provider), scope));

/**
 * Ties the directory's rows of whoever `userId`'s sign-in accounts name,
 * as they sign in (auth.ts): the read's own rule, for their rows alone.
 */
export const tieSignedIn = async (env: Env, userId: string): Promise<void> => {
  const db = drizzle(env.DB);
  for (const kind of directoryKinds) {
    // oxlint-disable-next-line no-await-in-loop -- one provider at a time
    await tieDirectoryPeople(
      db,
      kind,
      sql`${directoryPeople.accountId} IN (
        SELECT lower(${kind.signedInAs}) FROM ${accounts}
        WHERE ${accounts.userId} = ${userId}
          AND ${accounts.providerId} = ${kind.signInProvider}
      )`
    );
  }
};

/**
 * Deletes the directory's rows of a person being erased (person-erasure.ts,
 * the identity area), in the batch that deletes their accounts, before it
 * does: the rows tied to `userId`, and those of every ID any account of
 * theirs carries, whichever provider's, tied or not (the tie lasts only
 * while they are a member, and is only ever a sign-in's; the directory
 * made Teams writers members under an account of its own). The read
 * writes none of them again: the keyed hash of each subject stays
 * (erased-people.ts).
 */
export const forgetDirectoryPeople = (db: DrizzleD1Database, userId: string) =>
  db.delete(directoryPeople).where(
    or(
      eq(directoryPeople.userId, userId),
      ...directoryKinds.map(
        (
          kind
        ) => sql`(${directoryPeople.provider} = ${kind.provider} AND ${directoryPeople.accountId} IN (
          SELECT lower(${kind.signedInAs}) FROM ${accounts}
          WHERE ${accounts.userId} = ${userId}
            AND ${kind.signedInAs} IS NOT NULL
        ))`
      )
    )
  );
