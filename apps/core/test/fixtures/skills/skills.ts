import type { ShippedSkill } from "../../../src/shipped-skills.ts";
import closeTheMonth from "./close-the-month/SKILL.md";
import fileAnExpense from "./file-an-expense/SKILL.md";

/**
 * The skills core's tests ship as the release's (`#shipped-skills`, which
 * vite.config.ts makes this module for them): two, the second naming the
 * first as its prerequisite, each for a task of its own. Never a
 * release's: core's build ships src/release-skills.ts.
 */
const skills: readonly ShippedSkill[] = [
  { name: "close-the-month", text: closeTheMonth },
  { name: "file-an-expense", text: fileAnExpense },
];
export default skills;
