import { actorOf } from "@grasp-os/shared/audit";
import {
  connectionErrors,
  revocationsByHandSchema,
  revocationsListed,
} from "@grasp-os/shared/connect";
import type { RevocationByHand } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { asc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import {
  connections,
  givenUpRevocations,
  tokenRevocations,
} from "./db/schema.ts";
import { stuckAttempts } from "./revocations.ts";

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
// - Alert fatigue: a revoke shows only once it is stuck (about a day of
//   failures), not on its first failed try, and one given up shows for
//   `givenUpShownMs`, then goes.

/** How long a given-up revoke stays listed: long enough to act on. */
export const givenUpShownMs = 90 * 24 * 60 * 60 * 1000;

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
  const [stuck, givenUp] = await Promise.all([
    db
      .select({ owed: tokenRevocations, connection: connections })
      .from(tokenRevocations)
      .innerJoin(connections, eq(connections.id, tokenRevocations.connectionId))
      .where(gte(tokenRevocations.attempts, stuckAttempts))
      .orderBy(asc(tokenRevocations.createdAt))
      .limit(revocationsListed),
    db
      .select({ ended: givenUpRevocations, connection: connections })
      .from(givenUpRevocations)
      .innerJoin(
        connections,
        eq(connections.id, givenUpRevocations.connectionId)
      )
      .where(gte(givenUpRevocations.givenUpAt, new Date(now - givenUpShownMs)))
      .orderBy(asc(givenUpRevocations.owedAt))
      .limit(revocationsListed),
  ]);

  return [
    ...stuck.map(({ owed, connection }) => ({
      id: owed.id,
      ...who(connection),
      state: "stuck" as const,
      owedFor: owed.reason,
      since: owed.createdAt.toISOString(),
      attempts: owed.attempts,
      givenUpAt: null,
      reason: null,
    })),
    ...givenUp.map(({ ended, connection }) => ({
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
