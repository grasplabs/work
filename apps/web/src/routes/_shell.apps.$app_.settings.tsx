import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { AppSettings, settingsSectionOf } from "../apps/app-settings.tsx";
import type { AppSettingsSection } from "../apps/app-settings.tsx";
import { readStoreChanges } from "../apps/store-changes.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// An App's settings (apps/app-settings.tsx), for everyone who opens the
// App, each section as they may see it, from "…" on the App's bar; its
// builders have the same beside the chat in its workspace. The inbox and
// the admin's pages link here for what is decided about an App: its
// versions and its connections.

const AppSettingsPage = () => {
  const { page, storeChanges } = Route.useLoaderData();
  const { section } = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Apps`, to: "/apps" }, { label: t`App` }]}
        icon={LayoutGridIcon}
        notFound={t`App not found`}
        page={page}
      />
    );
  }
  const app = page.data;
  const appName = app.name;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Apps`, to: "/apps" },
          { label: app.name, to: "/apps/$app", params: { app: app.id } },
          { label: t`Settings` },
        ]}
      />
      {/* The page's heading: the section's heads what is open. */}
      <h1 className="sr-only">
        <Trans>Settings of {appName}</Trans>
      </h1>
      <AppSettings
        app={app}
        identity={identity}
        key={app.id}
        section={section}
        storeChanges={storeChanges}
        within="page"
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/$app_/settings")({
  pendingComponent: PageLoading,
  component: AppSettingsPage,
  // The section to open; any other value (an old or hand-typed address)
  // opens General. Always set, as the address's own would otherwise pass
  // through unchecked (the root route reads the search raw).
  validateSearch: (
    search: Record<string, unknown>
  ): { section?: AppSettingsSection | undefined } => ({
    section: settingsSectionOf(search.section),
  }),
  loader: async ({ context: { core, identity }, params }) => {
    // Only for who may abandon a store's failed change: the
    // organization's own admins. Not awaited: General waits for it.
    const storeChanges = readStoreChanges(core, identity, params.app);
    const page = await loadFromCore(
      core,
      async (session) => await session.apps.get(params.app)
    );
    return { storeChanges, page };
  },
});
