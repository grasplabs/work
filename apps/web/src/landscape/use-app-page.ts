import { useLoaderData } from "@tanstack/react-router";

import type { AppAudit } from "./app-page.ts";
import type { LandscapeApp } from "./landscape.ts";

/**
 * The app a tab of its page is about, and its audit trail, as the page's
 * frame read them; no app while the frame shows that it didn't load or
 * isn't there (it then renders no tab).
 */
export const useAppPage = (): { app: LandscapeApp | null; audit: AppAudit } => {
  const { app, audit } = useLoaderData({ from: "/_shell/landscape/$appId" });
  return { app: app.state === "ready" ? app.data : null, audit };
};
