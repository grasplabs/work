import { createFileRoute } from "@tanstack/react-router";

import { DataTab } from "../landscape/data-tab.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";

const Data = () => {
  const { app } = useAppPage();
  return app === null ? null : <DataTab app={app} />;
};

export const Route = createFileRoute("/_shell/landscape/$appId/data")({
  component: Data,
});
