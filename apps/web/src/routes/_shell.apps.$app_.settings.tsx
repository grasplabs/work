import type { DependencyApprovals } from "@grasp-os/shared/dependencies";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { AppSettings, settingsSectionOf } from "../engines/app-settings.tsx";
import type { AppSettingsSection } from "../engines/app-settings.tsx";
import { PackageApprovals } from "../engines/package-approvals.tsx";
import { readStoreChanges } from "../engines/store-changes.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// An App's settings (engines/app-settings.tsx), for everyone who opens the
// App, each section as they may see it, from "…" on the App's bar; its
// builders have the same beside the chat in its workspace. The inbox and
// the admin's pages link here for what is decided about an App: its
// versions, its connections, the approvals its packages wait on.
// Someone who may approve packages but isn't one of the App's members gets
// those alone: all core lets them read of it.

/**
 * The App for someone core lets read nothing of it but its approved
 * packages: its name and its approvals, and ending them; never its pages,
 * workflows or members.
 */
const PackagesOnlyView = ({ listed }: { listed: DependencyApprovals }) => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Apps`, to: "/apps" },
          { label: listed.subject.name },
        ]}
      />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7 text-sm">
        <div className="flex flex-col gap-0.5">
          <PageHeaderTitle>{listed.subject.name}</PageHeaderTitle>
          <p className="text-muted-foreground">
            <Trans>
              The packages approved for this App. You see them because you may
              approve packages; the rest of the App is for its members.
            </Trans>
          </p>
        </div>
        <section aria-labelledby="app-packages" className="flex flex-col gap-3">
          <h2 className="text-base font-medium" id="app-packages">
            <Trans>Packages</Trans>
          </h2>
          <PackageApprovals key={listed.subject.id} listed={listed} />
        </section>
      </div>
    </>
  );
};

const AppSettingsPage = () => {
  const { page, packagesOnly, storeChanges } = Route.useLoaderData();
  const { section } = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  if (page.state !== "ready") {
    const notLoaded = (
      <PageNotLoaded
        crumbs={[{ label: t`Apps`, to: "/apps" }, { label: t`App` }]}
        icon={LayoutGridIcon}
        notFound={t`App not found`}
        page={page}
      />
    );
    // Not a member: someone who may approve packages still gets those.
    return packagesOnly === undefined ? (
      notLoaded
    ) : (
      <Await fallback={<PageLoading />} promise={packagesOnly}>
        {(listed) =>
          listed.state === "ready" ? (
            <PackagesOnlyView listed={listed.data} />
          ) : (
            notLoaded
          )
        }
      </Await>
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
    // Not a member (core answers as for an App it doesn't have): someone
    // who may approve packages still gets those, and core alone decides
    // whether they are listed. Any other failure says why.
    const packagesOnly =
      page.state === "missing"
        ? loadFromCore(
            core,
            async (session) =>
              await session.dependencies.approvals({ app: params.app })
          )
        : undefined;
    return { storeChanges, page, packagesOnly };
  },
});
