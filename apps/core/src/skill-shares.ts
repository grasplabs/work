import { skillCardOf } from "@grasp-os/brain-next/skills";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema } from "@grasp-os/shared/ids";
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { skillErrors } from "@grasp-os/shared/skills";
import type {
  ListedSkill,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
  SkillText,
} from "@grasp-os/shared/skills";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appendAuditEvent,
  auditedBatch,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import {
  addCompanySkill,
  addOwnSkill,
  eraseOwnSkill,
  listSkillsAs,
  readCurrentSkillAs,
  readSkillAs,
  retireCompanySkill,
} from "./brain-next.ts";
import type { SkillCardAt } from "./brain-next.ts";
import { skillShares, users } from "./db/core/schema.ts";

// Writing skills, and sharing one with the company (GRA-1754). Threat
// model on GRA-1754; what could go wrong, and what stops it:
//
// - Someone else's own skill read, listed or used: a person's own skills
//   are in their own store (brain-next.ts), and every call here names the
//   person from their session (`Identity`), never from what they send.
// - Instructions planted company-wide (a company skill steers every
//   member's agents): a company skill is added only by an approval, given
//   by one of the organization's own admins (never Grasp staff) on their
//   own session, of a share a person asked for on theirs. Agents have no
//   call here (agent-skills.ts only reads). A share takes its text from the
//   person's own stored skill at the version they name, never from what
//   they send, and keeps that text: the admin approves exactly the text
//   they were shown, so an edit after asking needs a new share. Asking
//   again replaces a waiting share under a new ID, so an approval of the
//   one shown is refused, never applied to text nobody reviewed.
// - A decision that reads as done when it isn't: approving records the
//   decision (one conditional update from `pending`, with its audit
//   event), then adds the text to the Brain under the share's ID as its
//   change, then records the version (with its own event). When the add
//   fails the call throws and the share shows approved without a version;
//   approving it again finishes it, adding nothing twice (the Brain answers
//   a change it has with the version it made). Nothing uses a company
//   skill but from the Brain, so none is used before it is in.
// - A skill granting access: none does. Writing, sharing, approving or
//   retiring one creates no permission, binding or grant.
// - Audit: requests and decisions by the share's ID; a company skill's
//   retirement by its name, its only identifier; never a skill's text.
//   A person's own skills, which affect no one else, are not audited, as
//   their own instruction file isn't.

const nameSchema = z.string().min(1).max(64);

/** Grasp's skills aren't the page's: none of their names is asked for. */
const noShipped: ReadonlySet<string> = new Set();
const versionSchema = z.int().positive();

/** `by`, refused unless one of the organization's own admins. */
const requireAdmin = (by: Identity): void => {
  if (!isMemberAdmin(by)) {
    throw roleErrors.create("role.forbidden");
  }
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

/** A share as the page reads it, with its asker's name. */
const shareColumns = {
  id: skillShares.id,
  name: skillShares.name,
  text: skillShares.text,
  status: skillShares.status,
  requestedAt: skillShares.requestedAt,
  userId: skillShares.requestedBy,
  userName: users.name,
  decidedAt: skillShares.decidedAt,
  version: skillShares.version,
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
  version: number | null;
}

const shareOf = (row: ShareRow): SkillShare => ({
  id: row.id,
  name: row.name,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  requestedBy: { userId: row.userId, name: row.userName },
  decidedAt: row.decidedAt?.toISOString() ?? null,
  version: row.version,
});

/** Most shares a page lists of each kind. */
const sharesListed = 100;

/** The share `id`, or `skills.not_found`. */
const shareById = async (env: Env, id: unknown): Promise<ShareRow> => {
  const parsed = identifierSchema.safeParse(id);
  if (!parsed.success) {
    throw skillErrors.create("skills.not_found");
  }
  const [row] = await drizzle(env.DB)
    .select(shareColumns)
    .from(skillShares)
    .leftJoin(users, eq(users.id, skillShares.requestedBy))
    .where(eq(skillShares.id, parsed.data));
  if (row === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  return row;
};

/** The audit entry of something that happened to a share: its ID only. */
const shareEntry = (
  by: Identity,
  action: string,
  id: string,
  detail: Record<string, number> = {}
): AuditEntry => ({
  actor: actorOf(by),
  action: `skill.share.${action}`,
  target: { type: "skill_share", id },
  detail,
});

/**
 * What the skills page shows `by`: their own skills, the company's, their
 * own shares, and, for admins, every share that waits and every approved
 * one still to finish, each with its text.
 */
export const skillsOverview = async (
  env: Env,
  by: Identity
): Promise<SkillsOverview> => {
  const db = drizzle(env.DB);
  const [listed, shares] = await Promise.all([
    listSkillsAs(env, by.userId, noShipped, { personal: true }),
    db
      .select(shareColumns)
      .from(skillShares)
      .leftJoin(users, eq(users.id, skillShares.requestedBy))
      .where(eq(skillShares.requestedBy, by.userId))
      .orderBy(desc(skillShares.requestedAt), desc(skillShares.id))
      .limit(sharesListed),
  ]);
  const company = listed.filter(({ scope }) => scope === "company");
  const companyNames = new Set(company.map(({ name }) => name));
  const requests = isMemberAdmin(by)
    ? await db
        .select(shareColumns)
        .from(skillShares)
        .leftJoin(users, eq(users.id, skillShares.requestedBy))
        .where(
          or(
            eq(skillShares.status, "pending"),
            and(eq(skillShares.status, "approved"), isNull(skillShares.version))
          )
        )
        .orderBy(asc(skillShares.requestedAt), asc(skillShares.id))
        .limit(sharesListed)
    : null;
  return {
    own: listed.filter(({ scope }) => scope === "person").map(listedOf),
    company: company.map(listedOf),
    shares: shares.map(shareOf),
    requests:
      requests?.flatMap((row): SkillShareRequest[] =>
        row.text === null
          ? []
          : [
              {
                ...shareOf(row),
                text: row.text,
                replaces: companyNames.has(row.name),
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
 * Erases `by`'s own skill `name` for good, then drops their share of it
 * that waits, if any (its text is theirs). Safe to repeat.
 */
export const removeOwnSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  await eraseOwnSkill(env, by.userId, named);
  await drizzle(env.DB)
    .delete(skillShares)
    .where(
      and(
        eq(skillShares.requestedBy, by.userId),
        eq(skillShares.name, named),
        eq(skillShares.status, "pending")
      )
    );
};

/**
 * Asks to share `by`'s own skill `name`, exactly as it is at `version`,
 * with the company: it waits for an admin, in place of a share of it
 * that waits already, which is dropped.
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
    db.insert(skillShares).values({
      id,
      name: read.name,
      text: read.text,
      requestedBy: by.userId,
      requestedAt: new Date(),
      status: "pending",
    }),
    outboxedIfChanged(db, shareEntry(by, "requested", id)),
  ]);
  return shareOf(await shareById(env, id));
};

/**
 * Approves the share `id` as the admin `by`: records the decision, adds
 * its text as the next version of the company's skill of its name, then
 * records that version and drops the text. A share approved before whose
 * add didn't finish is finished. `skills.not_found` for a share there
 * isn't or that was declined or replaced.
 */
export const approveShare = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<SkillShare> => {
  requireAdmin(by);
  const row = await shareById(env, id);
  const db = drizzle(env.DB);
  if (row.status === "pending") {
    await auditedBatch(env, db, [
      db
        .update(skillShares)
        .set({
          status: "approved",
          decidedBy: by.userId,
          decidedAt: new Date(),
        })
        .where(
          and(eq(skillShares.id, row.id), eq(skillShares.status, "pending"))
        ),
      outboxedIfChanged(db, shareEntry(by, "approved", row.id)),
    ]);
  }
  // As it is now: approved by this call or one before, or not at all.
  const decided = await shareById(env, row.id);
  if (decided.status !== "approved" || decided.text === null) {
    if (decided.status === "approved") {
      return shareOf(decided);
    }
    throw skillErrors.create("skills.not_found");
  }
  let version: number;
  try {
    ({ version } = await addCompanySkill(env, by.userId, {
      name: decided.name,
      change: `share:${decided.id}`,
      text: decided.text,
    }));
  } catch (error) {
    // The decision stands, and its outcome is said: not added yet.
    // Approving it again finishes it.
    await appendAuditEvent(env, shareEntry(by, "publish_failed", decided.id));
    throw error;
  }
  await auditedBatch(env, db, [
    db
      .update(skillShares)
      .set({ version, text: null })
      .where(
        and(
          eq(skillShares.id, decided.id),
          eq(skillShares.status, "approved"),
          isNull(skillShares.version)
        )
      ),
    outboxedIfChanged(db, shareEntry(by, "published", decided.id, { version })),
  ]);
  return shareOf(await shareById(env, decided.id));
};

/**
 * Declines the share `id` as the admin `by`, dropping its text.
 * `skills.not_found` for a share there isn't or that no longer waits.
 */
export const declineShare = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<SkillShare> => {
  requireAdmin(by);
  const row = await shareById(env, id);
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
        and(eq(skillShares.id, row.id), eq(skillShares.status, "pending"))
      ),
    outboxedIfChanged(db, shareEntry(by, "declined", row.id)),
  ]);
  const decided = await shareById(env, row.id);
  if (decided.status !== "declined") {
    throw skillErrors.create("skills.not_found");
  }
  return shareOf(decided);
};

/**
 * Retires the company's skill `name` as the admin `by`: nobody lists,
 * selects or reads it from then on, and its versions stay as history.
 * `skills.not_found` when the company has no such skill live.
 */
export const retireSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  requireAdmin(by);
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  const retired = await retireCompanySkill(env, by.userId, {
    name: named,
    change: crypto.randomUUID(),
  });
  if (!retired) {
    throw skillErrors.create("skills.not_found");
  }
  await appendAuditEvent(env, {
    actor: actorOf(by),
    action: "skill.retired",
    target: { type: "company_skill", id: named },
  });
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
  const rows = await drizzle(env.DB)
    .select(shareColumns)
    .from(skillShares)
    .leftJoin(users, eq(users.id, skillShares.requestedBy))
    .where(eq(skillShares.status, "pending"))
    .orderBy(asc(skillShares.requestedAt), asc(skillShares.id))
    .limit(sharesListed);
  return rows.map(shareOf);
};
