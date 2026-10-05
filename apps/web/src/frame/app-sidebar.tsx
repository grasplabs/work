import type { Identity } from "@grasp-os/shared/rpc";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
  BookOpenIcon,
  CogIcon,
  BlocksIcon,
  MessagesSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { DashboardItem } from "../dashboard/nav-item.tsx";
import { GraspMark } from "../grasp-mark.tsx";
import { PersonMenu } from "./person-menu.tsx";

// The product's sections, down the left beside every signed-in page. What
// only admins use is in the person menu at its foot.

interface Section {
  to: "/" | "/knowledge" | "/engines" | "/workflows" | "/integrations";
  label: MessageDescriptor;
  icon: LucideIcon;
}

const sections: readonly Section[] = [
  { to: "/", label: msg`Chat`, icon: MessagesSquareIcon },
  { to: "/knowledge", label: msg`Knowledge`, icon: BookOpenIcon },
  { to: "/engines", label: msg`Engines`, icon: CogIcon },
  { to: "/workflows", label: msg`Workflows`, icon: WorkflowIcon },
  { to: "/integrations", label: msg`Integrations`, icon: BlocksIcon },
];

/** A section's entry: Chat is only itself; any other holds the pages under it. */
const SectionItem = ({ section }: { section: Section }) => {
  const { i18n } = useLingui();
  const matchRoute = useMatchRoute();
  const { to, label, icon: Icon } = section;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={matchRoute({ to, fuzzy: to !== "/" }) !== false}
        render={<Link to={to} />}
      >
        <Icon />
        <span>{i18n._(label)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** The app's sidebar: the mark, the sections and the person signed in. */
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
  return (
    <Sidebar collapsible="offcanvas" label={t`Sidebar`} variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" />} size="lg">
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg">
                <GraspMark className="size-4" />
              </span>
              <span className="truncate font-medium">Grasp</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={t`Main`}>
              <SidebarMenu>
                {sections.slice(0, 1).map((section) => (
                  <SectionItem key={section.to} section={section} />
                ))}
                <DashboardItem identity={identity} />
                {sections.slice(1).map((section) => (
                  <SectionItem key={section.to} section={section} />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <PersonMenu core={core} identity={identity} />
      </SidebarFooter>
    </Sidebar>
  );
};
