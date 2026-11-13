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
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appendAuditEvent,
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import {
  addCompanySkill,
  addOwnSkill,
  companyChangeVersionOf,
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
//   again replaces every open share of that skill (waiting, or approved
//   with no add landed) under a new ID, and deleting the skill for good
//   closes them too: a closed share's text is dropped, so an approval of
//   it is refused, never applied to text nobody reviewed or that is gone.
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
//   version it was read at, so one refused as stale never landed, ends as
//   failed, and lands once approved again. Retiring is audited before the
//   Brain write too. Nothing uses a company skill but from the Brain, so
//   none is used before it is in.
// - A close dropping what is live from the record: every close or delete
//   of a share (declined, asked again, deleted, erased with its person)
//   goes through `closingShares`, which first asks the store which version
//   that share's change made and records it with `skill.share.added`. Any
//   member may ask that, as the person asking again or deleting does: it
//   answers a version number alone, of an unguessable change key, never
//   text; the add itself stays an admin's.
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

/**
 * That a share is open, as SQL: waiting, or approved with no add landed
 * and its text kept. The one rule the decline, asking again, deleting
 * the skill, the admin's list and approving go by.
 */
const isOpen = or(
  eq(skillShares.status, "pending"),
  and(
    eq(skillShares.status, "approved"),
    isNull(skillShares.version),
    isNotNull(skillShares.text)
  )
);

/** That `row` is open, as `isOpen` says it. */
const openOf = (row: Pick<ShareRow, "status" | "version" | "text">): boolean =>
  row.status === "pending" ||
  (row.status === "approved" && row.version === null && row.text !== null);

const shareOf = (row: ShareRow): SkillShare => ({
  id: row.id,
  name: row.name,
  status: row.status,
  requestedAt: row.requestedAt.toISOString(),
  requestedBy: { userId: row.userId, name: row.userName },
  decidedAt: row.decidedAt?.toISOString() ?? null,
  version: row.version,
  open: openOf(row),
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
  by: Actor,
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
 * own shares, and, for admins, every open share (waiting, or approved with
 * no add landed), each with its text.
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
        .where(isOpen)
        .orderBy(asc(skillShares.requestedAt), asc(skillShares.id))
    : null;
  /**
   * Whether a waiting share's text is no longer the person's current one:
   * read for those waiting alone, at most one a name.
   */
  const outdatedOf = async (row: ShareRow): Promise<boolean> => {
    if (row.status !== "pending" || row.text === null) {
      return false;
    }
    const current = await readCurrentSkillAs(env, by.userId, {
      scope: "person",
      name: row.name,
    });
    return current !== null && current.text !== row.text;
  };
  const outdated = await Promise.all(shares.map(outdatedOf));
  return {
    own: listed.filter(({ scope }) => scope === "person").map(listedOf),
    company: company.map(listedOf),
    shares: shares.map((row, at) => ({
      ...shareOf(row),
      outdated: outdated[at] ?? false,
    })),
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
 * Records the version `share`'s add landed at, if it landed and isn't
 * recorded yet: the store's answer, asked by its change without sending
 * the text, then the version on the row with `skill.share.added`, once.
 * For a share about to be closed (a lost reply, a failed record), so its
 * record says what is live; and for a closed one approved again, which is
 * never added. Answers the version, or null when the change made none.
 */
const recordLanded = async (
  env: Env,
  by: Actor,
  share: Pick<ShareRow, "id" | "name" | "version">
): Promise<number | null> => {
  if (share.version !== null) {
    return share.version;
  }
  const version = await companyChangeVersionOf(env, by.userId, {
    name: share.name,
    change: `share:${share.id}`,
  });
  if (version === null) {
    return null;
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(skillShares)
      .set({ version, text: null })
      .where(and(eq(skillShares.id, share.id), isNull(skillShares.version))),
    outboxedIfChanged(db, shareEntry(by, "added", share.id, { version })),
  ]);
  return version;
};

/** Who closes shares: a person, by their ID, as the audit log names them. */
type Actor = Pick<Identity, "userId" | "staff">;

/**
 * Which shares a close takes, and why:
 * - `replaced`: their person asked again for that skill, or deleted it
 *   for good. A waiting one goes; an approved one with no add landed keeps
 *   its record and drops its text.
 * - `declined`: an admin declined it, waiting or approved with no add
 *   landed; its text goes.
 * - `unasked`: an ask just written for a skill deleted meanwhile.
 * - `erased`: their person is erased; every share of theirs goes.
 */
export type Closing =
  | { why: "replaced"; requestedBy: string; name: string }
  | { why: "declined"; id: string }
  | { why: "unasked"; id: string }
  | { why: "erased"; requestedBy: string };

/** The shares `closing` takes. */
const takenBy = (closing: Closing): SQL | undefined => {
  switch (closing.why) {
    case "replaced": {
      return and(
        eq(skillShares.requestedBy, closing.requestedBy),
        eq(skillShares.name, closing.name)
      );
    }
    case "declined":
    case "unasked": {
      return eq(skillShares.id, closing.id);
    }
    case "erased": {
      return eq(skillShares.requestedBy, closing.requestedBy);
    }
    default: {
      throw new Error("Unknown closing");
    }
  }
};

/**
 * The only way a share is closed or deleted, whatever the reason: it first
 * records the version each add among them landed at, if one did and
 * nothing recorded it (`recordLanded`: a lost reply, a failed record), so
 * the record and the log say what is live before the text or the row
 * goes; then it answers the statements that close them, for the caller's
 * batch. `by` is who closes them, asking the store as themselves.
 */
export const closingShares = async (
  env: Env,
  by: Actor,
  closing: Closing
): Promise<[BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]> => {
  const db = drizzle(env.DB);
  const taken = takenBy(closing);
  const unrecorded = await db
    .select({
      id: skillShares.id,
      name: skillShares.name,
      version: skillShares.version,
    })
    .from(skillShares)
    .where(
      and(
        taken,
        eq(skillShares.status, "approved"),
        isNull(skillShares.version)
      )
    );
  for (const share of unrecorded) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await recordLanded(env, by, share);
  }
  switch (closing.why) {
    case "replaced": {
      return [
        db
          .delete(skillShares)
          .where(and(taken, eq(skillShares.status, "pending"))),
        db.update(skillShares).set({ text: null }).where(and(taken, isOpen)),
      ];
    }
    case "declined": {
      return [
        db
          .update(skillShares)
          .set({
            status: "declined",
            decidedBy: by.userId,
            decidedAt: new Date(),
            text: null,
          })
          .where(and(taken, isOpen)),
      ];
    }
    case "unasked": {
      return [
        db
          .delete(skillShares)
          .where(and(taken, eq(skillShares.status, "pending"))),
      ];
    }
    case "erased": {
      return [db.delete(skillShares).where(taken)];
    }
    default: {
      throw new Error("Unknown closing");
    }
  }
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
 * Erases `by`'s own skill `name` for good, then closes their open shares
 * of it (`closingShares`: their text is theirs, and goes). Safe to
 * repeat.
 */
export const removeOwnSkill = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<void> => {
  const named = skillErrors.parse("skills.invalid", nameSchema, name);
  await eraseOwnSkill(env, by.userId, named);
  await drizzle(env.DB).batch(
    await closingShares(env, by, {
      why: "replaced",
      requestedBy: by.userId,
      name: named,
    })
  );
};

/**
 * Asks to share `by`'s own skill `name`, exactly as it is at `version`,
 * with the company: it waits for an admin, in place of every open share
 * of it (`closingShares`), which is closed.
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
  // The new ask replaces every open share of that skill of theirs.
  const replacing = await closingShares(env, by, {
    why: "replaced",
    requestedBy: by.userId,
    name: read.name,
  });
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    ...replacing,
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
    await db.batch(await closingShares(env, by, { why: "unasked", id }));
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
 * Approves the share `id` as the admin `by`, as a pair of audit events:
 * the decision (`skill.share.approved`), written with the decision before
 * anything reaches the Brain, and its outcome, one per attempt.
 *
 * The rule: the last add to land is live, and every row and event says at
 * which version. The add is made over the company skill's current version
 * as read here; the store writes it only while that is still current (in
 * its own transaction), and answers a change it already has (this
 * share's, `share:<id>`) with the version it made, first. Landed, the
 * version it answered is recorded on the row with `skill.share.added`,
 * always, however late. Anything else, a stale refusal included (the
 * change never landed), ends the attempt as `skill.share.approve_failed`:
 * the share stays approved with its text, and approving it again reads
 * the current version afresh and lands it, without a second decision. A
 * decision with no outcome is one whose attempt stopped half-way.
 * `skills.not_found` for a share there isn't or that is closed (declined,
 * or its text dropped by its person asking again or deleting the skill):
 * an approve that starts after the close never adds it. An add already on
 * its way when the share is closed may still land: the store's answer is
 * what is live, so the record step writes its version and
 * `skill.share.added` on the row whatever its status.
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
  // Its add landed, whatever became of it since (declined while the add
  // was on its way, say): the store's answer is the truth.
  if (decided.version !== null) {
    return shareOf(decided);
  }
  // Closed (declined, or its text dropped by the person asking again or
  // deleting the skill): never added from then on.
  if (decided.status !== "approved" || decided.text === null) {
    // Its add may have landed though nothing recorded it: recovered from
    // the store, never added.
    if ((await recordLanded(env, by, decided)) !== null) {
      return shareOf(await shareById(env, decided.id));
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
      // Whatever its status: closed while its add was on its way, the add
      // still landed, and the row and the log say what is live.
      .where(and(eq(skillShares.id, decided.id), isNull(skillShares.version))),
    // Logged when this recorded it, and when the row went meanwhile with
    // its person's erasure: the skill is live either way. By the share's
    // ID and the version alone, so nothing of the erased person is kept.
    outboxedWhere(
      db,
      shareEntry(by, "added", decided.id, { version }),
      sql`changes() > 0 OR NOT EXISTS (SELECT 1 FROM ${skillShares} WHERE ${skillShares.id} = ${decided.id})`
    ),
  ]);
  const [recorded] = await drizzle(env.DB)
    .select(shareColumns)
    .from(skillShares)
    .leftJoin(users, eq(users.id, skillShares.requestedBy))
    .where(eq(skillShares.id, decided.id));
  // Gone with its person's erasure: answered as it landed.
  return shareOf(recorded ?? { ...decided, version, text: null });
};

/**
 * Declines the open share `id` as the admin `by` (waiting, or approved
 * with no add landed), dropping its text. `skills.not_found` for a share
 * there isn't or that is closed.
 */
export const declineShare = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<SkillShare> => {
  requireAdmin(by);
  const row = await shareById(env, id);
  // What landed is recorded first: then it is no longer open to decline.
  const declining = await closingShares(env, by, {
    why: "declined",
    id: row.id,
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    ...declining,
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
    .where(isOpen)
    .orderBy(asc(skillShares.requestedAt), asc(skillShares.id));
  return rows.map(shareOf);
};
