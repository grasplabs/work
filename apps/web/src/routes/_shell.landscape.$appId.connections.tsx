import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsTab } from "../landscape/connections-tab.tsx";

export const Route = createFileRoute("/_shell/landscape/$appId/connections")({
  // `path` is the access path shown in the side panel, so a path can be
  // linked to, as in the prototype; Grasp observes no paths yet.
  validateSearch: (search: Record<string, unknown>): { path?: string } =>
    typeof search.path === "string" ? { path: search.path } : {},
  component: ConnectionsTab,
});
