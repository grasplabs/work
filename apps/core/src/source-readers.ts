import type { PersonalAccount } from "@grasp-os/shared/connect";
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
// connected as their own. A link reaches nobody, an outside account is
// held by nobody, and a group is held by nobody until core knows its
// members.
//
// Each system names a user reader by what its own ID tokens vouch for:
// Microsoft by the Entra object ID (Graph's `grantedToV2.user.id`, the
// token's `oid`); Google by address (Drive's permissions name users by
// address), counted only from a Google ID token that marked it verified,
// under the company's hosted domain and in one of its sign-in domains.
// Entra's address is never verified, so a Microsoft reader is never
// matched by one. An address is compared in Unicode NFC and lowercase on
// both sides. A reassigned address (a leaver's given to someone new)
// reads a list that still names it until the sync reads that list again,
// at most a day (decided for the sync run, GRA-1719); the leaver
// themselves is refused at once, as every read checks membership.
//
// A group's name is its kind, then its parts joined by ":", which no part
// holds (`sourceReaderSchema`), so two readers never share a name. No other
// group core names starts with these kinds (`team:`, `connection:`,
// `company`, `members`).

/** `part` as two names of it are compared: Unicode NFC, lowercase. */
const comparable = (part: string): string =>
  part.normalize("NFC").toLowerCase();

/** The Brain's group of `reader`, or none for a link, which nobody holds. */
export const principalOfReader = (reader: SourceReader): string | undefined => {
  switch (reader.kind) {
    case "account": {
      return `account:${reader.provider}:${comparable(reader.tenant)}:${comparable(reader.account)}`;
    }
    case "group": {
      return `group:${reader.provider}:${comparable(reader.tenant)}:${reader.group}`;
    }
    case "tenant": {
      return `tenant:${reader.provider}:${comparable(reader.tenant)}`;
    }
    case "link": {
      return undefined;
    }
    default: {
      throw new Error("Unknown reader");
    }
  }
};

/**
 * An account someone proved is theirs: the system, its tenant and what
 * the system's reader lists name it by (an Entra object ID, a Google
 * address).
 */
export interface ProvenAccount {
  provider: string;
  tenant: string;
  account: string;
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

/** Whether `address` is in one of the company's sign-in domains, after its last `@`. */
const inCompanyDomains = (
  address: string,
  domains: readonly string[]
): boolean => {
  const at = address.lastIndexOf("@");
  return at > 0 && domains.includes(comparable(address.slice(at + 1)));
};

/**
 * The accounts a person proved are theirs, as reader lists name them:
 * their sign-in accounts (`signIns`, `signInAccountsRead`), in the tenant
 * the deployment's sign-in is pinned to (auth/config.ts), and the suite
 * accounts they connected as their own (`connected`). Microsoft's by
 * object ID; Google's by verified address, none outside the company's
 * sign-in domains. None of a provider the sign-in config no longer names,
 * and none without what its lists name it by.
 */
export const provenAccountsOf = (
  env: Pick<Env, "SIGN_IN">,
  signIns: readonly {
    providerId: string;
    oid: string | null;
    verifiedEmail: string | null;
  }[],
  connected: readonly PersonalAccount[]
): ProvenAccount[] => {
  const config = signInConfig(env);
  if (config === undefined) {
    return [];
  }
  const google = (tenant: string, address: string | null): ProvenAccount[] =>
    address !== null && inCompanyDomains(address, config.domains)
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
      if (providerId === providerIds.google && config.google) {
        return google(config.google.hostedDomain, verifiedEmail);
      }
      return [];
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
 * The Brain's groups a person holds by `proven`, the accounts they proved
 * are theirs: each account's, and its tenant's. One that isn't a reader's
 * ID (another system, a part with ":") holds nothing.
 */
export const heldPrincipalsOf = (proven: readonly ProvenAccount[]): string[] =>
  proven.flatMap(({ provider, tenant, account }) =>
    [
      { kind: "account", provider, tenant, account },
      { kind: "tenant", provider, tenant },
    ].flatMap((reader) => {
      const parsed = sourceReaderSchema.safeParse(reader);
      const principal = parsed.success
        ? principalOfReader(parsed.data)
        : undefined;
      return principal === undefined ? [] : [principal];
    })
  );
