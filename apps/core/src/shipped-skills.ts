import releaseSkills from "#shipped-skills";

/** A skill as a release ships it: its name (its folder's), and its `SKILL.md`. */
export interface ShippedSkill {
  name: string;
  text: string;
}

/**
 * Grasp's own skills this release ships, by name (src/release-skills.ts,
 * as `#shipped-skills`; core's tests ship fixtures of their own), which
 * may be none. The install puts each into the Brain (brain-skills.ts), and
 * only the ones listed here are listed, selected or read: one a release
 * drops stays in the Brain as history, which no agent, App or workflow
 * reaches again, and which no export holds.
 */
export const shippedSkills: readonly ShippedSkill[] = releaseSkills;
