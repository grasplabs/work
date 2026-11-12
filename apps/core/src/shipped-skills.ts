import drawAWorkflow from "../skills/draw-a-workflow/SKILL.md";
import interviewAStakeholder from "../skills/interview-a-stakeholder/SKILL.md";
import runABaseline from "../skills/run-a-baseline/SKILL.md";
import writeBoardPage from "../skills/write-board-page/SKILL.md";

/** A skill as a release ships it: its name (its folder's), and its `SKILL.md`. */
export interface ShippedSkill {
  name: string;
  text: string;
}

/**
 * Grasp's own skills this release ships, one `SKILL.md` each in
 * apps/core/skills/<name>/, the name being the folder's and the one its
 * frontmatter gives. Add a skill's folder here. The install puts each into
 * the Brain (brain-skills.ts), and only the ones listed here are selected
 * or read: a skill a release drops stays in the Brain as history.
 */
export const shippedSkills: readonly ShippedSkill[] = [
  { name: "draw-a-workflow", text: drawAWorkflow },
  { name: "interview-a-stakeholder", text: interviewAStakeholder },
  { name: "run-a-baseline", text: runABaseline },
  { name: "write-board-page", text: writeBoardPage },
];
