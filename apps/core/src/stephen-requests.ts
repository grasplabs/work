import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  dayFrom,
  elsewhere,
  fewestPeople,
  monthSpan,
  requestsReport,
  weekOf as weekStart,
} from "@grasp-os/shared/stephen-requests";
import type {
  MonthBilled,
  StephenRequest,
  StephenRequestsApi,
  StephenWeek,
} from "@grasp-os/shared/stephen-requests";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { mayAct, organizationId } from "./auth/auth.ts";
import { companyDay, toolsIn } from "./channels/stephen-requests.ts";
import {
  members,
  stephenRequestQuestions,
  stephenRequests,
  teamMembers,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { readStephenReach } from "./stephen-reach.ts";

// Stephen's requests as owners and admins read them (GRA-1267, GRA-1275):
// Stephen's week on the first agent's Access tab, and this month's billed
// requests for Settings › Billing.
// Built from the request records (channels/stephen-requests.ts) with the
// pure report of @grasp-os/shared/stephen-requests.
//
// Threat model: re-identifying a person through small groups.
//
// - A group that points at a few people: a question is named only once
//   five or more people asked it (`requestsReport`), and an app only once
//   he called it for five or more, the rest folded into one. A name follows the week it is shown with,
//   never the whole list: it goes again when its people fall under five,
//   an erased person's requests going with them.
// - Anyone else reading it: admins only, Grasp staff's every view audited
//   (staff-audit.ts); members get `role.forbidden`.
// - Words: none are kept (channels/stephen-requests.ts).

const requireReader = (by: Identity): void => {
  if (!isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** How many people may reach Stephen at all now: the active members his audience holds. */
const reachOf = async (env: Env): Promise<number> => {
  const reach = await readStephenReach(env);
  const db = drizzle(env.DB);
  const rows = await db
    .select({ userId: members.userId, teamId: teamMembers.teamId })
    .from(members)
    .leftJoin(teamMembers, eq(teamMembers.userId, members.userId))
    .where(
      and(eq(members.organizationId, organizationId), mayAct(members.userId))
    );
  const audience = reach.on ? reach.audience : { who: "nobody" as const };
  const inAudience = (teamId: string | null): boolean =>
    audience.who === "everyone" ||
    (audience.who === "teams" &&
      teamId !== null &&
      audience.teams.includes(teamId));
  const teamsOf = new Map<string, string[]>();
  for (const { userId, teamId } of rows) {
    teamsOf.set(userId, [
      ...(teamsOf.get(userId) ?? []),
      ...(teamId === null ? [] : [teamId]),
    ]);
  }
  return [...teamsOf.values()].filter((theirs) =>
    theirs.length === 0 ? inAudience(null) : theirs.some(inAudience)
  ).length;
};

/** The requests of the days from `from` to `to`. */
const requestsIn = async (
  env: Env,
  from: string,
  to: string
): Promise<StephenRequest[]> => {
  const rows = await drizzle(env.DB)
    .select({
      day: stephenRequests.day,
      personId: stephenRequests.personId,
      outcome: stephenRequests.outcome,
      topic: stephenRequests.topicId,
      question: stephenRequests.questionId,
      tools: stephenRequests.tools,
    })
    .from(stephenRequests)
    .where(and(gte(stephenRequests.day, from), lte(stephenRequests.day, to)));
  return rows.map((row) => ({ ...row, tools: toolsIn(row.tools) }));
};

/** The wording and role of the questions `ids` names. */
const questionsNamed = async (
  env: Env,
  ids: readonly string[]
): Promise<{ id: string; name: string; role: string | null }[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({
      id: stephenRequestQuestions.id,
      name: stephenRequestQuestions.wording,
      role: stephenRequestQuestions.role,
    })
    .from(stephenRequestQuestions)
    .where(inList(stephenRequestQuestions.id, [...new Set(ids)]));
  return rows;
};

/** The app (pack) a tool is of: the brain, workflows, an App, or the connection it called. */
const packOf = (tool: string): string => {
  if (tool.startsWith("workflow:")) {
    return "workflows";
  }
  if (tool.startsWith("app:")) {
    return "apps";
  }
  const [pack = tool] = tool.split(".");
  return pack;
};

/**
 * The requests billed this month, counted in the database: one number
 * for Settings › Billing, without the report.
 */
const billedOf = async (env: Env): Promise<MonthBilled> => {
  const month = monthSpan(await companyDay(env));
  const counted = await drizzle(env.DB)
    .select({ billed: sql<number>`count(*)` })
    .from(stephenRequests)
    .where(
      and(
        gte(stephenRequests.day, month.from),
        lte(stephenRequests.day, month.to),
        // Billed: what he finished.
        eq(stephenRequests.outcome, "done")
      )
    )
    .get();
  return { billed: counted?.billed ?? 0 };
};

/** Stephen's week, for the card on the first agent's Access tab. */
const weekOf = async (env: Env): Promise<StephenWeek> => {
  const today = await companyDay(env);
  const from = dayFrom(today, -29);
  const eightWeeks = dayFrom(weekStart(today), -7 * 7);
  const [reach, all] = await Promise.all([
    reachOf(env),
    requestsIn(env, eightWeeks < from ? eightWeeks : from, today),
  ]);
  const requests = all.filter(({ day }) => day >= from);
  const { weeks } = requestsReport(all, { from: eightWeeks, to: today });
  const weekFrom = dayFrom(today, -6);
  const asked = new Set(
    requests
      .filter(({ day }) => day >= weekFrom)
      .map(({ personId }) => personId)
  ).size;
  const { unanswered } = requestsReport(requests, { from, to: today });
  const answered = requests.filter(({ outcome }) => outcome === "done").length;
  const packs = new Map<
    string,
    { done: number; failed: number; people: Set<string> }
  >();
  for (const request of requests) {
    for (const tool of request.tools) {
      const pack = packOf(tool.id);
      const counts = packs.get(pack) ?? {
        done: 0,
        failed: 0,
        people: new Set(),
      };
      if (tool.ok) {
        counts.done += 1;
      } else {
        counts.failed += 1;
      }
      counts.people.add(request.personId);
      packs.set(pack, counts);
    }
  }
  const shownPacks = [...packs].filter(
    ([, { people }]) => people.size >= fewestPeople
  );
  const small = [...packs].filter(
    ([, { people }]) => people.size < fewestPeople
  );
  const questions = await questionsNamed(
    env,
    unanswered.map(({ question }) => question)
  );
  const named = new Map(questions.map((row) => [row.id, row]));
  return {
    asked,
    reach,
    weeks,
    answeredShare: requests.length === 0 ? null : answered / requests.length,
    answered,
    questions: requests.length,
    unanswered: unanswered.flatMap(({ question, people }) => {
      const row = named.get(question);
      return row === undefined
        ? []
        : [{ question, wording: row.name, people, role: row.role }];
    }),
    packs: [
      ...shownPacks
        .map(([pack, { done, failed }]) => ({ pack, done, failed }))
        .toSorted((a, b) => b.done + b.failed - (a.done + a.failed)),
      ...(small.length === 0
        ? []
        : [
            {
              pack: elsewhere,
              done: small.reduce((sum, [, each]) => sum + each.done, 0),
              failed: small.reduce((sum, [, each]) => sum + each.failed, 0),
            },
          ]),
    ],
  };
};

/** A signed-in person's `stephenRequests`. */
export class StephenRequestsRpc
  extends CoreRpcTarget
  implements StephenRequestsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async billed(): Promise<MonthBilled> {
    return await withPerson(this.#check, async (by) => {
      requireReader(by);
      return await billedOf(this.#env);
    });
  }

  async week(): Promise<StephenWeek> {
    return await withPerson(this.#check, async (by) => {
      requireReader(by);
      return await weekOf(this.#env);
    });
  }
}
