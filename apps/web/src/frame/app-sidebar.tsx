import type { SidebarApp } from "@grasp-os/shared/pages";
import type { Identity } from "@grasp-os/shared/rpc";
import { AppShellSidebar } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import {
  AppShellNav,
  AppShellNavEmpty,
  AppShellSwitch,
} from "@grasp-os/ui/blocks/app-shell-01/app-shell-01-sidebar";
import type { AppShellNavGroup } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01-sidebar";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import {
  AppWindowIcon,
  BellIcon,
  BrainIcon,
  CableIcon,
  HouseIcon,
  Icon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  RepeatIcon,
  SettingsIcon,
  UserSparklesIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import { radius } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useLocation,
  useMatchRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useAgentSection } from "../agents/agent-section.tsx";
import { useAppSection } from "../apps/app-section.tsx";
import { useBrainSection } from "../brain/brain-section.tsx";
import { chatsKey, useChatsWindow } from "../chat/chat-switcher.tsx";
import { useRecentChats } from "../chat/sidebar-chats.tsx";
import { useIntegrationsSection } from "../connections/integrations-sidebar.tsx";
import type { CoreConnection } from "../core-connection.ts";
import type { InboxItem } from "../inbox/items.ts";
import { useInboxGroups, useWaitingItems } from "../inbox/sidebar-inbox.tsx";
import { appSplat } from "../pages/app-address.ts";
import { groupedSectionsFor } from "../settings/sections.ts";
import { useWorkflowsWaiting } from "../workflows/nav-item.tsx";
import { GraspMark } from "./grasp-mark.ts";
import { PersonMenu } from "./person-menu.tsx";
import { FrameLevels } from "./sidebar.tsx";
import type { SidebarSection } from "./sidebar.tsx";
import { useSidebarApps } from "./surface-nav.tsx";
import { useWayOut, WayOut } from "./way-out.tsx";
import type { Outside } from "./way-out.tsx";

// The product's sidebar, as the reference's (#2503's
// grasp/frame/grasp-sidebar.tsx): the product's sections, the person's
// recent chats and the Apps' own entries, or what waits, chosen with the
// Home | Inbox switch under the head; while a page of an area with a
// navigation of its own is open (Settings, the Brain, Integrations, one
// App, one agent), that area's level in their place; the person at the
// foot. Staff who reach the onboarding alone get no views and none of the
// sections: Grasp steers the onboarding from its admin.
//
// Projects has no row: a project's page is the back step of an App or a
// workflow started from it (frame/item-shell.tsx), and its crumb leads to
// the list of projects.

/** What waits, in words, for a screen reader: the badge shows the number alone. */
const thingsWaiting = (waiting: number): string =>
  plural(waiting, { one: "# thing waiting", other: "# things waiting" });

/** The Workflows' count in words, for a screen reader: the badge shows the number alone. */
const workflowsWaitingLabel = (waiting: number): string =>
  plural(waiting, {
    one: "# workflow needs you",
    other: "# workflows need you",
  });

/** The sidebar's two views, chosen with the switch under its head. */
const styles = stylex.create({
  home: {
    display: "flex",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    color: "inherit",
  },
});

type SidebarView = "home" | "inbox";

const isView = (value: string): value is SidebarView =>
  value === "home" || value === "inbox";

/** The Apps' own entries (spec 34.1), a group of their own; none when there are none. */
const fromAppsGroup = (
  apps: readonly SidebarApp[],
  label: string,
  isCurrent: (app: string) => boolean
): AppShellNavGroup[] =>
  apps.length === 0
    ? []
    : [
        {
          id: "from-apps",
          label,
          rows: apps.map((app) => ({
            id: app.app,
            label: app.name,
            icon: AppWindowIcon,
            render: <Link params={{ app: app.app }} to="/apps/$app" />,
            current: isCurrent(app.app),
            rows: app.entries.map((entry) => {
              const splat = appSplat(entry.path);
              return {
                id: entry.path,
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

/** The product's sections, the recent chats and the Apps' own entries; or, on the Inbox view, what waits. */
const useGroups = ({
  core,
  identity,
  view,
  waitingItems,
  chats,
}: {
  core: CoreConnection;
  identity: Identity;
  view: SidebarView;
  waitingItems: readonly InboxItem[] | undefined;
  chats: Pick<ReturnType<typeof useRecentChats>, "rows" | "more">;
}): AppShellNavGroup[] => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const inbox = useInboxGroups(waitingItems);
  const workflowsWaiting = useWorkflowsWaiting();
  const apps = useSidebarApps(core);
  if (identity.onboardingOnly === true) {
    return [];
  }
  const at = (
    to: "/" | "/brain" | "/apps" | "/workflows" | "/agents" | "/connectors",
    fuzzy = true
  ) => matchRoute({ to, fuzzy }) !== false;
  const sections: AppShellNavGroup = {
    id: "sections",
    rows: [
      {
        id: "chat",
        label: t`Chat`,
        icon: MessageSquareIcon,
        render: <Link to="/" />,
        current: at("/", false),
      },
      {
        id: "brain",
        label: t`Brain`,
        icon: BrainIcon,
        render: <Link to="/brain" />,
        current: at("/brain"),
      },
      {
        id: "apps",
        label: t`Apps`,
        icon: LayoutDashboardIcon,
        render: <Link to="/apps" />,
        current: at("/apps"),
      },
      {
        id: "workflows",
        label: t`Workflows`,
        icon: RepeatIcon,
        render: <Link to="/workflows" />,
        current: at("/workflows"),
        ...(workflowsWaiting === undefined
          ? {}
          : {
              count: workflowsWaiting,
              countText: workflowsWaitingLabel(workflowsWaiting),
            }),
      },
      {
        id: "agents",
        label: t`Agents`,
        icon: UserSparklesIcon,
        render: <Link to="/agents" />,
        current: at("/agents"),
      },
      {
        id: "integrations",
        label: t`Connectors`,
        icon: CableIcon,
        render: <Link to="/connectors" />,
        current: at("/connectors"),
      },
    ],
  };
  // The person's recent chats: a group of their own under the sections,
  // named, its label folding the list away; the way to every chat after
  // them, the chats window.
  const recent: AppShellNavGroup[] =
    chats.rows.length === 0
      ? []
      : [
          {
            id: "chats",
            label: t`Chats`,
            collapsible: true,
            count: chats.rows.length,
            rows: chats.rows,
            more: chats.more,
          },
        ];
  const fromApps = fromAppsGroup(
    apps,
    t`From your Apps`,
    (app) =>
      matchRoute({ to: "/apps/$app", params: { app }, fuzzy: true }) !== false
  );
  return view === "inbox" ? inbox : [sections, ...recent, ...fromApps];
};

/**
 * Settings as a level of the sidebar while a Settings page is open: its
 * name, which opens Settings' first page, beside Back to the page the
 * person came from (Chat, when they landed on Settings), then the sections
 * they may see, in their groups (settings/sections.ts).
 */
const useSettingsSection = (
  identity: Identity,
  outside: Outside | undefined
): SidebarSection | undefined => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  if (pathname !== "/settings" && !pathname.startsWith("/settings/")) {
    return undefined;
  }
  return {
    id: "settings",
    title: t`Settings`,
    icon: SettingsIcon,
    home: (lead, title) => (
      <Link to="/settings">
        {lead}
        {title}
      </Link>
    ),
    back: { label: t`Back`, link: <WayOut outside={outside} /> },
    groups: groupedSectionsFor(identity).map(({ group, sections }) => ({
      id: group.id,
      label: i18n._(group.title),
      rows: sections.map(({ label, href, icon }) => ({
        id: href,
        label: i18n._(label),
        icon,
        render: <Link to={href} />,
        current: pathname.startsWith(href),
      })),
    })),
  };
};

/** The sidebar: Grasp's mark, the search and the fold, the views or a level, and the person. */
export const AppSidebar = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const openChats = useChatsWindow();
  const [view, setView] = useState<SidebarView>("home");
  const searching = identity.onboardingOnly !== true;
  // What waits on the person: the Inbox view's list, and so the dot.
  const waitingItems = useWaitingItems(identity, searching);
  const waiting = waitingItems?.length;
  const chats = useRecentChats({ enabled: searching });
  const groups = useGroups({
    core,
    identity,
    view,
    waitingItems,
    chats,
  });
  // Kept here, where it stays as the levels come and go.
  const outside = useWayOut();
  // Each area says whether one of its pages is open; at most one is.
  const settingsSection = useSettingsSection(identity, outside);
  const agentSection = useAgentSection();
  const brainSection = useBrainSection(identity, outside);
  const appSection = useAppSection(identity);
  const integrationsSection = useIntegrationsSection(outside);
  const section =
    settingsSection ??
    agentSection ??
    brainSection ??
    appSection ??
    integrationsSection;
  // On a phone the sidebar is a sheet over the page: going anywhere from it
  // closes it, so the page it went to is in view. Not the Inbox switch,
  // which opens the inbox under the sheet and shows its view in it, as the
  // reference's sheet stays for a press that follows no link.
  const keepSheet = useRef(false);
  const openInbox = async () => {
    keepSheet.current = true;
    await navigate({ to: "/inbox" });
    // Already on the inbox, nothing navigated to take the flag down.
    keepSheet.current = false;
  };
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", () => {
        if (keepSheet.current) {
          keepSheet.current = false;
          return;
        }
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  const rows = (
    <AppShellNav
      aria-label={view === "inbox" ? t`Inbox` : t`Main`}
      groups={groups}
    >
      {/* Said only once core has said so: while it can't be read, the view
          stays blank rather than claim nothing waits. */}
      {view === "inbox" && waitingItems !== undefined && groups.length === 0 ? (
        <AppShellNavEmpty>{t`Nothing waits for you.`}</AppShellNavEmpty>
      ) : null}
    </AppShellNav>
  );
  return (
    <>
      <AppShellSidebar
        mark={
          // The mark is the way home: the chat's start, on the Home view.
          <Link
            onClick={() => {
              setView("home");
            }}
            to="/"
            {...stylex.props(styles.home, focusRing)}
          >
            <Icon icon={GraspMark} label="Grasp" />
          </Link>
        }
        // The chats window. Its keys are the switcher's own, which close it
        // again too (chat/chat-switcher.tsx): the button shows them.
        listenToSearchShortcut={false}
        searchShortcut={`mod+${chatsKey}`}
        onSearch={
          searching
            ? () => {
                openChats(true);
              }
            : undefined
        }
      >
        <FrameLevels section={section}>
          {searching ? (
            <AppShellSwitch
              aria-label={t`Views`}
              // The switch is the one way in to the Inbox: choosing it opens
              // the Inbox's page too, so there is something to see even when
              // nothing waits and the view has no row to press.
              onValueChange={(next) => {
                if (!isView(next)) {
                  return;
                }
                setView(next);
                if (next === "inbox") {
                  void openInbox();
                }
              }}
              tabs={[
                { value: "home", label: t`Home`, icon: HouseIcon },
                {
                  value: "inbox",
                  label: t`Inbox`,
                  icon: BellIcon,
                  // The red dot on the bell: something waits for the person.
                  count: waiting ?? 0,
                  countText: thingsWaiting(waiting ?? 0),
                },
              ]}
              value={view}
            >
              {rows}
            </AppShellSwitch>
          ) : (
            rows
          )}
        </FrameLevels>
        <PersonMenu core={core} identity={identity} />
      </AppShellSidebar>
      {chats.dialog}
    </>
  );
};
