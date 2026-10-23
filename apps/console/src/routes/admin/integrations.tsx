import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsToBuild } from "../../admin/integrations.tsx";

interface IntegrationsSearch {
  /** The app open in its sheet, by its key. */
  app?: string;
}

const Integrations = () => <IntegrationsToBuild open={Route.useSearch().app} />;

/** The integrations Grasp builds into the platform itself (src/admin/integrations.tsx). */
export const Route = createFileRoute("/admin/integrations")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch =>
    typeof search.app === "string" && search.app !== ""
      ? { app: search.app }
      : {},
  component: Integrations,
});
