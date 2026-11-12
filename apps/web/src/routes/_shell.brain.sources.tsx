import { createFileRoute, useRouteContext } from "@tanstack/react-router";

import { useBrainData } from "../brain/brain-data.ts";
import { SourcesPage } from "../brain/sources-page.tsx";

// Brain › Sources: what the new Brain keeps that the person may read, its
// search, and how their connections feed it (GRA-1734). The connections
// are the ones the brain's layout already read (`brain.read`).

const Sources = () => {
  const { workspace } = useBrainData();
  const { identity } = useRouteContext({ from: "/_shell" });
  return (
    <SourcesPage
      connections={workspace.connections.filter(
        ({ status }) => status === "connected"
      )}
      teams={identity.teams}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/sources")({
  component: Sources,
});
