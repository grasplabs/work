import { connectErrors } from "@grasp-os/shared/connect";
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
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionTokens, connections } from "./db/schema.ts";
import type { ReaderGroupsReading } from "./db/schema.ts";
import { emailOf } from "./directory.ts";
import { ownerErased } from "./erased-people.ts";
import { SourceError, readFromProvider, requestBudget } from "./event-kinds.ts";
import type { ProviderAccess, RequestBudget } from "./event-kinds.ts";
import { providerFor } from "./providers.ts";
import { accessTokenFor, pausedWait } from "./tokens.ts";

// The groups each person's own suite account is in, nested ones included
// (GRA-1761; the threat model is on GRA-1719, "Group members"): what core
// counts them in a copied reader list's group by. Read with the person's
// own token, never the directory's, so a person proves only their own
// groups and nothing is stored of anyone else.
//
// A read grants only once it is whole. However many groups a person is
// in, it goes on across runs: what it found so far, and who is still to be
// asked, wait on the connection (`reader_groups_reading`), and replace the
// groups core counts only when nobody is left to ask. Until then, and when
// a read fails, the groups an earlier whole read found count until that
// read is a day old (core's source-readers.ts, `readerProofMaxAgeMs`),
// never longer. A whole read counts from when it started, so a membership
// taken away while it went on counts no longer than a day from then.
//
// When: a connection is due once its access token was minted after its
// last try (connected, reconnected, renewed), so the provider's token
// lifetime paces the reads, as it paces the address a renewal confirms
// (tokens.ts); and while a read of it is under way. A connection nobody
// uses isn't renewed, isn't read, and stops counting by its groups after a
// day. Each turn moves a connection behind the others, so one person's
// long read never holds up anyone else's.

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

/**
 * What one turn sends besides the pages, counted in the run's requests:
 * a renewal of the connection's token (the token endpoint and, without an
 * ID token, Google's userinfo endpoint) and, on Google, the proof that the
 * address the turn asked about is still the account's (`proved`).
 */
const turnRequests = 3;

/** IDs as Entra issues them. */
const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The providers whose reader lists name groups, by connect's IDs of them. */
const groupProviderSchema = z.enum(["google", "microsoft"]);
type GroupProvider = z.infer<typeof groupProviderSchema>;

/** Microsoft's one member asked: the token's own account. */
const me = "me";

const readingSchema = z.strictObject({
  startedAt: z.number().int(),
  account: z.string(),
  address: z.string().nullable(),
  found: z.array(z.string()),
  pending: z.array(z.string()),
  page: z.string().nullable(),
});

/**
 * The request of a run: how many requests it may send to the providers,
 * and how many D1 queries it may make (connect's own invocation's, every
 * one counted: the token's and the writes too), all told.
 */
const runSchema = z.strictObject({
  requests: z.number().int().positive(),
  queries: z.number().int().positive(),
  /**
   * Whose own connections are read nothing of now, by core's user ID:
   * members core has suspended (GRA-2143). Sent whole with every run, so
   * connect keeps no list of its own.
   */
  paused: z.array(z.string().min(1).max(256)),
});

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

/** One page of a member's groups: those found, and the next page's token. */
interface Page {
  groups: string[];
  next: string | null;
}

/** Graph's next page's position: only its `$skiptoken`, on Graph. */
const graphPosition = (link: string | undefined): string | null => {
  if (link === undefined) {
    return null;
  }
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
  return position;
};

/** A page of the Entra groups the token's own account is in, nested ones included. */
const microsoftPage = async (
  access: ProviderAccess,
  _member: string,
  page: string | null
): Promise<Page> => {
  const url = new URL(`https://${graphHost}${memberOfPath}`);
  if (page !== null) {
    url.searchParams.set("$skiptoken", page);
  }
  const answer = graphPageSchema.parse(await graph(access, url.href));
  return {
    // Directory roles and administrative units share the list: no list
    // names them as a reader.
    groups: answer.value.flatMap(({ "@odata.type": type, id }) =>
      type === "#microsoft.graph.group" && guidPattern.test(id)
        ? [id.toLowerCase()]
        : []
    ),
    next: graphPosition(answer["@odata.nextLink"]),
  };
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

/** A page of the Google groups `member` is directly in. */
const googlePage = async (
  access: ProviderAccess,
  member: string,
  page: string | null
): Promise<Page> => {
  const url = new URL(`https://${cloudIdentityHost}${directGroupsPath}`);
  url.searchParams.set(
    "query",
    `member_key_id == '${member}' && '${groupLabel}' in labels`
  );
  url.searchParams.set("pageSize", String(googlePageSize));
  if (page !== null) {
    url.searchParams.set("pageToken", page);
  }
  const answer = googlePageSchema.parse(await cloudIdentity(access, url.href));
  return {
    // A group mapped from another identity source has a namespace: no
    // Drive permission names it.
    groups: (answer.memberships ?? []).flatMap(({ groupKey }) => {
      const key =
        groupKey.namespace === undefined ? keyOf(groupKey.id) : undefined;
      return key === undefined ? [] : [key];
    }),
    next:
      answer.nextPageToken === undefined || answer.nextPageToken === ""
        ? null
        : answer.nextPageToken,
  };
};

/** Each provider's page of a member's groups. */
const pageOf: Record<
  GroupProvider,
  (access: ProviderAccess, member: string, page: string | null) => Promise<Page>
> = {
  microsoft: microsoftPage,
  google: googlePage,
};

/**
 * A read of the account starting now: Microsoft's asks the token's own
 * account; Google's, the address its provider confirmed, or none without
 * one.
 */
const readingFrom = (
  provider: GroupProvider,
  account: string,
  address: string | null
): ReaderGroupsReading | undefined => {
  let start: string | undefined = me;
  if (provider === "google") {
    start = address === null ? undefined : keyOf(address);
  }
  return start === undefined
    ? undefined
    : {
        startedAt: Date.now(),
        account,
        address,
        found: [],
        pending: [start],
        page: null,
      };
};

/**
 * Goes on with `reading` until nobody is left to ask (whole) or the
 * budget is spent (`partial`); each group found is asked about in turn on
 * Google, whose answers are direct, never on Microsoft, whose are not.
 */
const goOn = async (
  provider: GroupProvider,
  access: ProviderAccess,
  reading: ReaderGroupsReading
): Promise<{ reading: ReaderGroupsReading; whole: boolean }> => {
  const found = new Set(reading.found);
  const pending = [...reading.pending];
  let { page } = reading;
  const now = (): ReaderGroupsReading => ({
    ...reading,
    found: [...found],
    pending,
    page,
  });
  while (pending.length > 0) {
    const [member = ""] = pending;
    let answer: Page;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      answer = await pageOf[provider](access, member, page);
    } catch (error) {
      if (error instanceof SourceError && error.spent) {
        return { reading: now(), whole: false };
      }
      throw error;
    }
    for (const group of answer.groups) {
      if (!found.has(group)) {
        found.add(group);
        if (provider === "google") {
          pending.push(group);
        }
      }
    }
    page = answer.next;
    if (page === null) {
      pending.shift();
    }
  }
  return { reading: now(), whole: true };
};

/**
 * `db`, counting each query it runs into `counter` (a batch is one, as D1
 * counts it): the D1 queries a run makes, whoever makes them.
 */
const countedDatabase = (
  db: D1Database,
  counter: { queries: number }
): D1Database => {
  const counted = new WeakMap<object, D1PreparedStatement>();
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(prepared, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        if (key === "bind") {
          return (...values: unknown[]) => statement(target.bind(...values));
        }
        return (...args: unknown[]): unknown => {
          if (["first", "run", "all", "raw"].includes(String(key))) {
            counter.queries += 1;
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    counted.set(proxy, prepared);
    return proxy;
  };
  return new Proxy(db, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") {
        return value;
      }
      if (key === "prepare") {
        return (query: string) => statement(target.prepare(query));
      }
      if (key === "batch") {
        return (statements: D1PreparedStatement[]): unknown => {
          counter.queries += 1;
          return target.batch(
            statements.map((each) => counted.get(each) ?? each)
          );
        };
      }
      return (...args: unknown[]): unknown => {
        counter.queries += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
};

/**
 * Whether `provider` says, for `token`, that `address` is still the
 * address of the account `accountId` under `tenant`: the token's own
 * userinfo, so an address given to someone else since the turn's address
 * was confirmed keeps nothing of what was asked about it. A provider asked
 * about the token's own account (Microsoft's `/me`) has nothing to prove:
 * no one else's can become it.
 */
const proved = async (
  provider: GroupProvider,
  token: string,
  tenant: string,
  accountId: string,
  address: string | null
): Promise<boolean> => {
  const config = providerFor(provider);
  if (config?.kind !== "oauth" || config.userinfo === undefined) {
    return true;
  }
  const now = await config.userinfo(token, tenant, accountId);
  return now !== null && address !== null && keyOf(now) === keyOf(address);
};

/** Spends `count` of the run's requests at once; false when it has fewer. */
const spendAll = (budget: RequestBudget, count: number): boolean => {
  if (budget.left < count) {
    return false;
  }
  for (let spent = 0; spent < count; spent += 1) {
    budget.spend();
  }
  return true;
};

/**
 * Reads the groups of the personal suite connections that are due, the
 * longest untried first, each turn going on from where the last stopped,
 * within the `requests` and the D1 `queries` the caller gives the whole run
 * (core's clock: source-readers.ts). A turn starts only while queries are
 * left, so the run stops one turn past its share at most; what is left is
 * due next run. How many reads became whole.
 */
export const readReaderGroups = async (
  env: Env,
  request: unknown
): Promise<number> => {
  const { requests, queries, paused } = connectErrors.parse(
    "connect.invalid",
    runSchema,
    request
  );
  const counter = { queries: 0 };
  const counted: Env = { ...env, DB: countedDatabase(env.DB, counter) };
  const db = drizzle(counted.DB);
  const budget = requestBudget(requests);
  const due = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      tenant: connections.tenant,
      accountId: connections.accountId,
      verifiedEmail: connections.verifiedEmail,
      reading: connections.readerGroupsReading,
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
        // Not a suspended person's, a read under way of theirs included:
        // it goes on, from where it was, once they're back.
        sql`${connections.ownerUserId} NOT IN (SELECT value FROM json_each(${JSON.stringify(paused)}))`,
        // Nor one whose vendor asked every caller to wait: its read waits
        // too, kept for when the wait is over.
        or(
          isNull(connectionTokens.pausedUntil),
          lt(connectionTokens.pausedUntil, new Date())
        ),
        or(
          isNotNull(connections.readerGroupsReading),
          isNull(connections.readerGroupsTriedAt),
          lt(connections.readerGroupsTriedAt, connectionTokens.updatedAt)
        )
      )
    )
    .orderBy(asc(connections.readerGroupsTriedAt))
    // A turn costs `turnRequests` at least.
    .limit(Math.ceil(requests / turnRequests));
  let whole = 0;
  for (const row of due) {
    const { id, tenant, accountId, verifiedEmail } = row;
    const provider = groupProviderSchema.parse(row.provider);
    if (
      tenant === null ||
      accountId === null ||
      counter.queries >= queries ||
      !spendAll(budget, turnRequests)
    ) {
      break;
    }
    // Where the last turn stopped, if it read the same account at the
    // same address; else from the start.
    const stored = readingSchema.safeParse(row.reading);
    const reading =
      stored.success &&
      stored.data.account === accountId &&
      stored.data.address === verifiedEmail
        ? stored.data
        : readingFrom(provider, accountId, verifiedEmail);
    // Each try's time is taken once the turn is over: a renewal the turn
    // made itself is no reason to read again.
    let set: Partial<typeof connections.$inferInsert>;
    try {
      if (reading === undefined) {
        throw new SourceError("No confirmed address to read the groups of");
      }
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, in one budget
      const token = await accessTokenFor(counted, id);
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time, in one budget
      const turn = await goOn(provider, { token, budget }, reading);
      // A provider asked about an address keeps nothing it said unless it
      // says, for the same token, the address is still this account's.
      if (
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        !(await proved(provider, token, tenant, accountId, reading.address))
      ) {
        throw new SourceError("The address asked about isn't the account's");
      }
      if (turn.whole) {
        whole += 1;
        set = {
          readerGroups: turn.reading.found,
          readerGroupsAt: new Date(turn.reading.startedAt),
          readerGroupsTriedAt: new Date(),
          readerGroupsReading: null,
        };
      } else {
        set = {
          readerGroupsReading: turn.reading,
          readerGroupsTriedAt: new Date(),
        };
      }
    } catch (error) {
      log.warn("reader_groups.read_failed", {
        provider,
        ...(error instanceof SourceError && error.status !== undefined
          ? { status: error.status }
          : {}),
        ...errorFields(error),
      });
      // A paused connection keeps the read, under way or about to start,
      // to go on with once its vendor's wait is over.
      set = {
        readerGroupsReading:
          pausedWait(error) === undefined ? null : (reading ?? null),
        readerGroupsTriedAt: new Date(),
      };
    }
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    await db
      .update(connections)
      .set(set)
      .where(
        and(
          eq(connections.id, id),
          // The account and address the turn read for, still: a reconnect
          // to another account meanwhile, or an address a renewal
          // confirmed in its place (it may be someone else's now), keeps
          // nothing of it, and the next turn starts over.
          eq(connections.accountId, accountId),
          verifiedEmail === null
            ? isNull(connections.verifiedEmail)
            : eq(connections.verifiedEmail, verifiedEmail),
          ne(connections.status, "disconnected"),
          // Nothing of a person whose erasure began, though the read
          // started before it.
          not(ownerErased(id))
        )
      );
    if (budget.left === 0) {
      break;
    }
  }
  return whole;
};
