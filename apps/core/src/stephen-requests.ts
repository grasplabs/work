import { actorOf } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import { isAdmin, isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  dayFrom,
  elsewhere,
  fewestPeople,
  noRequestSettings,
  rangeSpan,
  requestKinds,
  requestsReport,
  stephenRequestErrors,
  stephenRequestSettingsChangeSchema,
  stephenRequestSettingsSchema,
  weekOf as weekStart,
} from "@grasp-os/shared/stephen-requests";
import type {
  MissingTool,
  MonthBilled,
  StephenRequest,
  StephenRequestSettings,
  StephenRequestSettingsChange,
  StephenRequestsApi,
  StephenWeek,
} from "@grasp-os/shared/stephen-requests";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, mayAct, organizationId } from "./auth/auth.ts";
import { companyDay, toolsIn } from "./channels/stephen-requests.ts";
import {
  members,
  orgSettings,
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
// Stephen's week on the first agent's Access tab, this month's billed
// requests for Settings › Billing, and the company's settings for them.
// Built from the request records (channels/stephen-requests.ts) with the
// pure report of @grasp-os/shared/stephen-requests.
//
// Threat model: re-identifying a person through small groups.
//
// - A group that points at a few people: the week folds its groups of
//   fewer than five people into one (`requestsReport`), a question is
//   named only once five or more people asked it, and an app only once he
//   called it for five or more. A name follows the week it is shown with,
//   never the whole list: it goes again when its people fall under five,
//   an erased person's requests going with them.
// - Anyone else reading it: admins only, Grasp staff's every view audited
//   (staff-audit.ts); members get `role.forbidden`.
// - Words: none are kept (channels/stephen-requests.ts).
// - The settings: one row in org settings, read leniently (a field added
//   later defaults on an older row), changed by owners only, each change
//   in the audit log by who made it.

/** The org setting's row. */
const settingsKind = "stephenRequests";

/** The settings as stored, defaults for what an older row lacks. */
const readRequestSettings = async (
  env: Env
): Promise<StephenRequestSettings> => {
  const [row] = await drizzle(env.DB)
    .select({ value: orgSettings.value })
    .from(orgSettings)
    .where(eq(orgSettings.kind, settingsKind));
  if (row === undefined) {
    return noRequestSettings;
  }
  const parsed = stephenRequestSettingsSchema.safeParse(JSON.parse(row.value));
  if (!parsed.success) {
    log.warn("stephen_requests.settings_unreadable", {});
    return noRequestSettings;
  }
  return parsed.data;
};

const requireReader = (by: Identity): void => {
  if (!isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** Owners: the organization's own admins, never Grasp staff. */
const requireOwner = (by: Identity): void => {
  if (!isMemberAdmin(by)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** The settings a change can name, in the order their events are recorded. */
const settingFields = [
  "requestsIncluded",
  "minutesSaved",
  "requestsPerPerson",
] as const;

/** The settings `change` changes against `before`: those it names with another value. */
const changedFields = (
  before: StephenRequestSettings,
  change: StephenRequestSettingsChange
): (typeof settingFields)[number][] => {
  const minutes = change.minutesSaved;
  const changed = {
    requestsIncluded:
      change.requestsIncluded !== undefined &&
      change.requestsIncluded !== before.requestsIncluded,
    minutesSaved:
      minutes !== undefined &&
      requestKinds.some(
        (kind) =>
          minutes[kind] !== undefined &&
          (minutes[kind] ?? null) !== (before.minutesSaved[kind] ?? null)
      ),
    requestsPerPerson:
      change.requestsPerPerson !== undefined &&
      change.requestsPerPerson !== before.requestsPerPerson,
  };
  return settingFields.filter((field) => changed[field]);
};

/**
 * Changes what `input` names of the settings, an owner's: written only
 * while they still are one, merged into the row as it is when written
 * (`json_patch`), so a change made meanwhile to another setting stays.
 * Each setting changed is its own audit event, by who changed it.
 */
const saveRequestSettings = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<StephenRequestSettings> => {
  requireOwner(by);
  const parsed = stephenRequestSettingsChangeSchema.safeParse(input);
  if (!parsed.success) {
    throw stephenRequestErrors.create("stephen_requests.settings_invalid");
  }
  const change = parsed.data;
  const fields = changedFields(await readRequestSettings(env), change);
  const patch = JSON.stringify(change);
  const patched = sql`json_patch(${orgSettings.value}, ${patch})`;
  const now = Date.now();
  const db = drizzle(env.DB);
  const whileOwner = db
    .select({
      kind: sql<string>`${settingsKind}`.as("kind"),
      value:
        sql<string>`json_patch(${JSON.stringify(noRequestSettings)}, ${patch})`.as(
          "value"
        ),
      updatedAt: sql<Date>`${now}`.as("updated_at"),
    })
    .from(sql`(SELECT 1)`)
    .where(activeMember(by.userId, ["admin"]));
  // Each event only once the one before it was kept: the first once the
  // row changed, so a change that changed nothing records nothing.
  const events = fields.map((field) =>
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action:
        field === "requestsPerPerson"
          ? `stephen_requests.per_person.${change.requestsPerPerson === true ? "turned_on" : "turned_off"}`
          : "stephen_requests.settings.updated",
      target: { type: "organization", id: organizationId },
      detail: { field },
    })
  );
  const [written] = await auditedBatch(env, db, [
    db
      .insert(orgSettings)
      .select(whileOwner)
      .onConflictDoUpdate({
        target: orgSettings.kind,
        set: { value: patched, updatedAt: new Date(now) },
        setWhere: sql`${patched} <> ${orgSettings.value}`,
      }),
    ...events,
  ]);
  if (written.meta.changes === 0) {
    const still = await db.get<{ admin: number }>(
      sql`SELECT ${activeMember(by.userId, ["admin"])} AS admin`
    );
    if (still.admin !== 1) {
      throw roleErrors.create("role.forbidden");
    }
  }
  return await readRequestSettings(env);
};

/** The people who may reach Stephen, per team, and how many in all. */
interface Reach {
  byTeam: Map<string, number>;
  people: number;
}

/** Who may reach Stephen at all now: the active members his audience holds, counted per team. */
const reachOf = async (env: Env): Promise<Reach> => {
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
  const reaching = new Set<string>();
  const byTeam = new Map<string, Set<string>>();
  const teamsOf = new Map<string, string[]>();
  for (const { userId, teamId } of rows) {
    teamsOf.set(userId, [
      ...(teamsOf.get(userId) ?? []),
      ...(teamId === null ? [] : [teamId]),
    ]);
  }
  for (const [userId, theirs] of teamsOf) {
    if (!(theirs.length === 0 ? inAudience(null) : theirs.some(inAudience))) {
      continue;
    }
    reaching.add(userId);
    for (const teamId of theirs) {
      byTeam.set(teamId, (byTeam.get(teamId) ?? new Set()).add(userId));
    }
  }
  return {
    byTeam: new Map(
      [...byTeam].map(([teamId, people]) => [teamId, people.size])
    ),
    people: reaching.size,
  };
};

const missingSchema = z.array(
  z.object({
    id: z.string(),
    why: z.enum(["appOff", "actionOff", "workflowClosed", "noApp", "noAction"]),
  })
);

const missingIn = (stored: string): MissingTool[] => {
  try {
    return missingSchema.parse(JSON.parse(stored));
  } catch {
    return [];
  }
};

/** The requests of the days from `from` to `to`. */
const requestsIn = async (
  env: Env,
  from: string,
  to: string
): Promise<StephenRequest[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: stephenRequests.id,
      day: stephenRequests.day,
      place: stephenRequests.place,
      personId: stephenRequests.personId,
      teamId: stephenRequests.teamId,
      kind: stephenRequests.kind,
      outcome: stephenRequests.outcome,
      topic: stephenRequests.topicId,
      question: stephenRequests.questionId,
      tools: stephenRequests.tools,
      missing: stephenRequests.missing,
      rating: stephenRequests.rating,
    })
    .from(stephenRequests)
    .where(and(gte(stephenRequests.day, from), lte(stephenRequests.day, to)));
  return rows.map((row) => ({
    ...row,
    tools: toolsIn(row.tools),
    missing: missingIn(row.missing),
  }));
};

/**
 * The names of the topics `ids` names. A name rests on one person's
 * message (channels/request-sorting.ts), so it is held to a question's
 * floor: only topics a report shows as a group of their own, five or more
 * people (`topicsIn`), are ever named.


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
 * The requests billed this month, counted in the database, and what the
 * plan includes: one number for Settings › Billing, without the report.
 */
const billedOf = async (env: Env): Promise<MonthBilled> => {
  const month = rangeSpan("month", await companyDay(env));
  const [settings, counted] = await Promise.all([
    readRequestSettings(env),
    drizzle(env.DB)
      .select({ billed: sql<number>`count(*)` })
      .from(stephenRequests)
      .where(
        and(
          gte(stephenRequests.day, month.from),
          lte(stephenRequests.day, month.to),
          // Billed: what he finished (`requestsReport`'s billed).
          eq(stephenRequests.outcome, "done")
        )
      )
      .get(),
  ]);
  return { billed: counted?.billed ?? 0, included: settings.requestsIncluded };
};

/** Stephen's week, for the card on top of Settings › Stephen. */
const weekOf = async (env: Env): Promise<StephenWeek> => {
  const today = await companyDay(env);
  const from = dayFrom(today, -29);
  const eightWeeks = dayFrom(weekStart(today), -7 * 7);
  const [reach, all] = await Promise.all([
    reachOf(env),
    requestsIn(env, eightWeeks < from ? eightWeeks : from, today),
  ]);
  const requests = all.filter(({ day }) => day >= from);
  const { weeks } = requestsReport(
    all.filter(({ day }) => day >= eightWeeks),
    { from: eightWeeks, to: today, by: "day" },
    { perPerson: false, reach: new Map() }
  );
  const weekFrom = dayFrom(today, -6);
  const asked = new Set(
    requests
      .filter(({ day }) => day >= weekFrom)
      .map(({ personId }) => personId)
  ).size;
  const report = requestsReport(
    requests,
    { from, to: today, by: "day" },
    { perPerson: false, reach: reach.byTeam }
  );
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
    report.unanswered.map(({ question }) => question)
  );
  const named = new Map(questions.map((row) => [row.id, row]));
  return {
    asked,
    reach: reach.people,
    weeks,
    answeredShare: requests.length === 0 ? null : answered / requests.length,
    answered,
    questions: requests.length,
    unanswered: report.unanswered.flatMap(({ question, people }) => {
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

  async settings(): Promise<StephenRequestSettings> {
    return await withPerson(this.#check, async (by) => {
      requireReader(by);
      return await readRequestSettings(this.#env);
    });
  }

  async updateSettings(
    change: StephenRequestSettingsChange
  ): Promise<StephenRequestSettings> {
    return await withPerson(
      this.#check,
      async (by) => await saveRequestSettings(this.#env, by, change)
    );
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
