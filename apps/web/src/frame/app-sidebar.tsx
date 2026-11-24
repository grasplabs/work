import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarLevel,
  SidebarLevels,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import {
  BellIcon,
  BrainIcon,
  HouseIcon,
  Icon,
  LayoutGridIcon,
  LinkIcon,
  MessageCircleIcon,
  SearchIcon,
  UserSparklesIcon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useLocation,
  useMatchRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { chatsKey, useChatsWindow } from "../chat/chat-switcher.tsx";
import { RecentChats } from "../chat/sidebar-chats.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { InboxView, useWaitingCount } from "../inbox/sidebar-inbox.tsx";
import { shortcutLabel } from "../shortcuts.ts";
import { WorkflowsItem } from "../workflows/nav-item.tsx";
import { GraspMark } from "./grasp-mark.ts";
import { levelAt } from "./levels.ts";
import { PersonMenu } from "./person-menu.tsx";
import { SettingsLevel } from "./settings-level.tsx";
import { SurfaceNav } from "./surface-nav.tsx";
import { useWayOut } from "./way-out.tsx";

// The app's sidebar, as the reference's, on Damsko's Sidebar on its own
// light ground, the page a card beside it: Grasp's mark at the top, with
// the search of the chats and the sidebar's own fold; under it a switch of
// two views, Home and Inbox. Home holds the product's sections (Chat,
// Brain, Apps, Workflows, Agents and Integrations, the same for every
// role), the person's recent chats and the Apps' own entries; Inbox, what
// waits on the person. While a Settings page is open, Settings' own level
// stands in their place. At the foot, the person signed in, with their
// menu. Folded, it goes off the side whole, and each page's bar holds the
// way back (frame/site-header.tsx). On a phone it is a sheet from the
// start. Staff who reach the onboarding alone get no views and none of
// the sections: Grasp steers the onboarding from its admin.
//
// Projects has no row, as in the reference: a project's page is the back
// step of an App or a workflow started from it (frame/item-shell.tsx), and
// its crumb leads to the list of projects.

interface Section {
  to: "/" | "/brain" | "/apps" | "/agents" | "/integrations";
  label: MessageDescriptor;
  icon: IconData;
}

const chat: Section = { to: "/", label: msg`Chat`, icon: MessageCircleIcon };
const brain: Section = { to: "/brain", label: msg`Brain`, icon: BrainIcon };
const apps: Section = { to: "/apps", label: msg`Apps`, icon: LayoutGridIcon };
// The company's agents: the ones a person may ask, and for admins all of them.
const agents: Section = {
  to: "/agents",
  label: msg`Agents`,
  icon: UserSparklesIcon,
};
const integrations: Section = {
  to: "/integrations",
  label: msg`Integrations`,
  icon: LinkIcon,
};

const styles = stylex.create({
  // Grasp's mark at the start, the search and the fold at the end, in one
  // row a sidebar row tall.
  head: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    minHeight: size.sidebarMenuButtonHeight,
    paddingInlineStart: size.sidebarRowInline,
  },
  // The views' switch, under the head, at the rows' inset; the views
  // themselves stand in the level as its list did, each scrolling.
  views: { display: "contents" },
  switch: {
    flexShrink: 0,
    marginInline: space["2"],
    marginBlockEnd: space["1"],
  },
  // A view's icon and words, a row's gap apart, as a row's are.
  tab: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  // The mark at the shell's mark size, in the sidebar's ink.
  mark: {
    [iconVars.size]: size.appShellMark,
    display: "inline-flex",
    marginInlineEnd: "auto",
  },
});

/** A section's entry: Chat is itself; any other holds the pages under it. */
const SectionItem = ({ section }: { section: Section }) => {
  const { i18n } = useLingui();
  const matchRoute = useMatchRoute();
  const { to, label, icon } = section;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={matchRoute({ to, fuzzy: to !== "/" }) !== false}
      >
        <Link to={to}>
          <Icon icon={icon} />
          {i18n._(label)}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** The search of the person's chats, a round button in the head: the chats window, ⌘K. */
const SearchButton = () => {
  const { t } = useLingui();
  const openChats = useChatsWindow();
  const { setOpenMobile } = useSidebar();
  const keys = shortcutLabel(chatsKey);
  return (
    <SidebarMenuButton
      aria-label={t`Search chats`}
      onClick={() => {
        // The window opens over the page: the phone's sheet goes first.
        setOpenMobile(false);
        openChats(true);
      }}
      size="icon"
      title={`${t`Search chats`} (${keys})`}
    >
      <Icon icon={SearchIcon} />
    </SidebarMenuButton>
  );
};

/**
 * The sidebar's top: Grasp's mark, and the search and the fold at its end;
 * in the phone's sheet, a close button in the fold's place.
 */
const Head = ({ searching }: { searching: boolean }) => {
  const { t } = useLingui();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <div {...stylex.props(styles.head)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspMark} label="Grasp" />
      </span>
      {searching ? <SearchButton /> : null}
      {isMobile ? (
        <SidebarMenuButton
          aria-label={t`Close`}
          onClick={() => {
            setOpenMobile(false);
          }}
          size="icon"
        >
          <Icon icon={XIcon} />
        </SidebarMenuButton>
      ) : (
        <SidebarTrigger aria-label={t`Show or hide the sidebar`} />
      )}
    </div>
  );
};

/** What waits, in words, for a screen reader: the Inbox's dot shows no number. */
const thingsWaiting = (waiting: number): string =>
  plural(waiting, { one: "# thing waiting", other: "# things waiting" });

/** The sidebar's two views. */
type View = "home" | "inbox";

const isView = (value: string | null): value is View =>
  value === "home" || value === "inbox";

/**
 * Home and Inbox, the switch under the head and the view it shows: Home,
 * the sections, the recent chats and the Apps' entries; Inbox, what waits.
 * Choosing Inbox opens the inbox's page too, so there is something to see
 * even when nothing waits; Home keeps the page the person is on.
 */
const Views = ({ core }: { core: CoreConnection }) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("home");
  // The Inbox tab's dot, and the Inbox view's count.
  const waiting = useWaitingCount();
  const dotted = waiting !== undefined && waiting > 0;
  return (
    <Tabs
      onValueChange={(next) => {
        if (!isView(next)) {
          return;
        }
        setView(next);
        if (next === "inbox") {
          void navigate({ to: "/inbox" });
        }
      }}
      style={styles.views}
      value={view}
    >
      <TabsList aria-label={t`Views`} style={styles.switch}>
        <TabsTrigger value="home">
          <span {...stylex.props(styles.tab)}>
            <Icon icon={HouseIcon} />
            {t`Home`}
          </span>
        </TabsTrigger>
        <TabsTrigger value="inbox">
          <span {...stylex.props(styles.tab)}>
            <Icon icon={BellIcon} />
            {t`Inbox`}
            {/* The red dot: something waits; how much, in its name. */}
            {dotted ? (
              <Badge
                aria-label={thingsWaiting(waiting)}
                dot
                variant="destructive"
              />
            ) : null}
          </span>
        </TabsTrigger>
      </TabsList>
      <TabsContent style={styles.views} value="home">
        <SidebarContent aria-label={t`Main`}>
          <SidebarGroup>
            <SidebarMenu>
              <SectionItem section={chat} />
              <SectionItem section={brain} />
              <SectionItem section={apps} />
              {/* With how many workflows need the person. */}
              <WorkflowsItem />
              <SectionItem section={agents} />
              <SectionItem section={integrations} />
            </SidebarMenu>
          </SidebarGroup>
          <RecentChats />
          <SurfaceNav core={core} />
        </SidebarContent>
      </TabsContent>
      <TabsContent style={styles.views} value="inbox">
        <InboxView waiting={waiting} />
      </TabsContent>
    </Tabs>
  );
};

/** The app's sidebar: Grasp's mark, search and the fold, the views or a level, and the person. */
export const AppSidebar = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  // Settings' own while a Settings page is open, else the main one.
  const level = levelAt(useLocation().pathname);
  // Kept here, not in the level: the phone's sheet draws its rows anew.
  const outside = useWayOut();
  // On a phone the sidebar is a sheet over the page: going anywhere from it
  // closes it, so the page it went to is in view.
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  const sections = identity.onboardingOnly !== true;
  return (
    <Sidebar aria-label={t`Sidebar`} variant="inset">
      <SidebarHeader>
        <Head searching={sections} />
      </SidebarHeader>
      <SidebarLevels value={level}>
        <SidebarLevel value="main">
          {/* No landmark with nothing in it: who reaches the onboarding
              alone has no sections. */}
          {sections ? <Views core={core} /> : null}
        </SidebarLevel>
        <SettingsLevel identity={identity} outside={outside} />
      </SidebarLevels>
      <SidebarFooter>
        <PersonMenu core={core} identity={identity} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};
