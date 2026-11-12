import { defineErrorFamily } from "./errors.ts";

// Skills: how things are done here, as `SKILL.md` documents kept in the
// Brain, Grasp's own (shipped with each release) and the company's shared
// ones (core's brain-skills.ts).

/** Why a skill couldn't be selected or read. */
export const skillErrors = defineErrorFamily({
  "skills.invalid": "That isn't a task or a skill.",
  "skills.not_found": "There's no such skill, or not at that version.",
});
