import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute, useRouteContext } from "@tanstack/react-router";

import { useBrainData } from "../brain/brain-data.ts";
import { SourcesPage } from "../brain/sources-page.tsx";

// Brain › Sources: every source the person may read, of every kind, and
// its search (GRA-1734). The Brain's own sources and the connections are
// the ones the brain's layout already read (`brain.read`).

const Sources = () => {
  const { workspace } = useBrainData();
  const { identity } = useRouteContext({ from: "/_shell" });
  return (
    <SourcesPage
      connections={workspace.connections.filter(
        ({ status }) => status === "connected"
      )}
      sources={workspace.sources}
      teams={identity.teams}
      admin={isAdmin(identity.role)}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/sources")({
  component: Sources,
});
