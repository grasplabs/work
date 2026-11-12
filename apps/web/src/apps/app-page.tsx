import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArchiveIcon,
  LayoutGridIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ItemBar, ItemShell } from "../frame/item-shell.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import { pageHref, useAppAddress } from "../pages/app-address.ts";
import { PageFrame } from "../pages/page-frame.tsx";
import { buildsApp } from "./app-role.ts";
import type { AppSettingsSection } from "./app-settings.tsx";
import { StatusBadge, statusOf } from "./app-status.tsx";
import { AppWorkspace } from "./app-workspace.tsx";
import type {
  ReadOnlyShown,
  WorkspaceEnv,
  WorkspaceView,
} from "./app-workspace.tsx";

// An App at its address (/apps/$app): its workspace for who builds it
// (app-workspace.tsx); for anyone else the live App, its current version,
// full width, under the one bar every App has (frame/item-shell.tsx), with
// nothing that builds it. An archived App opens nothing for them, as
// nobody uses one until it is restored. Its settings, under "…", are for
// everyone who opens it, each section as they may see it (app-settings.tsx).

/** "…": the open page at full size, and the App's settings. */
const MoreMenu = ({
  app,
  name,
  fullPage,
}: {
  app: string;
  name: string;
  fullPage: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t`More for ${name}`}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {fullPage}
        <DropdownMenuItem
          render={<Link params={{ app }} to="/apps/$app/settings" />}
        >
          <SettingsIcon />
          <Trans>Settings</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** No page to show: archived, or nothing built yet. */
const NoPage = ({ archived }: { archived: boolean }) => (
  <div className="flex flex-1 items-center justify-center p-6">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {archived ? <ArchiveIcon /> : <LayoutGridIcon />}
        </EmptyMedia>
        <EmptyTitle>
          {archived ? (
            <Trans>This App is archived</Trans>
          ) : (
            <Trans>No page yet</Trans>
          )}
        </EmptyTitle>
        <EmptyDescription>
          {archived ? (
            <Trans>
              It is kept as it was, and nobody works on it, until a builder
              restores it.
            </Trans>
          ) : (
            <Trans>This App has nothing to open yet.</Trans>
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
);

/** The live App: its bar, then its open page (`children`), or that it has none. */
const AppPage = ({
  app,
  back,
  opens,
  fullPage,
  children,
}: {
  app: ViewedApp;
  /** The way back: the Apps, or the project it was opened from. */
  back: Crumb;
  /** Whether its pages open: it has some, and isn't archived. */
  opens: boolean;
  /** "Open full page", as a menu item, while a page is open. */
  fullPage: ReactNode;
  children: ReactNode;
}) => {
  const { name } = app;
  return (
    <ItemShell
      bar={
        <ItemBar
          actions={<MoreMenu app={app.id} fullPage={fullPage} name={name} />}
          back={back}
          name={name}
          // Who uses it sees it only live; anything else says so.
          state={
            statusOf(app) === "live" ? undefined : <StatusBadge app={app} />
          }
        />
      }
    >
      {opens ? children : <NoPage archived={app.archived} />}
    </ItemShell>
  );
};

/**
 * The live App, for one who uses it: its pages run as one single page app
 * in the frame under its bar, routed by the App's own router; where it is
 * goes in the address (pages/app-address.ts). "Open full page" opens the
 * route open now outside the shell (apps.$app.full.tsx).
 */
const LiveApp = ({
  app,
  back,
  pages,
}: {
  app: ViewedApp;
  back: Crumb;
  pages: boolean;
}) => {
  const { id } = app;
  const router = useRouter();
  const { t } = useLingui();
  const address = useAppAddress({
    root: `/apps/${id}`,
    sub: `/apps/${id}/pages`,
  });
  const opens = pages && !app.archived;
  return (
    <AppPage
      app={app}
      back={back}
      fullPage={
        opens ? (
          <DropdownMenuItem
            render={
              // Where the App is, its search and hash as the App wrote
              // them, full page: outside the shell, so a document of
              // its own.
              <a
                aria-label={t`Open full page`}
                href={pageHref(
                  { root: `/apps/${id}/full`, sub: `/apps/${id}/full` },
                  address.at ?? "/"
                )}
              />
            }
          >
            <Maximize2Icon />
            <Trans>Open full page</Trans>
          </DropdownMenuItem>
        ) : null
      }
      opens={opens}
    >
      {opens ? (
        <PageFrame
          app={id}
          at={address.at}
          // The App's bar holds the page's heading, its name.
          embedded
          onMoved={address.handleMoved}
          // Loading the App again reads its current version again too.
          onReload={() => {
            void router.invalidate();
          }}
          ownPath={address.own}
        />
      ) : null}
    </AppPage>
  );
};

/**
 * An App, opened at its address: its workspace for one who builds it
 * (`buildsApp`), with Grasp's chat about it beside; the live App, with
 * nothing that builds it, for anyone else.
 */
export const OpenedApp = ({
  app,
  back,
  pages,
  identity,
  handedOver,
  ...at
}: {
  app: ViewedApp;
  back: Crumb;
  /** Whether it has pages to open. */
  pages: boolean;
  identity: Identity;
  /** The chat the person came from, building this App in Chat. */
  handedOver: string | undefined;
  view: WorkspaceView;
  env: WorkspaceEnv;
  shown: ReadOnlyShown | undefined;
  section: AppSettingsSection | undefined;
}) =>
  buildsApp(app, identity) ? (
    <AppWorkspace
      app={app}
      back={back}
      handedOver={handedOver}
      identity={identity}
      {...at}
    />
  ) : (
    <LiveApp app={app} back={back} pages={pages} />
  );
