import { toHex } from "@grasp-os/shared/encoding";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { erasedSubjects, personErasures } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";

// Who was erased (GRA-903, person-erasure.ts), by the email that was
// theirs: their address is gone from `users`, so this is what keeps them
// out when they sign in (auth.ts) or are invited (members.ts) again under
// it. Kept apart so sign-in reads it without the erasure itself.
//
// The hash is an HMAC under a key derived for this purpose alone from the
// deployment's auth secret (derived-keys.ts): per deployment, from its
// secrets, never in the repo, and no use for anything else. Each hash keeps
// the version of the key it was made with (`emailKeyVersion`).
//
// Rotating the auth secret changes the key, so no hash made before it
// matches any more: until a rotation re-keys them, which nothing does yet,
// every person erased before it can sign in or be invited again under the
// address that was theirs. A rotation must keep that in mind.
//
// The hash keeps out an address, not a person: one the company gives to
// someone else later stays out too, until an admin releases it
// (`releaseAddress`, members.ts), audited. Released, it lets in whoever
// signs in under it: the erased person too, if their IdP still has it.

// Their sign-in identities too, by the verified subject each IdP or
// chat platform names them with (`subjectsOf`): the email alone keeps out
// an address, and someone the directory made a member before they ever
// signed in had none of their own (a placeholder, directory-members.ts).
// Without these, their next Teams message, an unknown sender once their
// accounts went, would make them a member again from the directory, and so
// would their first Microsoft sign-in. Kept as keyed hashes under a key of
// their own, like the email's. Unlike an address, a subject is never given
// to someone else (an Entra object id names one account for good), so no
// admin releases one.

/** The version of the key emails are hashed with now. */
export const emailKeyVersion = 1;

/** What the key is for, by its version: none other derives it. */
const emailKeyPurpose = `person-erasure.email.v${emailKeyVersion}`;

/**
 * A keyed hash of `email`, lowercased, under the key of version
 * `emailKeyVersion`: what keeps an erased person out once their email is
 * gone, never the email itself.
 */
export const emailHashOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  email: string
): Promise<string> => {
  const key = await derivedHmacKey(env, emailKeyPurpose, ["sign"]);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(email.trim().toLowerCase())
  );
  return toHex(new Uint8Array(signed));
};

/** That the person who had the address hashed `hash` was erased, as SQL. */
export const erasedAddress = (hash: string) =>
  and(
    eq(personErasures.emailHash, hash),
    eq(personErasures.emailKeyVersion, emailKeyVersion)
  );

/** Whether the person who had `email` was erased, and it isn't released. */
export const isErasedEmail = async (
  env: Pick<Env, "DB" | "BETTER_AUTH_SECRET">,
  email: string
): Promise<boolean> => {
  const hash = await emailHashOf(env, email);
  const [row] = await drizzle(env.DB)
    .select({ userId: personErasures.userId })
    .from(personErasures)
    .where(erasedAddress(hash));
  return row !== undefined;
};

/** The version of the key sign-in subjects are hashed with now. */
export const subjectKeyVersion = 1;

/** What the subject key is for, by its version: none other derives it. */
const subjectKeyPurpose = `person-erasure.subject.v${subjectKeyVersion}`;

/** An account as erasure and sign-in read it: who the IdP says it is. */
export interface SignInAccount {
  readonly providerId: string;
  readonly accountId: string;
  /** The Entra object id a Microsoft sign-in's ID token named, if any. */
  readonly oid: string | null;
}

/** The subject that names an Entra account, however it came in. */
export const entraSubject = (oid: string): string =>
  `entra:${oid.toLowerCase()}`;

/**
 * Every subject that names whoever holds `account`: its provider's own
 * account id, and its Entra object id if it has one. The directory's
 * accounts are keyed by object id (directory-members.ts), so one from the
 * directory and one from a Microsoft sign-in name the same person by the
 * same `entraSubject`.
 */
export const subjectsOf = (
  account: SignInAccount,
  directoryProviderId: string
): string[] => {
  const subjects = [`${account.providerId}:${account.accountId}`];
  if (account.providerId === directoryProviderId) {
    subjects.push(entraSubject(account.accountId));
  }
  if (account.oid !== null) {
    subjects.push(entraSubject(account.oid));
  }
  return subjects;
};

/**
 * A keyed hash of `subject` under the key of version `subjectKeyVersion`:
 * what keeps an erased person's sign-in identities out once their
 * accounts are gone, never the subject itself.
 */
export const subjectHashOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  subject: string
): Promise<string> => {
  const key = await derivedHmacKey(env, subjectKeyPurpose, ["sign"]);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(subject)
  );
  return toHex(new Uint8Array(signed));
};

/** Whether any of `subjects` named someone who was erased. */
export const isErasedSubject = async (
  env: Pick<Env, "DB" | "BETTER_AUTH_SECRET">,
  subjects: readonly string[]
): Promise<boolean> => {
  if (subjects.length === 0) {
    return false;
  }
  const hashes = await Promise.all(
    subjects.map(async (subject) => await subjectHashOf(env, subject))
  );
  const [row] = await drizzle(env.DB)
    .select({ userId: erasedSubjects.userId })
    .from(erasedSubjects)
    .where(
      and(
        inArray(erasedSubjects.subjectHash, hashes),
        eq(erasedSubjects.keyVersion, subjectKeyVersion)
      )
    )
    .limit(1);
  return row !== undefined;
};
