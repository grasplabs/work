import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { buttonVariants, Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { buildsApp } from "./app-role.ts";
import { StatusBadge } from "./app-status.tsx";

// An App as its people use it (/apps/$app): the live App, its current
// version, full width, under a slim bar with its name and its pages
// (core's pages) as tabs. Nothing here builds it: its builders get Edit,
// which opens its workspace (/apps/$app/edit, app-workspace.tsx), where the
// chat builds a preview and Publish makes it live. Its settings, under
// "…", are for everyone who opens it, each section as they may see it
// (app-settings.tsx).

/** "…": the open page at full size, and the App's settings. */
const MoreMenu = ({
  app,
  name,
  fullPage,
  builds,
}: {
  app: string;
  name: string;
  fullPage: ReactNode;
  builds: boolean;
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
          render={
            // Its builders change the settings beside the chat.
            builds ? (
              <Link
                params={{ app }}
                search={{ view: "settings" }}
                to="/apps/$app/edit"
              />
            ) : (
              <Link params={{ app }} to="/apps/$app/settings" />
            )
          }
        >
          <SettingsIcon />
          <Trans>Settings</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** No page to show: archived, or nothing built yet. */
const NoPage = ({
  app,
  archived,
  editable,
}: {
  app: string;
  archived: boolean;
  editable: boolean;
}) => (
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
      {editable ? (
        <EmptyContent>
          <Link
            className={buttonVariants()}
            params={{ app }}
            to="/apps/$app/edit"
          >
            <PencilIcon data-icon="inline-start" />
            {archived ? <Trans>Restore it</Trans> : <Trans>Build it</Trans>}
          </Link>
        </EmptyContent>
      ) : null}
    </Empty>
  </div>
);

/**
 * The live App: its bar, then its open page (`children`), or that it
 * has none. Only one who builds it (`buildsApp`, by their role in this
 * App) gets Edit.
 */
export const AppPage = ({
  app,
  opens,
  identity,
  fullPage,
  children,
}: {
  app: ViewedApp;
  /** Whether its pages open: it has some, and isn't archived. */
  opens: boolean;
  identity: Pick<Identity, "staff">;
  /** "Open full page", as a menu item, while a page is open. */
  fullPage: ReactNode;
  children: ReactNode;
}) => {
  const { name } = app;
  const builds = buildsApp(app, identity);
  const archived = app.status === "archived";
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="bg-background flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 md:px-6">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="bg-muted text-foreground inline-flex size-7 flex-none items-center justify-center rounded-lg"
          >
            <LayoutGridIcon className="size-4" />
          </span>
          <h1 className="truncate text-base font-medium">{name}</h1>
          {/* Who uses it sees it only published; its builders see when it isn't. */}
          {app.status === "published" ? null : (
            <StatusBadge status={app.status} />
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {builds ? (
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              params={{ app: app.id }}
              to="/apps/$app/edit"
            >
              <PencilIcon data-icon="inline-start" />
              <Trans>Edit</Trans>
            </Link>
          ) : null}
          <MoreMenu
            app={app.id}
            builds={builds}
            fullPage={fullPage}
            name={name}
          />
        </span>
      </div>
      {opens ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <NoPage app={app.id} archived={archived} editable={builds} />
      )}
    </div>
  );
};
