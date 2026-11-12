import { selectSkills } from "@grasp-os/brain-next/skills";
import { brainQuestionMaxLength } from "@grasp-os/shared/brain-sources";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { skillErrors } from "@grasp-os/shared/skills";
import { z } from "zod";

import { addSkill, listSkillsAs, readSkillAs } from "./brain-next.ts";
import type { SkillAt, SkillCardAt, SkillVersion } from "./brain-next.ts";
import { shippedSkills } from "./shipped-skills.ts";
import type { ShippedSkill } from "./shipped-skills.ts";

export type { SkillAt, SkillCardAt, SkillVersion } from "./brain-next.ts";

// Skills in the Brain (GRA-1826, GRA-1754), as chats, Apps and workflows
// read them: Grasp's own, which each release ships and installs here, the
// company's shared ones, and a person's own. This file holds the rules;
// brain-next.ts names them for the Brain.
//
// - Who reads: the person the code acts for, while a member, through the
//   Brain's own reader check. A skill is guidance every member may read,
//   as the company's instruction file, and grants nothing: what the agent
//   or code does after reading it is checked against its own grants.
// - Which: Grasp's skills only by the names this release ships (one a
//   release dropped stays in the Brain as history, never selected or
//   read), a company skill of the same name in its place, as the
//   company's adapted copy, and the person's own of that name in place of
//   either, for them alone.
// - A person's own skills only where what they shape reaches that person
//   alone (`SkillsReach`): their own chat. A chat others share gets
//   Grasp's and the company's, and their own store is never addressed.
// - Selection: the skills whose name or description shares the task's
//   telling words, as recall's words way matches them, best first, a
//   few; none when none does. No model call.
// - A pin: each skill comes at its version, and a read takes that version,
//   so a release changing the text mid-task changes nothing the task read.
// - Writing: Grasp's by the release's install, here; the company's only by
//   an admin's approval of a person's share, and a person's own by that
//   person alone, both in skill-shares.ts. Agents only read.

/**
 * Puts each of `skills` (this release's, unless a test passes others) into
 * the Brain as Grasp's own, each change minted once for this install, so
 * a retry within it adds nothing twice, and a later install of the same
 * text adds nothing (the same text is the same version). A skill that
 * fails is logged, by its place in the list alone, and the others are
 * still added. Resolves whether every one is in. The release's install
 * on the first request runs it (builtins.ts).
 */
export const installShippedSkills = async (
  env: Env,
  skills: readonly ShippedSkill[] = shippedSkills
): Promise<boolean> => {
  const change = crypto.randomUUID();
  let complete = true;
  for (const [position, { name, text }] of skills.entries()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few skills, one at a time
      await addSkill(env, { skill: { scope: "grasp", name }, change, text });
    } catch (error) {
      complete = false;
      log.error("skills.install_failed", { position, ...errorFields(error) });
    }
  }
  return complete;
};

/** The person `by` acts for, from an `Authority` checked whole. */
const personOf = (by: Authority): string =>
  permissionErrors.parse("permission.context_invalid", authoritySchema, by)
    .onBehalfOf;

/** The names of Grasp's skills this release ships. */
const shippedNames: ReadonlySet<string> = new Set(
  shippedSkills.map(({ name }) => name)
);

/**
 * Where the skills read shape what reaches the person alone (their own
 * chat): then their own skills come too. Anywhere else (a chat others
 * share) only Grasp's and the company's, and their own store is never
 * addressed.
 */
export interface SkillsReach {
  personal: boolean;
}

/** Which of a skill's sources wins a name: the person's, the company's, Grasp's. */
const rank: Record<SkillCardAt["scope"], number> = {
  person: 0,
  company: 1,
  grasp: 2,
};

/**
 * The skills the code `by` acts with may use, by name: Grasp's this
 * release ships, the company's, and, with `personal`, the person's own,
 * one per name: the person's own in place of the company's, and the
 * company's in place of Grasp's, as each one's adapted copy. Refused with
 * `permission.person_inactive` once the person it acts for is no longer a
 * member.
 */
export const skillsFor = async (
  env: Env,
  by: Authority,
  { personal }: SkillsReach
): Promise<SkillCardAt[]> => {
  const listed = await listSkillsAs(env, personOf(by), { personal });
  const usable = listed.filter(
    ({ scope, name }) => scope !== "grasp" || shippedNames.has(name)
  );
  const byName = new Map<string, SkillCardAt>();
  for (const skill of usable) {
    const held = byName.get(skill.name);
    if (held === undefined || rank[skill.scope] < rank[held.scope]) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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
  input: unknown
): Promise<SkillCardAt[]> => {
  const { task } = skillErrors.parse("skills.invalid", taskSchema, input);
  return selectSkills(task, await skillsFor(env, by, reach));
};

const skillAtSchema = z.strictObject({
  // As a listing or a selection gives it: what else it carries (its
  // description) is left out.
  skill: z.object({
    scope: z.enum(["grasp", "company", "person"]),
    name: z.string(),
    version: z.int().positive(),
  }),
});

/**
 * The skill `input.skill` at exactly its version, whole, as a selection
 * pinned it: its text is guidance, never a grant. `skills.not_found`,
 * alike, for a skill or version there isn't, one the person may no longer
 * read, one of Grasp's this release doesn't ship, and, without
 * `personal`, any of the person's own (which is only ever theirs: another
 * person's is never found); `skills.invalid` for input that isn't a skill
 * at a version.
 */
export const readSkillFor = async (
  env: Env,
  by: Authority,
  { personal }: SkillsReach,
  input: unknown
): Promise<SkillVersion> => {
  const { skill } = skillErrors.parse("skills.invalid", skillAtSchema, input);
  const wanted: SkillAt = skill;
  if (wanted.scope === "person" && !personal) {
    // Their own store is never addressed here.
    throw skillErrors.create("skills.not_found");
  }
  // Read first, so the person's membership is checked alike for every
  // skill named.
  const read = await readSkillAs(env, personOf(by), wanted);
  if (
    read === null ||
    (wanted.scope === "grasp" && !shippedNames.has(wanted.name))
  ) {
    throw skillErrors.create("skills.not_found");
  }
  return read;
};
