/**
 * Grasp's admin as a place of its own, apart from the console's pages and
 * from the platform a company works in, ported from the prototype
 * (grasplabs/prototype `packages/grasp/src/components/admin/admin-frame.tsx`):
 * its own sidebar (its places, every organization, and the way back to the
 * console at its foot) and none of the console's bar above. It folds to
 * icons, so inside one organization that organization's own column of
 * sections has the room.
 *
 * Beside each organization, as the prototype has it, how many things need
 * Grasp there, as the admin's model works it out of what its core answered
 * (src/admin/views.ts). Not yet here: how many integrations wait on Grasp
 * and how many companies' platforms need a look, for the console has no
 * source for them yet; those places show no number rather than a made-up
 * one.
 */
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import { Link, Outlet, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BuildingIcon,
  CableIcon,
  FlaskConicalIcon,
  HourglassIcon,
  LayoutDashboardIcon,
  ServerIcon,
  SparklesIcon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect } from "react";
import type { ComponentType, SVGProps } from "react";

import type { ClientAdmin } from "../clients/admin.ts";
import { GraspMark } from "./grasp-mark.tsx";
import { organizationsOf, unreadWords } from "./views.ts";
import type { Organization } from "./views.ts";

/** One of the admin's own places, down the top of its sidebar. */
interface Place {
  to:
    | "/admin"
    | "/admin/integrations"
    | "/admin/platform"
    | "/admin/ask"
    | "/admin/sources"
    | "/admin/lab";
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const places: readonly Place[] = [
  { to: "/admin", label: "Overview", icon: LayoutDashboardIcon },
  {
    to: "/admin/integrations",
    label: "Integrations to build",
    icon: WrenchIcon,
  },
  { to: "/admin/platform", label: "Platform", icon: ServerIcon },
  { to: "/admin/ask", label: "Ask Grasp", icon: SparklesIcon },
  { to: "/admin/sources", label: "Sources", icon: CableIcon },
  { to: "/admin/lab", label: "Stephen Lab", icon: FlaskConicalIcon },
];

/**
 * Why an organization's core isn't read now, in words and as a mark: not
 * deployed yet, or not answering; null when it answered. A mark, where the
 * prototype has its count, for words don't fit beside the name.
 */
const unreadOf = (
  admin: ClientAdmin
): { words: string; Mark: ComponentType<SVGProps<SVGSVGElement>> } | null => {
  if (admin.state === "answered") {
    return null;
  }
  return {
    words: unreadWords(admin),
    Mark: admin.error === "not_deployed" ? HourglassIcon : UnplugIcon,
  };
};

/** The tooltip of an organization's entry: its name, and what its mark or count says. */
const tooltipOf = (
  name: string,
  unread: { words: string } | null,
  needs: number
): string => {
  if (unread !== null) {
    return `${name}: ${unread.words}`;
  }
  if (needs === 0) {
    return name;
  }
  return `${name}: ${needs} ${needs === 1 ? "thing needs" : "things need"} Grasp`;
};

const PlaceItem = ({ place }: { place: Place }) => {
  const matchRoute = useMatchRoute();
  const { to, label, icon: Icon } = place;
  // The overview is only itself; any other place holds the pages under it.
  const active = matchRoute({ to, fuzzy: to !== "/admin" }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={<Link to={to} />}
        tooltip={label}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/**
 * An organization: its name, and how many things need Grasp there, or when
 * its core isn't read now, why.
 */
const OrganizationItem = ({ organization }: { organization: Organization }) => {
  const matchRoute = useMatchRoute();
  const { admin, view } = organization;
  const { id, name } = admin.client;
  const unread = unreadOf(admin);
  const needs = view?.needs.length ?? 0;
  const active =
    matchRoute({
      to: "/admin/$clientId",
      params: { clientId: id },
      fuzzy: true,
    }) !== false;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // Room for the mark or count, so a long name ends before it.
        className={unread === null && needs === 0 ? undefined : "pr-8"}
        isActive={active}
        render={<Link params={{ clientId: id }} to="/admin/$clientId" />}
        tooltip={tooltipOf(name, unread, needs)}
      >
        <BuildingIcon />
        <span>{name}</span>
      </SidebarMenuButton>
      {unread === null ? null : (
        <SidebarMenuBadge>
          <unread.Mark aria-hidden className="size-4" />
          <span className="sr-only">{unread.words}</span>
        </SidebarMenuBadge>
      )}
      {needs > 0 ? (
        <SidebarMenuBadge>
          {needs}
          <span className="sr-only">
            {needs === 1 ? "thing needs Grasp" : "things need Grasp"}
          </span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
};

const AdminSidebar = ({ admins }: { admins: readonly ClientAdmin[] }) => {
  const router = useRouter();
  const organizations = organizationsOf(admins);
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
    <Sidebar collapsible="icon" label="Admin" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/admin" />}
              size="lg"
              tooltip="Grasp admin"
            >
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <GraspMark className="size-4" />
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Grasp</span>
                <span className="text-muted-foreground truncate text-xs">
                  Admin
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Admin">
              <SidebarMenu>
                {places.map((place) => (
                  <PlaceItem key={place.to} place={place} />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Organizations</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Organizations">
              <SidebarMenu>
                {organizations.map((organization) => (
                  <OrganizationItem
                    key={organization.admin.client.id}
                    organization={organization}
                  />
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" />}
              tooltip="Back to the console"
            >
              <ArrowLeftIcon />
              <span>Back to the console</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

/**
 * The admin's frame around its pages: its sidebar beside the page, which
 * scrolls inside it so its bar stays in view, as the platform's frame does.
 */
export const AdminFrame = ({ admins }: { admins: readonly ClientAdmin[] }) => (
  <TooltipProvider>
    <SidebarProvider className="h-svh">
      <AdminSidebar admins={admins} />
      <SidebarInset className="min-h-0 min-w-0 overflow-y-auto">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
);
