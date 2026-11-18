import { connectorIsolateRequests } from "@grasp-os/connector-kit/manifest";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionTokens, connections } from "./db/schema.ts";
import { emailOf } from "./directory.ts";
import { ownerErased } from "./erased-people.ts";
import { SourceError, readFromProvider, requestBudget } from "./event-kinds.ts";
import type { ProviderAccess } from "./event-kinds.ts";
import { accessTokenFor } from "./tokens.ts";

// The groups each person's own suite account is in, nested ones included
// (GRA-1761; the threat model is on GRA-1719, "Group members"): what core
// counts them in a copied reader list's group by. Read with the person's
// own token, never the directory's, so a person proves only their own
// groups and nothing is stored of anyone else. A read is whole or it is
// nothing: what it found is kept only when every page of it was read, and
// a read that fails keeps only when it was tried, so the groups an earlier
// read found count until that read is a day old (core's
// source-readers.ts, `readerProofMaxAgeMs`), never longer.
//
// When: a connection is due once its access token was minted after its
// last try (connected, reconnected, renewed), so the provider's token
// lifetime paces the reads, as it paces the address a renewal confirms
// (tokens.ts). A connection nobody uses isn't renewed, isn't read, and
// stops counting by its groups after a day.

/** The providers whose reader lists name groups, by connect's IDs of them. */
const groupProviderSchema = z.enum(["google", "microsoft"]);
type GroupProvider = z.infer<typeof groupProviderSchema>;

const graphHost = "graph.microsoft.com";
/**
 * The signed-in account's groups, directory roles and administrative
 * units, direct and nested
 * (https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0):
 * `User.Read`, which every Microsoft connection holds, is enough. Asked
 * without query options, which this endpoint takes only as advanced
 * queries (`ConsistencyLevel: eventual`, an index that may lag behind a
 * removal): Graph's default page, 100.
 */
const memberOfPath = "/v1.0/me/transitiveMemberOf";
const graph = readFromProvider({ name: "Microsoft Graph", hosts: [graphHost] });

const cloudIdentityHost = "cloudidentity.googleapis.com";
/**
 * The groups a member (a person or a group) is directly in
 * (https://docs.cloud.google.com/identity/docs/reference/rest/v1/groups.memberships/searchDirectGroups),
 * with `cloud-identity.groups.readonly`. Its transitive twin is offered
 * only on Enterprise and Cloud Identity Premium editions, so nested groups
 * are found by asking again for each group found. Groups whose
 * memberships the person may not see are left out by Google: nobody's.
 */
const directGroupsPath = "/v1/groups/-/memberships:searchDirectGroups";
/** The label every Google group carries (Cloud Identity's groups.labels). */
const groupLabel = "cloudidentity.googleapis.com/groups.discussion_forum";
/** A page as large as Google allows ("max 1000"). */
const googlePageSize = 1000;
const cloudIdentity = readFromProvider({
  name: "Cloud Identity",
  hosts: [cloudIdentityHost],
});

/** IDs as Entra issues them. */
const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const graphPageSchema = z.object({
  value: z.array(
    z.object({ "@odata.type": z.string().optional(), id: z.string() })
  ),
  "@odata.nextLink": z.string().optional(),
});

const googlePageSchema = z.object({
  memberships: z
    .array(
      z.object({
        groupKey: z.object({
          id: z.string(),
          namespace: z.string().optional(),
        }),
      })
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/** Graph's next page: only its `$skiptoken`, on the endpoint asked. */
const graphNext = (link: string | undefined): URL | null => {
  if (link === undefined) {
    return null;
  }
  const url = new URL(`https://${graphHost}${memberOfPath}`);
  const next = new URL(link);
  const position = next.searchParams.get("$skiptoken");
  if (
    next.protocol !== "https:" ||
    next.host !== graphHost ||
    position === null ||
    position === ""
  ) {
    throw new SourceError("Microsoft Graph handed back another next link");
  }
  url.searchParams.set("$skiptoken", position);
  return url;
};

/** The Entra groups the token's own account is in, nested ones included. */
const microsoftGroups = async (access: ProviderAccess): Promise<string[]> => {
  const groups = new Set<string>();
  let url: URL | null = new URL(`https://${graphHost}${memberOfPath}`);
  while (url !== null) {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = graphPageSchema.parse(await graph(access, url.href));
    for (const { "@odata.type": type, id } of page.value) {
      // Directory roles and administrative units share the list: no list
      // names them as a reader.
      if (type === "#microsoft.graph.group" && guidPattern.test(id)) {
        groups.add(id.toLowerCase());
      }
    }
    url = graphNext(page["@odata.nextLink"]);
  }
  return [...groups];
};

/**
 * A Google member key as a CEL string literal may hold it: an address,
 * lower case, without a quote or a backslash; none for anything else.
 */
const keyOf = (id: string): string | undefined => {
  const address = emailOf(id);
  return address === "" || address.includes("'") || address.includes("\\")
    ? undefined
    : address;
};

/** The groups `member` is directly in, every page of them. */
const directGroupsOf = async (
  access: ProviderAccess,
  member: string
): Promise<string[]> => {
  const found: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://${cloudIdentityHost}${directGroupsPath}`);
    url.searchParams.set(
      "query",
      `member_key_id == '${member}' && '${groupLabel}' in labels`
    );
    url.searchParams.set("pageSize", String(googlePageSize));
    if (pageToken !== undefined) {
      url.searchParams.set("pageToken", pageToken);
    }
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = googlePageSchema.parse(await cloudIdentity(access, url.href));
    for (const { groupKey } of page.memberships ?? []) {
      // A group mapped from another identity source has a namespace: no
      // Drive permission names it.
      const key =
        groupKey.namespace === undefined ? keyOf(groupKey.id) : undefined;
      if (key !== undefined) {
        found.push(key);
      }
    }
    pageToken = page.nextPageToken === "" ? undefined : page.nextPageToken;
  } while (pageToken !== undefined);
  return found;
};

/**
 * The Google groups the account at `address` is in, nested ones included:
 * its own groups, then each one's groups, every group asked once.
 */
const googleGroups = async (
  access: ProviderAccess,
  address: string | null
): Promise<string[]> => {
  const start = address === null ? undefined : keyOf(address);
  if (start === undefined) {
    throw new SourceError("No confirmed address to read the groups of");
  }
  const groups = new Set<string>();
  let members = [start];
  while (members.length > 0) {
    const next: string[] = [];
    for (const member of members) {
      // oxlint-disable-next-line no-await-in-loop -- within the read's budget, one at a time
      for (const group of await directGroupsOf(access, member)) {
        if (!groups.has(group)) {
          groups.add(group);
          next.push(group);
        }
      }
    }
    members = next;
  }
  return [...groups];
};

/** Each provider's read of the account's groups. */
const groupsOf: Record<
  GroupProvider,
  (access: ProviderAccess, address: string | null) => Promise<string[]>
> = {
  microsoft: microsoftGroups,
  google: googleGroups,
};

/**
 * Reads the groups of the personal suite connections that are due, the
 * oldest try first, within one budget of `connectorIsolateRequests`
 * requests to the providers for the whole run. A read the budget cut
 * short is left for the next run, unless it had the whole budget: then it
 * can never be whole, and counts as a failure, so it doesn't hold up the
 * others. How many reads were whole.
 */
export const readReaderGroups = async (env: Env): Promise<number> => {
  const db = drizzle(env.DB);
  const due = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      accountId: connections.accountId,
      verifiedEmail: connections.verifiedEmail,
    })
    .from(connections)
    .innerJoin(
      connectionTokens,
      eq(connectionTokens.connectionId, connections.id)
    )
    .where(
      and(
        eq(connections.scope, "personal"),
        eq(connections.serverKind, "native"),
        eq(connections.status, "active"),
        inArray(connections.provider, groupProviderSchema.options),
        isNotNull(connections.tenant),
        isNotNull(connections.accountId),
        or(
          isNull(connections.readerGroupsTriedAt),
          lt(connections.readerGroupsTriedAt, connectionTokens.updatedAt)
        )
      )
    )
    .orderBy(asc(connections.readerGroupsTriedAt))
    // Each read sends a request at least.
    .limit(connectorIsolateRequests);
  const budget = requestBudget(connectorIsolateRequests);
  let whole = 0;
  for (const { id, provider, accountId, verifiedEmail } of due) {
    if (budget.left === 0) {
      break;
    }
    const hadAll = budget.left === connectorIsolateRequests;
    const read = groupsOf[groupProviderSchema.parse(provider)];
    let groups: string[] | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, in one budget
      const token = await accessTokenFor(env, id);
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, in one budget
      groups = await read({ token, budget }, verifiedEmail);
    } catch (error) {
      if (error instanceof SourceError && error.spent && !hadAll) {
        break;
      }
      log.warn("reader_groups.read_failed", {
        provider,
        ...(error instanceof SourceError && error.status !== undefined
          ? { status: error.status }
          : {}),
        ...errorFields(error),
      });
    }
    // After the read: a renewal it made is not another reason to read.
    const now = new Date();
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    await db
      .update(connections)
      .set(
        groups === undefined
          ? { readerGroupsTriedAt: now }
          : {
              readerGroups: groups,
              readerGroupsAt: now,
              readerGroupsTriedAt: now,
            }
      )
      .where(
        and(
          eq(connections.id, id),
          // The account and address the read was for, still: a reconnect
          // to another account meanwhile, or an address changed, keeps
          // nothing of it.
          accountId === null
            ? isNull(connections.accountId)
            : eq(connections.accountId, accountId),
          verifiedEmail === null
            ? isNull(connections.verifiedEmail)
            : eq(connections.verifiedEmail, verifiedEmail),
          ne(connections.status, "disconnected"),
          // Nothing of a person whose erasure began, though the read
          // started before it.
          not(ownerErased(id))
        )
      );
    if (groups !== undefined) {
      whole += 1;
    }
  }
  return whole;
};
