import { createFileRoute } from "@tanstack/react-router";

import { AppsAsked } from "../admin/integrations.tsx";
import { loadEveryAdmin } from "../admin/org-loads.ts";
import { freshMs } from "../admin/org-reads.ts";

interface IntegrationsSearch {
  /** The app open in its sheet, by its key. */
  app?: string;
}

const Integrations = () => {
  const { admins } = Route.useLoaderData();
  return <AppsAsked admins={admins} open={Route.useSearch().app} />;
};

/** The apps the companies asked Grasp to add (src/admin/integrations.tsx). */
export const Route = createFileRoute("/connectors")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch =>
    typeof search.app === "string" && search.app !== ""
      ? { app: search.app }
      : {},
  loader: loadEveryAdmin,
  staleTime: freshMs,
  // A preload reads nothing: opened, the page loads anew and reads them.
  preloadStaleTime: 0,
  component: Integrations,
});
