import { skillCardOf } from "@grasp-os/brain-next/skills";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
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
import { and, asc, desc, eq, isNull, ne, not, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appendAuditEvent,
  auditedBatch,
  outboxed,
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
import { shippedSkills } from "./shipped-skills.ts";

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
// - A decision that reads as done when it isn't, or one done unaudited:
//   approving records the decision and its one `skill.share.approved`
//   event in one batch (one conditional update from `pending`), before
//   anything reaches the Brain; then adds the text to the Brain under the
//   share's ID as its change; then records the version on the row. When
//   the add fails the call throws, `skill.share.approve_failed` is
//   audited, and the share shows approved without a version: approving it
//   again finishes it, adding nothing twice (the Brain answers a change it
//   has with the version it made) and auditing nothing twice. One a later
//   approval of the same name overtook is refused as superseded, never
//   written over the newer text. Retiring is audited before the Brain
//   write too. Nothing uses a company skill but from the Brain, so none is
//   used before it is in.
// - A skill granting access: none does. Writing, sharing, approving or
//   retiring one creates no permission, binding or grant.
// - Audit: requests and decisions by the share's ID; a company skill's
//   retirement by its name, its only identifier; never a skill's text.
//   A person's own skills, which affect no one else, are not audited, as
//   their own instruction file isn't.

const nameSchema = z.string().min(1).max(64);

/** The names of Grasp's skills this release ships, which a company skill replaces. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

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
  // Their skill could have been deleted for good meanwhile
  // (`removeOwnSkill` erases it, then drops what waits of it): asked
  // again after the share is written, so whichever lands last, no share
  // of a deleted skill is left waiting.
  const still = await readSkillAs(env, by.userId, {
    scope: "person",
    ...wanted,
  });
  if (still === null) {
    await db
      .delete(skillShares)
      .where(and(eq(skillShares.id, id), eq(skillShares.status, "pending")));
    throw skillErrors.create("skills.not_found");
  }
  return shareOf(await shareById(env, id));
};

/**
 * Writes `entry`, an outcome, straight to the log: a failure to is logged
 * by `failed`, never thrown, so it hides nothing the caller throws.
 */
const sayOutcome = async (
  env: Env,
  entry: AuditEntry,
  failed: string
): Promise<void> => {
  try {
    await appendAuditEvent(env, entry);
  } catch (error) {
    log.error(failed, errorFields(error));
  }
};

/** That a share approved after `share`, of the same name, exists, as SQL. */
const laterApprovalOf = (share: Pick<ShareRow, "id" | "name" | "decidedAt">) =>
  sql`EXISTS (
    SELECT 1 FROM ${skillShares} later
    WHERE later.name = ${share.name}
      AND later.status = 'approved'
      AND later.id <> ${share.id}
      AND later.decided_at > ${share.decidedAt?.getTime() ?? 0}
  )`;

/**
 * Whether a later approval of the same name than `share`'s overtook it:
 * then adding `share`'s text now would write the older text over the newer.
 */
const overtaken = async (
  env: Env,
  share: Pick<ShareRow, "id" | "name" | "decidedAt">
): Promise<boolean> => {
  const [row] = await drizzle(env.DB)
    .select({ overtaken: sql<number>`${laterApprovalOf(share)}` })
    .from(sql`(SELECT 1)`);
  return row?.overtaken === 1;
};

/**
 * Marks `share` superseded, its text dropped, with its outcome
 * (`skill.share.superseded`), once: while it is still approved and not
 * added.
 */
const supersede = async (
  env: Env,
  by: Identity,
  share: Pick<ShareRow, "id">
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(skillShares)
      .set({ status: "superseded", text: null })
      .where(
        and(
          eq(skillShares.id, share.id),
          eq(skillShares.status, "approved"),
          isNull(skillShares.version)
        )
      ),
    outboxedIfChanged(db, shareEntry(by, "superseded", share.id)),
  ]);
};

/**
 * After `share`'s text landed in the Brain although a later approval of
 * the same name exists: puts the latest approval's text back on top
 * (under a change of its own, which adds nothing when it is current
 * already), so an older text never stays over a newer approval.
 */
const restoreNewest = async (
  env: Env,
  by: Identity,
  share: Pick<ShareRow, "id" | "name">
): Promise<void> => {
  const [newest] = await drizzle(env.DB)
    .select({ text: skillShares.text, version: skillShares.version })
    .from(skillShares)
    .where(
      and(
        eq(skillShares.name, share.name),
        eq(skillShares.status, "approved"),
        ne(skillShares.id, share.id)
      )
    )
    .orderBy(desc(skillShares.decidedAt), desc(skillShares.id))
    .limit(1);
  if (newest === undefined) {
    return;
  }
  // Waiting for its add, it holds its text; added, the Brain does.
  let { text } = newest;
  if (text === null && newest.version !== null) {
    const added = await readSkillAs(env, by.userId, {
      scope: "company",
      name: share.name,
      version: newest.version,
    });
    text = added?.text ?? null;
  }
  if (text === null) {
    return;
  }
  await addCompanySkill(env, by.userId, {
    name: share.name,
    change: `restore:${share.id}`,
    text,
  });
};

/**
 * Approves the share `id` as the admin `by`, as a pair of audit events:
 * the decision (`skill.share.approved`), written with the decision before
 * anything reaches the Brain, and its outcome, one per attempt:
 * `skill.share.added` with the version, written with the version on the
 * row; `skill.share.approve_failed` when the add fails (approving again
 * finishes it, without a second decision); or `skill.share.superseded`
 * when a later approval of the same name came first (the share's status
 * says so, and the newer text stays on top). A decision with no outcome
 * is one whose attempt stopped half-way: approving again finishes it.
 * `skills.not_found` for a share there isn't or that was declined or
 * replaced; `skills.superseded` for one superseded.
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
    // The decision and its event, in one batch, before the Brain sees
    // anything: an approval is never live unaudited.
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
  if (decided.status === "superseded") {
    throw skillErrors.create("skills.superseded");
  }
  if (decided.status !== "approved" || decided.text === null) {
    if (decided.status === "approved") {
      return shareOf(decided);
    }
    throw skillErrors.create("skills.not_found");
  }
  if (await overtaken(env, decided)) {
    await supersede(env, by, decided);
    throw skillErrors.create("skills.superseded");
  }
  let version: number;
  try {
    ({ version } = await addCompanySkill(env, by.userId, {
      name: decided.name,
      change: `share:${decided.id}`,
      text: decided.text,
    }));
  } catch (error) {
    await sayOutcome(
      env,
      shareEntry(by, "approve_failed", decided.id),
      "skills.approve_failed_unaudited"
    );
    throw error;
  }
  // The version and its outcome, in one step, only while no later
  // approval of the name exists: one that came in meanwhile is checked
  // in the same statement, so this add is never recorded as the
  // company's over a newer one.
  await auditedBatch(env, db, [
    db
      .update(skillShares)
      .set({ version, text: null })
      .where(
        and(
          eq(skillShares.id, decided.id),
          eq(skillShares.status, "approved"),
          isNull(skillShares.version),
          not(laterApprovalOf(decided))
        )
      ),
    outboxedIfChanged(db, shareEntry(by, "added", decided.id, { version })),
  ]);
  const recorded = await shareById(env, decided.id);
  if (recorded.status === "approved" && recorded.version === null) {
    // Overtaken while this add was on its way: the newer text goes back
    // on top, and this one is superseded.
    await restoreNewest(env, by, decided);
    await supersede(env, by, decided);
    throw skillErrors.create("skills.superseded");
  }
  return shareOf(recorded);
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
 * selects or reads it from then on, and its versions stay as history. A
 * pair of audit events: the decision (`skill.retired`), written before the
 * Brain write, so nothing is retired unaudited, and its outcome:
 * `skill.retire_done` with the version the Brain retired, or
 * `skill.retire_failed`. `skills.not_found` when the company has no such
 * skill live.
 */
export const retireSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  requireAdmin(by);
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  const live = await readCurrentSkillAs(env, by.userId, {
    scope: "company",
    name: named,
  });
  if (live === null) {
    throw skillErrors.create("skills.not_found");
  }
  const entry = (action: string, detail: Record<string, number> = {}) => ({
    actor: actorOf(by),
    action,
    target: { type: "company_skill", id: named },
    detail,
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [outboxed(db, entry("skill.retired"))]);
  let retired: number | null;
  try {
    retired = await retireCompanySkill(env, by.userId, {
      name: named,
      change: crypto.randomUUID(),
    });
  } catch (error) {
    await sayOutcome(
      env,
      entry("skill.retire_failed"),
      "skills.retire_failed_unaudited"
    );
    throw error;
  }
  if (retired === null) {
    // Retired by someone else between the read and the write.
    await sayOutcome(
      env,
      entry("skill.retire_failed"),
      "skills.retire_failed_unaudited"
    );
    throw skillErrors.create("skills.not_found");
  }
  await auditedBatch(env, db, [
    outboxed(db, entry("skill.retire_done", { version: retired })),
  ]);
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
    .orderBy(asc(skillShares.requestedAt), asc(skillShares.id));
  return rows.map(shareOf);
};
