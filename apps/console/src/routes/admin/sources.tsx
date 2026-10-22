import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { AdminPage } from "../../admin/page.tsx";
import { Sources } from "../../admin/sources.tsx";
import { organizationsOf } from "../../admin/views.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi("/admin");

/** Today in the browser's own calendar, as the digest names it: YYYY-MM-DD. */
const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** Where the admin's numbers come from, and where they go. */
const SourcesPage = () => {
  const views = organizationsOf(adminRoute.useLoaderData()).flatMap(
    ({ view }) => (view === null ? [] : [view])
  );
  return (
    <AdminPage
      description="Where the admin’s numbers come from, and where they go. Every system is reached through its own MCP server, so one chat can work across all of them."
      title="Sources"
    >
      <Sources today={localToday()} views={views} />
    </AdminPage>
  );
};

export const Route = createFileRoute("/admin/sources")({
  component: SourcesPage,
});
