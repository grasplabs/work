import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { MemoryPage } from "../brain/memory-page.tsx";

// The Brain's memory records, inside the brain (GRA-298): a person's own
// and those shared with them, each with its lineage and correction.

const Memory = () => {
  const { identity } = Route.useRouteContext();
  const { concept } = Route.useSearch();
  return (
    <MemoryPage
      admin={isMemberAdmin(identity)}
      concept={concept}
      teams={identity.teams}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/memory")({
  // Concepts for Ruben (concept branch only): ?concept=b or ?concept=c.
  validateSearch: (search: Record<string, unknown>): { concept?: string } =>
    typeof search.concept === "string" ? { concept: search.concept } : {},
  component: Memory,
});
