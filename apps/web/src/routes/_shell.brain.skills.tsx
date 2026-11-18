import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { opportunityOf } from "../brain/opportunity-drafts.ts";
import { SkillsPage } from "../brain/skills-page.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Brain › Skills: the person's own skills, sharing one with the company,
// the company's, and, for admins, the shares waiting for them (GRA-1754).
// From an opportunity an admin drafts as a skill (`?opportunity=`, Brain ›
// Opportunities), the editor starts with a skill for it (GRA-1751).

/** What the address says: the opportunity the editor starts with. */
interface SkillsSearch {
  opportunity?: string;
}

const Skills = () => {
  const { opportunity } = Route.useLoaderData();
  return <SkillsPage opportunity={opportunity} />;
};

export const Route = createFileRoute("/_shell/brain/skills")({
  validateSearch: (search: Record<string, unknown>): SkillsSearch =>
    typeof search.opportunity === "string"
      ? { opportunity: search.opportunity }
      : {},
  loaderDeps: ({ search: { opportunity } }) => ({ opportunity }),
  // Deferred, and only for the organization's admins, who alone read
  // opportunities: the page never waits.
  loader: ({ context: { core, identity }, deps: { opportunity } }) => ({
    opportunity:
      opportunity === undefined || !isMemberAdmin(identity)
        ? undefined
        : loadFromCore(
            core,
            async (session) => await opportunityOf(session, opportunity)
          ),
  }),
  component: Skills,
});
