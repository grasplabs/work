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
  OwnSkillShare,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
  SkillText,
} from "@grasp-os/shared/skills";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember } from "./auth/membership-sql.ts";
import {
  addOwnSkill,
  companyChangeVersion,
  companySkillVersion,
  eraseOwnSkill,
  listSkillsAs,
  readCurrentSkillAs,
  readSkillAs,
  writeCompanySkill,
} from "./brain-next.ts";
import type { SkillCardAt } from "./brain-next.ts";
import {
  personErasures,
  skillDecisions,
  skillDeletions,
  skillShares,
  users,
} from "./db/core/schema.ts";
import { shippedSkills } from "./shipped-skills.ts";

// Writing skills, and sharing one with the company (GRA-1754). Threat
// model on GRA-1754; what could go wrong, and what stops it:
//
// - Someone else's own skill read, listed or used: a person's own skills
//   are in their own store (brain-next.ts), and every call here names the
//   person from their session (`Identity`), never from what they send.
// - Instructions planted company-wide (a company skill steers every
//   member's agents): a company skill is written only as an admin's
//   decision says, and a decision is written only by one of the
//   organization's own admins (never Grasp staff), checked in the very
//   statement that writes it. An approval decides the share's exact text,
//   taken from the person's own stored skill at the version they named
//   (never from what anyone sends), and only while that share still waits:
//   a share asked again, deleted with its skill or of a person removed is
//   gone, so a click on an older card is refused, never applied to text
//   nobody reviewed or that is gone. Agents have no call here.
// - The Brain saying something other than what was decided: core's
//   database is the one record of what should be live (`skill_decisions`,
//   numbered per name; the latest is the name's desired state). One
//   reconciler per name makes the Brain follow it, idempotently: it reads
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
// - Audit: asks and decisions by the share's ID, a retirement by the
//   skill's name, its only identifier; never a skill's text. A person's own
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

/** That `by` is one of the organization's admins as the statement runs. */
const deciding = (by: Identity) => activeMember(by.userId, ["admin"]);

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
  text: string | null;
  status: SkillShare["status"];
  requestedAt: Date;
  userId: string;
  userName: string | null;
  decidedAt: Date | null;
  outcome: "landed" | "superseded" | null;
  version: number | null;
}

/** Shares with their asker and their decision, if any. */
const sharesQuery = (db: ReturnType<typeof drizzle>) =>
  db
    .select(shareColumns)
    .from(skillShares)
    .leftJoin(users, eq(users.id, skillShares.requestedBy))
    .leftJoin(skillDecisions, eq(skillDecisions.shareId, skillShares.id));

const shareOf = (row: ShareRow): SkillShare => ({
  id: row.id,
  name: row.name,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  requestedBy: { userId: row.userId, name: row.userName },
  decidedAt: row.decidedAt?.toISOString() ?? null,
  version: row.outcome === "landed" ? row.version : null,
  superseded: row.outcome === "superseded",
});

/** The share `id`, or `skills.not_found`. */
const shareById = async (env: Env, id: string): Promise<ShareRow> => {
  const [row] = await sharesQuery(drizzle(env.DB)).where(
    eq(skillShares.id, id)
  );
  if (row === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  return row;
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

/** The audit entry of something that happened to the company's skill `name`. */
const skillEntry = (
  actor: AuditActor,
  action: string,
  name: string,
  detail: Record<string, number> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "company_skill", id: name },
  detail,
});

/**
 * What the skills page shows `by`: their own skills, the company's, their
 * own shares, and, for admins, every share that waits, with its text.
 */
export const skillsOverview = async (
  env: Env,
  by: Identity
): Promise<SkillsOverview> => {
  const db = drizzle(env.DB);
  const [listed, shares] = await Promise.all([
    listSkillsAs(env, by.userId, noShipped, { personal: true }),
    sharesQuery(db)
      .where(eq(skillShares.requestedBy, by.userId))
      .orderBy(desc(skillShares.requestedAt), desc(skillShares.id)),
  ]);
  const company = listed.filter(({ scope }) => scope === "company");
  const companyNames = new Set(company.map(({ name }) => name));
  /** What approving a share of `name` replaces for everyone, if anything. */
  const replacedBy = (name: string): SkillShareRequest["replaces"] => {
    if (companyNames.has(name)) {
      return "company";
    }
    return shippedNames.has(name) ? "grasp" : null;
  };
  const requests = isMemberAdmin(by)
    ? await sharesQuery(db)
        .where(eq(skillShares.status, "pending"))
        .orderBy(asc(skillShares.requestedAt), asc(skillShares.id))
    : null;
  /** Whether a waiting share's text is no longer the person's current one. */
  const ownOf = async (row: ShareRow): Promise<OwnSkillShare> => {
    if (row.status !== "pending" || row.text === null) {
      return { ...shareOf(row), outdated: false };
    }
    const current = await readCurrentSkillAs(env, by.userId, {
      scope: "person",
      name: row.name,
    });
    return {
      ...shareOf(row),
      outdated: current !== null && current.text !== row.text,
    };
  };
  return {
    own: listed.filter(({ scope }) => scope === "person").map(listedOf),
    company: company.map(listedOf),
    shares: await Promise.all(shares.map(ownOf)),
    requests:
      requests?.flatMap((row): SkillShareRequest[] =>
        row.text === null
          ? []
          : [
              {
                ...shareOf(row),
                text: row.text,
                replaces: replacedBy(row.name),
              },
            ]
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
    db
      .insert(skillDeletions)
      .values({ personId: by.userId, name: named })
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
 * with the company: it waits for an admin, in place of the share of it
 * that waited, which goes. Written only while they are a member, no
 * erasure of them has begun and they haven't deleted the skill, checked in
 * the write itself: `permission.person_inactive` or `skills.not_found`
 * otherwise, and nothing written.
 */
export const shareOwnSkill = async (
  env: Env,
  by: Identity,
  name: unknown,
  version: unknown
): Promise<SkillShare> => {
  const wanted = skillErrors.parse(
    "skills.invalid",
    z.strictObject({ name: nameSchema, version: versionSchema }),
    { name, version }
  );
  const read = await readSkillAs(env, by.userId, {
    scope: "person",
    ...wanted,
  });
  if (read === null) {
    throw skillErrors.create("skills.not_found");
  }
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  const deleted = sql`EXISTS (SELECT 1 FROM ${skillDeletions}
    WHERE ${skillDeletions.personId} = ${by.userId}
      AND ${skillDeletions.name} = ${read.name})`;
  const askable = sql`${activeMember(by.userId)}
    AND NOT EXISTS (SELECT 1 FROM ${personErasures}
      WHERE ${personErasures.userId} = ${by.userId})
    AND NOT ${deleted}`;
  await auditedBatch(env, db, [
    db
      .delete(skillShares)
      .where(
        and(
          eq(skillShares.requestedBy, by.userId),
          eq(skillShares.name, read.name),
          eq(skillShares.status, "pending")
        )
      ),
    db.insert(skillShares).select(
      sql`SELECT ${id}, ${read.name}, ${read.text}, ${by.userId}, ${Date.now()}, 'pending', NULL, NULL
          WHERE ${askable}`
    ),
    outboxedIfChanged(db, shareEntry(actorOf(by), "requested", id)),
  ]);
  const [written] = await sharesQuery(db).where(eq(skillShares.id, id));
  if (written !== undefined) {
    return shareOf(written);
  }
  const [deletion] = await db
    .select({ name: skillDeletions.name })
    .from(skillDeletions)
    .where(
      and(
        eq(skillDeletions.personId, by.userId),
        eq(skillDeletions.name, read.name)
      )
    );
  throw deletion === undefined
    ? permissionErrors.create("permission.person_inactive")
    : skillErrors.create("skills.not_found");
};

/** The change key a decision writes the Brain under: its own. */
const changeOf = (decision: { id: string }): string =>
  `decision:${decision.id}`;

type Decision = typeof skillDecisions.$inferSelect;

/** The core's actor for what the reconciler records. */
const reconciler: AuditActor = { type: "system" };

/** The outcome event of `decision`: what became of it in the Brain. */
const outcomeEntry = (
  decision: Decision,
  outcome: { version: number } | "superseded"
): AuditEntry => {
  if (decision.shareId === null) {
    return outcome === "superseded"
      ? skillEntry(reconciler, "skill.retire_superseded", decision.name)
      : skillEntry(reconciler, "skill.retire_done", decision.name, outcome);
  }
  return outcome === "superseded"
    ? shareEntry(reconciler, "superseded", decision.shareId)
    : shareEntry(reconciler, "added", decision.shareId, outcome);
};

/**
 * Records the outcomes of `decisions` once `latest` landed at `version`:
 * its own, and each earlier one's not recorded yet, from the store (the
 * version its change made, or none: then the later decision came first,
 * and it never will, as every write is over a version read before the
 * decisions). One event per outcome, written only by the update that
 * records it.
 */
const recordOutcomes = async (
  env: Env,
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
    const landed = await companyChangeVersion(env, {
      name: decision.name,
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
    outboxedIfChanged(db, outcomeEntry(decision, outcome)),
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
  name: string
): Promise<"done" | "stale"> => {
  const current = await companySkillVersion(env, name);
  const decisions = await drizzle(env.DB)
    .select()
    .from(skillDecisions)
    .where(eq(skillDecisions.name, name))
    .orderBy(asc(skillDecisions.seq));
  const latest = decisions.at(-1);
  if (
    latest === undefined ||
    decisions.every(({ outcome }) => outcome !== null)
  ) {
    return "done";
  }
  const landed = await companyChangeVersion(env, {
    name,
    change: changeOf(latest),
  });
  const version =
    landed ??
    (await writeCompanySkill(env, {
      name,
      change: changeOf(latest),
      text: latest.text,
      retired: latest.shareId === null,
      after: current,
    }));
  if (version === "stale") {
    return "stale";
  }
  await recordOutcomes(env, decisions, latest, version);
  return "done";
};

/**
 * Makes the Brain follow the latest decision on the company's skill `name`
 * (see the threat model above), and records each decision's outcome once.
 * Idempotent: run it as often as you like, from anywhere. Reads the
 * Brain's current version before the decisions, so whatever it writes is
 * over a version older than every decision it didn't see: one of those
 * lands first and its write is refused as stale, then read again.
 */
export const reconcileSkill = async (env: Env, name: string): Promise<void> => {
  for (let attempt = 0; attempt < reconcileAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only once refused
    if ((await reconcileOnce(env, name)) === "done") {
      return;
    }
  }
};

/** `reconcileSkill`, its failure logged: the clock runs it again. */
const reconcileNow = async (env: Env, name: string): Promise<void> => {
  try {
    await reconcileSkill(env, name);
  } catch (error) {
    log.error("skills.reconcile_failed", errorFields(error));
  }
};

/**
 * Reconciles every name with a decision whose outcome isn't recorded
 * (`reconcileSkill`): core's clock runs it each minute, so a decision
 * whose write or record failed is finished without anyone asking.
 */
export const reconcileSkills = async (env: Env): Promise<void> => {
  const names = await drizzle(env.DB)
    .selectDistinct({ name: skillDecisions.name })
    .from(skillDecisions)
    .where(isNull(skillDecisions.outcome));
  for (const { name } of names) {
    // oxlint-disable-next-line no-await-in-loop -- a name at a time
    await reconcileNow(env, name);
  }
};

/**
 * Approves the share `id` as the admin `by`: decides its exact text as the
 * company's skill of its name, in one batch with its event, only while the
 * share still waits and `by` is still an admin (`skills.not_found`
 * otherwise, nothing written), then reconciles the name. A failure after
 * the decision is the clock's to finish: the decision stands.
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
            WHERE ${skillDecisions.name} = ${skillShares.name}),
          ${skillShares.id}, ${skillShares.text}, ${by.userId}, ${now}, NULL, NULL
        FROM ${skillShares}
        WHERE ${skillShares.id} = ${shareId}
          AND ${skillShares.status} = 'pending'
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
    .select({ name: skillDecisions.name })
    .from(skillDecisions)
    .where(eq(skillDecisions.id, decisionId));
  if (decided === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  await reconcileNow(env, decided.name);
  return shareOf(await shareById(env, shareId));
};

/**
 * Declines the share `id` as the admin `by`, dropping its text, only while
 * it still waits and `by` is still an admin; `skills.not_found` otherwise.
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
      .where(
        and(
          eq(skillShares.id, shareId),
          eq(skillShares.status, "pending"),
          deciding(by)
        )
      ),
    outboxedIfChanged(db, shareEntry(actorOf(by), "declined", shareId)),
  ]);
  const decided = await shareById(env, shareId);
  if (decided.status !== "declined") {
    throw skillErrors.create("skills.not_found");
  }
  return shareOf(decided);
};

/**
 * Retires the company's skill `name` as the admin `by`: decides, in one
 * batch with its event (`skill.retired`), that nobody lists, selects or
 * reads it from then on (its versions stay as history), only while its
 * latest decision is an approval and `by` is still an admin;
 * `skills.not_found` otherwise. Then reconciles the name. A new approved
 * share of the name brings it back.
 */
export const retireSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  requireAdmin(by);
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  const decisionId = crypto.randomUUID();
  const db = drizzle(env.DB);
  const latest = sql`(SELECT MAX(${skillDecisions.seq}) FROM ${skillDecisions}
    WHERE ${skillDecisions.name} = ${named})`;
  await auditedBatch(env, db, [
    db.insert(skillDecisions).select(
      sql`SELECT ${decisionId}, ${named}, ${skillDecisions.seq} + 1, NULL,
          ${skillDecisions.text}, ${by.userId}, ${Date.now()}, NULL, NULL
        FROM ${skillDecisions}
        WHERE ${skillDecisions.name} = ${named}
          AND ${skillDecisions.seq} = ${latest}
          AND ${skillDecisions.shareId} IS NOT NULL
          AND ${deciding(by)}`
    ),
    outboxedIfChanged(db, skillEntry(actorOf(by), "skill.retired", named)),
  ]);
  const [decided] = await db
    .select({ id: skillDecisions.id })
    .from(skillDecisions)
    .where(eq(skillDecisions.id, decisionId));
  if (decided === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  await reconcileNow(env, named);
};

/**
 * The shares that wait for an admin: what the waiting feed lists for the
 * organization's own admins, by ID, name and when, never their text.
 */
export const waitingShares = async (
  env: Env,
  by: Identity
): Promise<SkillShare[]> => {
  if (!isMemberAdmin(by)) {
    return [];
  }
  const rows = await sharesQuery(drizzle(env.DB))
    .where(eq(skillShares.status, "pending"))
    .orderBy(asc(skillShares.requestedAt), asc(skillShares.id));
  return rows.map(shareOf);
};
