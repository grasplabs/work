import type { PersonalAccount } from "@grasp-os/shared/connect";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { readerProofMaxAgeMs } from "@grasp-os/shared/source-readers";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { and, eq, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { providerIds, signInConfig } from "./auth/config.ts";
import {
  accounts,
  directoryGroupMembers,
  directoryPeople,
  personErasures,
  signInAddresses,
  sourceReaderGroups,
  sourceReaderPairs,
  sourceReaderTokens,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { entra } from "./directory-ties.ts";

// Readers copied from where an item lives (GRA-1761; the threat model and
// the decisions are on the issue). A sync hands core each item's readers as
// the system lists them (`SourceReader`); core names each as a group of the
// Brain's, and puts a person in that group at every read only from
// accounts they proved are theirs: the ones they sign in with, and the
// suite accounts they connected as their own. A link reaches nobody, an
// outside account is held by nobody, and a group only by the people whose
// own connection's last read of their groups, within a day, says they are
// in it.
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
// A group reader is held by a person through the suite account they
// connected as their own: connect reads, with that account's own token,
// the groups it is in, nested ones included, each time its access token is
// minted (connect's reader-groups.ts), and the groups count while that read
// is recent (`readerProofMaxAgeMs`, as every proof here). So a person who
// leaves a group stops reading by it at their connection's next token
// renewal, and a day after its last read whatever happens; nobody holds a
// group by a read that failed, and nothing of anyone else's groups is
// kept by that read (GRA-1719, "Group members").
//
// An Entra group is held too through the company's directory (GRA-2146):
// its read of the members of each group a list names
// (directory-reader-groups.ts, or the daily read's of a group mapped to a
// team) counts for the member the daily read tied to that object ID in
// the deployment's tenant, while their directory account is on, for a day
// from the read that listed them (`directory_group_members.read_at`). An
// admin consented to that read for the company, and the tie is by tenant
// and object ID, which Entra never gives anyone else; never by address.
//
// A group's name is its kind, then its parts joined by ":", which no part
// holds (`sourceReaderSchema`), so two readers never share a name. No other
// group core names starts with these kinds (`team:`, `connection:`,
// `company`, `members`).

/**
 * How many requests one run of the clock lets connect send reading
 * people's groups (connect's reader-groups.ts), counted all told: the
 * providers' pages, each connection's token and each write. The platform's
 * limit is Workers' subrequests per invocation: 10,000 by default on
 * Workers Paid, as Cloudflare's Workers limits page states it (checked 18
 * November 2026; D1 queries count too; on-prem workerd has none). The page
 * doesn't say whether what a service binding's callee sends counts against
 * its caller, so it is taken to: this is a share of the clock's own
 * invocation, a tenth, as the shared reads' erasures take
 * (shared-reads.ts `brainCallsPerTick`), which leaves 8,000 for the
 * clock's other tasks. A read longer than one run goes on in the next.
 */
export const readerGroupRequestsPerTick = 1000;

/**
 * How many D1 queries one run of connect's reads of people's groups may
 * make before it starts no other turn, counted all told (the due list,
 * each connection's token, each write). The platform's limit is D1's
 * queries per Worker invocation: 1,000 on Workers Paid, a batch counting
 * as one, as Cloudflare's D1 limits page states it (checked 18 November
 * 2026; past it a query fails). The run is connect's own invocation:
 * Cloudflare's service bindings page counts each call to a service binding
 * as a Worker invocation. Half of it: the other half is room for the one
 * turn under way when the share is reached, whose worst case is a token
 * renewal waiting out another's lease (connect's tokens.ts `refreshed`:
 * three queries every 100 ms for 15 s, about 460 with the turn's own).
 */
export const readerGroupQueriesPerTick = 500;

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

/** What the Brain's name of a provider's group starts with. */
const groupPrefix = "group:";

/** What the Brain's name of every Entra group starts with (`groupPrincipal`). */
export const entraGroupPrefix = `${groupPrefix}microsoft:`;

/**
 * The Brain's group of the group `group` in `tenant` at `provider`: a
 * group's ID compared as an account's is (Entra's object IDs and Google's
 * addresses are both case-blind).
 */
const groupPrincipal = (
  provider: string,
  tenant: string,
  group: string
): string =>
  `${groupPrefix}${provider}:${comparable(tenant)}:${comparable(group)}`;

/** What names an account's token as the Brain's group. */
const tokenPrefix = "account:";

/** The Brain's group of an account by its token. */
const tokenPrincipal = (token: string): string => `${tokenPrefix}${token}`;

/**
 * The Brain's group of a pair (GRA-2145): the group of a place picked on
 * a shared connection (`place`, brain-next.ts `placeGroupOf`) and one of
 * the readers an item synced from it names (`principal`, as
 * `readerPrincipalsOf` names it). An item of the place is kept for its
 * readers' pairs, and a person holds a pair only while they hold both
 * (`heldPrincipalsOf`): so a person reads it only where the source lets
 * them and the connection's audience holds them, with nothing new in the
 * Brain. The one name of a pair: a hash of the two, so it fits a
 * principal, under its own kind, which no other group of core's has.
 */
export const pairPrincipalOf = async (
  place: string,
  principal: string
): Promise<string> =>
  `pair:${await sha256Hex(JSON.stringify([place, principal]))}`;

/**
 * The Brain's group of `reader` where it names no account: a group's or
 * a tenant's; none for a link, which nobody holds, or for an account,
 * which is named by its token (`readerPrincipalsOf`).
 */
export const plainPrincipalOf = (reader: SourceReader): string | undefined => {
  switch (reader.kind) {
    case "group": {
      return groupPrincipal(reader.provider, reader.tenant, reader.group);
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
 * That the erasure of the person `userId` began (`person_erasures`, kept
 * from the request on), as SQL. Every write that names a person, or an
 * address or account of theirs, carries `NOT` it in its own statement:
 * computed from what was read before the erasure, it writes nothing once
 * the erasure began, and nothing is left after its `identity` area ran
 * (person-erasure.ts). Better Auth's own writes of `accounts` carry it in
 * a trigger (migration 0272).
 */
export const erasureBegan = (userId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${personErasures} WHERE ${personErasures.userId} = ${userId})`;

/**
 * Keeps the address a sign-in proved among every address the person
 * `userId` proved (`sign_in_addresses`), for their erasure alone
 * (`forgetTokens`): an address replaced at a later sign-in still names
 * reader tokens to forget. Nothing reads it for access. None once their
 * erasure began.
 */
export const keepSignInAddress = async (
  env: Pick<Env, "DB">,
  userId: string,
  address: string
): Promise<void> => {
  await drizzle(env.DB)
    .insert(signInAddresses)
    .select(
      sql`SELECT ${userId}, ${address.toLowerCase()} WHERE NOT ${erasureBegan(userId)}`
    )
    .onConflictDoNothing();
};

/**
 * The Brain's groups of `readers`, each once: each account's token,
 * minted now where it has none, and each group's and tenant's name. For
 * the producer of a list (brain-next.ts `addSource`, `changeSourceReaders`):
 * one batch however long the list, each statement binding the list as one
 * value, as D1 binds at most 100 a query ("Maximum bound parameters per
 * query", Cloudflare's D1 limits). For an item of the place `place`
 * (GRA-2145), the same batch keeps each reader's pair with it
 * (`source_reader_pairs`), before the list reaches the Brain: so a person
 * who holds both holds the pair from the next read on.
 */
export const readerPrincipalsOf = async (
  env: Pick<Env, "DB" | "BETTER_AUTH_SECRET">,
  readers: readonly SourceReader[],
  place?: string
): Promise<string[]> => {
  const keys = await keysOf(
    env,
    readers.flatMap((reader) => (reader.kind === "account" ? [reader] : []))
  );
  const plain = [
    ...new Set(readers.flatMap((reader) => plainPrincipalOf(reader) ?? [])),
  ];
  const db = drizzle(env.DB);
  // The groups the list names, kept before the list reaches the Brain: so
  // a person in them reads it from the next read on (`heldPrincipalsOf`).
  const named = plain.filter((principal) => principal.startsWith(groupPrefix));
  const nameGroups = db
    .insert(sourceReaderGroups)
    .select(
      sql`SELECT value, NULL FROM json_each(${JSON.stringify(named)}) WHERE true`
    )
    .onConflictDoNothing();
  // The place's pairs: of the readers named by a group or a tenant, and
  // of those named by an account's token, once minted (after it in the
  // batch).
  const plainPairs = (at: string) =>
    db
      .insert(sourceReaderPairs)
      .select(
        sql`SELECT ${at}, value FROM json_each(${JSON.stringify(plain)}) WHERE true`
      )
      .onConflictDoNothing();
  const tokenPairs = (at: string) =>
    db
      .insert(sourceReaderPairs)
      .select(
        sql`SELECT ${at}, ${tokenPrefix} || ${sourceReaderTokens.token} FROM ${sourceReaderTokens} WHERE ${inList(sourceReaderTokens.key, keys)}`
      )
      .onConflictDoNothing();
  if (keys.length === 0) {
    if (place !== undefined && plain.length > 0) {
      await db.batch([nameGroups, plainPairs(place)]);
    } else if (named.length > 0) {
      await nameGroups;
    }
    return plain;
  }
  const minted = JSON.stringify(keys.map((key) => [key, crypto.randomUUID()]));
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
    nameGroups,
    ...(place === undefined ? [] : [plainPairs(place), tokenPairs(place)]),
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
      verifiedEmailAt: accounts.verifiedEmailAt,
      verifiedTenant: accounts.verifiedTenant,
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

/**
 * Whether a proof of an address made at `at` (milliseconds) still counts:
 * within `readerProofMaxAgeMs`, the one bound every address proof has.
 */
const recent = (at: number | null): boolean =>
  at !== null && Date.now() - at < readerProofMaxAgeMs;

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
    // Each in the tenant its sign-in proved, only while the config names
    // it: a tenant the config moved to is proved by a sign-in through it.
    // A sign-in's address, as every proof of an address, only while
    // confirmed within a day (`recent`): one signed in once and then used
    // only through a chat app stops counting by it.
    ...signIns.flatMap(
      ({ providerId, oid, verifiedEmail, verifiedEmailAt, verifiedTenant }) => {
        const proved = (tenant: string): boolean =>
          verifiedTenant !== null &&
          comparable(verifiedTenant) === comparable(tenant);
        if (
          providerId === providerIds.entra &&
          config.entra &&
          oid !== null &&
          proved(config.entra.tenantId)
        ) {
          return [
            {
              provider: "microsoft",
              tenant: config.entra.tenantId,
              account: oid,
            },
          ];
        }
        return providerId === providerIds.google &&
          config.google &&
          proved(config.google.hostedDomain) &&
          recent(verifiedEmailAt?.getTime() ?? null)
          ? google(config.google.hostedDomain, verifiedEmail)
          : [];
      }
    ),
    // A connection's only while connected, and its address only while
    // the provider confirmed it within a day (`readerProofMaxAgeMs`): an
    // idle connection, or one needing reconnecting, stops counting by it.
    ...connected.flatMap(
      ({
        provider,
        tenant,
        accountId,
        verifiedEmail,
        verifiedEmailAt,
        connected: live,
      }) => {
        if (!live) {
          return [];
        }
        if (provider === "microsoft") {
          return [{ provider, tenant, account: accountId }];
        }
        return provider === "google" && recent(verifiedEmailAt)
          ? google(tenant, verifiedEmail)
          : [];
      }
    ),
  ];
};

/**
 * The read of the Entra groups the company's directory lists the member
 * `userId` in (`directory_group_members`), for one batch with their
 * membership (brain-next.ts `memberGroupsOf`): through the person the
 * daily read tied to them (`directory_people.user_id`), while their
 * directory account is on, each with when the read that listed them
 * started.
 */
export const directoryGroupsRead = (db: DrizzleD1Database, userId: string) =>
  db
    .select({
      tenant: directoryGroupMembers.tenant,
      group: directoryGroupMembers.groupId,
      readAt: directoryGroupMembers.readAt,
    })
    .from(directoryPeople)
    .innerJoin(
      directoryGroupMembers,
      and(
        eq(directoryGroupMembers.provider, directoryPeople.provider),
        eq(directoryGroupMembers.tenant, directoryPeople.tenant),
        eq(directoryGroupMembers.accountId, directoryPeople.accountId)
      )
    )
    .where(
      and(
        eq(directoryPeople.provider, entra.provider),
        eq(directoryPeople.userId, userId),
        // A deleted account is kept as one turned off.
        eq(directoryPeople.enabled, true)
      )
    );

/** A group the directory lists someone in, as `directoryGroupsRead` reads it. */
export type DirectoryGroupProof = Awaited<
  ReturnType<typeof directoryGroupsRead>
>[number];

/**
 * The Brain's groups of the groups a member provably holds, the one place
 * a group is proved for a person, whatever proves it. Each source of
 * proof is one field of `proofs`, and counts only while it is recent
 * (`readerProofMaxAgeMs`):
 *
 * - `connected`: the suite accounts they connected as their own: of each
 *   connection still connected, the groups its last whole read with
 *   their own token found (connect's reader-groups.ts), in its own tenant.
 * - `directory`: the Entra groups the company's directory read lists them
 *   in (`directoryGroupsRead`), in the tenant it read, each from the read
 *   that listed them.
 */
const provedGroupsOf = (proofs: {
  connected: readonly PersonalAccount[];
  directory: readonly DirectoryGroupProof[];
}): string[] => [
  ...proofs.connected.flatMap(
    ({ provider, tenant, groups, groupsReadAt, connected: live }) =>
      live && recent(groupsReadAt)
        ? groups.map((group) => groupPrincipal(provider, tenant, group))
        : []
  ),
  ...proofs.directory.flatMap(({ tenant, group, readAt }) =>
    recent(readAt.getTime()) ? [groupPrincipal("microsoft", tenant, group)] : []
  ),
];

/**
 * The read of which of `groups` a copied reader list ever named
 * (`source_reader_groups`), sorted, for the batch of a read: the only ones
 * a person needs to read as, however many groups they are in.
 */
const namedGroupsRead = (db: DrizzleD1Database, groups: readonly string[]) =>
  db
    .select({ name: sourceReaderGroups.name })
    .from(sourceReaderGroups)
    .where(inList(sourceReaderGroups.name, groups))
    .orderBy(sourceReaderGroups.name);

/** A pair as `source_reader_pairs` keeps it: a place's group and a reader. */
export interface Pair {
  place: string;
  principal: string;
}

/**
 * The read of the pairs (`source_reader_pairs`) of the places `places`
 * whose reader is one of `plain` (a tenant's or a group's name) or the
 * token of one of the accounts keyed `keys`, for the batch of a read: the
 * pairs a person holds, of those an item ever named. In the order of
 * `places`, then by reader, and at most `most` of them: the first ones,
 * so a person past the bound of groups leaves out the same ones each read
 * (brain-next.ts `readerGroupsOf`), and none past it is read. Each half
 * by the primary key, a place and a reader, the lists bound as one value
 * each.
 */
const pairsRead = (
  db: DrizzleD1Database,
  places: readonly string[],
  plain: readonly string[],
  keys: readonly string[],
  most: number
) => {
  const held = JSON.stringify(places);
  const columns = {
    place: sourceReaderPairs.place,
    principal: sourceReaderPairs.principal,
    // The place's position in `places`, which orders the union.
    at: sql<number>`(SELECT key FROM json_each(${held}) WHERE value = ${sourceReaderPairs.place})`.as(
      "at"
    ),
  };
  const inPlaces = sql`${sourceReaderPairs.place} IN (SELECT value FROM json_each(${held}))`;
  return db
    .select(columns)
    .from(sourceReaderPairs)
    .where(
      sql`${inPlaces} AND ${sourceReaderPairs.principal} IN (SELECT value FROM json_each(${JSON.stringify(plain)}))`
    )
    .union(
      db
        .select(columns)
        .from(sourceReaderPairs)
        .where(
          sql`${inPlaces} AND ${sourceReaderPairs.principal} IN (SELECT ${tokenPrefix} || ${sourceReaderTokens.token} FROM ${sourceReaderTokens} WHERE ${inList(sourceReaderTokens.key, keys)})`
        )
    )
    .orderBy(sql`at`, sql`principal`)
    .limit(Math.max(0, most));
};

/** `found` as pairs, without the position the read ordered them by. */
const pairsFrom = (found: readonly (Pair & { at: number })[]): Pair[] =>
  found.map(({ place, principal }) => ({ place, principal }));

/**
 * The Brain's groups the member `userId` holds, reading as themselves, by
 * the accounts they proved are theirs (`signIns`, `connected`) and the
 * groups the directory lists them in (`directory`): each
 * account's token and its tenant's name (`accounts`), those of the
 * groups they provably hold (`provedGroupsOf`) that a list named, sorted
 * (`groups`), and the pairs of the places `places` with any of these an
 * item named (`pairs`, GRA-2145; the places a reader's audiences hold
 * now, brain-next.ts `memberGroupsOf`), in their order, at most
 * `pairsMost`: the room the bound of groups leaves them at most. One
 * batch: they claim the tokens of those accounts (`person`, written only
 * where it changes), and their tokens, named groups and pairs are read. Nothing is minted: an account
 * no list named has no token, and holds nothing.
 */
export const heldPrincipalsOf = async (
  env: Pick<Env, "DB" | "SIGN_IN" | "BETTER_AUTH_SECRET">,
  userId: string,
  {
    signIns,
    connected,
    directory,
  }: {
    signIns: readonly SignIn[];
    connected: readonly PersonalAccount[];
    directory: readonly DirectoryGroupProof[];
  },
  places: readonly string[] = [],
  pairsMost = 0
): Promise<{
  accounts: string[];
  groups: string[];
  pairs: Pair[];
}> => {
  const reading = readingAccountsOf(env, signIns, connected);
  const groups = [...new Set(provedGroupsOf({ connected, directory }))];
  const db = drizzle(env.DB);
  if (reading.length === 0) {
    if (groups.length === 0) {
      return { accounts: [], groups: [], pairs: [] };
    }
    if (places.length === 0 || pairsMost <= 0) {
      const named = await namedGroupsRead(db, groups);
      return { accounts: [], groups: named.map(({ name }) => name), pairs: [] };
    }
    const [named, found] = await db.batch([
      namedGroupsRead(db, groups),
      pairsRead(db, places, groups, [], pairsMost),
    ]);
    return {
      accounts: [],
      groups: named.map(({ name }) => name),
      pairs: pairsFrom(found),
    };
  }
  const keys = await keysOf(env, reading);
  const tenants = reading.map(({ provider, tenant }) =>
    tenantPrincipal(provider, tenant)
  );
  const [, tokens, named, found] = await db.batch([
    db
      .update(sourceReaderTokens)
      .set({ person: userId })
      .where(
        and(
          inList(sourceReaderTokens.key, keys),
          or(
            isNull(sourceReaderTokens.person),
            ne(sourceReaderTokens.person, userId)
          ),
          not(erasureBegan(userId))
        )
      ),
    db
      .select({ token: sourceReaderTokens.token })
      .from(sourceReaderTokens)
      .where(inList(sourceReaderTokens.key, keys)),
    namedGroupsRead(db, groups),
    pairsRead(db, places, [...tenants, ...groups], keys, pairsMost),
  ]);
  return {
    accounts: [
      ...new Set([
        ...tokens.map(({ token }) => tokenPrincipal(token)),
        ...tenants,
      ]),
    ],
    groups: named.map(({ name }) => name),
    pairs: pairsFrom(found),
  };
};

/**
 * Claims for the member `userId` the tokens of the suite accounts they
 * connected as their own (`connected`, connect's `personalAccounts`) that
 * count for reading now (`readingAccountsOf`, as a read claims), minting
 * each that no list named yet: so their erasure finds them by person
 * (`forgetTokens`), whether or not they ever read by it. A stale proof, an
 * idle connection's address that may be someone else's by now, claims
 * nothing, and takes no one's token. Called when a connection is made or
 * made again (connections.ts).
 */
export const claimConnectedTokens = async (
  env: Pick<Env, "DB" | "SIGN_IN" | "BETTER_AUTH_SECRET">,
  userId: string,
  connected: readonly PersonalAccount[]
): Promise<void> => {
  const keys = await keysOf(env, readingAccountsOf(env, [], connected));
  if (keys.length === 0) {
    return;
  }
  const claimed = JSON.stringify(keys.map((key) => [key, crypto.randomUUID()]));
  await drizzle(env.DB)
    .insert(sourceReaderTokens)
    .select(
      sql`SELECT json_extract(value, '$[0]'), ${userId}, json_extract(value, '$[1]'), ${Date.now()}
        FROM json_each(${claimed}) WHERE NOT ${erasureBegan(userId)}`
    )
    .onConflictDoUpdate({
      target: sourceReaderTokens.key,
      set: { person: userId },
    });
};

/**
 * The keys of a person's accounts as core and connect keep them (`kept`:
 * object IDs, verified addresses, their address, and their connections'
 * accounts, disconnected or not), for `forgetTokens`.
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
