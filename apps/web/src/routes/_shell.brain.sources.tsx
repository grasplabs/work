import { createFileRoute } from "@tanstack/react-router";

import { useBrainData } from "../brain/brain-data.ts";
import { SourcesPage } from "../brain/sources-page.tsx";

// Brain › Sources: what the new Brain keeps that the person may read, its
// search, and how their connections feed it (GRA-1734). The connections
// are the ones the brain's layout already read (`brain.read`).

const Sources = () => {
  const { workspace } = useBrainData();
  const { concept } = Route.useSearch();
  return (
    <SourcesPage
      concept={concept}
      connections={workspace.connections.filter(
        ({ status }) => status === "connected"
      )}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/sources")({
  // Concepts for Ruben (concept branch only): ?concept=b or ?concept=c.
  validateSearch: (search: Record<string, unknown>): { concept?: string } =>
    typeof search.concept === "string" ? { concept: search.concept } : {},
  component: Sources,
});
