import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsToBuild } from "../../admin/integrations.tsx";

/** The integrations Grasp builds into the platform itself (src/admin/integrations.tsx). */
export const Route = createFileRoute("/admin/integrations")({
  component: IntegrationsToBuild,
});
