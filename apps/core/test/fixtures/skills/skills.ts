import type { ShippedSkill } from "../../../src/shipped-skills.ts";
import bookATrip from "./book-a-trip/SKILL.md";
import closeTheMonth from "./close-the-month/SKILL.md";
import fileAnExpense from "./file-an-expense/SKILL.md";

/**
 * The skills core's tests ship as the release's (`#shipped-skills`, which
 * vite.config.ts makes this module for them), each for a task of its
 * own: `close-the-month` names `file-an-expense` as its prerequisite, and
 * `book-a-trip` is the one a test lets the company adapt, which the
 * file's other tests then leave alone. Never a release's: core's build
 * ships src/release-skills.ts.
 */
const skills: readonly ShippedSkill[] = [
  { name: "book-a-trip", text: bookATrip },
  { name: "close-the-month", text: closeTheMonth },
  { name: "file-an-expense", text: fileAnExpense },
];
export default skills;
