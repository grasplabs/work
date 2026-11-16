import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage } from "../brain/skills-page.tsx";

// Brain › Skills: the person's own skills, sharing one with the company,
// the company's, and, for admins, the shares waiting for them (GRA-1754).

export const Route = createFileRoute("/_shell/brain/skills")({
  component: SkillsPage,
});
