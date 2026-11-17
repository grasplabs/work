import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
// The kit's mark: Grasp UI has no Grasp mark yet.
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatchRoute } from "@tanstack/react-router";
import { useState } from "react";

import { chatsKey, useChatsWindow } from "../../chat/chat-switcher.tsx";
import { useRecentChats } from "../../chat/sidebar-chats.tsx";
import type { CoreConnection } from "../../core-connection.ts";
import {
  organizationOf,
  useShownName,
} from "../../frame/organization-name.tsx";
import { useSignOut } from "../../frame/person-menu.tsx";
import { usePersonTheme } from "../../frame/person-theme.tsx";
import { useSidebarApps } from "../../frame/surface-nav.tsx";
import { chooseTheme, isTheme } from "../../frame/theme.ts";
import type { InboxItem } from "../../inbox/items.ts";
import { useInboxGroups, useWaitingItems } from "../../inbox/sidebar-inbox.tsx";
import { appSplat } from "../../pages/app-address.ts";
import { groupedSectionsFor } from "../../settings/sections.ts";
import { shortcutLabel } from "../../shortcuts.ts";
import { useWorkflowsWaiting } from "../../workflows/nav-item.tsx";
import {
  AgentPerson,
  AppPanels,
  AppWindow,
  Bell,
  Brain,
  Cable,
  Conversation,
  Home,
  Cycle,
  Inbox,
  Projects,
  Question,
  Settings,
  Computer,
  Moon,
  SignOut,
  Sun,
  Swap,
} from "../icons/index.ts";
import type {
  SidebarGroup,
  SidebarMenuEntry,
  SidebarProfileProps,
  SidebarProps,
  SidebarSection,
} from "../sidebar/index.ts";

// The product's sidebar: Grasp UI's Sidebar (grasp/sidebar), filled with
// the product's sections, the Apps' own entries, and the person's menu.
// App shell stands it beside the page, folded as the person left it in this
// browser (the frame keeps that), and on a phone in its menu's sheet.

/** The Dashboard's count in words, for a screen reader: the badge shows the number alone. */
const thingsWaiting = (waiting: number): string =>
  plural(waiting, { one: "# thing waiting", other: "# things waiting" });

/** The Workflows' count in words, for a screen reader: the badge shows the number alone. */
const workflowsWaitingLabel = (waiting: number): string =>
  plural(waiting, {
    one: "# workflow needs you",
    other: "# workflows need you",
  });

/** The sidebar's two views, chosen with the switch under its head. */
type SidebarView = "home" | "inbox";

/** The product's sections, and the Apps' own entries after them. */
const useGroups = (
  core: CoreConnection,
  identity: Identity,
  tab: SidebarView,
  waitingItems: readonly InboxItem[] | undefined
): SidebarGroup[] => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const waiting = waitingItems?.length;
  const inbox = useInboxGroups(waitingItems);
  const workflowsWaiting = useWorkflowsWaiting();
  const apps = useSidebarApps(core);
  // The person's recent chats: the Chats tab's list.
  const recent = useRecentChats({
    enabled: identity.onboardingOnly !== true,
  });
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
  // The person's recent chats: a group of their own under the product's
  // sections, named, so they never stand between the sections.
  const chats: SidebarGroup[] =
    recent.length === 0
      ? []
      : [
          {
            id: "chats",
            label: t`Chats`,
            // Its label folds the list away; the sidebar remembers it.
            collapsible: true,
            count: recent.length,
            rows: recent,
          },
        ];
  // The Inbox tab: what waits for the person, each to its place in the inbox.
  return tab === "inbox" ? inbox : [sections, ...chats, ...fromApps];
};

/** A page outside Settings, to go back to: its path and its search. */
interface Outside {
  pathname: string;
  search: Record<string, unknown>;
}

/**
 * Settings as the sidebar's section while the person is in it: Back to the
 * page they came from (Chat, when they landed on Settings), then the
 * sections they may see, in their groups (settings/sections.ts).
 */
const useSettingsSection = (identity: Identity): SidebarSection | undefined => {
  const { t, i18n } = useLingui();
  const { pathname, search } = useLocation();
  const inSettings =
    pathname === "/settings" || pathname.startsWith("/settings/");
  // The last page outside Settings; kept while the frame is, so a reload on
  // a section goes back to Chat.
  const [outside, setOutside] = useState<Outside>();
  if (!inSettings && outside?.pathname !== pathname) {
    setOutside({ pathname, search });
  }
  if (!inSettings) {
    return undefined;
  }
  return {
    id: "settings",
    title: t`Settings`,
    icon: Settings,
    back: {
      label: t`Back`,
      render:
        outside === undefined ? (
          <Link to="/" />
        ) : (
          <Link search={outside.search} to={outside.pathname} />
        ),
    },
    groups: groupedSectionsFor(identity).map(({ group, sections }) => ({
      label: i18n._(group.title),
      rows: sections.map((section) => ({
        label: i18n._(section.label),
        icon: section.icon,
        render: <Link to={section.href} />,
        current: pathname.startsWith(section.href),
      })),
    })),
  };
};

/** The person at the foot, and their menu: Settings, Appearance, Support, their organization, Sign out. */
const useProfile = (
  core: CoreConnection,
  identity: Identity
): SidebarProfileProps => {
  const { t } = useLingui();
  const organization = useShownName(organizationOf(core));
  const signOut = useSignOut(core);
  // The same choice the Theme switch in Settings › Appearance changes.
  const { mode: theme } = usePersonTheme(identity.userId);
  const items: SidebarMenuEntry[] = [
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
      { label: t`Light`, value: "light", icon: Sun },
      { label: t`Dark`, value: "dark", icon: Moon },
      { label: t`System`, value: "system", icon: Computer },
    ],
    themeLabel: t`Appearance`,
  };
};

/**
 * The props of the product's sidebar (Grasp UI's Sidebar): App shell stands
 * it in its column, or, on a phone, in its menu's sheet, and folds it, so
 * the frame passes the Sidebar itself, with these.
 */
export const useGraspSidebar = ({
  core,
  identity,
  open,
  onOpenChange,
  closeMenu,
}: {
  core: CoreConnection;
  identity: Identity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closes the phone's menu, for a row that starts something over the page. */
  closeMenu: () => void;
}): SidebarProps => {
  const { t } = useLingui();
  const openChats = useChatsWindow();
  const [tab, setTab] = useState<SidebarView>("home");
  // What waits on the person: the Inbox view's list, and so the bell's
  // dot and the Dashboard's count.
  const waitingItems = useWaitingItems(
    identity,
    identity.onboardingOnly !== true
  );
  const waiting = waitingItems?.length;
  const groups = useGroups(core, identity, tab, waitingItems);
  const profile = useProfile(core, identity);
  const section = useSettingsSection(identity);
  const searching = identity.onboardingOnly !== true;
  return {
    foldLabel: t`Show or hide the sidebar`,
    groups,
    head: <GraspMark aria-hidden />,
    label: t`Sidebar`,
    navLabel: t`Main`,
    onOpenChange,
    open,
    profile,
    searchLabel: t`Search chats`,
    // Said only once core has said so: while it can't be read, the
    // view stays blank rather than claim nothing waits.
    ...(tab === "inbox" && waitingItems !== undefined
      ? { empty: t`Nothing waits for you.` }
      : {}),
    // Where the sidebar keeps which of its groups are folded, in this browser.
    storageKey: "grasp.sidebar",
    ...(searching
      ? {
          tabs: [
            { value: "home", label: t`Home`, icon: Home },
            {
              value: "inbox",
              label: t`Inbox`,
              icon: Bell,
              // The red dot on the bell: something waits for the person.
              count: waiting ?? 0,
              countLabel: thingsWaiting(waiting ?? 0),
            },
          ],
          tab,
          onTabChange: (next: string) => {
            setTab(next === "inbox" ? "inbox" : "home");
          },
          tabsLabel: t`Views`,
        }
      : {}),
    searchShortcut: shortcutLabel(chatsKey),
    ...(section === undefined ? {} : { section }),
    ...(searching
      ? {
          // The phone's menu goes first: App shell closes it on its own
          // only behind a layer marked aria-modal, which the chats window
          // is not yet.
          onSearch: () => {
            closeMenu();
            openChats(true);
          },
        }
      : {}),
  };
};
