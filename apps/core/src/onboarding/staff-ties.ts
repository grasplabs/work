import { directoryProviders } from "@grasp-os/shared/directory";
import type {
  DirectoryPerson,
  DirectorySuite,
} from "@grasp-os/shared/directory";
import { fromHex, toHex } from "@grasp-os/shared/encoding";
import type { DirectoryTie, RosterPerson } from "@grasp-os/shared/onboarding";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  accounts,
  directoryPeople,
  directoryReads,
  erasedSubjects,
  memberRemovals,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { directoryKinds, namingAccount } from "../directory-ties.ts";
import type { DirectoryKind } from "../directory-ties.ts";
import {
  normalizedEmail,
  subjectHashOf,
  subjectKeyVersion,
} from "../erased-people.ts";

// An entry of the onboarding's staff list tied to its person in the
// organization's directory (GRA-2249; the threat model is on the issue),
// by the provider's ID of them, never by an address or a name:
//
// - A forged or swapped ID: the browser makes the roster, so an ID on an
//   entry counts only with core's proof of it (`proofsOf`), made by core's
//   own read of the deployment's own directory (directory.ts), over the
//   suite, the ID, and the address and name it read them with. A save
//   keeps a tie only where the proof holds for that entry's own address
//   and name (`tiesOf`), and only once an ID; the store keeps the proof,
//   and nothing shows the ID or the proof again.
// - An erased person tied again: a save keeps no tie to a subject erasure
//   keeps out (erased-people.ts), and their erasure finds their entry by
//   it, then takes the tie off with the rest (store.ts `eraseEntries`).
// - Left: by what the daily read wrote and who was removed (`leftAmong`),
//   never by reading the directory again.

/** What the proof's key is for, by its version: none other derives it. */
const proofPurpose = "onboarding.directory-tie.v1";

/** What a proof is made over: the suite, the ID, the address and the name. */
const provenOf = (
  suite: DirectorySuite,
  id: string,
  person: { email: string; name: string }
): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([
      suite,
      id,
      normalizedEmail(person.email),
      person.name.trim(),
    ])
  );

/**
 * Core's proof of each person of `suite`'s directory it just read, by the
 * provider's ID of them: a keyed hash of the suite, the ID, their address
 * and their name, as the read gave them.
 */
export const proofsOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  suite: DirectorySuite,
  people: readonly DirectoryPerson[]
): Promise<Record<string, string>> => {
  const key = await derivedHmacKey(env, proofPurpose, ["sign"]);
  return Object.fromEntries(
    await Promise.all(
      people.map(async (person) => {
        const signed = await crypto.subtle.sign(
          "HMAC",
          key,
          provenOf(suite, person.id, person)
        );
        return [person.id, toHex(new Uint8Array(signed))] as const;
      })
    )
  );
};

/** Whether `tie`'s proof is core's, of `person` as the entry has them. */
const proves = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  tie: DirectoryTie,
  person: { email: string; name: string }
): Promise<boolean> => {
  const proof = fromHex(tie.proof);
  if (proof === undefined) {
    return false;
  }
  const key = await derivedHmacKey(env, proofPurpose, ["verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    proof,
    provenOf(tie.suite, tie.id, person)
  );
};

/** The directory a suite's ties are of. */
const kindOf = (suite: DirectorySuite): DirectoryKind => {
  const kind = directoryKinds.find(
    ({ provider }) => provider === directoryProviders[suite]
  );
  if (kind === undefined) {
    throw new Error(`No directory is read for ${suite}`);
  }
  return kind;
};

/** One person of a directory, as ties compare them: the ID lower case. */
export const tieKey = (tie: { suite: string; id: string }): string =>
  `${tie.suite}:${tie.id.toLowerCase()}`;

/** The subject erasure keeps of the person `tie` names (erased-people.ts). */
export const tieSubject = (tie: Pick<DirectoryTie, "suite" | "id">): string =>
  kindOf(tie.suite).subjectOf(tie.id);

/**
 * The ties a save of `people` keeps, by entry: each entry's own (`directory`,
 * from a read just made) or else the one the store keeps for it
 * (`stored`), where core's proof holds for the entry's address and name as
 * they are now, the first entry an ID is on, and nobody's erasure keeps
 * its subject out.
 */
export const tiesOf = async (
  env: Pick<Env, "DB" | "BETTER_AUTH_SECRET">,
  people: readonly Pick<RosterPerson, "id" | "email" | "name" | "directory">[],
  stored: ReadonlyMap<string, DirectoryTie>
): Promise<Map<string, DirectoryTie>> => {
  const proven = await Promise.all(
    people.map(async (person) => {
      const tie = person.directory ?? stored.get(person.id);
      return tie !== undefined && (await proves(env, tie, person))
        ? ([person.id, tie] as const)
        : undefined;
    })
  );
  const kept = new Map<string, DirectoryTie>();
  const taken = new Set<string>();
  for (const each of proven) {
    if (each !== undefined && !taken.has(tieKey(each[1]))) {
      taken.add(tieKey(each[1]));
      kept.set(each[0], each[1]);
    }
  }
  if (kept.size === 0) {
    return kept;
  }
  const bySubject = new Map(
    await Promise.all(
      [...kept].map(
        async ([person, tie]) =>
          [await subjectHashOf(env, tieSubject(tie)), person] as const
      )
    )
  );
  const erased = await drizzle(env.DB)
    .select({ hash: erasedSubjects.subjectHash })
    .from(erasedSubjects)
    .where(
      and(
        inList(erasedSubjects.subjectHash, [...bySubject.keys()]),
        eq(erasedSubjects.keyVersion, subjectKeyVersion)
      )
    );
  for (const { hash } of erased) {
    const person = bySubject.get(hash);
    if (person !== undefined) {
      kept.delete(person);
    }
  }
  return kept;
};

/**
 * Which of `ties` are of people gone from the organization, by `tieKey`:
 * those an account of a removed member names (members.ts), as
 * `tiedMember` names them, and, `byRead`, those the last applied daily
 * read of their directory holds no row of, or only a deleted account's
 * (directory-people.ts). A directory never read yet leaves nobody by the
 * read. Only the read itself asks `byRead`: a list saved since it ran may
 * name people it never saw.
 */
export const leftAmong = async (
  env: Pick<Env, "DB">,
  ties: readonly Pick<DirectoryTie, "suite" | "id">[],
  { byRead }: { byRead: boolean }
): Promise<Set<string>> => {
  const db = drizzle(env.DB);
  const left = new Set<string>();
  for (const suite of new Set(ties.map(({ suite: each }) => each))) {
    const kind = kindOf(suite);
    const ids = [
      ...new Set(
        ties
          .filter((tie) => tie.suite === suite)
          .map(({ id }) => id.toLowerCase())
      ),
    ];
    // oxlint-disable-next-line no-await-in-loop -- one directory at a time, each one snapshot
    const [[read], held, removed] = await db.batch([
      db
        .select({ readAt: directoryReads.readAt })
        .from(directoryReads)
        .where(
          and(
            eq(directoryReads.provider, kind.provider),
            isNotNull(directoryReads.readAt)
          )
        ),
      db
        .select({ id: directoryPeople.accountId })
        .from(directoryPeople)
        .innerJoin(
          directoryReads,
          and(
            eq(directoryReads.provider, directoryPeople.provider),
            eq(directoryReads.tenant, directoryPeople.tenant)
          )
        )
        .where(
          and(
            eq(directoryPeople.provider, kind.provider),
            eq(directoryPeople.deleted, false),
            inList(directoryPeople.accountId, ids)
          )
        ),
      db
        .select({ id: sql<string>`lower(${kind.signedInAs})` })
        .from(accounts)
        .where(
          and(
            namingAccount(kind),
            inList(sql`lower(${kind.signedInAs})`, ids),
            sql`EXISTS (SELECT 1 FROM ${memberRemovals} WHERE ${memberRemovals.userId} = ${accounts.userId})`
          )
        ),
    ]);
    const stillHeld = new Set(held.map(({ id }) => id));
    for (const id of ids) {
      if (byRead && read !== undefined && !stillHeld.has(id)) {
        left.add(tieKey({ suite, id }));
      }
    }
    for (const { id } of removed) {
      left.add(tieKey({ suite, id }));
    }
  }
  return left;
};
