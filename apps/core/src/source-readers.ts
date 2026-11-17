import { sourceReaderSchema } from "@grasp-os/shared/source-readers";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { providerIds, signInConfig } from "./auth/config.ts";
import { accounts } from "./db/core/schema.ts";

// Readers copied from where an item lives (GRA-1761; the threat model is
// on the issue). A sync hands core each item's readers as the system lists
// them (`SourceReader`); core names each as a group of the Brain's, and
// puts a person in that group at every read only from accounts they proved
// are theirs: the ones they sign in with, and the suite accounts they
// connected as their own. So a reader list names IDs, never addresses: a
// name or an address in a list links nobody, an outside account is held by
// nobody, a link reaches nobody, and a group is held by nobody until core
// knows its members.
//
// A group's name is its kind, then its parts joined by ":", which no part
// holds (`sourceReaderSchema`), so two readers never share a name. No other
// group core names starts with these kinds (`team:`, `connection:`,
// `company`, `members`). The tenant is compared in lowercase, as connect
// keeps it.

/** The Brain's group of `reader`, or none for a link, which nobody holds. */
export const principalOfReader = (reader: SourceReader): string | undefined => {
  switch (reader.kind) {
    case "account": {
      return `account:${reader.provider}:${reader.tenant.toLowerCase()}:${reader.account}`;
    }
    case "group": {
      return `group:${reader.provider}:${reader.tenant.toLowerCase()}:${reader.group}`;
    }
    case "tenant": {
      return `tenant:${reader.provider}:${reader.tenant.toLowerCase()}`;
    }
    case "link": {
      return undefined;
    }
    default: {
      throw new Error("Unknown reader");
    }
  }
};

/** An account someone proved is theirs: the system, its tenant and the account's ID. */
export interface ProvenAccount {
  provider: string;
  tenant: string;
  accountId: string;
}

/**
 * The read of the accounts the person `userId` signs in with, for one
 * batch with their membership (brain-next.ts `memberGroupsOf`): the
 * Microsoft and Google ones the sign-in made from a verified ID token.
 * Accounts the directory made for someone who never signed in are not
 * among them: they prove nothing of the person.
 */
export const signInAccountsRead = (db: DrizzleD1Database, userId: string) =>
  db
    .select({
      providerId: accounts.providerId,
      accountId: accounts.accountId,
      oid: accounts.oid,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accounts.providerId, [providerIds.entra, providerIds.google])
      )
    );

/**
 * The sign-in accounts `rows` names, in the tenant the deployment's
 * sign-in is pinned to (auth/config.ts): an Entra account by the object ID
 * of its latest sign-in, a Google one by its subject under the hosted
 * domain. None of a provider the sign-in config no longer names.
 */
export const signInAccountsOf = (
  env: Pick<Env, "SIGN_IN">,
  rows: readonly { providerId: string; accountId: string; oid: string | null }[]
): ProvenAccount[] => {
  const config = signInConfig(env);
  return rows.flatMap(({ providerId, accountId, oid }) => {
    if (providerId === providerIds.entra && config?.entra && oid !== null) {
      return [
        {
          provider: "microsoft",
          tenant: config.entra.tenantId,
          accountId: oid,
        },
      ];
    }
    if (providerId === providerIds.google && config?.google) {
      return [
        {
          provider: "google",
          tenant: config.google.hostedDomain,
          accountId,
        },
      ];
    }
    return [];
  });
};

/**
 * The Brain's groups a person holds by `proven`, the accounts they proved
 * are theirs: each account's, and its tenant's. One that isn't a reader's
 * ID (another system, a part with ":") holds nothing.
 */
export const heldPrincipalsOf = (proven: readonly ProvenAccount[]): string[] =>
  proven.flatMap(({ provider, tenant, accountId }) =>
    [
      { kind: "account", provider, tenant, account: accountId },
      { kind: "tenant", provider, tenant },
    ].flatMap((reader) => {
      const parsed = sourceReaderSchema.safeParse(reader);
      const principal = parsed.success
        ? principalOfReader(parsed.data)
        : undefined;
      return principal === undefined ? [] : [principal];
    })
  );
