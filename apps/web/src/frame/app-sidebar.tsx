import type { Identity } from "@grasp-os/shared/rpc";
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
  BrainIcon,
  FolderIcon,
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
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useLocation,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { chatsKey, useChatsWindow } from "../chat/chat-switcher.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { InboxNavItem } from "../inbox/nav-item.tsx";
import { shortcutLabel } from "../shortcuts.ts";
import { WorkflowsItem } from "../workflows/nav-item.tsx";
import { GraspMark } from "./grasp-mark.ts";
import { levelAt } from "./levels.ts";
import { PersonMenu } from "./person-menu.tsx";
import { SettingsLevel } from "./settings-level.tsx";
import { SurfaceNav } from "./surface-nav.tsx";
import { useWayOut } from "./way-out.tsx";

// The app's sidebar, Damsko's Sidebar on its own light ground, the page a
// card beside it: Grasp's mark at the top, with the search of the chats
// and the sidebar's own fold; under it the product's sections and the
// Apps' own entries, or, while a Settings page is open, Settings' own
// level in their place; at the foot the person signed in, with their
// menu. Folded, it goes off the side whole, and each page's bar holds the
// way back (frame/site-header.tsx). On a phone it is a sheet from the
// start. Staff who reach the onboarding alone get none of the sections:
// Grasp steers the onboarding from its admin.

interface Section {
  to: "/" | "/brain" | "/projects" | "/apps" | "/agents" | "/integrations";
  label: MessageDescriptor;
  icon: IconData;
}

const chat: Section = { to: "/", label: msg`Chat`, icon: MessageCircleIcon };
const brain: Section = { to: "/brain", label: msg`Brain`, icon: BrainIcon };
const projects: Section = {
  to: "/projects",
  label: msg`Projects`,
  icon: FolderIcon,
};
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

/** The app's sidebar: Grasp's mark, search and the fold, the sections or a level, and the person. */
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
          {sections ? (
            <SidebarContent aria-label={t`Main`}>
              <SidebarGroup>
                <SidebarMenu>
                  <SectionItem section={chat} />
                  {/* With how many things wait on the person. */}
                  <InboxNavItem />
                  <SectionItem section={brain} />
                  <SectionItem section={projects} />
                  <SectionItem section={apps} />
                  {/* With how many workflows need the person. */}
                  <WorkflowsItem />
                  <SectionItem section={agents} />
                  <SectionItem section={integrations} />
                </SidebarMenu>
              </SidebarGroup>
              <SurfaceNav core={core} />
            </SidebarContent>
          ) : null}
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
