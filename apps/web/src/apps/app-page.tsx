import type { ViewedApp } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ItemBar, ItemShell } from "../frame/item-shell.tsx";
import type { Crumb } from "../frame/site-header.tsx";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuPanel,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  AppWindow,
  Archive,
  Expand,
  More,
  Settings,
} from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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

const styles = stylex.create({
  place: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: grasp.space6,
  },
});

/** "…": the open page at full size (`full`, its address), and the App's settings. */
const MoreMenu = ({
  app,
  name,
  full,
}: {
  app: string;
  name: string;
  full: string | undefined;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        icon={More}
        label={t`More for ${name}`}
        variant="ghost"
      />
      <DropdownMenuPanel align="end">
        {full === undefined ? null : (
          <DropdownMenuItem
            icon={Expand}
            onSelect={() => {
              // Outside the shell: a document of its own.
              window.location.assign(full);
            }}
          >
            {t`Open full page`}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          icon={Settings}
          onSelect={() => {
            void navigate({ to: "/apps/$app/settings", params: { app } });
          }}
        >
          {t`Settings`}
        </DropdownMenuItem>
      </DropdownMenuPanel>
    </DropdownMenu>
  );
};

/** No page to show: archived, or nothing built yet. */
const NoPage = ({ archived }: { archived: boolean }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.place)}>
      {archived ? (
        <Empty icon={Archive} title={t`This App is archived`}>
          {t`It is kept as it was, and nobody works on it, until a builder restores it.`}
        </Empty>
      ) : (
        <Empty icon={AppWindow} title={t`No page yet`}>
          {t`This App has nothing to open yet.`}
        </Empty>
      )}
    </div>
  );
};

/** The live App: its bar, then its open page (`children`), or that it has none. */
const AppPage = ({
  app,
  back,
  opens,
  full,
  children,
}: {
  app: ViewedApp;
  /** The way back: the Apps, or the project it was opened from. */
  back: Crumb;
  /** Whether its pages open: it has some, and isn't archived. */
  opens: boolean;
  /** Where "Open full page" goes, while a page is open. */
  full: string | undefined;
  children: ReactNode;
}) => {
  const { name } = app;
  return (
    <ItemShell
      bar={
        <ItemBar
          actions={<MoreMenu app={app.id} full={full} name={name} />}
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
  const address = useAppAddress({
    root: `/apps/${id}`,
    sub: `/apps/${id}/pages`,
  });
  const opens = pages && !app.archived;
  return (
    <AppPage
      app={app}
      back={back}
      full={
        // Where the App is, its search and hash as the App wrote them,
        // full page.
        opens
          ? pageHref(
              { root: `/apps/${id}/full`, sub: `/apps/${id}/full` },
              address.at ?? "/"
            )
          : undefined
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
