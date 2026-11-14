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
//   read), and a company skill of the same name in its place in what is
//   listed and selected, as the company's adapted copy; Grasp's is still
//   read when named by its scope, so a pin taken before keeps working.
//   The person's own of a name takes the place of either in what is
//   listed and selected, for them alone.
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
 * Where the skills read shape what reaches the person alone (their own
 * chat): then their own skills come too. Anywhere else (a chat others
 * share) only Grasp's and the company's, and their own store is never
 * addressed.
 */
export interface SkillsReach {
  personal: boolean;
}

/**
 * What a chat's scope may read of skills: the person's own too only when
 * the scope says it is their own attended turn (`ownChat`, set by that
 * turn alone). Opt-in: a scope that doesn't say so, whatever made it,
 * gets Grasp's and the company's alone.
 */
export const skillsReachOf = (scope: { ownChat?: boolean }): SkillsReach => ({
  personal: scope.ownChat === true,
});

/**
 * The skills the code `by` acts with may use, by name: Grasp's this
 * release ships and the company's, a company skill in place of Grasp's of
 * the same name (brain-next.ts `listSkillsAs`), and, with `personal`, the
 * person's own, in place of either of the same name. Refused with
 * `permission.person_inactive` once the person it acts for is no longer a
 * member.
 */
export const skillsFor = async (
  env: Env,
  by: Authority,
  { personal }: SkillsReach
): Promise<SkillCardAt[]> => {
  const listed = await listSkillsAs(env, personOf(by), shippedNames, {
    personal,
  });
  const own = new Set(
    listed.filter(({ scope }) => scope === "person").map(({ name }) => name)
  );
  return listed
    .filter(({ scope, name }) => scope === "person" || !own.has(name))
    .toSorted((a, b) => a.name.localeCompare(b.name));
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
  // description) is accepted and dropped here, by name, whatever zod's
  // default for unknown keys.
  skill: z
    .looseObject({
      scope: z.enum(["grasp", "company", "person"]),
      name: z.string(),
      version: z.int().positive(),
    })
    .transform(({ scope, name, version }) => ({ scope, name, version })),
});

/**
 * The skill `input.skill` at exactly its version, whole, as a selection
 * pinned it: its text is guidance, never a grant. `skills.not_found`,
 * alike, for a skill or version there isn't, one the person may no longer
 * read, one of Grasp's this release doesn't ship, and, without
 * `personal`, any of the person's own (which is only ever theirs: another
 * person's is never found); `skills.invalid` for input that isn't a skill
 * at a version. A Grasp skill that a company skill of the same name
 * replaces is still read when named by its scope: the replacing decides
 * what is listed and selected, so a task that pinned Grasp's before keeps
 * reading what it pinned.
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
