import { actorOf } from "@grasp-os/shared/audit";
import {
  connectionErrors,
  revocationsByHandSchema,
  revocationsListed,
} from "@grasp-os/shared/connect";
import type { RevocationByHand } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { mapConcurrently } from "@grasp-os/shared/release";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, asc, eq, gt, gte, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import {
  connections,
  givenUpRevocations,
  tokenRevocations,
} from "./db/schema.ts";
import { grantHeldAgain, stuckAttempts } from "./revocations.ts";

// The revokes at a provider connect couldn't make, for the company's
// admins to make by hand (GRA-1197): one still retried but stuck past
// `stuckAttempts`, or one given up (src/revocations.ts), whose grant may
// still be live. From its threat model:
//
// - A list that tells more than it must: by the connection's ID, its
//   provider, when, and how many tries; a shared connection's account by
//   the name the provider gave it, as admins see it on Integrations; a
//   personal one by its owner only, never the account's address or name,
//   and never a token or anything a connection read.
// - Someone else reading it: the company's admins, and Grasp's staff
//   read-only, each staff read on record before it is answered; anyone
//   else is refused, on record.
// - Cutting live access: a revoke whose grant a connection holds again
//   (the account connected again, in any scope, on Google's account-wide
//   grant, or handed the same refresh token) is left out, as `tryOwed`
//   drops it: removing it by hand would end access in use. Left out
//   while the list is read page by page, so many of them never hide a
//   newer one still to make (`oldestStillOwed`).
// - Alert fatigue: a revoke shows only once it is stuck (about a day of
//   failures), not on its first failed try, and one given up shows for
//   `givenUpShownMs`, then goes.

/** How long a given-up revoke stays listed: long enough to act on. */
export const givenUpShownMs = 90 * 24 * 60 * 60 * 1000;

/** How many listed revokes are checked against live grants at once. */
const checkedAtOnce = 10;

/** The items of `items` that `keep` keeps, a few asked at once. */
const filterAsync = async <T>(
  items: readonly T[],
  keep: (item: T) => Promise<boolean>
): Promise<T[]> => {
  const kept = await mapConcurrently(items, checkedAtOnce, keep);
  return items.filter((_, index) => kept[index] === true);
};

/**
 * Most pages of candidates one read goes through for each kind: a list's
 * worth each, so at most this many lists' worth of revokes whose grant is
 * in use again are passed over before the read stops where it got.
 */
const pagesAtMost = 5;

/** Where a page of candidates ends: by age, then ID. */
interface PageEnd {
  at: Date;
  id: string;
}

/**
 * The oldest candidates `keep` keeps, a list's worth at most: page after
 * page by age (`pageAfter`, the next after `endOf` the last), so revokes
 * whose grant is in use again never crowd out newer ones still to make,
 * and at most `pagesAtMost` pages.
 */
const oldestStillOwed = async <T>(
  pageAfter: (after: PageEnd | undefined) => Promise<T[]>,
  endOf: (row: T) => PageEnd,
  keep: (row: T) => Promise<boolean>
): Promise<T[]> => {
  const kept: T[] = [];
  let after: PageEnd | undefined;
  for (let page = 0; page < pagesAtMost; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const rows = await pageAfter(after);
    // oxlint-disable-next-line no-await-in-loop -- as above
    kept.push(...(await filterAsync(rows, keep)));
    const last = rows.at(-1);
    if (
      kept.length >= revocationsListed ||
      last === undefined ||
      rows.length < revocationsListed
    ) {
      break;
    }
    after = endOf(last);
  }
  return kept.slice(0, revocationsListed);
};

/** A connection, as the list names it: never a personal account. */
const who = (connection: typeof connections.$inferSelect) => ({
  connectionId: connection.id,
  provider: connection.provider,
  scope: connection.scope,
  accountName: connection.scope === "shared" ? connection.accountName : null,
  ownerUserId: connection.scope === "personal" ? connection.ownerUserId : null,
});
/** The revokes to make by hand, oldest first: for admins and staff only. */
export const revocationsByHand = async (
  env: Env,
  request: unknown
): Promise<RevocationByHand[]> => {
  const { person } = connectionErrors.parse(
    "connection.invalid",
    revocationsByHandSchema,
    request
  );
  if (!person.staff && !isAdmin(person.role)) {
    try {
      await recordEvents(env, [
        {
          actor: actorOf(person),
          action: "connection.revocations.viewed",
          detail: { outcome: "refused", reason: "role.forbidden" },
        },
      ]);
    } catch (error) {
      log.error("audit.record_failed", errorFields(error));
    }
    throw roleErrors.create("role.forbidden");
  }
  if (person.staff) {
    // On record before staff read anything; a refused record refuses the
    // read.
    await recordEvents(env, [
      {
        actor: { type: "staff", userId: person.userId },
        action: "connection.revocations.viewed",
        detail: {},
      },
    ]);
  }
  const db = drizzle(env.DB);
  const now = Date.now();
  const [stillStuck, stillGivenUp] = await Promise.all([
    oldestStillOwed(
      async (after) =>
        await db
          .select({ owed: tokenRevocations, connection: connections })
          .from(tokenRevocations)
          .innerJoin(
            connections,
            eq(connections.id, tokenRevocations.connectionId)
          )
          .where(
            and(
              gte(tokenRevocations.attempts, stuckAttempts),
              after === undefined
                ? undefined
                : or(
                    gt(tokenRevocations.createdAt, after.at),
                    and(
                      eq(tokenRevocations.createdAt, after.at),
                      gt(tokenRevocations.id, after.id)
                    )
                  )
            )
          )
          .orderBy(asc(tokenRevocations.createdAt), asc(tokenRevocations.id))
          .limit(revocationsListed),
      ({ owed }) => ({ at: owed.createdAt, id: owed.id }),
      async ({ owed, connection }) =>
        !(await grantHeldAgain(env, connection, owed.sealed))
    ),
    oldestStillOwed(
      async (after) =>
        await db
          .select({ ended: givenUpRevocations, connection: connections })
          .from(givenUpRevocations)
          .innerJoin(
            connections,
            eq(connections.id, givenUpRevocations.connectionId)
          )
          .where(
            and(
              gte(givenUpRevocations.givenUpAt, new Date(now - givenUpShownMs)),
              after === undefined
                ? undefined
                : or(
                    gt(givenUpRevocations.owedAt, after.at),
                    and(
                      eq(givenUpRevocations.owedAt, after.at),
                      gt(givenUpRevocations.id, after.id)
                    )
                  )
            )
          )
          .orderBy(asc(givenUpRevocations.owedAt), asc(givenUpRevocations.id))
          .limit(revocationsListed),
      ({ ended }) => ({ at: ended.owedAt, id: ended.id }),
      async ({ connection }) => !(await grantHeldAgain(env, connection))
    ),
  ]);

  return [
    ...stillStuck.map(({ owed, connection }) => ({
      id: owed.id,
      ...who(connection),
      state: "stuck" as const,
      owedFor: owed.reason,
      since: owed.createdAt.toISOString(),
      attempts: owed.attempts,
      givenUpAt: null,
      reason: null,
    })),
    ...stillGivenUp.map(({ ended, connection }) => ({
      id: ended.id,
      ...who(connection),
      state: "given_up" as const,
      owedFor: ended.owedFor,
      since: ended.owedAt.toISOString(),
      attempts: ended.attempts,
      givenUpAt: ended.givenUpAt.toISOString(),
      reason: ended.reason,
    })),
  ]
    .toSorted((one, other) => one.since.localeCompare(other.since))
    .slice(0, revocationsListed);
};

/** Forgets the given-up revokes no longer listed. The cron trigger calls it. */
export const pruneGivenUpRevocations = async (env: Env): Promise<void> => {
  await drizzle(env.DB)
    .delete(givenUpRevocations)
    .where(
      lt(givenUpRevocations.givenUpAt, new Date(Date.now() - givenUpShownMs))
    );
};
