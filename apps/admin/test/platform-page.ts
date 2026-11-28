import { fetchPlatform } from "../src/admin/platform-data.ts";
import { fetchReadiness } from "../src/admin/readiness.ts";
import { fetchAlertChannelsFn } from "../src/alerts/functions.ts";
import { fetchClientGrid } from "../src/clients/functions.ts";
import { fetchPlatformSpend } from "../src/platform-ai-functions.ts";
import { Route as PlatformRoute } from "../src/routes/platform/index.tsx";
import { Route as MaintenanceRoute } from "../src/routes/platform/maintenance.tsx";
import { callServerFn, renderedPage } from "./pages.ts";

/**
 * Platform, as `email` (a staff member) sees it: what its route reads,
 * through the Worker's entry as the page calls it, rendered
 * (src/routes/platform/index.tsx).
 */
export const platformPage = async (
  email = "staff@grasp.test"
): Promise<string> => {
  const caller = { email };
  const rows = await callServerFn(fetchClientGrid, undefined, caller);
  const platform = await callServerFn(fetchPlatform, undefined, caller);
  const readiness = await callServerFn(fetchReadiness, undefined, caller);
  // As the route reads it: a read that fails shows as a line.
  const spend = await callServerFn(fetchPlatformSpend, undefined, caller).catch(
    () => null
  );
  return await renderedPage(PlatformRoute, "/platform/", "/platform", {
    rows,
    platform,
    readiness,
    spend: Promise.resolve(spend),
  });
};

/** Platform's Maintenance, as `email` sees it (src/routes/platform/maintenance.tsx). */
export const maintenancePage = async (
  email = "staff@grasp.test"
): Promise<string> => {
  const caller = { email };
  const rows = await callServerFn(fetchClientGrid, undefined, caller);
  const platform = await callServerFn(fetchPlatform, undefined, caller);
  const alertChannels = await callServerFn(
    fetchAlertChannelsFn,
    undefined,
    caller
  );
  return await renderedPage(
    MaintenanceRoute,
    "/platform/maintenance",
    "/platform/maintenance",
    { rows, platform, alertChannels }
  );
};
