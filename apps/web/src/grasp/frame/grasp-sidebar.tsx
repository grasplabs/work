import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useLocation,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { chatsKey, useChatsWindow } from "../../chat/chat-switcher.tsx";
import type { CoreConnection } from "../../core-connection.ts";
import { useWaitingCount } from "../../dashboard/nav-item.tsx";
import { useSignOut } from "../../frame/person-menu.tsx";
import { organizationOf, useShownName } from "../../frame/sidebar-brand.tsx";
import { useSidebarApps } from "../../frame/surface-nav.tsx";
import {
  applyTheme,
  chooseTheme,
  isTheme,
  onThemeChange,
  readTheme,
} from "../../frame/theme.ts";
import { appSplat } from "../../pages/app-address.ts";
import { shortcutLabel } from "../../shortcuts.ts";
import { tourStops } from "../../tour/tour-script.ts";
import { startTour } from "../../tour/tour-state.ts";
import { useWorkflowsWaiting } from "../../workflows/nav-item.tsx";
import {
  AgentPerson,
  AppPanels,
  AppWindow,
  Brain,
  Cable,
  Checklist,
  Conversation,
  Cycle,
  Inbox,
  Projects,
  Question,
  Settings,
  SignOut,
  Swap,
} from "../icons/index.ts";
import { Sidebar } from "../sidebar/index.ts";
import type {
  SidebarGroup,
  SidebarMenuEntry,
  SidebarProfileProps,
} from "../sidebar/index.ts";
import { grasp } from "../tokens/tokens.stylex.ts";

// The product's sidebar: Grasp UI's Sidebar (grasp/sidebar), filled with
// the product's sections, the Apps' own entries, and the person's menu.
// On a wider window it stands beside the page and folds away, as the
// person left it in this browser (the kit's sidebar state, which the
// frame keeps); on a phone it is a sheet over the page.

const styles = stylex.create({
  // The phone's sheet: the sidebar fills it.
  sheet: {
    display: "flex",
    flexGrow: 1,
    height: "100%",
    backgroundColor: grasp.shellGround,
  },
  unseen: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** What a screen reader hears of the Dashboard's count, as the old sidebar said it. */
const thingsWaiting = (waiting: number): string =>
  plural(waiting, { one: "# thing waiting", other: "# things waiting" });

/** What a screen reader hears of the Workflows' count, as the old sidebar said it. */
const workflowsWaitingLabel = (waiting: number): string =>
  plural(waiting, {
    one: "# workflow needs you",
    other: "# workflows need you",
  });

/** The product's sections, and the Apps' own entries after them. */
const useGroups = (
  core: CoreConnection,
  identity: Identity
): SidebarGroup[] => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const waiting = useWaitingCount();
  const workflowsWaiting = useWorkflowsWaiting();
  const apps = useSidebarApps(core);
  if (identity.onboardingOnly === true) {
    return [];
  }
  const at = (to: string, fuzzy = true) => matchRoute({ to, fuzzy }) !== false;
  const inWorkflows = at("/workflows");
  const onRequests = at("/workflows/requests");
  const sections: SidebarGroup = {
    rows: [
      {
        label: t`Chat`,
        icon: Conversation,
        render: <Link to="/" />,
        current: at("/", false),
      },
      {
        label: t`Dashboard`,
        icon: Inbox,
        render: <Link to="/dashboard" />,
        current: at("/dashboard", false),
        count: waiting,
        countLabel: thingsWaiting(waiting ?? 0),
      },
      {
        label: t`Brain`,
        icon: Brain,
        render: <Link to="/brain" />,
        current: at("/brain"),
      },
      {
        label: t`Projects`,
        icon: Projects,
        render: <Link to="/projects" />,
        current: at("/projects"),
      },
      {
        label: t`Apps`,
        icon: AppPanels,
        render: <Link to="/apps" />,
        current: at("/apps"),
      },
      {
        label: t`Workflows`,
        icon: Cycle,
        render: <Link to="/workflows" />,
        current: inWorkflows && !onRequests,
        count: workflowsWaiting,
        countLabel: workflowsWaitingLabel(workflowsWaiting ?? 0),
        // Stephen's requests, under Workflows while the person is in them.
        ...(isAdmin(identity.role) && inWorkflows
          ? {
              rows: [
                {
                  label: t({
                    message: "Requests",
                    context: "Stephen's requests: the page",
                  }),
                  render: <Link to="/workflows/requests" />,
                  current: onRequests,
                },
              ],
            }
          : {}),
      },
      {
        label: t`Agents`,
        icon: AgentPerson,
        render: <Link to="/agents" />,
        current: at("/agents"),
      },
      {
        label: t`Integrations`,
        icon: Cable,
        render: <Link to="/integrations" />,
        current: at("/integrations"),
      },
    ],
  };
  // The Apps' own entries (spec 34.1), a group of their own; none when there are none.
  const fromApps: SidebarGroup[] =
    apps.length === 0
      ? []
      : [
          {
            label: t`From your Apps`,
            rows: apps.map((app) => ({
              label: app.name,
              icon: AppWindow,
              render: <Link params={{ app: app.app }} to="/apps/$app" />,
              current:
                matchRoute({
                  to: "/apps/$app",
                  params: { app: app.app },
                  fuzzy: true,
                }) !== false,
              rows: app.entries.map((entry) => {
                const splat = appSplat(entry.path);
                return {
                  label: entry.title,
                  render:
                    splat === "" ? (
                      <Link params={{ app: app.app }} to="/apps/$app" />
                    ) : (
                      <Link
                        params={{ app: app.app, _splat: splat }}
                        to="/apps/$app/pages/$"
                      />
                    ),
                };
              }),
            })),
          },
        ];
  return [sections, ...fromApps];
};

/** The person at the foot, and their menu: the tour, Settings, Appearance, Support, their organization, Sign out. */
const useProfile = (
  core: CoreConnection,
  identity: Identity,
  onLeave: () => void
): SidebarProfileProps => {
  const { t } = useLingui();
  const { pathname } = useLocation();
  const organization = useShownName(organizationOf(core));
  const signOut = useSignOut(core);
  // Read where it is kept, so a choice made in another tab shows here too.
  const theme = useSyncExternalStore(onThemeChange, () =>
    readTheme(identity.userId)
  );
  // What theme.js painted first was whoever was here last; this is theirs.
  useEffect(() => {
    applyTheme(readTheme(identity.userId));
  }, [identity.userId]);
  const items: SidebarMenuEntry[] = [
    ...(tourStops(identity).length > 0
      ? [
          {
            label: t`Getting started`,
            icon: Checklist,
            onSelect: () => {
              // On a phone the menu is in a sheet over the page: it goes, so the tour isn't told behind it.
              onLeave();
              startTour(identity.userId, pathname);
            },
          },
        ]
      : []),
    {
      label: t`Settings`,
      icon: Settings,
      render: <Link to="/settings/profile" />,
    },
    "appearance",
    {
      label: t`Support`,
      icon: Question,
      render: (
        // Named here as well: the menu fills in its words, the lint can't see them.
        <a
          aria-label={t`Support`}
          href="/docs"
          rel="noopener"
          target="_blank"
        />
      ),
    },
    "separator",
    // The organizations the person is in, the one they are in now
    // chosen: one, until Grasp lets a person be in more.
    {
      label: t`Switch organization`,
      icon: Swap,
      choices: [{ label: organization ?? "Grasp", value: "current" }],
      value: "current",
    },
    {
      label: t`Sign out`,
      icon: SignOut,
      danger: true,
      onSelect: () => {
        void signOut();
      },
    },
  ];
  return {
    name: identity.name,
    ...(organization === undefined ? {} : { organisation: organization }),
    items,
    theme,
    onThemeChange: (next) => {
      if (isTheme(next)) {
        chooseTheme(identity.userId, next);
      }
    },
    themes: [
      { label: t`Light`, value: "light" },
      { label: t`Dark`, value: "dark" },
      { label: t`System`, value: "system" },
    ],
    themeLabel: t`Appearance`,
  };
};

/** Grasp UI's sidebar, beside the page or, on a phone, in a sheet over it. */
export const GraspSidebar = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { isMobile, openMobile, setOpenMobile, open, setOpen } = useSidebar();
  const openChats = useChatsWindow();
  const groups = useGroups(core, identity);
  const profile = useProfile(core, identity, () => {
    setOpenMobile(false);
  });
  // Following a link on a phone goes to its page: the sheet goes with it.
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  const searching = identity.onboardingOnly !== true;
  const sidebar = (
    <Sidebar
      // In the phone's sheet it fills the sheet.
      fill={isMobile}
      foldLabel={t`Show or hide the sidebar`}
      groups={groups}
      head={<GraspMark aria-hidden />}
      label={t`Sidebar`}
      navLabel={t`Main`}
      onOpenChange={(next) => {
        if (isMobile) {
          setOpenMobile(next);
        } else {
          setOpen(next);
        }
      }}
      open={isMobile ? true : open}
      profile={profile}
      searchLabel={t`Search chats`}
      searchShortcut={shortcutLabel(chatsKey)}
      {...(searching
        ? {
            onSearch: () => {
              openChats(true);
            },
          }
        : {})}
    />
  );
  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        <SheetContent showCloseButton={false} side="left">
          <span {...stylex.props(styles.unseen)}>
            <SheetTitle>{t`Sidebar`}</SheetTitle>
          </span>
          <div {...stylex.props(styles.sheet)}>{sidebar}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return sidebar;
};
