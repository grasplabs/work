import type { AuditActor } from "@grasp-os/shared/audit";
import type { budgetsSchema } from "@grasp-os/shared/deployment-config";
import { personLimitsListed } from "@grasp-os/shared/models";
import type {
  PersonLimit,
  PersonLimitException,
  PersonLimits,
  PersonLimitSet,
  PersonLimitSubject,
} from "@grasp-os/shared/models";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import { activeMember, organizationId } from "./auth/auth.ts";
import { teamMembers, teams, users } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { membersOf } from "./members.ts";
import { limitedPersonOf } from "./model-budgets.ts";
import { appliedLimit, modelLedger, personTeamsMost } from "./model-ledger.ts";
import type { AppliedPersonLimit, StoredPersonLimit } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";

// The limits a company's admins set per person (D8), within Grasp's
// budgets: a default monthly limit and messages an hour for everyone, and
// exceptions for a person or a team. The model ledger keeps them and
// reserves every call made for a person against theirs (model-ledger.ts),
// finding it by the teams core's records have them in (model-budgets.ts).
// Here is what else core's records add: the people and teams an exception
// names, and Grasp's budgets a monthly limit may not go above. Settings ›
// AI spend reads and sets them over `ModelsRpc`, for admins only; the chat
// door asks for a person's messages an hour (`messagesAnHourOf`).

type Budgets = z.output<typeof budgetsSchema>;

type LedgerEnv = Pick<
  Env,
  "DB" | "MODEL_LEDGER" | "DURABLE_OBJECT_JURISDICTION"
>;

/**
 * The chat messages an hour admins allow `userId`; null when they set
 * none, and the chat door's own rate holds them. For the door to ask
 * before it reads a message.
 */
export const messagesAnHourOf = async (
  env: LedgerEnv,
  userId: string
): Promise<number | null> => {
  const person = await limitedPersonOf(env, userId);
  if (person === undefined) {
    return null;
  }
  const { messagesAnHour } = await modelLedger(env).personLimitOf(person);
  return messagesAnHour;
};

/**
 * The most a monthly limit may be, in micros: the lower of Grasp's budgets
 * for one person and for the whole deployment; none when neither is set.
 */
export const limitCeiling = (budgets: Budgets): number | null => {
  const set = [budgets?.user?.limit, budgets?.deployment?.limit].filter(
    (limit) => limit !== undefined
  );
  return set.length === 0
    ? null
    : Math.round(Math.min(...set) * microsPerDollar);
};

/** Micros as US dollars, none as none. */
const dollarsOf = (micros: number | null): number | null =>
  micros === null ? null : micros / microsPerDollar;

/** A limit as admins read it. */
const limitOf = ({
  monthlyMicros,
  messagesAnHour,
}: Pick<
  AppliedPersonLimit,
  "monthlyMicros" | "messagesAnHour"
>): PersonLimit => ({
  monthly: dollarsOf(monthlyMicros),
  messagesAnHour,
});

/** Whether `subject` names someone in the organization, or one of its teams. */
const exists = async (
  env: Pick<Env, "DB">,
  subject: PersonLimitSubject
): Promise<boolean> => {
  const db = drizzle(env.DB);
  if (subject.type === "person") {
    const row = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, subject.userId), activeMember(users.id)))
      .get();
    return row !== undefined;
  }
  if (subject.type === "team") {
    const row = await db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.id, subject.teamId),
          eq(teams.organizationId, organizationId)
        )
      )
      .get();
    return row !== undefined;
  }
  return true;
};

/**
 * Sets `subject`'s limit as admin `by` asked, never above Grasp's
 * `budgets`: refused when they can't be read (`invalid`), as it can't
 * be checked then.
 */
export const setPersonLimit = async (
  env: LedgerEnv,
  budgets: Budgets | "invalid",
  subject: PersonLimitSubject,
  limit: PersonLimit,
  by: AuditActor
): Promise<PersonLimitSet> => {
  if (budgets === "invalid") {
    return { state: "rules_invalid" };
  }
  if (!(await exists(env, subject))) {
    return { state: "not_found" };
  }
  const set = await modelLedger(env).setPersonLimit(
    subject,
    {
      monthlyMicros:
        limit.monthly === null
          ? null
          : Math.round(limit.monthly * microsPerDollar),
      messagesAnHour: limit.messagesAnHour,
    },
    limitCeiling(budgets),
    by
  );
  return set.state === "set"
    ? set
    : { state: "above_budget", ceiling: set.ceilingMicros / microsPerDollar };
};

/** The exceptions in `stored`, with the names core has for them. */
const exceptionsOf = async (
  env: Pick<Env, "DB">,
  stored: readonly StoredPersonLimit[]
): Promise<PersonLimitException[]> => {
  const userIds = stored.flatMap(({ subject }) =>
    subject.type === "person" ? [subject.userId] : []
  );
  const teamIds = stored.flatMap(({ subject }) =>
    subject.type === "team" ? [subject.teamId] : []
  );
  const db = drizzle(env.DB);
  // Each set as one bound parameter: D1 binds at most 100 to a query, and
  // a company can have more exceptions than that.
  const [userRows, teamRows] = await Promise.all([
    userIds.length === 0
      ? []
      : db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inList(users.id, userIds)),
    teamIds.length === 0
      ? []
      : db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inList(teams.id, teamIds)),
  ]);
  const people = new Map(userRows.map(({ id, name }) => [id, name]));
  const named = new Map(teamRows.map(({ id, name }) => [id, name]));
  return stored.flatMap(({ subject, ...values }): PersonLimitException[] => {
    if (subject.type === "person") {
      return [
        {
          subject,
          name: people.get(subject.userId) ?? null,
          limit: limitOf(values),
        },
      ];
    }
    if (subject.type === "team") {
      return [
        {
          subject,
          name: named.get(subject.teamId) ?? null,
          limit: limitOf(values),
        },
      ];
    }
    return [];
  });
};

/**
 * The limits admins set, and each of the organization's people (at most
 * {@link personLimitsListed}, by name) with the limit that applies to
 * them and what they spent against it in `month`. For admins to read.
 */
export const personLimitsIn = async (
  env: LedgerEnv,
  budgets: Budgets | "invalid",
  month: string
): Promise<PersonLimits> => {
  const ledger = modelLedger(env);
  const [stored, everyone, memberships] = await Promise.all([
    ledger.personLimits(),
    membersOf(env),
    drizzle(env.DB)
      .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
      .from(teamMembers)
      .orderBy(asc(teamMembers.teamId)),
  ]);
  const listed = everyone.slice(0, personLimitsListed);
  const [exceptions, spent] = await Promise.all([
    exceptionsOf(env, stored),
    ledger.spendOfKeys(
      month,
      "person",
      listed.map(({ userId }) => userId)
    ),
  ]);
  const teamsByPerson = Map.groupBy(memberships, ({ userId }) => userId);
  const spentBy = new Map(
    spent.map(({ key, spentMicros }) => [key, spentMicros])
  );
  const fallback = stored.find(({ subject }) => subject.type === "default");
  return {
    month,
    default: limitOf(fallback ?? { monthlyMicros: null, messagesAnHour: null }),
    exceptions,
    ceiling: budgets === "invalid" ? null : dollarsOf(limitCeiling(budgets)),
    people: listed.map(({ userId, name }) => {
      const applied = appliedLimit(
        stored,
        userId,
        (teamsByPerson.get(userId) ?? [])
          .slice(0, personTeamsMost)
          .map(({ teamId }) => teamId)
      );
      return {
        userId,
        name,
        from: applied.from,
        limit: limitOf(applied),
        spent: (spentBy.get(userId) ?? 0) / microsPerDollar,
      };
    }),
    more: everyone.length > listed.length,
  };
};
