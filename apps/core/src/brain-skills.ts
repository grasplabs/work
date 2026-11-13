import { selectSkills } from "@grasp-os/brain-next/skills";
import { brainQuestionMaxLength } from "@grasp-os/shared/brain-sources";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { skillErrors } from "@grasp-os/shared/skills";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { keepAuditEvent } from "./audit-outbox.ts";
import { addShippedSkill, listSkillsAs, readSkillAs } from "./brain-next.ts";
import type {
  Reach,
  SkillAt,
  SkillCardAt,
  SkillListed,
  SkillScope,
  SkillVersion,
} from "./brain-next.ts";
import { shippedSkills } from "./shipped-skills.ts";
import type { ShippedSkill } from "./shipped-skills.ts";
import {
  heldNothing,
  meets,
  needsAnything,
  skillNeedsOf,
} from "./skill-needs.ts";
import type { HeldCapabilities } from "./skill-needs.ts";

export type { SkillAt, SkillCardAt, SkillVersion } from "./brain-next.ts";

// Skills in the Brain (GRA-1826, GRA-1754, GRA-1844), as chats, Apps and
// workflows read them: Grasp's own, which each release ships and installs
// here, the company's shared ones, each team's, and a person's own. This
// file holds the rules; brain-next.ts names them for the Brain.
//
// - Who reads: the person the code acts for, while a member, through the
//   Brain's own reader check, with their teams as core counts them at
//   each read: someone who leaves a team stops getting its skills from
//   their next turn. A skill is guidance, and grants nothing: what the
//   agent or code does after reading it is checked against its own
//   grants.
// - How far (`SkillsReach`): a person's own skills only where what they
//   shape reaches that person alone, their own chat; their teams' in the
//   rest of their own conversation; a conversation others share gets
//   Grasp's and the company's alone, as it recalls nothing of a team.
// - Needs (skill-needs.ts): a skill that declares a connection or a tool
//   the caller doesn't hold now is never listed, selected or read: it is
//   as if it weren't there, so nothing of it reaches the model.
// - Which, of one name: Grasp's only by the names this release ships (one
//   a release dropped stays in the Brain as history, never selected or
//   read); then the company's over Grasp's, a team's over both for its
//   members (only they are ever given it), and the person's own over all,
//   for them alone. Each is still read when named by its scope, so a pin
//   taken before keeps working.
// - Selection: the skills whose name or description shares the task's
//   telling words, as recall's words way matches them, best first, a
//   few; none when none does. No model call.
// - A pin: each skill comes at its version, and a read takes that version,
//   so a release changing the text mid-task changes nothing the task read.
// - Writing: Grasp's by the release's install, here; the company's and a
//   team's only by an admin's approval of a person's share, and a person's
//   own by that person alone, both in skill-shares.ts. Agents only read.

/** The names of Grasp's skills this release ships. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

/**
 * Puts each of `skills` (this release's, unless a test passes others) into
 * the Brain as Grasp's own: only those whose current text differs from
 * the release's are written, as their next version, all with one change
 * key minted for this install. The others are still written whatever one
 * does:
 *
 * - one the Brain refuses as no skill of this release (`skills.invalid`:
 *   a name it doesn't ship, a frontmatter naming another skill, a text
 *   too long) fails alike every time until another release, so it isn't
 *   tried again: it is logged and audited by name (Grasp's own names
 *   aren't secret; a name the release doesn't ship, by its place alone)
 *   and doesn't hold the install back. The test that every shipped
 *   skill's frontmatter names it (brain-skills.test.ts) keeps it out of a
 *   release;
 * - one that fails otherwise (the Brain out of reach) is logged by its
 *   place, and the install answers incomplete, so the next one compares
 *   it again (builtins.ts stores the release's fingerprint only once the
 *   install is complete).
 *
 * Audited once, as the system: which release (its version, when the
 * Worker knows it), how many it shipped, wrote, found invalid and failed
 * to write, and the invalid ones' names; never a text. Resolves `false`
 * when a skill's write failed (the Brain out of reach, or refusing it while
 * it restores an export): that one is tried again by the next install. A
 * skill the Brain refuses as invalid doesn't make it `false`: it can't
 * succeed in this release, and is logged and audited instead. The release's
 * install on the first request runs it (builtins.ts).
 */
export const installShippedSkills = async (
  env: Env,
  skills: readonly ShippedSkill[] = shippedSkills
): Promise<boolean> => {
  const change = crypto.randomUUID();
  let changed = 0;
  let failed = 0;
  const invalid: string[] = [];
  for (const [position, { name, text }] of skills.entries()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few skills, one at a time
      const added = await addShippedSkill(env, { name, change, text });
      changed += added.changed ? 1 : 0;
    } catch (error) {
      if (skillErrors.codeOf(error) === "skills.invalid") {
        const shippedName = shippedNames.has(name) ? name : null;
        invalid.push(shippedName ?? `#${position}`);
        log.error("skills.install_invalid", {
          position,
          ...(shippedName === null ? {} : { name: shippedName }),
        });
      } else {
        failed += 1;
        log.error("skills.install_failed", {
          position,
          ...errorFields(error),
        });
      }
    }
  }
  // A shared skill steers every agent: what the release changed is
  // recorded, as Grasp's own act.
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: { type: "system" },
    action: "brain.skills.installed",
    target: { type: "brain", id: "skills" },
    detail: {
      release: env.CF_VERSION_METADATA?.id ?? null,
      shipped: skills.length,
      changed,
      invalid: invalid.length,
      invalidNames:
        invalid.length === 0
          ? null
          : invalid.join(",").slice(0, identifierMaxLength),
      failed,
    },
  });
  return failed === 0;
};

/** The person `by` acts for, from an `Authority` checked whole. */
const personOf = (by: Authority): string =>
  permissionErrors.parse("permission.context_invalid", authoritySchema, by)
    .onBehalfOf;

/**
 * How far the skills read for a chat go, as recall's reach (brain-next.ts
 * `Reach`): `person` where what they shape reaches the person alone (their
 * own attended chat), with their own skills and their teams'; `teams` in
 * the rest of their own conversation (a turn nobody asked for, a chat
 * app's direct message), with their teams' but never their own; and
 * `company` where others read the answer too (a thread or channel they
 * share), with Grasp's and the company's alone, as such a conversation
 * recalls nothing of a team either.
 */
export type SkillsReach = Reach;

/**
 * What a chat's scope may read of skills (`SkillsReach`): opt-in, so a
 * scope that doesn't say it is the person's own attended turn (`ownChat`,
 * set by that turn alone) never gets their own skills, and one others
 * share (`shared`) gets no team's.
 */
export const skillsReachOf = (
  scope: { ownChat?: boolean },
  shared: boolean
): SkillsReach => {
  if (shared) {
    return "company";
  }
  return scope.ownChat === true ? "person" : "teams";
};

/**
 * What the caller holds now, asked only when a skill it might be given
 * declares a need (skill-needs.ts): a failure is the caller's to take as
 * holding nothing.
 */
export type HeldNow = () => Promise<HeldCapabilities>;

/** Which of one name takes the place of the rest: the higher. */
const rankOf: Record<SkillScope, number> = {
  grasp: 0,
  company: 1,
  team: 2,
  person: 3,
};

/** `skill` as code and the prompt read it: without what it needs. */
const cardOf = (skill: SkillListed): SkillCardAt =>
  skill.scope === "team"
    ? {
        scope: skill.scope,
        team: skill.team,
        name: skill.name,
        version: skill.version,
        description: skill.description,
      }
    : {
        scope: skill.scope,
        name: skill.name,
        version: skill.version,
        description: skill.description,
      };

/**
 * The skills the code `by` acts with may use, by name, as far as `reach`
 * goes (brain-next.ts `listSkillsAs`): only those whose needs `held`
 * meets, asked only when one declares a need; then, of one name, those of
 * the highest scope alone, a person's own over their team's, a team's over
 * the company's, the company's over Grasp's (two teams' of one name are
 * both kept). A skill whose needs aren't met is dropped first, so it
 * takes no other's place: it is as if it weren't there. Refused with
 * `permission.person_inactive` once the person it acts for is no longer a
 * member.
 */
export const skillsFor = async (
  env: Env,
  by: Authority,
  reach: SkillsReach,
  held: HeldNow
): Promise<SkillCardAt[]> => {
  const listed = await listSkillsAs(env, personOf(by), shippedNames, {
    reach,
  });
  const holds = listed.some(({ needs }) => needsAnything(needs))
    ? await held()
    : heldNothing;
  const usable = listed.filter(({ needs }) => meets(holds, needs));
  const top = new Map<string, number>();
  for (const { name, scope } of usable) {
    top.set(name, Math.max(top.get(name) ?? 0, rankOf[scope]));
  }
  return usable
    .filter(({ name, scope }) => rankOf[scope] === top.get(name))
    .map((skill) => cardOf(skill))
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.scope === "team" && b.scope === "team"
          ? a.team.localeCompare(b.team)
          : 0)
    );
};

/** A task, in the asker's words, as a question to the Brain is. */
const taskSchema = z.strictObject({
  task: z.string().trim().min(1).max(brainQuestionMaxLength),
});

/**
 * The skills of `skillsFor` that apply to `input.task`, best first, a few
 * at most, each at its current version: keep it for the task, and read
 * that version. None when no skill shares a telling word with the task.
 * Refused with `skills.invalid` for input that isn't a task.
 */
export const selectSkillsFor = async (
  env: Env,
  by: Authority,
  reach: SkillsReach,
  held: HeldNow,
  input: unknown
): Promise<SkillCardAt[]> => {
  const { task } = skillErrors.parse("skills.invalid", taskSchema, input);
  return selectSkills(task, await skillsFor(env, by, reach, held));
};

const versionSchema = z.int().positive();

const skillAtSchema = z.strictObject({
  // As a listing or a selection gives it: what else it carries (its
  // description) is accepted and dropped here, by name, whatever zod's
  // default for unknown keys.
  skill: z.union([
    z
      .looseObject({
        scope: z.enum(["grasp", "company", "person"]),
        name: z.string(),
        version: versionSchema,
      })
      .transform(({ scope, name, version }) => ({ scope, name, version })),
    z
      .looseObject({
        scope: z.literal("team"),
        team: z.string(),
        name: z.string(),
        version: versionSchema,
      })
      .transform(({ scope, team, name, version }) => ({
        scope,
        team,
        name,
        version,
      })),
  ]),
});

/**
 * The skill `input.skill` at exactly its version, whole, as a selection
 * pinned it: its text is guidance, never a grant. `skills.not_found`,
 * alike, for a skill or version there isn't, one the person may no longer
 * read (a team's they left), one past `reach` (their own short of the
 * person's, a team's at the company's), one of Grasp's this release
 * doesn't ship, and one whose needs `held` doesn't meet;
 * `skills.invalid` for input that isn't a skill at a version. A skill
 * that another of its name replaces is still read when named by its
 * scope: the replacing decides what is listed and selected, so a task
 * that pinned it before keeps reading what it pinned.
 */
export const readSkillFor = async (
  env: Env,
  by: Authority,
  reach: SkillsReach,
  held: HeldNow,
  input: unknown
): Promise<SkillVersion> => {
  const { skill } = skillErrors.parse("skills.invalid", skillAtSchema, input);
  const wanted: SkillAt = skill;
  // Read first, so the person's membership is checked alike for every
  // skill named; brain-next.ts checks the rest of its shape.
  const read = await readSkillAs(env, personOf(by), wanted, { reach });
  if (
    read === null ||
    (read.scope === "grasp" && !shippedNames.has(read.name))
  ) {
    throw skillErrors.create("skills.not_found");
  }
  const needs = skillNeedsOf(read.text);
  if (needs === null || (needsAnything(needs) && !meets(await held(), needs))) {
    throw skillErrors.create("skills.not_found");
  }
  return read;
};
