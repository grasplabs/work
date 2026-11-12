import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Kbd } from "@grasp-os/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  BotIcon,
  BrainIcon,
  FolderIcon,
  LayoutGridIcon,
  MessagesSquareIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect } from "react";
import type { ComponentType, SVGProps } from "react";

import { chatsKey, useChatsWindow } from "../chat/chat-switcher.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { DashboardItem } from "../dashboard/nav-item.tsx";
import { shortcutLabel } from "../shortcuts.ts";
import { WorkflowsItem } from "../workflows/nav-item.tsx";
import { IntegrationsIcon } from "./integrations-icon.tsx";
import { PersonMenu } from "./person-menu.tsx";
import { SidebarBrand } from "./sidebar-brand.tsx";
import { SurfaceNav } from "./surface-nav.tsx";

// The app's sidebar, down the left beside every signed-in page, as
// Shopify's admin has it: the organization and the sidebar's own fold on
// top, with search under it; the product's sections; the Apps' own
// entries; and at the foot Settings and the person signed in. Folded, it
// is a rail of icons, each named on hover, the groups parted by hairlines.
// What only admins use is in the person menu. Staff who reach the
// onboarding alone get none of the sections: Grasp steers the onboarding
// from its admin.

interface Section {
  to: "/" | "/brain" | "/projects" | "/apps" | "/agents" | "/integrations";
  label: MessageDescriptor;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const chat: Section = { to: "/", label: msg`Chat`, icon: MessagesSquareIcon };
const brain: Section = { to: "/brain", label: msg`Brain`, icon: BrainIcon };
const projects: Section = {
  to: "/projects",
  label: msg`Projects`,
  icon: FolderIcon,
};
const apps: Section = { to: "/apps", label: msg`Apps`, icon: LayoutGridIcon };
// The company's agents: the ones a person may ask, and for admins all of them.
const agents: Section = { to: "/agents", label: msg`Agents`, icon: BotIcon };
const integrations: Section = {
  to: "/integrations",
  label: msg`Integrations`,
  icon: IntegrationsIcon,
};

/** A section's entry: Chat is itself; any other holds the pages under it. */
const SectionItem = ({ section }: { section: Section }) => {
  const { i18n } = useLingui();
  const matchRoute = useMatchRoute();
  const { to, label, icon: Icon } = section;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={matchRoute({ to, fuzzy: to !== "/" }) !== false}
        render={<Link to={to} />}
        tooltip={i18n._(label)}
      >
        <Icon />
        <span>{i18n._(label)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** Search, under the organization: the person's chats, ⌘K away anywhere. */
const SearchItem = () => {
  const { t } = useLingui();
  const openChats = useChatsWindow();
  return (
    // As much room above it, from the brand, as below it, to the sections.
    <SidebarMenu className="mt-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {
            openChats(true);
          }}
          tooltip={t`Search chats`}
          variant="field"
        >
          <SearchIcon />
          <span>{t`Search chats`}</span>
          <Kbd className="ml-auto">{shortcutLabel(chatsKey)}</Kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

/** Settings, at the foot: the person's own, and for admins the organization's. */
const SettingsItem = () => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={matchRoute({ to: "/settings", fuzzy: true }) !== false}
          render={<Link to="/settings/profile" />}
          tooltip={t`Settings`}
        >
          <SettingsIcon />
          <span>{t`Settings`}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

/** The app's sidebar: the organization, search, the sections, Settings and the person signed in. */
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
  // On a phone the sidebar is a sheet over the page: going anywhere from it
  // closes it, so the page it went to is in view.
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  const sections = identity.onboardingOnly !== true;
  return (
    <Sidebar collapsible="icon" label={t`Sidebar`} variant="inset">
      <SidebarHeader>
        <SidebarBrand core={core} />
        {sections ? <SearchItem /> : null}
      </SidebarHeader>
      <SidebarContent>
        {sections ? (
          <>
            <SidebarGroup>
              <nav aria-label={t`Main`}>
                <SidebarMenu>
                  <SectionItem section={chat} />
                  <DashboardItem />
                  <SectionItem section={brain} />
                  <SectionItem section={projects} />
                  <SectionItem section={apps} />
                  {/* With how many workflows need the person. */}
                  <WorkflowsItem requests={isAdmin(identity.role)} />
                  <SectionItem section={agents} />
                  <SectionItem section={integrations} />
                </SidebarMenu>
              </nav>
            </SidebarGroup>
            <SurfaceNav core={core} />
          </>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <SettingsItem />
        <PersonMenu core={core} identity={identity} />
      </SidebarFooter>
    </Sidebar>
  );
};
