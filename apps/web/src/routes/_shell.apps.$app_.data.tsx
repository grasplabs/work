import { buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, LayoutGridIcon } from "lucide-react";

import { AppData } from "../engines/app-data.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// A domain's data (engines/app-data.tsx), for its builders and the admins:
// core refuses anyone else, and the page says so as for a domain it can't
// open.

const AppDataPage = () => {
  const page = Route.useLoaderData();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Domains`, to: "/domains" }, { label: t`Domain` }]}
        icon={LayoutGridIcon}
        notFound={t`Domain not found`}
        page={page}
      />
    );
  }
  const { app, tables } = page.data;
  const appName = app.name;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Domains`, to: "/domains" },
          { label: app.name },
          { label: t`Data` },
        ]}
      />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 text-sm md:px-6">
        <div>
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            params={{ app: app.id }}
            to="/apps/$app"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            <Trans>Back to {appName}</Trans>
          </Link>
        </div>
        <h1 className="text-2xl font-medium tracking-tight">
          <Trans>Data of {appName}</Trans>
        </h1>
        {/* Opening another domain on this page starts afresh. */}
        <AppData
          app={app.id}
          key={`${app.id}/${tables.version}`}
          tables={tables.tables}
          version={tables.version}
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/$app_/data")({
  pendingComponent: PageLoading,
  component: AppDataPage,
  loader: async ({ context: { core }, params }) =>
    await loadFromCore(core, async (session) => {
      const [app, tables] = await Promise.all([
        session.apps.get(params.app),
        session.apps.data.tables(params.app),
      ]);
      return { app, tables };
    }),
});
