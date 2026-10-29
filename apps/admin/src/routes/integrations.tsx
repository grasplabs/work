import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsToBuild } from "../admin/integrations.tsx";
import { fetchStoppedBuilds } from "../builds/functions.ts";

interface IntegrationsSearch {
  /** The app open in its sheet, by its key. */
  app?: string;
}

const Integrations = () => (
  <IntegrationsToBuild
    open={Route.useSearch().app}
    stopped={Route.useLoaderData()}
  />
);

/** The integrations Grasp builds into the platform itself (src/admin/integrations.tsx). */
export const Route = createFileRoute("/integrations")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch =>
    typeof search.app === "string" && search.app !== ""
      ? { app: search.app }
      : {},
  loader: async () => await fetchStoppedBuilds(),
  component: Integrations,
});
