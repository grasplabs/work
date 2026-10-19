import { createFileRoute } from "@tanstack/react-router";

import { OverviewTab } from "../landscape/overview-tab.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";

const Overview = () => {
  const { app } = useAppPage();
  return app === null ? null : <OverviewTab app={app} />;
};

export const Route = createFileRoute("/_shell/landscape/$appId/overview")({
  component: Overview,
});
