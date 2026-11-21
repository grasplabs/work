import type { ShippedSkill } from "./shipped-skills.ts";

/**
 * Grasp's own skills this release ships (`#shipped-skills`): none for
 * now. Each is a `SKILL.md` in apps/core/skills/<name>/, imported here
 * and listed by its folder's name, which its frontmatter gives too; a
 * name listed whose file isn't there fails the build. Core's tests ship
 * their own instead (test/fixtures/skills/skills.ts).
 */
const skills: readonly ShippedSkill[] = [];
export default skills;
