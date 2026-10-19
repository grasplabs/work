import { createFileRoute } from "@tanstack/react-router";

import { UsageTab } from "../landscape/usage-tab.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";

const Usage = () => {
  const { app } = useAppPage();
  return app === null ? null : <UsageTab appName={app.name} />;
};

export const Route = createFileRoute("/_shell/landscape/$appId/usage/")({
  // `?team=Sales` opens the tab filtered to one team, as in the prototype.
  validateSearch: (search: Record<string, unknown>): { team?: string } =>
    typeof search.team === "string" && search.team !== ""
      ? { team: search.team }
      : {},
  component: Usage,
});
