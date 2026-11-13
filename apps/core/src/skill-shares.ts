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
import { and, asc, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
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
  companySkillVersionOf,
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
//   has with the version it made) and auditing nothing twice. Of several
//   approvals of one name, the last add to land is live, and every row and
//   event says at which version: the store writes an add only over the
//   version it was read at, so one refused as stale never landed, and is
//   superseded when a later approval exists. Retiring is audited before
//   the Brain write too. Nothing uses a company skill but from the Brain,
//   so none is used before it is in.
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

/**
 * Whether an approval of the same name decided after `share`'s exists:
 * asked only once the store refused `share`'s add as stale, so it never
 * landed and that later approval takes its place. Two decided in the same
 * millisecond count as neither later: then the stale refusal ends as
 * failed, and approving again settles it, which is harmless.
 */
const laterApprovalExists = async (
  env: Env,
  share: Pick<ShareRow, "id" | "name" | "decidedAt">
): Promise<boolean> => {
  if (share.decidedAt === null) {
    return false;
  }
  const [later] = await drizzle(env.DB)
    .select({ id: skillShares.id })
    .from(skillShares)
    .where(
      and(
        eq(skillShares.name, share.name),
        eq(skillShares.status, "approved"),
        ne(skillShares.id, share.id),
        gt(skillShares.decidedAt, share.decidedAt)
      )
    )
    .limit(1);
  return later !== undefined;
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
 * Approves the share `id` as the admin `by`, as a pair of audit events:
 * the decision (`skill.share.approved`), written with the decision before
 * anything reaches the Brain, and its outcome, one per attempt.
 *
 * The rule: the last add to land is live, and every row and event says
 * at which version. The add is made over the company skill's current
 * version as read here; the store writes it only while that is still
 * current (in its own transaction), and answers a change it already has
 * (this share's, `share:<id>`) with the version it made, first. So:
 * - landed: the version it answered holds this share's text and was
 *   current when it landed; recorded on the row with
 *   `skill.share.added`, always, however late (a retry after a lost
 *   reply included).
 * - refused as stale: this change never landed. With a later approval of
 *   the same name, the share is `superseded` (`skill.share.superseded`);
 *   without one, `skill.share.approve_failed`, and the admin approves
 *   again.
 * - any other failure: `skill.share.approve_failed`; approving again
 *   finishes it, without a second decision.
 * A decision with no outcome is one whose attempt stopped half-way.
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
  let version: number;
  try {
    const after = await companySkillVersionOf(env, by.userId, decided.name);
    ({ version } = await addCompanySkill(env, by.userId, {
      name: decided.name,
      change: `share:${decided.id}`,
      text: decided.text,
      after,
    }));
  } catch (error) {
    // Refused as stale: this change never landed. A later approval of
    // the name takes its place.
    if (
      skillErrors.codeOf(error) === "skills.changed" &&
      (await laterApprovalExists(env, decided))
    ) {
      await supersede(env, by, decided);
      throw skillErrors.create("skills.superseded");
    }
    await sayOutcome(
      env,
      shareEntry(by, "approve_failed", decided.id),
      "skills.approve_failed_unaudited"
    );
    throw error;
  }
  // The version the store answered, always: it holds this share's text,
  // and was current when it landed. Recorded once, with its outcome.
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
    outboxedIfChanged(db, shareEntry(by, "added", decided.id, { version })),
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
 * selects or reads it from then on, and its versions stay as history. A
 * pair of audit events: the decision (`skill.retired`), written before the
 * Brain write, so nothing is retired unaudited, and its outcome:
 * `skill.retire_done` with the version retired, or `skill.retire_failed`
 * (`skills.changed` when an approval landed in between). Retiring a skill
 * this retired already answers the retirement it made, with its outcome:
 * so a retry after an outcome that wasn't recorded ends in
 * `skill.retire_done`. `skills.not_found` when the company never had such
 * a skill.
 */
export const retireSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  requireAdmin(by);
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  if ((await companySkillVersionOf(env, by.userId, named)) === null) {
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
    retired = await retireCompanySkill(env, by.userId, { name: named });
  } catch (error) {
    await sayOutcome(
      env,
      entry("skill.retire_failed"),
      "skills.retire_failed_unaudited"
    );
    throw error;
  }
  if (retired === null) {
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
