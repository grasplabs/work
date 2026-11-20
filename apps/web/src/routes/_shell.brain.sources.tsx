import { createFileRoute } from "@tanstack/react-router";

import { useBrainData } from "../brain/brain-data.ts";
import { SourcesPage } from "../brain/sources-page.tsx";

// Brain › Sources: every source the person may read, of every kind, and
// its search (GRA-1734). The Brain's own sources and the connections are
// the ones the brain's layout already read (`brain.read`).

const Sources = () => {
  const { workspace } = useBrainData();
  return (
    <SourcesPage
      connections={workspace.connections.filter(
        ({ status }) => status === "connected"
      )}
      sources={workspace.sources}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/sources")({
  component: Sources,
});
