import { createFileRoute } from "@tanstack/react-router";

import { AppsAsked } from "../admin/integrations.tsx";

interface IntegrationsSearch {
  /** The app open in its sheet, by its key. */
  app?: string;
}

const Integrations = () => <AppsAsked open={Route.useSearch().app} />;

/** The apps the companies asked Grasp to add (src/admin/integrations.tsx). */
export const Route = createFileRoute("/integrations")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch =>
    typeof search.app === "string" && search.app !== ""
      ? { app: search.app }
      : {},
  component: Integrations,
});
