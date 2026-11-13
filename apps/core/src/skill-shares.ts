import { skillCardOf } from "@grasp-os/brain-next/skills";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { skillErrors } from "@grasp-os/shared/skills";
import type {
  ListedSkill,
  ListedTeamSkill,
  OwnSkillShare,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
  SkillText,
} from "@grasp-os/shared/skills";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember, organizationId } from "./auth/membership-sql.ts";
import {
  addOwnSkill,
  audienceKeyOf,
  audienceOf,
  eraseOwnSkill,
  listSkillsAs,
  readCurrentSkillAs,
  readSkillAs,
  sharedChangeVersion,
  sharedSkillVersion,
  writeSharedSkill,
} from "./brain-next.ts";
import type { SkillAudience, SkillCardAt } from "./brain-next.ts";
import {
  personErasures,
  skillDecisions,
  skillDeletions,
  skillShares,
  teamMembers,
  teams,
  users,
} from "./db/core/schema.ts";
import { shippedSkills } from "./shipped-skills.ts";

// Writing skills, and sharing one with the company (GRA-1754) or one of
// the asker's teams (GRA-1844). Threat models on both; what could go
// wrong, and what stops it:
//
// - Someone else's own skill read, listed or used: a person's own skills
//   are in their own store (brain-next.ts), and every call here names the
//   person from their session (`Identity`), never from what they send.
// - Instructions planted company-wide or in a team (a shared skill steers
//   its audience's agents): a shared skill is written only as an admin's
//   decision says, and a decision is written only by one of the
//   organization's own admins (never Grasp staff), checked in the very
//   statement that writes it. A share with a team is asked only by one of
//   its members and decided only while its asker is still one, each
//   checked in the statement that writes it (`inAudience`): a team they
//   aren't in, one that doesn't exist and another organization's are
//   refused alike. An approval decides the share's exact text,
//   taken from the person's own stored skill at the version they named
//   (never from what anyone sends), and only while that share still waits:
//   a share asked again, deleted with its skill or of a person removed is
//   gone, so a click on an older card is refused, never applied to text
//   nobody reviewed or that is gone. Agents have no call here.
// - A missing audience read as the company's: every share and decision
//   names its audience (`company`, or `team:<id>`), and a row without one,
//   or with one that isn't either, is never decided, listed or
//   reconciled.
// - The Brain saying something other than what was decided: core's
//   database is the one record of what should be live (`skill_decisions`,
//   numbered per audience and name; the latest is that skill's desired
//   state). One reconciler per audience and name makes the Brain follow
//   it, idempotently: it reads
//   the Brain's current version, then the decisions, and writes the latest
//   under its own change key over that version, or nothing when it has
//   landed. A lost reply, a failed write or record, two runs at once: each
//   is the reconciler running again, right after a decision and on the
//   clock. The store writes only over the version read (`after`), and the
//   version is read before the decisions, so an older decision never lands
//   over a newer one: the Brain follows the last decision, not the last
//   thing to land.
// - An audit log that says the opposite of what is live: each decision has
//   one outcome event, written once, from what the store says it did
//   (`landed` at its version, or `superseded` by a later decision before
//   it could), never from whether a reply arrived.
// - A skill granting access: none does. Writing, sharing, deciding or
//   retiring one creates no permission, binding or grant.
// - Audit: asks and decisions by the share's ID (the share says its
//   audience), a retirement by the skill's name (a team's, by its team's
//   ID and its name), its only identifiers; never a skill's text. A person's own
//   skills, which affect no one else, are not audited, as their own
//   instruction file isn't.

const nameSchema = z.string().min(1).max(64);
const versionSchema = z.int().positive();

/** The names of Grasp's skills this release ships, which a company skill replaces. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

/** Grasp's skills aren't the page's: none of their names is asked for. */
const noShipped: ReadonlySet<string> = new Set();

/** How many times a reconcile tries again over a version that moved, before it leaves the name to the clock. */
const reconcileAttempts = 3;

/** `by`, refused unless one of the organization's own admins. */
const requireAdmin = (by: Identity): void => {
  if (!isMemberAdmin(by)) {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * That `personId` is a member now and no erasure of them has begun, as the
 * statement runs: what writes on their behalf check, as other writes for a
 * person do (app-webhook-queue.ts).
 */
const stillHere = (personId: string) => sql`${activeMember(personId)}
  AND NOT EXISTS (SELECT 1 FROM ${personErasures}
    WHERE ${personErasures.userId} = ${personId})`;

/** That `by` is one of the organization's admins as the statement runs. */
const deciding = (by: Identity) => activeMember(by.userId, ["admin"]);

/** The company, as an audience is stored (`audienceKeyOf`). */
const companyKey = audienceKeyOf({ kind: "company" });

/**
 * That `personId` (an ID, or the column holding one) may share with, or
 * be decided for, `audience` (a stored audience, or the column holding
 * one), as the statement runs: the company, for anyone; a team, only for
 * its members, of a team of the organization. Never for a missing or
 * malformed audience: neither the company nor any team's.
 */
const inAudience = (
  personId: string | SQLiteColumn,
  audience: string | SQLiteColumn
): SQL => sql`(${audience} = ${companyKey} OR EXISTS (
  SELECT 1 FROM ${teamMembers}
    INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
  WHERE ${teamMembers.userId} = ${personId}
    AND ${teams.organizationId} = ${organizationId}
    AND 'team:' || ${teamMembers.teamId} = ${audience}
))`;

/** Whom a share is asked for, as the page sends it: the company, or a team by its ID. */
const audienceAskedSchema = z.union([
  z.literal("company"),
  z.strictObject({ team: identifierSchema }),
]);

/** `asked` as the audience it names; `skills.invalid` for anything else. */
const audienceAskedOf = (asked: unknown): SkillAudience => {
  const parsed = skillErrors.parse(
    "skills.invalid",
    audienceAskedSchema,
    asked
  );
  return parsed === "company"
    ? { kind: "company" }
    : { kind: "team", team: parsed.team };
};

const listedOf = ({
  name,
  version,
  description,
}: SkillCardAt): ListedSkill => ({
  name,
  version,
  description,
});

/** A share as the page reads it, with its asker's name and its decision's outcome. */
const shareColumns = {
  id: skillShares.id,
  name: skillShares.name,
  audience: skillShares.audience,
  teamName: teams.name,
  text: skillShares.text,
  status: skillShares.status,
  requestedAt: skillShares.requestedAt,
  userId: skillShares.requestedBy,
  userName: users.name,
  decidedAt: skillShares.decidedAt,
  outcome: skillDecisions.outcome,
  version: skillDecisions.version,
};

interface ShareRow {
  id: string;
  name: string;
  audience: string | null;
  teamName: string | null;
  text: string | null;
  status: SkillShare["status"];
  requestedAt: Date;
  userId: string;
  userName: string | null;
  decidedAt: Date | null;
  outcome: "landed" | "superseded" | null;
  version: number | null;
}

/** Shares with their asker, their team's name and their decision, if any. */
const sharesQuery = (db: ReturnType<typeof drizzle>) =>
  db
    .select(shareColumns)
    .from(skillShares)
    .leftJoin(users, eq(users.id, skillShares.requestedBy))
    .leftJoin(teams, sql`'team:' || ${teams.id} = ${skillShares.audience}`)
    .leftJoin(skillDecisions, eq(skillDecisions.shareId, skillShares.id));

/**
 * The shares a person sees: decided ones, and those that wait while their
 * asker may still be decided for (a team's only while they are in it).
 * Never one without an audience.
 */
const shown = (): SQL | undefined =>
  and(
    isNotNull(skillShares.audience),
    or(
      ne(skillShares.status, "pending"),
      inAudience(skillShares.requestedBy, skillShares.audience)
    )
  );

/** The shares that wait and may be decided now (`approveShare`'s own conditions). */
const decidable = (): SQL | undefined =>
  and(
    eq(skillShares.status, "pending"),
    isNotNull(skillShares.audience),
    inAudience(skillShares.requestedBy, skillShares.audience)
  );

/**
 * `row` as a share, or none when its audience isn't one (a row without
 * one is never shown, never as the company's).
 */
const shareOf = (row: ShareRow): SkillShare[] => {
  const audience = audienceOf(row.audience);
  if (audience === null) {
    return [];
  }
  return [
    {
      id: row.id,
      name: row.name,
      audience:
        audience.kind === "company"
          ? audience
          : {
              kind: "team",
              team: { id: audience.team, name: row.teamName },
            },
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      requestedBy: { userId: row.userId, name: row.userName },
      decidedAt: row.decidedAt?.toISOString() ?? null,
      version: row.outcome === "landed" ? row.version : null,
      superseded: row.outcome === "superseded",
    },
  ];
};

/** The share `id`, or `skills.not_found` (one without an audience too). */
const shareById = async (env: Env, id: string): Promise<SkillShare> => {
  const [row] = await sharesQuery(drizzle(env.DB)).where(
    eq(skillShares.id, id)
  );
  const [share] = row === undefined ? [] : shareOf(row);
  if (share === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  return share;
};

/** `id`, checked as a share's: `skills.not_found` for anything else. */
const shareIdOf = (id: unknown): string => {
  const parsed = identifierSchema.safeParse(id);
  if (!parsed.success) {
    throw skillErrors.create("skills.not_found");
  }
  return parsed.data;
};

/** The audit entry of something that happened to a share: its ID only. */
const shareEntry = (
  actor: AuditActor,
  action: string,
  id: string,
  detail: Record<string, number> = {}
): AuditEntry => ({
  actor,
  action: `skill.share.${action}`,
  target: { type: "skill_share", id },
  detail,
});

/**
 * The audit entry of something that happened to `audience`'s skill
 * `name`: the company's by its name, a team's by its team's ID and its
 * name.
 */
const skillEntry = (
  actor: AuditActor,
  action: string,
  audience: SkillAudience,
  name: string,
  detail: Record<string, number> = {}
): AuditEntry => ({
  actor,
  action,
  target:
    audience.kind === "company"
      ? { type: "company_skill", id: name }
      : { type: "team_skill", id: `${audience.team}:${name}` },
  detail,
});

/** Of each audience and name, whether its latest decision is an approval: what is (or is about to be) live. */
const decidedLive = async (env: Env): Promise<Set<string>> => {
  const rows = await drizzle(env.DB)
    .select({ audience: skillDecisions.audience, name: skillDecisions.name })
    .from(skillDecisions)
    .where(
      and(
        isNotNull(skillDecisions.audience),
        isNotNull(skillDecisions.shareId),
        sql`${skillDecisions.seq} = (SELECT MAX(latest.seq) FROM ${skillDecisions} AS latest
          WHERE latest.audience = ${skillDecisions.audience}
            AND latest.name = ${skillDecisions.name})`
      )
    );
  return new Set(rows.map(({ audience, name }) => `${audience} ${name}`));
};

/**
 * What the skills page shows `by`: their own skills, the company's, their
 * teams' (as the Brain gives them, by the teams core counts them in now),
 * the teams they may share with, their own shares, and, for admins,
 * every share that waits and may be decided, with its text and its team.
 */
export const skillsOverview = async (
  env: Env,
  by: Identity
): Promise<SkillsOverview> => {
  const db = drizzle(env.DB);
  const [listed, shares] = await Promise.all([
    listSkillsAs(env, by.userId, noShipped, { reach: "person" }),
    sharesQuery(db)
      .where(and(eq(skillShares.requestedBy, by.userId), shown()))
      .orderBy(desc(skillShares.requestedAt), desc(skillShares.id)),
  ]);
  const company = listed.filter(({ scope }) => scope === "company");
  const teamNames = new Map(by.teams.map(({ id, name }) => [id, name]));
  const team = listed.flatMap((skill): ListedTeamSkill[] =>
    skill.scope === "team"
      ? [
          {
            ...listedOf(skill),
            team: {
              id: skill.team,
              name: teamNames.get(skill.team) ?? skill.team,
            },
          },
        ]
      : []
  );
  const requests = isMemberAdmin(by)
    ? await sharesQuery(db)
        .where(decidable())
        .orderBy(asc(skillShares.requestedAt), asc(skillShares.id))
    : null;
  const live = requests === null ? new Set<string>() : await decidedLive(env);
  /** What approving `share` replaces for its audience, if anything. */
  const replacedBy = (share: SkillShare): SkillShareRequest["replaces"] => {
    const { audience, name } = share;
    if (
      audience.kind === "team" &&
      live.has(
        `${audienceKeyOf({ kind: "team", team: audience.team.id })} ${name}`
      )
    ) {
      return "team";
    }
    if (live.has(`${companyKey} ${name}`)) {
      return "company";
    }
    return shippedNames.has(name) ? "grasp" : null;
  };
  /** Whether a waiting share's text is no longer the person's current one. */
  const ownOf = async (row: ShareRow): Promise<OwnSkillShare[]> => {
    const [share] = shareOf(row);
    if (share === undefined) {
      return [];
    }
    if (row.status !== "pending" || row.text === null) {
      return [{ ...share, outdated: false }];
    }
    const current = await readCurrentSkillAs(env, by.userId, {
      scope: "person",
      name: row.name,
    });
    return [
      { ...share, outdated: current !== null && current.text !== row.text },
    ];
  };
  const asked = await Promise.all(shares.map(ownOf));
  return {
    own: listed.filter(({ scope }) => scope === "person").map(listedOf),
    company: company.map(listedOf),
    team,
    teams: by.teams.map(({ id, name }) => ({ id, name })),
    shares: asked.flat(),
    requests:
      requests?.flatMap(({ text, ...row }): SkillShareRequest[] =>
        text === null
          ? []
          : shareOf({ ...row, text }).map((share) => ({
              ...share,
              text,
              replaces: replacedBy(share),
            }))
      ) ?? null,
  };
};

/**
 * Their own skill (`own`) or the company's `name`, at its current
 * version; `skills.not_found` alike for one there isn't and one they may
 * not read.
 */
export const readSkill = async (
  env: Env,
  by: Identity,
  scope: unknown,
  name: unknown
): Promise<SkillText> => {
  const { scope: which, name: named } = skillErrors.parse(
    "skills.invalid",
    z.strictObject({ scope: z.enum(["own", "company"]), name: nameSchema }),
    { scope, name }
  );
  const read = await readCurrentSkillAs(env, by.userId, {
    scope: which === "own" ? "person" : "company",
    name: named,
  });
  if (read === null) {
    throw skillErrors.create("skills.not_found");
  }
  return { name: read.name, version: read.version, text: read.text };
};

/**
 * Saves `text` as the next version of `by`'s own skill of the name its
 * frontmatter gives, for them alone; nothing waits for anyone.
 */
export const saveOwnSkill = async (
  env: Env,
  by: Identity,
  text: unknown
): Promise<ListedSkill> => {
  const written = skillErrors.parse("skills.invalid", z.string(), text);
  const saved = await addOwnSkill(env, by.userId, {
    change: crypto.randomUUID(),
    text: written,
  });
  return {
    name: saved.name,
    version: saved.version,
    description: skillCardOf(written)?.description ?? "",
  };
};

/**
 * Deletes `by`'s own skill `name` for good: first records the deletion
 * and takes away the share of it that waits, in one batch, so from then on
 * no ask of it is written and none can be decided; then erases it from
 * their own store. A failure in between leaves a skill nobody can share,
 * and the call is safe to repeat.
 */
export const removeOwnSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  const db = drizzle(env.DB);
  await db.batch([
    // Only for someone still here: a deletion that waited while they were
    // removed and erased leaves nothing of theirs behind.
    db
      .insert(skillDeletions)
      .select(sql`SELECT ${by.userId}, ${named} WHERE ${stillHere(by.userId)}`)
      .onConflictDoNothing(),
    db
      .delete(skillShares)
      .where(
        and(
          eq(skillShares.requestedBy, by.userId),
          eq(skillShares.name, named),
          eq(skillShares.status, "pending")
        )
      ),
  ]);
  await eraseOwnSkill(env, by.userId, named);
};

/**
 * Asks to share `by`'s own skill `name`, exactly as it is at `version`,
 * with `audience` (the company, or one of their teams): it waits for an
 * admin, in place of the share of it for that audience that waited, which
 * goes. Written only while they are a member, no erasure of them has
 * begun, they haven't deleted the skill and, for a team, they are in it,
 * all checked in the write itself: `permission.person_inactive`,
 * `skills.not_found` or `skills.not_in_team` otherwise (a team they
 * aren't in, one that doesn't exist and another organization's alike),
 * and nothing written.
 */
export const shareOwnSkill = async (
  env: Env,
  by: Identity,
  name: unknown,
  version: unknown,
  audience: unknown
): Promise<SkillShare> => {
  const wanted = skillErrors.parse(
    "skills.invalid",
    z.strictObject({ name: nameSchema, version: versionSchema }),
    { name, version }
  );
  const key = audienceKeyOf(audienceAskedOf(audience));
  const read = await readSkillAs(
    env,
    by.userId,
    { scope: "person", ...wanted },
    { reach: "person" }
  );
  if (read === null) {
    throw skillErrors.create("skills.not_found");
  }
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  const deleted = sql`EXISTS (SELECT 1 FROM ${skillDeletions}
    WHERE ${skillDeletions.personId} = ${by.userId}
      AND ${skillDeletions.name} = ${read.name})`;
  const askable = sql`${stillHere(by.userId)} AND NOT ${deleted}
    AND ${inAudience(by.userId, key)}`;
  await auditedBatch(env, db, [
    db
      .delete(skillShares)
      .where(
        and(
          eq(skillShares.requestedBy, by.userId),
          eq(skillShares.name, read.name),
          eq(skillShares.audience, key),
          eq(skillShares.status, "pending")
        )
      ),
    db.insert(skillShares).select(
      sql`SELECT ${id}, ${read.name}, ${read.text}, ${by.userId}, ${Date.now()}, 'pending', NULL, NULL, ${key}
          WHERE ${askable}`
    ),
    outboxedIfChanged(db, shareEntry(actorOf(by), "requested", id)),
  ]);
  const [written] = await sharesQuery(db).where(eq(skillShares.id, id));
  const [share] = written === undefined ? [] : shareOf(written);
  if (share !== undefined) {
    return share;
  }
  // Why not, read after: the write itself checked it all at once.
  const [why] = await db.all<{ here: number; deleted: number }>(
    sql`SELECT ${stillHere(by.userId)} AS here, ${deleted} AS deleted`
  );
  if (why?.deleted === 1) {
    throw skillErrors.create("skills.not_found");
  }
  throw why?.here === 1
    ? skillErrors.create("skills.not_in_team")
    : permissionErrors.create("permission.person_inactive");
};

/** The change key a decision writes the Brain under: its own. */
const changeOf = (decision: { id: string }): string =>
  `decision:${decision.id}`;

type Decision = typeof skillDecisions.$inferSelect;

/** The core's actor for what the reconciler records. */
const reconciler: AuditActor = { type: "system" };

/** The outcome event of `decision`, of `audience`: what became of it in the Brain. */
const outcomeEntry = (
  audience: SkillAudience,
  decision: Decision,
  outcome: { version: number } | "superseded"
): AuditEntry => {
  if (decision.shareId === null) {
    return outcome === "superseded"
      ? skillEntry(
          reconciler,
          "skill.retire_superseded",
          audience,
          decision.name
        )
      : skillEntry(
          reconciler,
          "skill.retire_done",
          audience,
          decision.name,
          outcome
        );
  }
  return outcome === "superseded"
    ? shareEntry(reconciler, "superseded", decision.shareId)
    : shareEntry(reconciler, "added", decision.shareId, outcome);
};

/** A shared skill: its audience and its name, as the reconciler takes it. */
export interface SharedSkill {
  audience: SkillAudience;
  name: string;
}

/**
 * Records the outcomes of `decisions` of `skill` once `latest` landed at
 * `version`: its own, and each earlier one's not recorded yet, from the
 * store (the version its change made, or none: then the later decision
 * came first, and it never will, as every write is over a version read
 * before the decisions). One event per outcome, written only by the
 * update that records it.
 */
const recordOutcomes = async (
  env: Env,
  skill: SharedSkill,
  decisions: readonly Decision[],
  latest: Decision,
  version: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const outcomes: [Decision, { version: number } | "superseded"][] = [];
  for (const decision of decisions) {
    if (decision.outcome !== null) {
      continue;
    }
    if (decision.id === latest.id) {
      outcomes.push([decision, { version }]);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    const landed = await sharedChangeVersion(env, {
      ...skill,
      change: changeOf(decision),
    });
    outcomes.push([
      decision,
      landed === null ? "superseded" : { version: landed },
    ]);
  }
  const [first, ...rest] = outcomes.flatMap(([decision, outcome]) => [
    db
      .update(skillDecisions)
      .set(
        outcome === "superseded"
          ? { outcome: "superseded" }
          : { outcome: "landed", version: outcome.version }
      )
      .where(
        and(eq(skillDecisions.id, decision.id), isNull(skillDecisions.outcome))
      ),
    outboxedIfChanged(db, outcomeEntry(skill.audience, decision, outcome)),
  ]);
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
};

/**
 * One pass of `reconcileSkill`: `stale` when the Brain's version moved
 * after it was read, so the write was refused and nothing written.
 */
const reconcileOnce = async (
  env: Env,
  skill: SharedSkill
): Promise<"done" | "stale"> => {
  const { audience, name } = skill;
  const key = audienceKeyOf(audience);
  const current = await sharedSkillVersion(env, skill);
  // Only what it may act on: the decisions without an outcome, and the
  // latest, never every one a skill ever had.
  const decisions = await drizzle(env.DB)
    .select()
    .from(skillDecisions)
    .where(
      and(
        eq(skillDecisions.audience, key),
        eq(skillDecisions.name, name),
        or(
          isNull(skillDecisions.outcome),
          sql`${skillDecisions.seq} = (SELECT MAX(${skillDecisions.seq}) FROM ${skillDecisions}
            WHERE ${skillDecisions.audience} = ${key} AND ${skillDecisions.name} = ${name})`
        )
      )
    )
    .orderBy(asc(skillDecisions.seq));
  const latest = decisions.at(-1);
  if (
    latest === undefined ||
    decisions.every(({ outcome }) => outcome !== null)
  ) {
    return "done";
  }
  const landed = await sharedChangeVersion(env, {
    ...skill,
    change: changeOf(latest),
  });
  const version =
    landed ??
    (await writeSharedSkill(env, {
      ...skill,
      change: changeOf(latest),
      text: latest.text,
      retired: latest.shareId === null,
      after: current,
    }));
  if (version === "stale") {
    return "stale";
  }
  await recordOutcomes(env, skill, decisions, latest, version);
  return "done";
};

/**
 * Makes the Brain follow the latest decision on `skill` (an audience's
 * skill of a name; see the threat model above), and records each
 * decision's outcome once. Idempotent: run it as often as you like, from
 * anywhere. Reads the Brain's current version before the decisions, so
 * whatever it writes is over a version older than every decision it
 * didn't see: one of those lands first and its write is refused as stale,
 * then read again. Each audience's skill of a name is its own: a team's
 * and the company's of one name never touch each other.
 */
export const reconcileSkill = async (
  env: Env,
  skill: SharedSkill
): Promise<void> => {
  for (let attempt = 0; attempt < reconcileAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only once refused
    if ((await reconcileOnce(env, skill)) === "done") {
      return;
    }
  }
  // Refused as stale each time: written over again and again meanwhile.
  // Left to the clock, said once, by the attempts alone (a name is the
  // company's, but the log holds no content).
  log.warn("skills.reconcile_left_to_clock", { attempts: reconcileAttempts });
};

/** `reconcileSkill`, its failure logged: the clock runs it again. */
const reconcileNow = async (env: Env, skill: SharedSkill): Promise<void> => {
  try {
    await reconcileSkill(env, skill);
  } catch (error) {
    log.error("skills.reconcile_failed", errorFields(error));
  }
};

/**
 * Reconciles every audience's skill with a decision whose outcome isn't
 * recorded (`reconcileSkill`): core's clock runs it each minute, so a
 * decision whose write or record failed is finished without anyone
 * asking. A decision without an audience it can read is never
 * reconciled, never as the company's: it is said once a run, by count.
 */
export const reconcileSkills = async (env: Env): Promise<void> => {
  const open = await drizzle(env.DB)
    .selectDistinct({
      audience: skillDecisions.audience,
      name: skillDecisions.name,
    })
    .from(skillDecisions)
    .where(isNull(skillDecisions.outcome));
  let unread = 0;
  for (const { audience: stored, name } of open) {
    const audience = audienceOf(stored);
    if (audience === null) {
      unread += 1;
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a skill at a time
    await reconcileNow(env, { audience, name });
  }
  if (unread > 0) {
    log.warn("skills.reconcile_no_audience", { skills: unread });
  }
};

/**
 * Approves the share `id` as the admin `by`: decides its exact text as
 * its audience's skill of its name, in one batch with its event, only
 * while the share still waits, its asker may still be decided for (in its
 * team, for a team's) and `by` is still an admin (`skills.not_found`
 * otherwise, nothing written), then reconciles that skill. A failure
 * after the decision is the clock's to finish: the decision stands.
 */
export const approveShare = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<SkillShare> => {
  requireAdmin(by);
  const shareId = shareIdOf(id);
  const decisionId = crypto.randomUUID();
  const db = drizzle(env.DB);
  const now = Date.now();
  await auditedBatch(env, db, [
    db.insert(skillDecisions).select(
      sql`SELECT ${decisionId}, ${skillShares.name},
          (SELECT COALESCE(MAX(${skillDecisions.seq}), 0) + 1 FROM ${skillDecisions}
            WHERE ${skillDecisions.audience} = ${skillShares.audience}
              AND ${skillDecisions.name} = ${skillShares.name}),
          ${skillShares.id}, ${skillShares.text}, ${by.userId}, ${now}, NULL, NULL,
          ${skillShares.audience}
        FROM ${skillShares}
        WHERE ${skillShares.id} = ${shareId}
          AND ${decidable()}
          AND ${deciding(by)}`
    ),
    db
      .update(skillShares)
      .set({
        status: "approved",
        decidedBy: by.userId,
        decidedAt: new Date(now),
        text: null,
      })
      .where(
        and(
          eq(skillShares.id, shareId),
          eq(skillShares.status, "pending"),
          sql`EXISTS (SELECT 1 FROM ${skillDecisions} WHERE ${skillDecisions.id} = ${decisionId})`
        )
      ),
    outboxedIfChanged(db, shareEntry(actorOf(by), "approved", shareId)),
  ]);
  const [decided] = await db
    .select({ audience: skillDecisions.audience, name: skillDecisions.name })
    .from(skillDecisions)
    .where(eq(skillDecisions.id, decisionId));
  const audience = audienceOf(decided?.audience);
  if (decided === undefined || audience === null) {
    throw skillErrors.create("skills.not_found");
  }
  await reconcileNow(env, { audience, name: decided.name });
  return await shareById(env, shareId);
};

/**
 * Declines the share `id` as the admin `by`, dropping its text, only while
 * it still waits and may be decided, and `by` is still an admin;
 * `skills.not_found` otherwise.
 */
export const declineShare = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<SkillShare> => {
  requireAdmin(by);
  const shareId = shareIdOf(id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(skillShares)
      .set({
        status: "declined",
        decidedBy: by.userId,
        decidedAt: new Date(),
        text: null,
      })
      .where(and(eq(skillShares.id, shareId), decidable(), deciding(by))),
    outboxedIfChanged(db, shareEntry(actorOf(by), "declined", shareId)),
  ]);
  const decided = await shareById(env, shareId);
  if (decided.status !== "declined") {
    throw skillErrors.create("skills.not_found");
  }
  return decided;
};

/**
 * Retires `audience`'s skill `name` (the company's, or a team's) as the
 * admin `by`: decides, in one batch with its event (`skill.retired`),
 * that nobody lists, selects or reads it from then on (its versions stay
 * as history), only while its latest decision is an approval and `by` is
 * still an admin; `skills.not_found` otherwise. Then reconciles it. A new
 * approved share of the name for that audience brings it back.
 */
export const retireSkill = async (
  env: Env,
  by: Identity,
  name: unknown,
  audience: unknown
): Promise<void> => {
  requireAdmin(by);
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  const retired = audienceAskedOf(audience);
  const key = audienceKeyOf(retired);
  const decisionId = crypto.randomUUID();
  const db = drizzle(env.DB);
  const latest = sql`(SELECT MAX(${skillDecisions.seq}) FROM ${skillDecisions}
    WHERE ${skillDecisions.audience} = ${key} AND ${skillDecisions.name} = ${named})`;
  await auditedBatch(env, db, [
    db.insert(skillDecisions).select(
      sql`SELECT ${decisionId}, ${named}, ${skillDecisions.seq} + 1, NULL,
          ${skillDecisions.text}, ${by.userId}, ${Date.now()}, NULL, NULL, ${key}
        FROM ${skillDecisions}
        WHERE ${skillDecisions.audience} = ${key}
          AND ${skillDecisions.name} = ${named}
          AND ${skillDecisions.seq} = ${latest}
          AND ${skillDecisions.shareId} IS NOT NULL
          AND ${deciding(by)}`
    ),
    outboxedIfChanged(
      db,
      skillEntry(actorOf(by), "skill.retired", retired, named)
    ),
  ]);
  const [decided] = await db
    .select({ id: skillDecisions.id })
    .from(skillDecisions)
    .where(eq(skillDecisions.id, decisionId));
  if (decided === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  await reconcileNow(env, { audience: retired, name: named });
};

/**
 * The shares that wait for an admin and may be decided now: what the
 * waiting feed lists for the organization's own admins, by ID, name,
 * audience and when, never their text.
 */
export const waitingShares = async (
  env: Env,
  by: Identity
): Promise<SkillShare[]> => {
  if (!isMemberAdmin(by)) {
    return [];
  }
  const rows = await sharesQuery(drizzle(env.DB))
    .where(decidable())
    .orderBy(asc(skillShares.requestedAt), asc(skillShares.id));
  return rows.flatMap(shareOf);
};
