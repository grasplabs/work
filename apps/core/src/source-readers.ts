import type { PersonalAccount } from "@grasp-os/shared/connect";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  directoryProviderId,
  providerIds,
  signInConfig,
} from "./auth/config.ts";
import { accounts, sourceReaderTokens } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

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
// matched by one. An account is compared in Unicode NFC and lowercase on
// both sides.
//
// The Brain never holds an account: core gives it a random token in its
// place (`source_reader_tokens`), one per account, minted the first time a
// list names it, whether or not anyone here holds it yet, so a colleague
// who signs in later reads what was shared with them before. Erasing a
// person deletes their accounts' tokens with their accounts
// (person-erasure.ts `identity`): every list made before names a token
// nobody holds again, and a later list naming the same address mints a new
// one, which only whoever then proves that address holds. A token of an
// account nobody here ever holds (an outsider's) stays: telling whether a
// stored list still names it would take a read of the Brain's sets.
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

/** An account someone proved is theirs, or a list names: the system, its tenant and what lists name it by. */
interface Account {
  provider: string;
  tenant: string;
  account: string;
}

/** `account` as `source_reader_tokens` keys it: its parts compared, joined by ":". */
const keyOf = ({ provider, tenant, account }: Account): string =>
  `${provider}:${comparable(tenant)}:${comparable(account)}`;

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
 * one batch however long the list.
 */
export const readerPrincipalsOf = async (
  db: DrizzleD1Database,
  readers: readonly SourceReader[]
): Promise<string[]> => {
  const keys = [
    ...new Set(
      readers.flatMap((reader) =>
        reader.kind === "account" ? [keyOf(reader)] : []
      )
    ),
  ];
  const plain = readers.flatMap((reader) => plainPrincipalOf(reader) ?? []);
  if (keys.length === 0) {
    return [...new Set(plain)];
  }
  const minted = JSON.stringify(keys.map((key) => [key, crypto.randomUUID()]));
  const [, tokens] = await db.batch([
    db
      .insert(sourceReaderTokens)
      .select(
        sql`SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ${Date.now()}
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
 * batch with their membership (brain-next.ts `memberGroupsOf`) and for
 * their erasure: the Microsoft and Google ones the sign-in made from a
 * verified ID token.
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

/**
 * Whether no part of `account` holds ":", which joins them, as no reader
 * list's does (`sourceReaderSchema`): one that does is no account any list
 * names.
 */
const whole = (account: Account): boolean =>
  [account.tenant, account.account].every((part) => !part.includes(":"));

/** Whether `address` is in one of `domains`, after its last `@`. */
const inDomains = (address: string, domains: readonly string[]): boolean => {
  const at = address.lastIndexOf("@");
  return at > 0 && domains.includes(comparable(address.slice(at + 1)));
};

/**
 * Every account a person proved is theirs, as lists name it: their
 * sign-in accounts (`signIns`), in the tenant the deployment's sign-in is
 * pinned to (auth/config.ts), and the suite accounts they connected as
 * their own (`connected`), each with whether it counts for reading now
 * (`reads`): a connection still connected, and a Google address in one of
 * the company's sign-in domains. Microsoft's by object ID, Google's by
 * verified address.
 */
const accountsOf = (
  env: Pick<Env, "SIGN_IN">,
  signIns: readonly SignIn[],
  connected: readonly PersonalAccount[]
): (Account & { reads: boolean })[] => {
  const config = signInConfig(env);
  if (config === undefined) {
    return [];
  }
  const google = (tenant: string, address: string | null, live: boolean) =>
    address === null
      ? []
      : [
          {
            provider: "google",
            tenant,
            account: address,
            reads: live && inDomains(address, config.domains),
          },
        ];
  const all: (Account & { reads: boolean })[] = [
    ...signIns.flatMap(({ providerId, oid, verifiedEmail }) => {
      // The object ID the directory made them under too (its accounts are
      // read only for their erasure): proved by no sign-in of theirs, so
      // it reads nothing.
      const directory = providerId === directoryProviderId;
      if (
        (providerId === providerIds.entra || directory) &&
        config.entra &&
        oid !== null
      ) {
        return [
          {
            provider: "microsoft",
            tenant: config.entra.tenantId,
            account: oid,
            reads: !directory,
          },
        ];
      }
      return providerId === providerIds.google && config.google
        ? google(config.google.hostedDomain, verifiedEmail, true)
        : [];
    }),
    ...connected.flatMap(
      ({ provider, tenant, accountId, verifiedEmail, connected: live }) => {
        if (provider === "microsoft") {
          return [{ provider, tenant, account: accountId, reads: live }];
        }
        return provider === "google" ? google(tenant, verifiedEmail, live) : [];
      }
    ),
  ];
  return all.filter(whole);
};

/**
 * The Brain's groups a person holds by the accounts they proved are
 * theirs (`signIns`, `connected`) and count for reading now: each
 * account's token, in one indexed read, and its tenant's name. An account
 * no list ever named has no token, and holds nothing.
 */
export const heldPrincipalsOf = async (
  env: Pick<Env, "SIGN_IN">,
  db: DrizzleD1Database,
  signIns: readonly SignIn[],
  connected: readonly PersonalAccount[]
): Promise<string[]> => {
  const reading = accountsOf(env, signIns, connected).filter(
    ({ reads }) => reads
  );
  if (reading.length === 0) {
    return [];
  }
  const tokens = await db
    .select({ token: sourceReaderTokens.token })
    .from(sourceReaderTokens)
    .where(inList(sourceReaderTokens.key, reading.map(keyOf)));
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
 * Deletes the tokens of every account the person proved is theirs
 * (`signIns`, `connected`, disconnected ones and addresses outside the
 * company's domains too), for their erasure, in the batch that deletes
 * their accounts (person-erasure.ts `identity`): every list naming them
 * names a token nobody holds from then on.
 */
export const forgetTokens = (
  env: Pick<Env, "SIGN_IN">,
  db: DrizzleD1Database,
  signIns: readonly SignIn[],
  connected: readonly PersonalAccount[]
) =>
  db
    .delete(sourceReaderTokens)
    .where(
      inList(
        sourceReaderTokens.key,
        accountsOf(env, signIns, connected).map(keyOf)
      )
    );
