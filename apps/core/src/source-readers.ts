import type { PersonalAccount } from "@grasp-os/shared/connect";
import { toHex } from "@grasp-os/shared/encoding";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { providerIds, signInConfig } from "./auth/config.ts";
import { accounts, sourceReaderTokens } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { derivedHmacKey } from "./derived-keys.ts";

// Readers copied from where an item lives (GRA-1761; the threat model and
// the decisions are on the issue). A sync hands core each item's readers as
// the system lists them (`SourceReader`); core names each as a group of the
// Brain's, and puts a person in that group at every read only from
// accounts they proved are theirs: the ones they sign in with, and the
// suite accounts they connected as their own. A link reaches nobody, an
// outside account is held by nobody, and a group is held by nobody until
// core knows its members.
//
// Each system names a user reader by what its own ID tokens vouch for:
// Microsoft by the Entra object ID (Graph's `grantedToV2.user.id`, the
// token's `oid`); Google by address (Drive's permissions name users by
// address), counted only from a Google ID token that marked it verified,
// under the company's hosted domain and in one of its sign-in domains.
// Entra's address is never verified, so a Microsoft reader is never
// matched by one. An account is compared in Unicode NFC and lowercase.
// An object ID or an address names one account wherever it is listed, so
// the tenant a list names it in is not part of it.
//
// Neither the Brain nor core keeps an account as such: core gives the
// Brain a random token in its place (`source_reader_tokens`), one per
// account, under a keyed hash of the account (`keyOf`, a key derived from
// the deployment's auth secret for this alone). A token is minted the first
// time a list names its account, whether or not anyone here holds it yet,
// so a colleague who signs in later reads what was shared with them
// before. Whoever reads as themselves claims the tokens of the accounts
// they prove (`person`), the latest of them if two do; erasing a person
// deletes the tokens they claimed, and those of the accounts core keeps of
// them that nobody claimed (person-erasure.ts `identity`), never one a
// colleague claimed. Every list made before then names a token nobody
// holds again, and a later list naming the account mints a new one. An
// erased person's address can be proved by nobody until an admin releases
// it (erased-people.ts), and an object ID is never anyone else's.
//
// A reassigned address (a leaver's given to someone new, without an
// erasure) reads a list that still names it until the sync reads that list
// again, at most a day (decided for the sync run, GRA-1719); the leaver
// themselves is refused at once, as every read checks membership.
//
// A group's name is its kind, then its parts joined by ":", which no part
// holds (`sourceReaderSchema`), so two readers never share a name. No other
// group core names starts with these kinds (`team:`, `connection:`,
// `company`, `members`).

/** `part` as two names of it are compared: Unicode NFC, lowercase. */
const comparable = (part: string): string =>
  part.normalize("NFC").toLowerCase();

/** What the key of `source_reader_tokens` is derived for, and nothing else. */
const keyPurpose = "source-readers.account.v1";

/**
 * The account `account` at `provider` as `source_reader_tokens` keys it:
 * a keyed hash (HMAC-SHA256) of the two, compared, so the table holds no
 * account itself.
 */
const keyOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  provider: string,
  account: string
): Promise<string> => {
  const key = await derivedHmacKey(env, keyPurpose, ["sign"]);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${provider}:${comparable(account)}`)
  );
  return toHex(new Uint8Array(signed));
};

/** The keys of `wanted`, each once. */
const keysOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  wanted: readonly { provider: string; account: string }[]
): Promise<string[]> => [
  ...new Set(
    await Promise.all(
      wanted.map(
        async ({ provider, account }) => await keyOf(env, provider, account)
      )
    )
  ),
];

/** The Brain's group of everyone in `tenant` at `provider`. */
const tenantPrincipal = (provider: string, tenant: string): string =>
  `tenant:${provider}:${comparable(tenant)}`;

/** The Brain's group of an account by its token. */
const tokenPrincipal = (token: string): string => `account:${token}`;

/**
 * The Brain's group of `reader` where it names no account: a group's or
 * a tenant's; none for a link, which nobody holds, or for an account,
 * which is named by its token (`readerPrincipalsOf`).
 */
export const plainPrincipalOf = (reader: SourceReader): string | undefined => {
  switch (reader.kind) {
    case "group": {
      return `group:${reader.provider}:${comparable(reader.tenant)}:${reader.group}`;
    }
    case "tenant": {
      return tenantPrincipal(reader.provider, reader.tenant);
    }
    case "account":
    case "link": {
      return undefined;
    }
    default: {
      throw new Error("Unknown reader");
    }
  }
};

/**
 * The Brain's groups of `readers`, each once: each account's token,
 * minted now where it has none, and each group's and tenant's name. For
 * the producer of a list (brain-next.ts `addSource`, `changeSourceReaders`):
 * one batch however long the list, each statement binding the list as one
 * value, as D1 binds at most 100 a query ("Maximum bound parameters per
 * query", Cloudflare's D1 limits).
 */
export const readerPrincipalsOf = async (
  env: Pick<Env, "DB" | "BETTER_AUTH_SECRET">,
  readers: readonly SourceReader[]
): Promise<string[]> => {
  const keys = await keysOf(
    env,
    readers.flatMap((reader) => (reader.kind === "account" ? [reader] : []))
  );
  const plain = readers.flatMap((reader) => plainPrincipalOf(reader) ?? []);
  if (keys.length === 0) {
    return [...new Set(plain)];
  }
  const minted = JSON.stringify(keys.map((key) => [key, crypto.randomUUID()]));
  const db = drizzle(env.DB);
  const [, tokens] = await db.batch([
    db
      .insert(sourceReaderTokens)
      .select(
        sql`SELECT json_extract(value, '$[0]'), NULL, json_extract(value, '$[1]'), ${Date.now()}
          FROM json_each(${minted}) WHERE true`
      )
      .onConflictDoNothing(),
    db
      .select({ token: sourceReaderTokens.token })
      .from(sourceReaderTokens)
      .where(inList(sourceReaderTokens.key, keys)),
  ]);
  return [
    ...new Set([...tokens.map(({ token }) => tokenPrincipal(token)), ...plain]),
  ];
};

/**
 * The read of the accounts the person `userId` signs in with, for one
 * batch with their membership (brain-next.ts `memberGroupsOf`): the
 * Microsoft and Google ones the sign-in made from a verified ID token.
 */
export const signInAccountsRead = (db: DrizzleD1Database, userId: string) =>
  db
    .select({
      providerId: accounts.providerId,
      oid: accounts.oid,
      verifiedEmail: accounts.verifiedEmail,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.providerId, [providerIds.entra, providerIds.google])
      )
    );

/** A sign-in account as `signInAccountsRead` reads it. */
type SignIn = Awaited<ReturnType<typeof signInAccountsRead>>[number];

/** An account someone proved is theirs: the system, its tenant and what lists name it by. */
interface Account {
  provider: string;
  tenant: string;
  account: string;
}

/** Whether `address` is in one of `domains`, after its last `@`. */
const inDomains = (address: string, domains: readonly string[]): boolean => {
  const at = address.lastIndexOf("@");
  return at > 0 && domains.includes(comparable(address.slice(at + 1)));
};

/**
 * The accounts a person proved are theirs and that count for reading now:
 * their sign-in accounts (`signIns`), in the tenant the deployment's
 * sign-in is pinned to (auth/config.ts), and the suite accounts they
 * connected as their own (`connected`). Microsoft's by object ID; Google's
 * by verified address, only in one of the company's sign-in domains.
 */
const readingAccountsOf = (
  env: Pick<Env, "SIGN_IN">,
  signIns: readonly SignIn[],
  connected: readonly PersonalAccount[]
): Account[] => {
  const config = signInConfig(env);
  if (config === undefined) {
    return [];
  }
  const google = (tenant: string, address: string | null): Account[] =>
    address !== null && inDomains(address, config.domains)
      ? [{ provider: "google", tenant, account: address }]
      : [];
  return [
    ...signIns.flatMap(({ providerId, oid, verifiedEmail }) => {
      if (providerId === providerIds.entra && config.entra && oid !== null) {
        return [
          {
            provider: "microsoft",
            tenant: config.entra.tenantId,
            account: oid,
          },
        ];
      }
      return providerId === providerIds.google && config.google
        ? google(config.google.hostedDomain, verifiedEmail)
        : [];
    }),
    ...connected.flatMap(({ provider, tenant, accountId, verifiedEmail }) => {
      if (provider === "microsoft") {
        return [{ provider, tenant, account: accountId }];
      }
      return provider === "google" ? google(tenant, verifiedEmail) : [];
    }),
  ];
};

/**
 * The Brain's groups the member `userId` holds, reading as themselves, by
 * the accounts they proved are theirs (`signIns`, `connected`): each
 * account's token and its tenant's name. One batch: they claim the
 * tokens of those accounts (`person`, written only where it changes), and
 * their tokens are read. Nothing is minted: an account no list named has
 * no token, and holds nothing.
 */
export const heldPrincipalsOf = async (
  env: Pick<Env, "DB" | "SIGN_IN" | "BETTER_AUTH_SECRET">,
  userId: string,
  signIns: readonly SignIn[],
  connected: readonly PersonalAccount[]
): Promise<string[]> => {
  const reading = readingAccountsOf(env, signIns, connected);
  if (reading.length === 0) {
    return [];
  }
  const keys = await keysOf(env, reading);
  const db = drizzle(env.DB);
  const [, tokens] = await db.batch([
    db
      .update(sourceReaderTokens)
      .set({ person: userId })
      .where(
        and(
          inList(sourceReaderTokens.key, keys),
          or(
            isNull(sourceReaderTokens.person),
            ne(sourceReaderTokens.person, userId)
          )
        )
      ),
    db
      .select({ token: sourceReaderTokens.token })
      .from(sourceReaderTokens)
      .where(inList(sourceReaderTokens.key, keys)),
  ]);
  return [
    ...new Set([
      ...tokens.map(({ token }) => tokenPrincipal(token)),
      ...reading.map(({ provider, tenant }) =>
        tenantPrincipal(provider, tenant)
      ),
    ]),
  ];
};

/**
 * The keys of what core keeps of a person's accounts (`kept`: object IDs,
 * verified addresses and their address), for `forgetTokens`.
 */
export const keptAccountKeysOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  kept: {
    objectIds: readonly string[];
    addresses: readonly string[];
  }
): Promise<string[]> =>
  await keysOf(env, [
    ...kept.objectIds.map((account) => ({ provider: "microsoft", account })),
    ...kept.addresses.map((account) => ({ provider: "google", account })),
  ]);

/**
 * Deletes the tokens the person `userId` claimed, and those nobody claimed
 * of the accounts core keeps of them (`keptKeys`, `keptAccountKeysOf`), for
 * their erasure, in the batch that deletes their accounts
 * (person-erasure.ts `identity`): by what core stored, never by connect or
 * the sign-in config now. A token a colleague claimed stays theirs,
 * whatever address of the person's was stale.
 */
export const forgetTokens = (
  db: DrizzleD1Database,
  userId: string,
  keptKeys: readonly string[]
) =>
  db
    .delete(sourceReaderTokens)
    .where(
      or(
        eq(sourceReaderTokens.person, userId),
        and(
          isNull(sourceReaderTokens.person),
          inList(sourceReaderTokens.key, keptKeys)
        )
      )
    );
