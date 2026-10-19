import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Await,
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import { DownloadIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { ErrorText } from "../error-text.tsx";
import { PageLoading } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { loadAppPage } from "../landscape/app-page.ts";
import type { AppAudit } from "../landscape/app-page.ts";
import { downloadCsv } from "../landscape/download.ts";
import { appTabs, tabOf } from "../landscape/landscape-app.ts";
import {
  auditCsv,
  auditFileName,
  hasOlder,
  readWholeAppAudit,
  trailEvents,
} from "../landscape/landscape-audit.ts";
import type { AppAuditTrail } from "../landscape/landscape-audit.ts";
import type { LandscapeApp } from "../landscape/landscape.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The frame of every app page, as in the prototype
// (`components/landscape/app-layout.tsx`): the app's name with its vendor
// and users, the export of its audit trail on the right, the tabs, and the
// tab itself. The prototype also shows the app's browser extension there;
// Grasp sees no extensions yet.

/**
 * The export of the app's whole audit trail: it reads on from the stretch
 * the page read to the start of the log, then downloads. Only admins read
 * the log.
 */
const ExportTrail = ({
  appName,
  audit,
}: {
  appName: string;
  audit: AppAudit;
}) => {
  const { busy, failure, run } = useCoreAction();
  const trail = audit.state === "ready" ? audit.data : undefined;
  const exportAll = async (from: AppAuditTrail) => {
    const whole = await run(
      async (session) => await readWholeAppAudit(session, from)
    );
    if (whole !== undefined) {
      downloadCsv(auditCsv(trailEvents(whole)), auditFileName(appName));
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={
          busy ||
          trail === undefined ||
          (trailEvents(trail).length === 0 && !hasOlder(trail.read))
        }
        onClick={() => {
          if (trail !== undefined) {
            void exportAll(trail);
          }
        }}
        size="sm"
        variant="ghost"
      >
        <DownloadIcon data-icon="inline-start" />
        <Trans>Export</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** The app's logo and name, its vendor and how many use it; the export on the right. */
const AppHeader = ({
  app,
  audit,
}: {
  app: LandscapeApp;
  audit: Promise<AppAudit>;
}) => {
  const { t } = useLingui();
  const { users, vendor } = app;
  let about: ReactNode;
  if (users === null) {
    about = vendor === null ? t`Usage unknown` : t`${vendor} · usage unknown`;
  } else {
    about =
      vendor === null ? (
        <Plural one="# user" other="# users" value={users} />
      ) : (
        <Plural
          one={`${vendor} · # user`}
          other={`${vendor} · # users`}
          value={users}
        />
      );
  }
  return (
    <div className="flex items-center gap-4">
      <AppLogo name={app.name} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="truncate text-2xl font-medium tracking-tight">
          {app.name}
        </h1>
        <span className="text-muted-foreground truncate">{about}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Await
          fallback={
            <ExportTrail appName={app.name} audit={{ state: "adminsOnly" }} />
          }
          promise={audit}
        >
          {(loaded) => <ExportTrail appName={app.name} audit={loaded} />}
        </Await>
      </div>
    </div>
  );
};

const AppLayout = () => {
  const { t, i18n } = useLingui();
  const { app, audit } = Route.useLoaderData();
  const { appId } = Route.useParams();
  const { pathname } = useLocation();

  if (app.state !== "ready") {
    return (
      <>
        <SiteHeader crumbs={[{ label: t`Landscape`, to: "/landscape" }]} />
        <Page wide>
          <NotLoaded page={app} />
        </Page>
      </>
    );
  }
  if (app.data === null) {
    return (
      <>
        <SiteHeader
          crumbs={[
            { label: t`Landscape`, to: "/landscape" },
            { label: t`Not found` },
          ]}
        />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>
              <h1>{t`App not found`}</h1>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                It may have been removed, or the link is no longer valid.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const tab = tabOf(pathname, appId);
  const current = appTabs.find((each) => each.segment === tab) ?? appTabs[0];
  const tabLabel = i18n._(current.label);
  const crumbs: Crumb[] = [
    { label: t`Landscape`, to: "/landscape" },
    {
      label: app.data.name,
      to: "/landscape/$appId/overview",
      params: { appId },
    },
    { label: tabLabel },
  ];

  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <Page wide>
        <AppHeader app={app.data} audit={audit} />
        <Tabs value={tab}>
          <TabsList variant="line">
            {appTabs.map((each) => (
              <TabsTrigger
                key={each.segment}
                nativeButton={false}
                render={<Link params={{ appId }} to={each.to} />}
                value={each.segment}
              >
                {i18n._(each.label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Outlet />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/landscape/$appId")({
  // Every tab reads the same: moving between them reads nothing again.
  shouldReload: false,
  loader: async ({ context: { core, identity }, params }) =>
    await loadAppPage(core, identity, params.appId),
  pendingComponent: PageLoading,
  component: AppLayout,
});
